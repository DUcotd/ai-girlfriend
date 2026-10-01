/**
 * KeywordScorer - 方案 B 检索器：不依赖嵌入模型的关键词检索。
 *
 * 打分是 BM25 风格（而非旧版的朴素命中计数）：
 *   score = Σ_term idf(t) · tf·(k1+1) / (tf + k1·(1-b+b·dl/avgdl))
 * 命中词项数必须 ≥ minHits 才入选（中日韩 bigram 单词项命中的噪音太大），
 * 再叠加 recency 加分后参与统一排序。
 */
import { tokenize, jaccardSimilarity } from './textSim.js';

const K1 = 1.2;
const B = 0.75;

/**
 * 对情节库做关键词打分。
 *
 * @param {object} opts
 * @param {Array} opts.episodes 记忆条目（{id, text, timestamp, ...}）
 * @param {string} opts.query 查询文本
 * @param {number} opts.minHits 最少命中词项数
 * @param {number} opts.recencyWeight recency 加分上限
 * @param {number} opts.recencyHalfLifeDays recency 半衰期（天）
 * @returns {Array<{id, text, score, baseScore, hits}>} 按 score 降序
 */
export function scoreEpisodes({ episodes, query, minHits, recencyWeight, recencyHalfLifeDays }) {
    const terms = tokenize(query);
    if (terms.length === 0) return [];

    const nowSec = Date.now() / 1000;
    const halfLifeSec = recencyHalfLifeDays * 86400;

    // 语料统计：文档长度与查询词的文档频率（BM25 两要素）
    const docs = episodes.map((ep) => {
        const docTerms = tokenize(ep.text);
        return { ep, docTerms, dl: docTerms.length };
    });
    const avgdl = docs.reduce((s, d) => s + d.dl, 0) / (docs.length || 1) || 1;

    const results = [];
    for (const { ep, docTerms, dl } of docs) {
        let baseScore = 0;
        let hits = 0;
        for (const term of terms) {
            const tf = docTerms.filter((t) => t === term).length;
            if (tf === 0) continue;
            hits++;
            const df = docs.filter((d) => d.docTerms.includes(term)).length;
            const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
            baseScore += idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (dl / avgdl)));
        }
        if (hits < minHits) continue;

        // baseScore 按本次查询的理论峰值归一（top=1），与语义模式的 0~1 分数量纲对齐
        const maxIdf = Math.log(1 + docs.length); // df=0 时的 idf 上界
        const baseNormalized = Math.min(1, baseScore / (maxIdf * terms.length));
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
