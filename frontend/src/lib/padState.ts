/**
 * PAD 状态的读取归一（FE-11）。
 *
 * `emotionalState` 来自后端，也可能是 localStorage 镜像 / 旧版本 payload /
 * 后端重启前的半成品响应。以前组件直接 `const { P, A, D } = emotionalState.current`，
 * 缺一个字段就是 `undefined.toFixed()` **整页白屏** —— 一个展示用的数字不该有这个威力。
 * 这里统一读成有限数字，缺省回落 0（0 是「中性」，也是引擎的初始值）。
 */

export interface PadAxis {
    P: number;
    A: number;
    D: number;
}

const AXIS_KEYS = ["P", "A", "D"] as const;

function finiteNumber(value: unknown, fallback = 0): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 从任意形状里安全取出一组 PAD 轴值（非对象 / 缺字段 / NaN 全部回落 0） */
export function readPadAxes(source: unknown): PadAxis {
    const src = (source ?? {}) as Record<string, unknown>;
    const out: PadAxis = { P: 0, A: 0, D: 0 };
    for (const key of AXIS_KEYS) out[key] = finiteNumber(src[key]);
    return out;
}

/** 情绪时间线（REQ-10）之类的一段序列：脏值条目直接丢，不让一个 null 打断整条线 */
export function readAxisSeries(
    entries: unknown,
    key: (typeof AXIS_KEYS)[number]
): { t: number; value: number }[] {
    if (!Array.isArray(entries)) return [];
    const out: { t: number; value: number }[] = [];
    for (const raw of entries) {
        if (!raw || typeof raw !== "object") continue;
        const item = raw as Record<string, unknown>;
        const t = item.t ?? item.time ?? item.timestamp;
        if (typeof t !== "number" || !Number.isFinite(t)) continue;
        // 每一点可以带整组 PAD，也可以只带该轴的值
        const pad = (item.P !== undefined || item.A !== undefined || item.D !== undefined)
            ? item
            : (item.pad ?? item.axes ?? item.state);
        out.push({ t, value: readPadAxes(pad)[key] });
    }
    return out;
}
