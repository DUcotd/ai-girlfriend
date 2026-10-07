/**
 * EmbeddingClient - 嵌入向量客户端（仅语义检索模式使用）。
 *
 * 嵌入只用来做「锦上添花」的语义检索：超时短、不重试，
 * 慢/挂了就立刻退回关键词模式，绝不拖慢对话主链路。
 *
 * B1-4 之后「快速降级」才是真的（审计 CORE-18：config 注释承诺了两年，代码里没有）：
 *   - `available` 的含义从「配了 Key」改成「**配了且健康**」；
 *   - 连续失败 failureThreshold 次 → 熔断打开，冷却 cooldownMs 内**一次都不发起**，
 *     检索直接走关键词。坏 Key 时旧行为是每轮白吃两次 2500 ms 超时（记忆 + 叙事各一次），
 *     首字延迟凭空加 5 秒，而且永远如此；
 *   - 冷却到期后自动半开：下一次调用当探针，成功即清零、失败立刻重新熔断；
 *   - `update()` 在 Key/模型/地址**真的变了**时重置熔断 ——
 *     用户改对 Key 不必重启。
 *
 * B1-5：同一轮的 query 嵌入只发一次网络往返。
 * ⚠️ 这条是**延迟**修复（首字更快），不是成本修复：命中的是「记忆检索与叙事检索
 * 在同一轮里对同一个字符串各问一次」（审计 CORE-18 实测），
 * 缓存按 (model, text) 键、容量有界（config.embedding.cacheMax，超出按 LRU 逐旧）。
 */
import OpenAI from 'openai';
import { config } from '../../config.js';
import { LLM_CHANNELS, record as recordCall } from '../../utils/llmCalls.js';
import { toVector } from './vectorCodec.js';

/**
 * 厂商默认模型映射：部分网关不托管 openai 默认嵌入模型，按 baseUrl 自动纠正。
 * 旧的 if-hardcode 收敛成配置表，新增厂商只加一行。
 */
const VENDOR_MODEL_OVERRIDES = [
    { test: /siliconflow/i, model: 'BAAI/bge-large-zh-v1.5' },
];

export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

export class EmbeddingClient {
    /**
     * @param {object} opts 已解析的嵌入配置 { apiKey, baseUrl, model, now? }
     *   now?: () => number 时钟注入点（B1-4 的熔断测试要用它推进时间，
     *        **绝不用 sleep** —— 睡出来的断言验的是调度器而不是这段代码）
     */
    constructor({ apiKey, baseUrl, model, now = null } = {}) {
        this.apiKey = apiKey || null;
        this.baseUrl = (baseUrl || 'https://api.openai.com/v1').replace(/\/embeddings\/?$/, '');
        this.model = model || DEFAULT_EMBEDDING_MODEL;
        this._now = typeof now === 'function' ? now : () => Date.now();

        for (const override of VENDOR_MODEL_OVERRIDES) {
            if (override.test.test(this.baseUrl) && this.model === DEFAULT_EMBEDDING_MODEL) {
                this.model = override.model;
                break;
            }
        }

        /** 熔断状态（B1-4）。全是可观测字段，测试直接断言状态迁移 */
        this.consecutiveFailures = 0;
        this.breakerOpenUntil = 0;
        this.breakerTrips = 0;

        /** `${model}\u0000${text}` → 向量的有界 LRU（B1-5）；cacheMax=0 等于关掉 */
        this._cache = new Map();
        this.cacheHits = 0;
        this.networkCalls = 0;

        this.client = null;
        if (this.apiKey) {
            this.init();
        }
    }

    init() {
        this.client = new OpenAI({
            apiKey: this.apiKey,
            baseURL: this.baseUrl,
            timeout: config.embedding.timeoutMs,
            maxRetries: config.embedding.maxRetries,
        });
    }

    /** 熔断是否打开（冷却期内 true）。纯读，不改状态 */
    isBreakerOpen() {
        return this.breakerOpenUntil > this._now();
    }

    /** 是否具备调用条件：**配了 Key 且没被熔断**（B1-4 改了语义，调用方据此降级） */
    get available() {
        return !!this.client && !this.isBreakerOpen();
    }

    /** 配置热更新（字段缺省保留原值） */
    update({ apiKey, baseUrl, model } = {}) {
        // 「真的变了」才重置熔断：用户改对 Key 不必重启；而只是重复下发同一份配置
        // （前端每次挂载都会 syncConfig 一遍）不该把失败账本清零、让坏 Key 又开始每轮超时。
        const changed = (apiKey && apiKey !== this.apiKey)
            || (baseUrl && baseUrl.replace(/\/embeddings\/?$/, '') !== this.baseUrl)
            || (model && model !== this.model);
        if (changed) this.resetBreaker();

        if (apiKey) this.apiKey = apiKey;
        if (baseUrl) this.baseUrl = baseUrl.replace(/\/embeddings\/?$/, '');
        if (model) this.model = model;
        for (const override of VENDOR_MODEL_OVERRIDES) {
            if (override.test.test(this.baseUrl) && this.model === DEFAULT_EMBEDDING_MODEL) {
                this.model = override.model;
                break;
            }
        }
        if (this.apiKey && !this.client) {
            this.init();
        }
        // 换了任何一项配置，旧 (model, text) 的缓存都可能对不上新语义，清一次
        if (changed) this._cache.clear();
    }

    /** 手动关闭熔断（配置变更/测试用）：清零失败计数与冷却时间 */
    resetBreaker() {
        this.consecutiveFailures = 0;
        this.breakerOpenUntil = 0;
    }

    /** 熔断与缓存快照（供 /config/status 展示与排障；只给计数，不给任何文本） */
    breakerStatus() {
        return {
            available: this.available,
            configured: !!this.client,
            healthy: !this.isBreakerOpen(),
            consecutiveFailures: this.consecutiveFailures,
            open: this.isBreakerOpen(),
            /** 冷却剩余毫秒；0 = 没在冷却或已到期可以试探 */
            cooldownRemainingMs: Math.max(0, this.breakerOpenUntil - this._now()),
            trips: this.breakerTrips,
            cacheSize: this._cache.size,
            cacheHits: this.cacheHits,
            networkCalls: this.networkCalls,
        };
    }

    /** LRU 写入：容量 0 = 关掉 memoize；超出容量丢最旧（Map 保持插入序） */
    _cacheSet(key, value) {
        const cap = config.embedding.cacheMax;
        if (!Number.isFinite(cap) || cap <= 0) return;
        this._cache.set(key, value);
        while (this._cache.size > cap) {
            this._cache.delete(this._cache.keys().next().value);
        }
    }

    /**
     * 文本 → 向量；无客户端、熔断中或调用失败返回 null（调用方自行走关键词路径）。
     * @param {string} text
     * @returns {Promise<number[]|Float32Array|null>}
     */
    async embed(text) {
        if (!this.client) return null;
        // 冷却期内一次都不发起 —— 这就是「快速降级」的全部含义
        if (this.isBreakerOpen()) return null;

        const key = `${this.model}\u0000${text}`;
        if (this._cache.has(key)) {
            const hit = this._cache.get(key);
            // 命中即确认失败账本可以清零（上一轮成功过、这一轮压根不用问）
            this.cacheHits++;
            return hit;
        }

        this.networkCalls++;
        recordCall(LLM_CHANNELS.EMBEDDING);
        try {
            const response = await this.client.embeddings.create({
                model: this.model,
                input: text,
            });
            const vector = response.data[0].embedding;
            this.consecutiveFailures = 0;
            this.breakerOpenUntil = 0;
            this._cacheSet(key, vector);
            return vector;
        } catch (e) {
            // 静默退化是有意设计，但至少要留一条日志，否则 key/模型配错永远无人知晓
            this.consecutiveFailures++;
            const threshold = config.embedding.failureThreshold;
            if (this.consecutiveFailures >= threshold) {
                this.breakerOpenUntil = this._now() + config.embedding.cooldownMs;
                this.breakerTrips++;
                this._cache.clear();
                console.warn(
                    `[Memory] 嵌入连续失败 ${this.consecutiveFailures} 次，熔断 ${Math.round(config.embedding.cooldownMs / 1000)}s`
                    + `（期间强制走关键词检索）：${e.status || 'no-status'} ${e.message || e}`
                );
            } else {
                console.warn(`[Memory] embed failed (${e.status || 'no-status'}): ${e.message || e}`);
            }
            return null;
        }
    }

    /**
     * 余弦相似度；维度不匹配或零向量返回 0（换嵌入模型后旧向量即走这条路）。
     *
     * B8-2：入参形状从此不再固定 —— Array（老数据/新嵌入结果）、Float32Array、
     * base64 字符串（新的磁盘形状）三种都要能吃，统一过 toVector 归一。
     * 这一处是全站余弦的收口点，所以 8 个读取点不必各自判形状（旧写法有 8 份
     * `Array.isArray(...)`，加一种形状就要改 8 处，漏一处就是静默 0 分）。
     */
    static cosineSimilarity(vecA, vecB) {
        const a = toVector(vecA);
        const b = toVector(vecB);
        if (!a || !b || a.length !== b.length) return 0;
        let dotProduct = 0, normA = 0, normB = 0;
        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        if (normA === 0 || normB === 0) return 0;
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }
}
