/**
 * 情绪增量的纯函数工具（无 IO、无 Date.now()，时间/配置由调用方注入）。
 *
 * 为什么单独成文件：`<metadata>.emotion_delta` 是模型自己写的自由 JSON，
 * 而 PAD 状态同时驱动「关系风格、主动消息情绪闸门、记忆情绪染色」三条链路。
 * 审计 CORE-05 / CORE-13 实测：
 *   - 词表通道有逐轴裁剪（P±0.5 / A±0.4 / D±0.3），LLM 通道**一点裁剪都没有**：
 *     模型给 `{"P":-5}` 就能单轮把 P 砸到 −1.0，直接 trip ghosting；
 *   - 词表与 LLM 两条 delta 在同一轮里被**先后各 apply 一次**，
 *     同一个情绪事件按约 2 倍幅度落地。
 * 这里把「强类型 + 逐轴裁剪 + 加权混合」收敛成一处，方便单测锁死。
 */

export const PAD_AXES = ['P', 'A', 'D'];

/** 单个数值强转：只接受真数字与「看起来是数字」的字符串；null/布尔/空串/NaN → null */
export function toFiniteNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string') {
        const trimmed = v.trim().replace(/^\+/, '').replace(/−/g, '-');   // 兼容全角负号
        if (!trimmed) return null;
        const n = Number(trimmed);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

/**
 * 把任意来源的 PAD 增量规整成 `{P,A,D}`（缺轴为 null）并逐轴裁剪到 ±cap。
 * @param {object|null} raw 模型或词表给的 delta
 * @param {number|{P?:number,A?:number,D?:number}} cap 每轴上限（默认三轴同值）
 * @returns {{delta: {P: number|null, A: number|null, D: number|null}, clipped: boolean, rejected: string[]}}
 */
export function normalizeDelta(raw, cap = 0.5) {
    const delta = { P: null, A: null, D: null };
    const rejected = [];
    let clipped = false;
    if (!raw || typeof raw !== 'object') {
        return { delta, clipped, rejected: ['not-an-object'] };
    }
    for (const axis of PAD_AXES) {
        if (!(axis in raw)) continue;                 // 没写这一轴就是没有，不当 0 用
        const n = toFiniteNumber(raw[axis]);
        if (n === null) { rejected.push(`${axis}=${JSON.stringify(raw[axis])}`); continue; }
        const limit = typeof cap === 'number' ? cap : (cap?.[axis] ?? 0.5);
        const clamped = Math.max(-limit, Math.min(limit, n));
        if (clamped !== n) clipped = true;
        delta[axis] = clamped;
    }
    return { delta, clipped, rejected };
}

/**
 * 加权混合两路 delta，**按在场通道的权重归一化**：
 *   out[axis] = (auto*kw + llm*lw) / (在场通道的权重和)
 *
 * 关键点是混合而不是叠加：同一条「我今天好难过」被词表和模型各判一次负向，
 * 叠加等于把一次事件记成两次（审计 CORE-13）。
 * 而归一化保证「只有一路说话时，那一路按原幅度生效」——模型没回 emotion_delta
 * 时不该把词表判定打个对折（那等于让她的表情比她的感受更淡）。
 * 与 UserEmotionEngine.fuse() 用的是同一套归一化口径。
 * @returns {{delta: {P: number|null, A: number|null, D: number|null}}}
 */
export function blendDeltas(auto, llm, { keywordWeight = 0.5, llmWeight = 0.5 } = {}) {
    const out = { P: null, A: null, D: null };
    for (const axis of PAD_AXES) {
        const a = auto?.[axis];
        const l = llm?.[axis];
        const kw = (typeof a === 'number' && Number.isFinite(a)) ? keywordWeight : 0;
        const lw = (typeof l === 'number' && Number.isFinite(l)) ? llmWeight : 0;
        const total = kw + lw;
        if (!total) continue;                       // 这一轴两路都没说话：不产生位移
        out[axis] = ((a ?? 0) * kw + (l ?? 0) * lw) / total;
    }
    return { delta: out };
}

/** 好感度/情绪里最常见的模型失误：把数字写成字符串。统一强转，失败时给出可见原因 */
export function coerceAffinityChange(raw) {
    if (raw === undefined || raw === null) return { value: 0, rejected: false };
    const n = toFiniteNumber(raw);
    if (n === null) return { value: 0, rejected: true, reason: `affinity_change=${JSON.stringify(raw)}` };
    return { value: n, rejected: false };
}
