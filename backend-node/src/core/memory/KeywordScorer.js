/**
 * KeywordScorer - 方案 B 检索器：不依赖嵌入模型的关键词检索。
 *
 * 打分是 BM25 风格（而非旧版的朴素命中计数）：
 *   score = Σ_term idf(t) · tf·(k1+1) / (tf + k1·(1-b+b·dl/avgdl))
 * 命中词项数必须 ≥ minHits 才入选（中日韩 bigram 单词项命中的噪音太大），
 * 再叠加 recency 加分后参与统一排序。
 */
import { tokenize, tokenizeToMap, jaccardSimilarity } from './textSim.js';

const K1 = 1.2;
const B = 0.75;

/**
 * 分词结果缓存：按原文缓存词频表与长度。
 *
 * 旧实现每次查询都对整个情节库重新分词（500 条 × 每轮），叠加下面 df 在
 * 「每文档 × 每词」内层重算，构成 O(n²·T) —— 实测 500 条 + 91 词查询要 2.9 秒，
 * 而它是在请求路径上 await 的，等于一条长消息冻结整个进程（审计 CORE-07）。
 * 缓存只在模块内、按文本内容键（不写进 episode 对象，避免污染落盘 JSON）。
 */
const DOC_CACHE_MAX = 2000;
const docCache = new Map();

function docStats(text) {
    const cached = docCache.get(text);
    if (cached) return cached;
    const counts = tokenizeToMap(text);
    let length = 0;
    for (const n of counts.values()) length += n;
    const stats = { counts, length, terms: [...counts.keys()] };
    if (docCache.size >= DOC_CACHE_MAX) {
        // 简单 FIFO 逐旧：分词是纯函数，丢缓存只损失时间不损失正确性
        docCache.delete(docCache.keys().next().value);
    }
    docCache.set(text, stats);
    return stats;
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
 * @returns {Array<{id, text, score, baseScore, hits}>} 按 score 降序
 */
export function scoreEpisodes({ episodes, query, minHits, recencyWeight, recencyHalfLifeDays }) {
    const terms = tokenize(query);
    if (terms.length === 0 || !Array.isArray(episodes) || episodes.length === 0) return [];

    const nowSec = Date.now() / 1000;
    const halfLifeSec = recencyHalfLifeDays * 86400;

    const docs = episodes.map((ep) => {
        const stats = docStats(ep.text || '');
        return { ep, stats };
    });
    const avgdl = docs.reduce((s, d) => s + d.stats.length, 0) / docs.length || 1;

    // df 一次预计算：旧写法在每篇文档的每个词上再 filter 一遍全库（O(n²·T)）
    const df = new Map();
    for (const term of terms) {
        let count = 0;
        for (const { stats } of docs) {
            if (stats.counts.has(term)) count++;
        }
        df.set(term, count);
    }
    const idfOf = (term) => {
        const d = df.get(term) || 0;
        return Math.log(1 + (docs.length - d + 0.5) / (d + 0.5));
    };

    const results = [];
    for (const { ep, stats } of docs) {
        let baseScore = 0;
        let hits = 0;
        let idfSum = 0;
        for (const term of terms) {
            const tf = stats.counts.get(term) || 0;      // 真词频（旧实现恒为 1）
            const idf = idfOf(term);
            idfSum += idf;
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
