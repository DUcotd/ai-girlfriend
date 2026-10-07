/**
 * KeywordScorer - 方案 B 检索器：不依赖嵌入模型的关键词检索。
 *
 * 打分是 BM25 风格（而非旧版的朴素命中计数）：
 *   score = Σ_term idf(t) · tf·(k1+1) / (tf + k1·(1-b+b·dl/avgdl))
 * 命中词项数必须 ≥ minHits 才入选（中日韩 bigram 单词项命中的噪音太大），
 * 再叠加 recency 加分后参与统一排序。
 *
 * B8-1 之后这一层的形状：
 *   - 分词与 df 来自 KeywordIndex 的**增量索引**（文档没变就不再分词，
 *     见 memory/KeywordIndex.js 顶部说明与审计 CORE-07 的实测数据）；
 *   - idf 在查询层**按词项算一次**，旧写法把它放在文档循环里（每篇 × 每词）；
 *   - 查询词项数截断到 config.memory.retrieval.maxQueryTerms（只截查询、不截文档）。
 * 记忆层与叙事层共用同一个索引与同一套查询预处理（单一事实源）。
 */
import { jaccardSimilarity } from './textSim.js';
import { KeywordIndex } from './KeywordIndex.js';
import { config } from '../../config.js';

const K1 = 1.2;
const B = 0.75;

/**
 * 没显式传索引时的默认索引（按**文档数组身份**各存一份）。
 * 用 WeakMap：数组被丢弃后索引随之可回收，不会变成第二份无界缓存
 * （旧实现的模块级 docCache 按文本内容键，1000 条封顶，改一次文本就多一份）。
 */
const implicitIndexes = new WeakMap();

function resolveIndex(episodes, provided, version) {
    if (provided instanceof KeywordIndex) {
        provided.sync(episodes, { version });
        return provided;
    }
    let idx = implicitIndexes.get(episodes);
    if (!idx) {
        idx = new KeywordIndex('keyword');
        implicitIndexes.set(episodes, idx);
    }
    idx.sync(episodes, { version });
    return idx;
}

/**
 * 查询预处理：切词 + 截断 + 每个词项算一次 idf（记忆/叙事共用）。
 * @param {KeywordIndex} index
 * @param {string} query
 * @param {number} [maxQueryTerms]
 * @returns {Array<{term:string, idf:number}>}
 */
export function prepareKeywordQuery(index, query, maxQueryTerms = config.memory.retrieval.maxQueryTerms) {
    return index.prepareQuery(query, maxQueryTerms, K1);
}

/** 词项在文档中的命中数（文档侧用索引里的词项集，不再重新分词/归一化） */
export function countHits(queryTerms, stats) {
    if (!stats) return 0;
    let hits = 0;
    for (const q of queryTerms) {
        if (stats.counts.has(typeof q === 'string' ? q : q.term)) hits++;
    }
    return hits;
}

/**
 * 对情节库做关键词打分（真 BM25 变体）。
 *
 * @param {object} opts
 * @param {Array} opts.episodes 记忆条目（{id, text, timestamp, ...}）
 * @param {string} opts.query 查询文本
 * @param {number} opts.minHits 最少命中词项数
 * @param {number} opts.recencyWeight recency 加分上限
 * @param {number} opts.recencyHalfLifeDays recency 半衰期（天）
 * @param {KeywordIndex} [opts.index] 该库的增量索引（调用方持有；缺省时按数组身份建一份）
 * @param {number} [opts.indexVersion] 调用方的索引世代号（store 增删情节时自增，走 O(1) 快路径）
 * @param {number} [opts.maxQueryTerms] 查询词项上限（默认 config.memory.retrieval.maxQueryTerms）
 * @returns {Array<{id, text, score, baseScore, hits}>} 按 score 降序
 */
export function scoreEpisodes({
    episodes,
    query,
    minHits,
    recencyWeight,
    recencyHalfLifeDays,
    index = null,
    indexVersion,
    maxQueryTerms = config.memory.retrieval.maxQueryTerms,
}) {
    if (!Array.isArray(episodes) || episodes.length === 0) return [];
    const idx = resolveIndex(episodes, index, indexVersion);
    const terms = prepareKeywordQuery(idx, query, maxQueryTerms);
    if (terms.length === 0) return [];

    const nowSec = Date.now() / 1000;
    const halfLifeSec = recencyHalfLifeDays * 86400;
    const avgdl = idx.avgdl;
    // idf 已经按词项算过一次，这里只需要那个「全部命中满饱和」的理论峰值
    const idfSum = terms.reduce((s, t) => s + t.idf, 0);

    const results = [];
    for (const ep of episodes) {
        const stats = idx.statsOf(String(ep?.id ?? ep?.text ?? ''));
        if (!stats) continue;
        let baseScore = 0;
        let hits = 0;
        for (const { term, idf } of terms) {
            const tf = stats.counts.get(term) || 0;      // 真词频（旧实现恒为 1）
            if (tf === 0) continue;
            hits++;
            baseScore += idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (stats.length / avgdl)));
        }
        if (hits < minHits) continue;

        // 归一到 0~1：分母是「本次命中的那些词全部满饱和」的理论峰值。
        // 旧写法除以 `maxIdf × 查询词数`，把分数压到 1e-4 量级，
        // 于是 0.15 的 recency 加分反而主导排序 —— 召回的是「最近的」而不是「相关的」
        // （审计 CORE-15：[相关回忆] 名不副实）。
        const peak = idfSum * (K1 + 1) || 1;
        const baseNormalized = Math.min(1, baseScore / peak);
        const recency = recencyWeight * Math.pow(2, -(nowSec - (ep.timestamp || nowSec)) / halfLifeSec);

        results.push({
            id: ep.id,
            text: ep.text,
            score: baseNormalized + recency,
            baseScore: baseNormalized,
            hits,
        });
    }

    results.sort((a, b) => b.score - a.score);
    return results;
}

/**
 * 无向量场景的近重复判定：归一化等价 或 bigram Jaccard 超阈值。
 */
export function isNearDuplicateText(textA, textB, threshold) {
    const a = String(textA || '');
    const b = String(textB || '');
    if (a === b) return true;
    return jaccardSimilarity(a, b) > threshold;
}

export { KeywordIndex };
