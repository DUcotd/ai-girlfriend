/**
 * 加分疲劳 —— 纯函数模块（PRD P0-c）。
 *
 * 背景：重构前「近 24h 加分疲劳」的裁窗 / 计数 / push 时间戳业务逻辑内联在
 * AiGirlfriend._finalize()，与编排耦合、无法单测。这里抽成三个无副作用纯函数，
 * 规则本体不读时间、不读文件，时间由调用方注入。
 *
 * 语义（与现实对齐）：好感不会连续快速地涨——
 *   近 24h 内已涨过 0 次 → 原值；1~2 次 → 减半（四舍五入）；≥3 次 → 归零。
 */

/**
 * 裁掉 windowMs 之前的事件，返回**新数组**（不改入参）。
 * @param {number[]} events 时间戳数组（epoch ms）
 * @param {number} now 当前时间
 * @param {number} windowMs 有效窗口
 * @returns {number[]}
 */
export function pruneGainEvents(events, now, windowMs) {
    if (!Array.isArray(events)) return [];
    return events.filter((t) => typeof t === 'number' && now - t < windowMs);
}

/**
 * 追加一个时间戳，返回**新数组**（不改入参）。
 * @param {number[]} events
 * @param {number} now
 * @returns {number[]}
 */
export function recordGain(events, now) {
    const base = Array.isArray(events) ? events : [];
    return [...base, now];
}

/**
 * 24h 疲劳：count>=3 → 0；count 1~2 → Math.round(change*0.5)；count 0 → 原值。
 * @param {number} change 当前（正向）变化
 * @param {number} recentPositiveCount 近 24h 已生效正增长次数
 * @returns {{ change: number, applied: boolean }} applied 表示是否走了疲劳削减分支
 */
export function applyGainFatigue(change, recentPositiveCount) {
    const count = Number.isFinite(recentPositiveCount) ? recentPositiveCount : 0;
    if (count <= 0) return { change, applied: false };
    if (count >= 3) return { change: 0, applied: true };
    return { change: Math.round(change * 0.5), applied: true };
}
