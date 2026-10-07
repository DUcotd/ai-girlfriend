/**
 * 情绪时间线的数据整理（REQ-10）。
 *
 * 后端 `EmotionEngine.history` 一直记着她每次情绪结算的 before/delta/after（上限 50 条），
 * 但**从来没有消费者**——写了没接线的拟人化残件在本项目里的处理方式是接上，不是删掉。
 * 这里把它整理成可以直接画的点，并对脏数据免疫（老版本条目缺字段不能拖垮整条线）。
 */
import { readPadAxes } from "./padState";

export interface EmotionPoint {
    t: number;
    P: number;
    A: number;
    D: number;
}

export interface EmotionTrend {
    /** 近窗相对早窗的 P 轴位移（正=更开心） */
    dP: number;
    dA: number;
    dD: number;
    /** 用于展示的中文一句话；点数不足时为 null（不硬编一句没根据的话） */
    sentence: string | null;
}

const MIN_POINTS_FOR_TREND = 4;

/** 每条历史条目形如 { timestamp, before, delta, after }；缺 after 时退回 before */
export function toEmotionPoints(raw: unknown, limit = 50): EmotionPoint[] {
    if (!Array.isArray(raw)) return [];
    const points: EmotionPoint[] = [];
    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const entry = item as Record<string, unknown>;
        const t = entry.timestamp ?? entry.t ?? entry.time;
        if (typeof t !== "number" || !Number.isFinite(t)) continue;
        const axes = readPadAxes(entry.after ?? entry.before ?? entry.state);
        points.push({ t, ...axes });
    }
    return points.slice(-Math.max(1, limit));
}

function mean(list: number[]): number {
    return list.length === 0 ? 0 : list.reduce((a, b) => a + b, 0) / list.length;
}

/**
 * 早窗 / 近窗各占一半，比较 P、A、D 的平均位移。
 * 阈值写在这里并注明语义：低于 0.05 的变化不值得替她说出来。
 */
export function describeTrend(points: EmotionPoint[]): EmotionTrend {
    if (points.length < MIN_POINTS_FOR_TREND) {
        return { dP: 0, dA: 0, dD: 0, sentence: null };
    }
    const half = Math.floor(points.length / 2);
    const early = points.slice(0, half);
    const recent = points.slice(-half);
    const dP = mean(recent.map((p) => p.P)) - mean(early.map((p) => p.P));
    const dA = mean(recent.map((p) => p.A)) - mean(early.map((p) => p.A));
    const dD = mean(recent.map((p) => p.D)) - mean(early.map((p) => p.D));

    const SENTENCE_EPS = 0.05;
    let sentence: string | null = null;
    if (dP > SENTENCE_EPS) sentence = "最近心情比前阵子亮一些";
    else if (dP < -SENTENCE_EPS) sentence = "最近心情比前阵子低一些";
    else if (dA > SENTENCE_EPS) sentence = "最近更有劲，也更爱动";
    else if (dA < -SENTENCE_EPS) sentence = "最近有点提不起劲";
    else if (dD > SENTENCE_EPS) sentence = "最近更敢表达自己的想法";
    else if (dD < -SENTENCE_EPS) sentence = "最近有点被情绪牵着走";

    return { dP, dA, dD, sentence };
}

/** SVG 折线用：把 [-1,1] 的轴值映射到 [0,height] 的像素（越靠上数值越大） */
export function toPolyline(points: EmotionPoint[], width: number, height: number): string {
    if (points.length === 0) return "";
    const n = points.length;
    return points
        .map((p, i) => {
            const x = n === 1 ? width / 2 : (i / (n - 1)) * width;
            const y = ((1 - p.P) / 2) * height;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ");
}
