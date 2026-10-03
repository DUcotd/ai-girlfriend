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
import { MemoryStore } from './memory/MemoryStore.js';
import { EmbeddingClient } from './memory/EmbeddingClient.js';
import { MemoryRetriever } from './memory/MemoryRetriever.js';
import { FactExtractor, clampImportance, normalizeCategory } from './memory/FactExtractor.js';
import { isNearDuplicateText } from './memory/KeywordScorer.js';

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
     */
    async recordTurn(userInput, replyText, { emotionSnapshot = null } = {}) {
        const generation = this._extractGeneration;
        const text = `User: ${userInput}\nXiao Ai: ${replyText}`;
        await this._addEpisode(text, emotionSnapshot, generation);
        this._scheduleFactExtraction(userInput, replyText);
    }

    async _addEpisode(text, emotionSnapshot, generation = this._extractGeneration) {
        const embedding = await this.embedding.embed(text);
        // 嵌入是网络等待，期间可能发生过 clearMemory/resetAll：作废这次写入，
        // 否则被删掉的情节会在重置之后复活。
        if (generation !== this._extractGeneration) {
            console.log('[Memory] Episode write skipped (记忆在等待期间被清空)');
            return;
        }

        // 写入去重：与既有情节近重复的直接丢弃（防复读对话刷库）。
        // 有新向量用余弦判定；无向量（关键词模式 / 嵌入失败）退化为文本 Jaccard。
        const threshold = config.memory.dedupWriteSimilarity;
        const isDup = embedding
            ? this.store.episodes.some((e) =>
                e.embedding && EmbeddingClient.cosineSimilarity(embedding, e.embedding) > threshold)
            : this.store.episodes.some((e) => isNearDuplicateText(text, e.text, threshold));
        if (isDup) {
            console.log('[Memory] Episode skipped (near-duplicate of existing)');
            return;
        }

        this.store.addEpisode({
            text,
            embedding,
            embeddingModel: embedding ? this.embedding.model : null,
            emotionSnapshot,
        });
        this.store.scheduleSave();
    }

    /** 事实提取串行队列：提取与应用不并发，避免两轮提取交叉写事实库 */
    _scheduleFactExtraction(userInput, replyText) {
        if (!config.memory.facts.enabled || !this._getChatClient) return;

        const generation = this._extractGeneration;
        this._extractQueue = this._extractQueue
            .then(async () => {
                // 期间记忆被清空 → 本轮提取作废（防清空后残留事实复活）
                if (generation !== this._extractGeneration) return;
                const ops = await this.factExtractor.extractOps(userInput, replyText, this.store.facts);
                const changed = ops.add.length + ops.update.length + ops.delete.length;
                if (changed === 0 || generation !== this._extractGeneration) return;
                await this._applyFactOps(ops, generation);
                console.log(`[Memory] Facts: +${ops.add.length} ~${ops.update.length} -${ops.delete.length}`);
            })
            .catch((e) => console.error(`[Memory] fact extraction failed: ${e.message}`));
    }

    async _applyFactOps(ops, generation = this._extractGeneration) {
        const now = Date.now() / 1000;
        /** 每次 await 之后都要重新确认世代：清空可能落在任意两次嵌入之间 */
        const stale = () => generation !== this._extractGeneration;

        for (const id of ops.delete) {
            const idx = this.store.facts.findIndex((f) => f.id === id);
            if (idx !== -1) this.store.facts.splice(idx, 1);
        }

        for (const upd of ops.update) {
            if (stale()) return;
            const fact = this.store.facts.find((f) => f.id === upd.id);
            if (!fact) continue;
            const content = upd.content.trim();
            if (content !== fact.content) {
                fact.content = content;
                const embedding = await this.embedding.embed(content);
                if (stale()) return;
                if (embedding) {
                    fact.embedding = embedding;
                    fact.embeddingModel = this.embedding.model;
                }
            }
            if (upd.importance !== undefined) fact.importance = clampImportance(upd.importance);
            if (upd.category !== undefined) fact.category = normalizeCategory(upd.category);
            fact.updatedAt = now;
        }

        for (const add of ops.add) {
            if (stale()) return;
            const content = add.content.trim();
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
     * 构建注入 prompt 的记忆上下文：[已知事实]（重要度常驻）+ [相关回忆]（语义/关键词检索）。
     * 无可注入内容时返回空串（调用方据此整段省略）。
     */
    async buildMemoryContext(query, currentEmotion = null) {
        const factsText = this._formatFactsForInjection();
        let episodesText = '';
        try {
            const hits = await this.retriever.retrieve(query, currentEmotion);
            if (hits.length > 0) {
                episodesText = hits.map((h) => `- ${h.text}`).join('\n');
            }
        } catch (e) {
            console.error(`[Memory] retrieve failed: ${e.message}`);
        }
        if (!factsText && !episodesText) return '';

        const sections = [];
        if (factsText) sections.push(`[已知事实]\n${factsText}`);
        if (episodesText) sections.push(`[相关回忆]\n${episodesText}`);
        return sections.join('\n\n');
    }

    /** 事实注入：按重要度→最新排序取 top-N（不依赖嵌入，重启后即生效） */
    _formatFactsForInjection() {
        if (!config.memory.facts.enabled || this.store.facts.length === 0) return '';
        const top = [...this.store.facts]
            .sort((a, b) => (b.importance - a.importance) || (b.updatedAt - a.updatedAt))
            .slice(0, config.memory.facts.injectTopN);
        return top.map((f) => `- ${f.content}`).join('\n');
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
        const trimmed = String(content || '').trim();
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
            const trimmed = String(content).trim();
            if (trimmed && trimmed !== fact.content) {
                fact.content = trimmed;
                const embedding = await this.embedding.embed(trimmed);
                if (embedding) {
                    fact.embedding = embedding;
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
        const factIdx = this.store.facts.findIndex((f) => f.id === id);
        if (factIdx !== -1) {
            this.store.facts.splice(factIdx, 1);
            this.store.scheduleSave();
            return 'fact';
        }
        const epIdx = this.store.episodes.findIndex((e) => e.id === id);
        if (epIdx !== -1) {
            this.store.episodes.splice(epIdx, 1);
            this.store.scheduleSave();
            return 'episode';
        }
        return null;
    }

    // ==================== 生命周期 ====================

    /** 全清（「完全重置」语义）；在途事实提取作废，立即落盘 */
    clearMemory() {
        this.store.episodes = [];
        this.store.facts = [];
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
