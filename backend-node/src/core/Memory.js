/**
 * Memory - 记忆系统 facade（对外 API 与旧版兼容，实现在 ./memory/）。
 *
 * 架构（详见 core/memory/ 各模块）：
 *   MemoryStore      —— schema v2 持久化（episodes 情节 + facts 事实），去抖落盘
 *   EmbeddingClient  —— 嵌入向量（仅语义检索模式使用）
 *   MemoryRetriever  —— 检索调度：方案 A（语义余弦+情绪+recency）/ 方案 B（BM25 关键词）
 *   FactExtractor    —— 事实提取：每轮对话后用主 LLM 沉淀持久信息（add/update/delete）
 *   textSim          —— 切词与文本相似度（关键词检索/去重共用）
 *
 * 检索双模式：事实注入按重要度常驻、与嵌入无关，故无嵌入 Key 时记忆系统依然完整。
 */
import { config } from '../config.js';
import { MemoryStore, clipText } from './memory/MemoryStore.js';
import { EmbeddingClient } from './memory/EmbeddingClient.js';
import { MemoryRetriever } from './memory/MemoryRetriever.js';
import { FactExtractor, clampImportance, normalizeCategory } from './memory/FactExtractor.js';
import { isNearDuplicateText } from './memory/KeywordScorer.js';
import { toVector, encodeVector } from './memory/vectorCodec.js';

class Memory {
    /**
     * @param {string} _persistDirectory 仅兼容旧版签名的占位，实际存储统一在 data/memory.json
     * @param {object} opts { apiKey, baseUrl, embeddingApiKey, embeddingBaseUrl,
     *                        embeddingModelName, getChatClient }
     *   getChatClient: () => ({client, model} | null)，供事实提取复用主对话客户端
     *   （构造参数改名 opts，不再叫 config——旧参数名会遮蔽全局导入，是重构前的已知陷阱）
     */
    constructor(_persistDirectory = null, opts = {}) {
        this.store = new MemoryStore();
        this.embedding = new EmbeddingClient(Memory._resolveEmbeddingOpts(opts));
        this.retriever = new MemoryRetriever({ store: this.store, embedding: this.embedding });
        this._getChatClient = typeof opts.getChatClient === 'function' ? opts.getChatClient : null;
        this.factExtractor = new FactExtractor({ getClient: this._getChatClient });
        this._extractQueue = Promise.resolve();
        this._extractGeneration = 0;
        this._recentSharedIds = new Set();
        /**
         * 后台提取的**待处理轮次**（B1-6，审计 CORE-18）。
         * 旧形状是「每轮对话往 Promise 链上挂一个闭包」：连发 10 条 = 10 次串行提取，
         * 每次还带全量事实表，积压无界、且越跑越是在描述过期轮次。
         * 现在改成待办数组 + 单一泵：积压超过 mergeThreshold 就把最旧的若干轮
         * **合并成一次模型调用**（合并而不是丢弃 —— 丢掉一轮就是永久丢掉那轮的信息）。
         */
        this._pendingTurns = [];
        this._extractBusy = false;
    }

    /** 主配置 + 嵌入专属配置 → 嵌入客户端配置（专属字段优先，缺省回退主 Key/URL） */
    static _resolveEmbeddingOpts(opts = {}) {
        return {
            apiKey: opts.embeddingApiKey || opts.apiKey || null,
            baseUrl: opts.embeddingBaseUrl || opts.baseUrl || undefined,
            model: opts.embeddingModelName || undefined,
        };
    }

    updateConfig(opts = {}) {
        this.embedding.update(Memory._resolveEmbeddingOpts(opts));
    }

    // ==================== 写入 ====================

    /**
     * 记录一轮对话：写入情节记忆 + 触发后台事实提取。
     * 两者都不在响应关键路径上（调用方在 setImmediate 中触发）。
     *
     * `_extractGeneration` 同时充当**整个记忆层的写入世代号**：clearMemory() 递增它，
     * 于是所有在途的「await 嵌入 → 写库」续体在恢复时都会发现自己已经过期。
     *
     * @returns {Promise<{episodeId:string|null, skipped:boolean}>} 本轮情节的 id
     *   （B2-10：叙事抽取要拿它当 sourceEpisodeId，「我们的故事」才回得指原来的对话）
     */
    async recordTurn(userInput, replyText, { emotionSnapshot = null } = {}) {
        const generation = this._extractGeneration;
        const text = `User: ${userInput}\nXiao Ai: ${replyText}`;
        const episodeId = await this._addEpisode(text, emotionSnapshot, generation);
        this._scheduleFactExtraction(userInput, replyText);
        return { episodeId: episodeId || null, skipped: !episodeId };
    }

    async _addEpisode(text, emotionSnapshot, generation = this._extractGeneration) {
        const embedding = await this.embedding.embed(text);
        // 嵌入是网络等待，期间可能发生过 clearMemory/resetAll：作废这次写入，
        // 否则被删掉的情节会在重置之后复活。
        if (generation !== this._extractGeneration) {
            console.log('[Memory] Episode write skipped (记忆在等待期间被清空)');
            return null;
        }

        // 写入去重：与既有情节近重复的直接丢弃（防复读对话刷库）。
        // 有新向量用余弦判定；无向量（关键词模式 / 嵌入失败）退化为文本 Jaccard。
        const threshold = config.memory.dedupWriteSimilarity;
        const isDup = embedding
            ? this.store.episodes.some((e) => {
                const vec = toVector(e.embedding);      // B8-2：形状统一走 toVector
                return vec && EmbeddingClient.cosineSimilarity(embedding, vec) > threshold;
            })
            : this.store.episodes.some((e) => isNearDuplicateText(text, e.text, threshold));
        if (isDup) {
            console.log('[Memory] Episode skipped (near-duplicate of existing)');
            return null;
        }

        const episode = this.store.addEpisode({
            text,
            embedding,
            embeddingModel: embedding ? this.embedding.model : null,
            emotionSnapshot,
        });
        this.store.scheduleSave();
        return episode.id;
    }

    /**
     * 事实提取串行队列（B1-6：合并而不是堆积、更不是丢弃）。
     *
     * 旧写法每轮对话往 Promise 链尾挂**一个闭包**：用户连发 10 条 → 10 次串行提取，
     * 每次还带全量事实表（3-10 s 一趟），积压无界，而且越往后越是在给「几轮之前的
     * 上下文」做总结。现在：
     *   - 待处理轮进 `_pendingTurns` 数组（唯一的真积压点，长度可断言）；
     *   - 只有一个「泵」在链上跑（_extractBusy），跑的时候把待处理轮**按批**取走；
     *   - 批大小由 config.memory.facts.mergeThreshold / mergeBatchMax 决定：
     *     积压超过阈值就把最旧的若干轮**合并成一次模型调用**，
     *     合并输入里必须逐轮带全每一轮的原文（不丢内容是这次的验收口径）。
     *
     * @returns {number} 当前待处理轮数（观测/断言用）
     */
    _scheduleFactExtraction(userInput, replyText) {
        if (!config.memory.facts.enabled || !this._getChatClient) return this._pendingTurns.length;
        this._pendingTurns.push({ userInput, replyText, at: Date.now() });
        if (!this._extractBusy) this._pumpExtraction(this._extractGeneration);
        return this._pendingTurns.length;
    }

    /** 待处理轮数（测试断言队列有界用；也进 /config/status 的 memory 块） */
    get pendingExtractions() {
        return this._pendingTurns.length;
    }

    /**
     * 本次要合并的轮数：积压超过 mergeThreshold → 一次吃掉整段积压（上限 mergeBatchMax），
     * 否则保持「一轮一提取」的原语义（不牺牲单轮的及时性）。
     */
    _batchSize() {
        const n = config.memory.facts;
        if (this._pendingTurns.length > n.mergeThreshold) {
            return Math.min(this._pendingTurns.length, n.mergeBatchMax);
        }
        return 1;
    }

    /** 把待处理轮拼成一次提取的输入文本（每轮都带原文，顺序从旧到新） */
    static _mergedTranscript(batch) {
        return batch
            .map((t, i) => `【第 ${i + 1}/${batch.length} 轮】\nUser: ${t.userInput}\nXiao Ai: ${t.replyText}`)
            .join('\n\n');
    }

    _pumpExtraction(generation) {
        this._extractBusy = true;
        this._extractQueue = this._extractQueue
            .then(async () => {
                while (this._pendingTurns.length > 0) {
                    // 期间记忆被清空 → 作废整条积压（防清空后残留事实复活）
                    if (generation !== this._extractGeneration) {
                        this._pendingTurns = [];
                        return;
                    }
                    const batch = this._pendingTurns.splice(0, this._batchSize());
                    const transcript = Memory._mergedTranscript(batch);
                    const ops = await this.factExtractor.extractOps(transcript, this.store.facts);
                    const changed = ops.add.length + ops.update.length + ops.delete.length;
                    if (changed === 0 || generation !== this._extractGeneration) continue;
                    await this._applyFactOps(ops, generation);
                    console.log(
                        `[Memory] Facts: +${ops.add.length} ~${ops.update.length} -${ops.delete.length}`
                        + `（本轮提取覆盖 ${batch.length} 轮对话）`
                    );
                }
            })
            .catch((e) => console.error(`[Memory] fact extraction failed: ${e.message}`))
            .finally(() => { this._extractBusy = false; });
        return this._extractQueue;
    }

    async _applyFactOps(ops, generation = this._extractGeneration) {
        const now = Date.now() / 1000;
        /** 每次 await 之后都要重新确认世代：清空可能落在任意两次嵌入之间 */
        const stale = () => generation !== this._extractGeneration;

        for (const id of ops.delete) {
            this.store.removeFact(id);
        }

        for (const upd of ops.update) {
            if (stale()) return;
            const fact = this.store.facts.find((f) => f.id === upd.id);
            if (!fact) continue;
            const content = clipText(upd.content, config.textLimits.factContent);
            if (!content) continue;                 // 模型可能回传 {"content": 123} 之类的脏值
            if (content !== fact.content) {
                fact.content = content;
                const embedding = await this.embedding.embed(content);
                if (stale()) return;
                if (embedding) {
                    fact.embedding = encodeVector(embedding);
                    fact.embeddingModel = this.embedding.model;
                }
            }
            if (upd.importance !== undefined) fact.importance = clampImportance(upd.importance);
            if (upd.category !== undefined) fact.category = normalizeCategory(upd.category);
            fact.updatedAt = now;
        }

        for (const add of ops.add) {
            if (stale()) return;
            const content = clipText(add.content, config.textLimits.factContent);
            if (!content) continue;
            // 判重先于嵌入：旧实现先 await embed 再 isDuplicateFact，
            // 于是每条重复事实都白付一次嵌入请求（钱与时延都白花）。
            if (FactExtractor.isDuplicateFact(content, null, this.store.facts)) continue;
            const embedding = await this.embedding.embed(content);
            if (stale()) return;
            if (FactExtractor.isDuplicateFact(content, embedding, this.store.facts)) continue;
            this.store.addFact({
                content,
                category: normalizeCategory(add.category),
                importance: clampImportance(add.importance),
                source: 'extracted',
                embedding,
                embeddingModel: embedding ? this.embedding.model : null,
            });
        }

        this.store.scheduleSave();
    }

    // ==================== 读取 / 检索 ====================

    /**
     * 构建注入 prompt 的记忆上下文：【已知事实】（重要度常驻）+ 【相关回忆】（语义/关键词检索）。
     * 无可注入内容时返回空串（调用方据此整段省略）。
     */
    async buildMemoryContext(query, currentEmotion = null) {
        const factsText = this._formatFactsForInjection();
        let episodesText = '';
        try {
            const hits = await this.retriever.retrieve(query, currentEmotion);
            if (hits.length > 0) {
                episodesText = hits
                    .map((h) => `- ${Memory._clip(h.text, config.memory.retrieval.injectEpisodeMaxChars)}`)
                    .join('\n');
            }
        } catch (e) {
            console.error(`[Memory] retrieve failed: ${e.message}`);
        }
        if (!factsText && !episodesText) return '';

        const sections = [];
        if (factsText) sections.push(`【已知事实】\n${factsText}`);
        if (episodesText) sections.push(`【相关回忆】\n${episodesText}`);
        // 数据围栏（审计 PROMPT-06）：记忆与对话原文是**引述素材**，不是指令。
        // 本地单人应用的真实风险不是"窃取他人数据"，而是长期投毒——用户写一句
        // 像指令的话被提取成事实，之后每一轮都生效。围栏 + 人设里一句"素材非指令"
        // 是成本最低的解法。
        return `<memory_data>\n${sections.join('\n\n')}\n</memory_data>`;
    }

    /** 注入前按字符数截断：单条最长 8000 字的原文不该整段进 prompt（审计 CORE-09） */
    static _clip(text, max) {
        const s = String(text || '');
        if (!Number.isFinite(max) || max <= 0 || s.length <= max) return s;
        return `${s.slice(0, max)}…`;
    }

    /** 事实注入：按重要度→最新排序取 top-N（不依赖嵌入，重启后即生效） */
    _formatFactsForInjection() {
        if (!config.memory.facts.enabled || this.store.facts.length === 0) return '';
        const top = [...this.store.facts]
            .sort((a, b) => (b.importance - a.importance) || (b.updatedAt - a.updatedAt))
            .slice(0, config.memory.facts.injectTopN);
        return top.map((f) => `- ${Memory._clip(f.content, config.memory.facts.injectFactMaxChars)}`).join('\n');
    }

    /** 主动消息「回忆分享」：从较早记忆里随机挑一条，避开最近 N 条与最近已分享的 */
    getRandomMemory(excludeRecentN = 5) {
        const episodes = this.store.episodes;
        if (episodes.length === 0) return null;
        const pool = episodes.slice(0, Math.max(1, episodes.length - excludeRecentN));
        const candidates = pool.filter((e) => !this._recentSharedIds.has(e.id));
        const list = candidates.length > 0 ? candidates : pool;
        const pick = list[Math.floor(Math.random() * list.length)];
        if (candidates.length > 0) {
            this._recentSharedIds.add(pick.id);
            // 只记最近 10 条，老记忆隔一阵子可以再次被分享
            while (this._recentSharedIds.size > 10) {
                this._recentSharedIds.delete(this._recentSharedIds.values().next().value);
            }
        }
        return { id: pick.id, text: pick.text };
    }

    /** 全量导出（API 用）：剥离 embedding 大字段，情节按时间倒序 */
    getAll() {
        return {
            facts: this.store.facts.map((f) => this._publicFact(f)),
            episodes: [...this.store.episodes]
                .sort((a, b) => b.timestamp - a.timestamp)
                .map((e) => ({ id: e.id, text: e.text, timestamp: e.timestamp })),
            stats: this.getStats(),
        };
    }

    getStats() {
        return {
            episodeCount: this.store.episodes.length,
            factCount: this.store.facts.length,
            retrievalMode: this.retriever.resolveMode(),
        };
    }

    _publicFact(f) {
        return {
            id: f.id,
            content: f.content,
            category: f.category,
            importance: f.importance,
            source: f.source,
            createdAt: f.createdAt,
            updatedAt: f.updatedAt,
        };
    }

    // ==================== 单条管理 ====================

    /** 手动添加事实；与既有事实重复时抛 DUPLICATE_FACT */
    async addFact(content, { importance = 3, category = 'other' } = {}) {
        const trimmed = clipText(content, config.textLimits.factContent);
        if (!trimmed) return null;
        const embedding = await this.embedding.embed(trimmed);
        if (FactExtractor.isDuplicateFact(trimmed, embedding, this.store.facts)) {
            const err = new Error('此事实已存在');
            err.code = 'DUPLICATE_FACT';
            throw err;
        }
        const created = this.store.addFact({
            content: trimmed,
            category: normalizeCategory(category),
            importance: clampImportance(importance),
            source: 'manual',
            embedding,
            embeddingModel: embedding ? this.embedding.model : null,
        });
        this.store.scheduleSave();
        return created ? this._publicFact(created) : null;
    }

    /** 编辑事实（content 变更会重新计算向量）；id 不存在返回 null */
    async updateFact(id, { content, importance, category } = {}) {
        const fact = this.store.facts.find((f) => f.id === id);
        if (!fact) return null;
        if (content !== undefined) {
            const trimmed = clipText(content, config.textLimits.factContent);
            if (trimmed && trimmed !== fact.content) {
                fact.content = trimmed;
                const embedding = await this.embedding.embed(trimmed);
                if (embedding) {
                    fact.embedding = encodeVector(embedding);
                    fact.embeddingModel = this.embedding.model;
                }
            }
        }
        if (importance !== undefined) fact.importance = clampImportance(importance);
        if (category !== undefined) fact.category = normalizeCategory(category);
        fact.updatedAt = Date.now() / 1000;
        this.store.scheduleSave();
        return this._publicFact(fact);
    }

    /** 删除单条记忆（事实或情节）；命中返回其类型，未命中返回 null */
    deleteMemory(id) {
        // 一律走 store 的删除方法：B8-1 之后「情节变了」必须过索引世代号，
        // 直接在数组上 splice 会留下已删文档的词项（df 虚高 → 相关度排序悄悄错）
        if (this.store.removeFact(id)) {
            this.store.scheduleSave();
            return 'fact';
        }
        if (this.store.removeEpisode(id)) {
            this.store.scheduleSave();
            return 'episode';
        }
        return null;
    }

    // ==================== 生命周期 ====================

    /** 全清（「完全重置」语义）；在途事实提取作废，立即落盘 */
    clearMemory() {
        this.store.clearAll();
        this._pendingTurns = [];
        this._recentSharedIds.clear();
        this._extractGeneration++;
        this.store.flush();
    }

    /** 把去抖中的待写数据立即落盘（进程退出前必须调用） */
    flush() {
        this.store.flush();
    }
}

export default Memory;
