/**
 * emotionResonance.js - 情绪共振（REQ-02 的地基，纯函数、无 IO）。
 *
 * 解决的问题（docs/companion-upgrade/PRD.md REQ-02、docs/full-audit/01-analysis.md PROMPT-04/CORE-14）：
 *   用户情绪通道（REQ-01）已经能**读出**他此刻的情绪，但那份读数只进了 prompt 文本，
 *   她自己的 PAD 完全不受影响 —— 于是「知道他难过，但她一点都不难过」。
 *   共振要做的是：他的情绪**改变她的情绪**，而且改变多少取决于他们有多熟。
 *
 * 三条设计约束：
 * 1. **阶段调制**：陌生人阶段他的情绪不该牵动她（factor=0），恋人阶段全盘接住。
 *    这与 relationshipStages.js 的阶段口径一致，PRD Q1 无论怎么拍板都成立。
 * 2. **只走数值通道**：共振量由用户的 valence/arousal/intensity 三个连续量算出，
 *    不看她的情绪标签（标签是 PAD 的派生结果，反向喂回去等于自我强化）。
 * 3. **叠加而不是混合**：她自己的遭遇（词表 + 模型两路）与「因他而起的感受」是两个
 *    独立成因，加权平均会互相稀释；所以共振项**加**在混合结果之上，再统一裁剪到
 *    单轮总上限（守住审计 CORE-05 的不变量：任何一轮都不能把 PAD 拉满）。
 *
 * 关闭态安全：`cfg.enabled=false` 或用户情绪无信号时一律返回 null，
 * `combineWithResonance()` 原样返回入参，逐轴与改造前完全一致。
 */
import { toFiniteNumber, normalizeDelta, PAD_AXES } from './emotionDelta.js';

/**
 * 关系阶段 → 共振系数（0~1，唯一事实源）。
 * 陌生阶段严格为 0：还不认识他，他的情绪与她无关。
 */
export const RESONANCE_STAGE_FACTOR = Object.freeze({
    stranger: 0,
    acquaintance: 0.3,
    friend: 0.6,
    close: 0.85,
    lover: 1,
});

/**
 * 计算本轮的共振增量。
 *
 * @param {object|null} userEmotion 用户情绪（fuse() 的结果或 UserEmotionEngine.state）
 *        需要数值型 valence / arousal / intensity
 * @param {string} stage 当前关系阶段名（取自 relationshipStages.js）
 * @param {object} cfg config.emotion.resonance
 * @returns {{P:number,A:number,D:number}|null} 无信号/未启用/陌生阶段 → null
 */
export function computeResonanceDelta(userEmotion, stage, cfg = {}) {
    if (!cfg.enabled) return null;

    const factor = RESONANCE_STAGE_FACTOR[stage];
    if (typeof factor !== 'number' || factor <= 0) return null;

    const valence = toFiniteNumber(userEmotion?.valence);
    const arousal = toFiniteNumber(userEmotion?.arousal);
    const intensity = toFiniteNumber(userEmotion?.intensity);
    if (valence === null || arousal === null || intensity === null) return null;
    if (intensity < cfg.minIntensity) return null;      // 太淡的情绪不值得被接住

    // 共振幅度：越熟 × 他的情绪越浓 × 全局强度
    const amp = cfg.strength * factor * intensity;
    const down = Math.max(0, -valence);                // 他往下的那部分

    const raw = {
        // 情绪传染：效价同向（他难过她也跟着沉，他开心她也亮起来）
        P: amp * valence,
        // 唤醒两条来源：他的激动直接传染 + 他低落时她的担心（担心本身是高唤醒的）
        A: amp * (cfg.arousalContagion * arousal + cfg.concernArousal * down),
        // 他低落时她放低姿态（D 下移），这与 TIER_PAD 里亲密阶段 D 为负是同一个方向
        D: amp * (-cfg.yieldD * down),
    };

    // 复用单一真源的逐轴裁剪：共振项自己也不能越过单轴上限
    const { delta } = normalizeDelta(raw, cfg.axisCap);
    const moved = PAD_AXES.some((axis) => delta[axis] !== null && delta[axis] !== 0);
    return moved ? delta : null;
}

/**
 * 把共振项加到已混合的增量上，并按**单轮总上限**再裁一次。
 *
 * 空轴（null）不参与加法：某一轴两路都没说话时，只有共振说话就只用共振，
 * 不会因为"混合"凭空产生一个本来不存在的位移。
 *
 * @param {object} delta 已混合的 her-PAD 增量（可为 null 轴结构）
 * @param {object|null} resonance computeResonanceDelta() 的结果
 * @param {{P:number,A:number,D:number}} totalAxisCap 单轮每轴总上限
 * @returns {{delta:object, applied:boolean, clipped:boolean}}
 */
export function combineWithResonance(delta, resonance, totalAxisCap) {
    const base = { P: null, A: null, D: null, ...(delta || {}) };
    if (!resonance) {
        return { delta: base, applied: false, clipped: false };
    }
    const summed = { P: null, A: null, D: null };
    for (const axis of PAD_AXES) {
        const b = typeof base[axis] === 'number' && Number.isFinite(base[axis]) ? base[axis] : null;
        const r = typeof resonance[axis] === 'number' && Number.isFinite(resonance[axis]) ? resonance[axis] : null;
        if (b === null && r === null) continue;
        summed[axis] = (b ?? 0) + (r ?? 0);
    }
    const { delta: clamped, clipped } = normalizeDelta(summed, totalAxisCap);
    return { delta: clamped, applied: true, clipped };
}
