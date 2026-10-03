/**
 * 文本相似度工具：切词与去重度量，供关键词检索（方案 B）与写入/检索去重共用。
 *
 * 切词规则（沿用旧版 Memory._queryTerms 的语义）：
 * - ASCII 片段按整词保留（英文/数字）
 * - 其余片段（中日韩）按字符二元组（bigram）切——
 *   否则整句只产生一个「词」，等价于全文精确子串匹配，中文检索基本恒空
 */

/** 归一化：小写、去空白与常见标点，用于等价判断 */
export function normalizeText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/\s+/g, '')
        .replace(/[，。！？、~～…！!?,.:：;；"'（）()\[\]{}<>《》「」『』·—\-]/g, '');
}

/**
 * 检索词切分（**去重**）：用于查询词项集合与命中数统计。
 */
export function tokenize(query) {
    return [...tokenizeToMap(query).keys()];
}

/**
 * 切词并返回词频表（**不去重**的信息保留版）。
 *
 * 为什么单独要一份：BM25 的 tf 项需要重复计数，而 `tokenize` 返回的是 Set 去重结果
 * —— 旧实现拿它算 `tf = docTerms.filter(t => t === term).length` 时 tf 恒为 1，
 * k1/b/avgdl 那套饱和公式形同虚设（审计 CORE-15）。
 * @returns {Map<string, number>}
 */
export function tokenizeToMap(text) {
    const lower = String(text || '').toLowerCase().trim();
    const map = new Map();
    if (!lower) return map;
    // 中英混排：连续 ASCII 片段整词保留，其余片段按 bigram 切
    const segments = lower.split(/([a-z0-9]+)/).filter(Boolean);
    for (const seg of segments) {
        if (/^[a-z0-9]+$/.test(seg)) {
            map.set(seg, (map.get(seg) || 0) + 1);
            continue;
        }
        for (let i = 0; i < seg.length - 1; i++) {
            const gram = seg.slice(i, i + 2);
            map.set(gram, (map.get(gram) || 0) + 1);
        }
    }
    return map;
}

/** 文本的 bigram 集合（去重），用于 Jaccard 相似度 */
export function bigramSet(text) {
    const normalized = normalizeText(text);
    const grams = new Set();
    for (let i = 0; i < normalized.length - 1; i++) {
        grams.add(normalized.slice(i, i + 2));
    }
    // 超短文本（归一化后不足 2 字符）退化为单字符集合，保证非空可比较
    if (grams.size === 0 && normalized.length > 0) {
        grams.add(normalized);
    }
    return grams;
}

/**
 * bigram Jaccard 相似度（0~1）。
 * 语义模式下去重用余弦；无向量场景（关键词模式 / 未嵌入的记忆）用本度量兜底。
 */
export function jaccardSimilarity(a, b) {
    const ga = bigramSet(a);
    const gb = bigramSet(b);
    if (ga.size === 0 || gb.size === 0) return 0;
    let intersection = 0;
    for (const g of ga) {
        if (gb.has(g)) intersection++;
    }
    const union = ga.size + gb.size - intersection;
    return union === 0 ? 0 : intersection / union;
}
