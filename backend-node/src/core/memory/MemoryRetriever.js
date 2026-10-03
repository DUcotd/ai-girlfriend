/**
 * MemoryRetriever - 检索调度层：按配置把查询分派到语义模式（方案 A）
 * 或关键词模式（方案 B），并做统一后处理（阈值过滤 → 打分排序 → 去重 → 取 top-K）。
 *
 * 模式解析（config.memory.retrieval.mode）：
 *   'embedding' —— 强制语义；嵌入客户端不可用时一次性警告后退关键词
 *   'keyword'   —— 强制关键词
 *   'auto'      —— 有可用客户端且库里有向量 → 语义，否则关键词
 */
import { config } from '../../config.js';
import { EmbeddingClient } from './EmbeddingClient.js';
import { scoreEpisodes, isNearDuplicateText } from './KeywordScorer.js';

export class MemoryRetriever {
    /**
     * @param {object} opts
     * @param {import('./MemoryStore.js').MemoryStore} opts.store
     * @param {EmbeddingClient} opts.embedding
     */
    constructor({ store, embedding }) {
        this.store = store;
        this.embedding = embedding;
        this._warnedNoEmbedding = false;
        this._warnedStaleModels = false;
    }

    /** 实际生效的检索模式（供 /config/status 与调试日志） */
    resolveMode() {
        const mode = config.memory.retrieval.mode;
        if (mode === 'keyword') return 'keyword';
        if (mode === 'embedding') return 'embedding';
        // auto：嵌入客户端可用且库里至少有一条向量，语义检索才有意义
        const hasVectors = this.store.episodes.some((e) => e.embedding);
        return this.embedding.available && hasVectors ? 'embedding' : 'keyword';
    }

    /**
     * 检索相关情节，返回 [{id, text, score}]（≤topK，按得分降序）。
     *
     * @param {string} query 当前用户输入
     * @param {object|null} currentEmotion 当前 PAD 情绪状态（{P,A,D}）
     */
    async retrieve(query, currentEmotion = null, topK = config.memory.retrieval.topK) {
        if (!this.store.episodes.length || !query || !query.trim()) return [];

        let mode = this.resolveMode();
        if (mode === 'embedding' && !this.embedding.available) {
            if (!this._warnedNoEmbedding) {
                this._warnedNoEmbedding = true;
                console.warn('[Memory] retrieval.mode=embedding 但嵌入客户端不可用，退回关键词检索');
            }
            mode = 'keyword';
        }

        let selected = [];
        if (mode === 'embedding') {
            selected = await this._semanticSearch(query, currentEmotion, topK);
            if (selected.length === 0) {
                // 语义无结果（embedding 调用失败或全部低于阈值）→ 关键词兜底。
                // 关键词要求更严的命中数，宁缺毋滥。
                selected = this._keywordSearch(query, topK);
            }
        } else {
            selected = this._keywordSearch(query, topK);
        }

        return this._dedupe(selected, topK);
    }

    /** 候选池大小：去重会丢弃部分入选者，必须超额取候选再回截到 topK */
    static _poolSize(topK) {
        return Math.max(topK * 3, topK + 5);
    }

    /** 方案 A：向量余弦 + 情绪染色 + recency */
    async _semanticSearch(query, currentEmotion, topK) {
        const { semanticThreshold, recencyWeight, recencyHalfLifeDays, emotionWeight, emotionWeightNegative } =
            config.memory.retrieval;

        const queryEmbedding = await this.embedding.embed(query);
        if (!queryEmbedding) return [];

        this._warnStaleModels();

        const nowSec = Date.now() / 1000;
        const halfLifeSec = recencyHalfLifeDays * 86400;
        const eWeight = currentEmotion && currentEmotion.P < 0 ? emotionWeightNegative : emotionWeight;

        const scored = [];
        for (const mem of this.store.episodes) {
            if (!mem.embedding) continue;
            const semanticScore = EmbeddingClient.cosineSimilarity(queryEmbedding, mem.embedding);
            // 阈值含边界（与 NarrativeRetriever 的 `>= threshold` 同一把尺子）：
            // 两处一个用 > 一个用 >= 会让「同一套语义门槛」在不同层表现不一致（CORE-15）
            if (semanticScore < semanticThreshold) continue;

            let emotionScore = 0;
            if (currentEmotion && mem.emotionSnapshot) {
                emotionScore = this._emotionSimilarity(currentEmotion, mem.emotionSnapshot);
            }
            const recency = recencyWeight * Math.pow(2, -(nowSec - (mem.timestamp || nowSec)) / halfLifeSec);
            // 排序与过滤用同一把尺子：先按语义门槛过滤，再按综合分排序
            const score = semanticScore + emotionScore * eWeight + recency;
            scored.push({ id: mem.id, text: mem.text, score, semanticScore, embedding: mem.embedding });
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, MemoryRetriever._poolSize(topK));
    }

    /** 方案 B：BM25 风格关键词打分 + recency */
    _keywordSearch(query, topK) {
        const { keywordMinHits, recencyWeight, recencyHalfLifeDays } = config.memory.retrieval;
        return scoreEpisodes({
            episodes: this.store.episodes,
            query,
            minHits: keywordMinHits,
            recencyWeight,
            recencyHalfLifeDays,
        }).slice(0, MemoryRetriever._poolSize(topK));
    }

    /**
     * 入选结果间去重（贪心）：与任一已选条目近重复的候选丢弃，由后续候选递补。
     * 语义结果用向量余弦判定，无向量候选退化为文本 Jaccard。
     */
    _dedupe(selected, topK) {
        const threshold = config.memory.dedupSimilarity;
        const kept = [];
        for (const cand of selected) {
            const dup = kept.some((k) => {
                if (cand.embedding && k.embedding) {
                    return EmbeddingClient.cosineSimilarity(cand.embedding, k.embedding) > threshold;
                }
                return isNearDuplicateText(cand.text, k.text, threshold);
            });
            if (!dup) kept.push(cand);
            if (kept.length >= topK) break;
        }
        return kept;
    }

    /** 换过嵌入模型后旧向量维度不匹配、相似度恒 0——至少给出一条可发现的警告 */
    _warnStaleModels() {
        if (this._warnedStaleModels) return;
        const staleModels = new Set(
            this.store.episodes
                .filter((m) => m.embedding && m.embeddingModel && m.embeddingModel !== this.embedding.model)
                .map((m) => m.embeddingModel)
        );
        if (staleModels.size > 0) {
            this._warnedStaleModels = true;
            console.warn(
                `[Memory] ${staleModels.size} 个旧嵌入模型（${[...staleModels].join(', ')}）生成的历史记忆与当前模型` +
                `（${this.embedding.model}）不兼容，已无法参与语义检索；可清空记忆或换回原模型。`
            );
        }
    }

    /** PAD 三维差值归一相似度（0~1） */
    _emotionSimilarity(e1, e2) {
        if (!e1 || !e2) return 0;
        const pDiff = Math.abs((e1.P || 0) - (e2.P || 0));
        const aDiff = Math.abs((e1.A || 0) - (e2.A || 0));
        const dDiff = Math.abs((e1.D || 0) - (e2.D || 0));
        return 1 - (pDiff + aDiff + dDiff) / 6;
    }
}
