/** 单条规则最多保留的命中时间戳数。 */
const MAX_HITS_PER_RULE = 50;

/**
 * 裁掉滚动窗口之外的规则命中时间戳，返回新对象且不修改入参。
 * @param {Record<string, number[]>} hits 规则命中表
 * @param {number} now 当前 epoch 毫秒
 * @param {number} windowMs 有效窗口毫秒数
 * @returns {Record<string, number[]>}
 */
export function pruneRuleHits(hits, now, windowMs) {
    if (!hits || typeof hits !== 'object' || Array.isArray(hits)) return {};
    const safeNow = Number.isFinite(now) ? now : 0;
    const safeWindow = Number.isFinite(windowMs) && windowMs >= 0 ? windowMs : 0;
    const next = {};

    for (const [ruleId, timestamps] of Object.entries(hits)) {
        if (!Array.isArray(timestamps)) continue;
        const kept = timestamps
            .filter((timestamp) => Number.isFinite(timestamp)
                && safeNow - timestamp >= 0
                && safeNow - timestamp < safeWindow)
            .slice(-MAX_HITS_PER_RULE);
        if (kept.length > 0) next[ruleId] = kept;
    }
    return next;
}

/**
 * 记录一次规则命中，返回新对象且不修改入参。
 * @param {Record<string, number[]>} hits 规则命中表
 * @param {string} ruleId 规则 ID
 * @param {number} now 当前 epoch 毫秒
 * @returns {Record<string, number[]>}
 */
export function recordRuleHit(hits, ruleId, now) {
    const next = {};
    if (hits && typeof hits === 'object' && !Array.isArray(hits)) {
        for (const [key, timestamps] of Object.entries(hits)) {
            next[key] = Array.isArray(timestamps) ? [...timestamps] : [];
        }
    }
    if (typeof ruleId !== 'string' || !ruleId || !Number.isFinite(now)) return next;
    next[ruleId] = [...(next[ruleId] || []), now].slice(-MAX_HITS_PER_RULE);
    return next;
}

/**
 * 按本次命中前的近 24h 次数计算规则疲劳系数。
 * @param {number} count 本次之前的命中次数
 * @returns {number}
 */
export function fatigueMultiplier(count) {
    const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (safeCount === 0) return 1.0;
    if (safeCount === 1) return 0.6;
    return 0.3;
}
