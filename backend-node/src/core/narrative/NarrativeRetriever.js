/**
 * NarrativeRetriever - 关系叙事检索层（REQ-03，检索 + 纪念日 + 随机故事）。
 *
 * 定位（docs/companion-upgrade/02-architecture.md REQ-03 §2.3.3）：
 *   - getRelevantNarratives(query, topK)：语义/关键词双模检索（复用 EmbeddingClient + textSim），
 *     供 _prepare() 注入 [我们的故事] 段使用。
 *   - getUpcomingAnniversaries(now, withinDays)：返回即将到来的纪念日（REQ-04 触发源）。
 *   - getRandomStory(excludeRecentN)：供主动消息「主动回顾共同经历」用（升级 memory_share）。
 *
 * 双模设计（与 MemoryRetriever 同思路，但此处刻意轻量）：
 *   嵌入可用时用余弦相似度入选；不可用（无 Key / 调用失败）时退化为关键词命中 + 重要度/新近加权。
 *   叙事池通常只有几十条，全量打分成本可忽略，无需索引。
 */
import { config } from '../../config.js';
import { EmbeddingClient } from '../memory/EmbeddingClient.js';
import { tokenize, normalizeText } from '../memory/textSim.js';

/** 从叙事文本里取检索用的拼接文本（title + summary + tags）。 */
function narrativeText(n) {
    const parts = [n.title, n.summary, ...(Array.isArray(n.tags) ? n.tags : [])];
    return parts.filter(Boolean).join(' ');
}

/**
 * 将 MM-DD 解析为「当年的月/日」数值（便于与 now 比较），非法返回 null。
 * @param {string} mmdd
 * @returns {{month:number, day:number}|null}
 */
export function parseMonthDay(mmdd) {
    const m = /^(\d{2})-(\d{2})$/.exec(String(mmdd || ''));
    if (!m) return null;
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { month, day };
}

/**
 * 计算「下一个 MM-DD 纪念日」距离 now 的天数；once 类型返回 null（不重复）。
 * @param {object} narrative
 * @param {Date} now
 * @returns {number|null} 天数（>=0）；非年度/月度循环或日期非法返回 null
 */
export function daysUntilAnniversary(narrative, now) {
    const rec = narrative?.recurring;
    if (!rec || !rec.isAnniversary) return null;
    if (rec.anniversaryType === 'once') return null;
    const md = parseMonthDay(rec.anniversaryDate);
    if (!md) return null;

    const year = now.getFullYear();
    // 年度循环：每年同一 MM-DD；按月循环用月度近似（把 MM-DD 的 DD 当每月日）
    let target;
    if (rec.anniversaryType === 'monthly') {
        // 每月循环：用当前月的 day（不足则该月最后一天）
        const thisMonth = new Date(year, now.getMonth(), Math.min(md.day, 28));
        if (thisMonth.getTime() >= startOfDay(now).getTime()) {
            target = thisMonth;
        } else {
            target = new Date(year, now.getMonth() + 1, Math.min(md.day, 28));
        }
    } else {
        const thisYear = new Date(year, md.month - 1, md.day);
        target = thisYear.getTime() >= startOfDay(now).getTime()
            ? thisYear
            : new Date(year + 1, md.month - 1, md.day);
    }

    const diffMs = startOfDay(target).getTime() - startOfDay(now).getTime();
    return Math.round(diffMs / (24 * 60 * 60 * 1000));
}

/** 当日零点（消除时分秒对天数计算的影响）。 */
function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export class NarrativeRetriever {
    /**
     * @param {object} opts
     * @param {import('./NarrativeStore.js').NarrativeStore} opts.store
     * @param {EmbeddingClient} [opts.embedding] 可缺省——缺省时强制走关键词路径
     */
    constructor({ store, embedding = null } = {}) {
        this.store = store;
        this.embedding = embedding;
    }

    // ==================== 相关叙事检索（注入用） ====================

    /**
     * 按 query 取最相关的 topK 条叙事。
     * 语义模式：query 嵌入与叙事嵌入（无嵌入的叙事走关键词兜底）余弦相似，超阈值入选；
     * 关键词模式（无嵌入）：query 词项与叙事文本的词项命中数 + 重要度/新近加权打分。
     * 任何异常都返回空数组（调用方据此整段省略，绝不拖垮主链路）。
     *
     * @param {string} query
     * @param {number} [topK]
     * @returns {Promise<Array>} 命中的叙事（原始对象，注入时由 prompt 层截断）
     */
    async getRelevantNarratives(query, topK = config.narrative.injectTopK) {
        const pool = this.store?.narratives || [];
        if (pool.length === 0) return [];

        try {
            const queryEmbedding = this.embedding ? await this.embedding.embed(query) : null;
            if (queryEmbedding) {
                return this._semanticSearch(query, queryEmbedding, topK);
            }
            return this._keywordSearch(query, topK);
        } catch (e) {
            console.error(`[Narrative] getRelevantNarratives failed: ${e.message}`);
            return [];
        }
    }

    /** 语义检索：余弦超阈值入选，按相似度 + 重要度微调排序。 */
    _semanticSearch(query, queryEmbedding, topK) {
        const threshold = config.narrative.semanticThreshold;
        const scored = [];
        for (const n of this.store.narratives) {
            let score = 0;
            if (n.embedding) {
                score = EmbeddingClient.cosineSimilarity(queryEmbedding, n.embedding);
            } else {
                // 该条无嵌入（历史遗留 / 嵌入失败）→ 退化为关键词贡献
                score = this._keywordScore(query, n) * 0.5;
            }
            if (score >= threshold) {
                scored.push({ n, score: score + n.importance * 0.01 });
            }
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, Math.max(0, topK)).map((s) => s.n);
    }

    /** 关键词检索：命中词项数为主，重要度 + 新近微调。 */
    _keywordSearch(query, topK) {
        const minHits = config.narrative.keywordMinHits;
        const scored = [];
        for (const n of this.store.narratives) {
            const hits = this._keywordHits(query, n);
            if (hits >= minHits) {
                scored.push({ n, score: hits + this._keywordScore(query, n) });
            }
        }
        // 命中相同（常见于短 query）时，以重要度→新近兜底排序，保证注入优先给重要事件
        scored.sort((a, b) =>
            (b.score - a.score)
            || (b.n.importance - a.n.importance)
            || (b.n.occurredAt - a.n.occurredAt)
        );
        return scored.slice(0, Math.max(0, topK)).map((s) => s.n);
    }

    /** query 词项在叙事文本里的命中数。 */
    _keywordHits(query, n) {
        const terms = tokenize(query);
        if (terms.length === 0) return 0;
        const norm = normalizeText(narrativeText(n));
        let hits = 0;
        for (const t of terms) {
            if (norm.includes(t)) hits++;
        }
        return hits;
    }

    /** 关键词辅助分：命中率 + 重要度 + 新近（0~1 量级，仅做二次排序）。 */
    _keywordScore(query, n) {
        const terms = tokenize(query);
        if (terms.length === 0) return 0;
        const hitRatio = this._keywordHits(query, n) / terms.length;
        const importancePart = (n.importance || 3) / 5 * 0.3;
        return hitRatio + importancePart;
    }

    // ==================== 纪念日查询（REQ-04 触发源） ====================

    /**
     * 取出未来 withinDays 天内的纪念日（按临近天数升序）。
     * 无 recurring / 非纪念日 / once 类型一律排除。
     *
     * @param {Date} [now]
     * @param {number} [withinDays]
     * @returns {Array<{narrative:object, daysUntil:number}>}
     */
    getUpcomingAnniversaries(now = new Date(), withinDays = config.narrative.anniversaryWithinDays) {
        const pool = this.store?.narratives || [];
        const result = [];
        for (const n of pool) {
            const daysUntil = daysUntilAnniversary(n, now);
            if (daysUntil === null) continue;
            if (daysUntil <= withinDays) {
                result.push({ narrative: n, daysUntil });
            }
        }
        result.sort((a, b) => a.daysUntil - b.daysUntil);
        return result;
    }

    // ==================== 随机故事（主动回顾） ====================

    /**
     * 从较早的叙事里随机挑一条（避开最近 excludeRecentN 条与最近已回顾的），供主动消息使用。
     * 与 Memory.getRandomMemory 同思路，但作用于叙事池；优先挑 recallCount 低的。
     *
     * @param {number} [excludeRecentN]
     * @returns {object|null}
     */
    getRandomStory(excludeRecentN = 5) {
        const pool = [...(this.store?.narratives || [])]
            .sort((a, b) => a.occurredAt - b.occurredAt);
        if (pool.length === 0) return null;

        const cutoff = Math.max(1, pool.length - excludeRecentN);
        const older = pool.slice(0, cutoff);
        const candidates = older.length > 0 ? older : pool;

        // 优先 recallCount 最少的一批，避免反复复读同一件事
        const minRecall = Math.min(...candidates.map((n) => n.recallCount || 0));
        const leastRecalled = candidates.filter((n) => (n.recallCount || 0) === minRecall);
        const pick = leastRecalled[Math.floor(Math.random() * leastRecalled.length)];
        return pick || null;
    }
}

export default NarrativeRetriever;
