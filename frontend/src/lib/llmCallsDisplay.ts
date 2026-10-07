/**
 * 模型调用计数的展示格式化（B1-2）。
 *
 * 目的写在 `config.llmCalls` 的注释里也写过：**排障与理解行为**，不是压成本 ——
 * 「她这轮到底调了几次模型」以前只能靠猜，而「同一轮 query 嵌入两次」这类
 * 「写了没接线」的重复调用也就永远不会被发现。
 *
 * 通道中文名由后端随快照下发（`labelsZh`），前端**不抄第二份清单**：
 * 两份真相迟早漂移，这个项目已经为此加过跨端测试。
 */

export interface LlmCallsSnapshot {
    turnId?: number;
    turnStartedAt?: number | null;
    turn?: Record<string, number>;
    lastHour?: Record<string, number> & { windowMs?: number };
    labelsZh?: Record<string, string>;
}

/** 不参与逐通道展示的键（它们是汇总与元数据） */
const NON_CHANNEL_KEYS = new Set(["total", "windowMs", "turnId", "turnStartedAt"]);

export function llmCallChannels(snap?: LlmCallsSnapshot | null): string[] {
    if (!snap?.turn) return [];
    return Object.keys(snap.turn).filter((k) => !NON_CHANNEL_KEYS.has(k));
}

/** 「主对话 1 · 事实提取 1 · 嵌入 0」——只列后端下发的通道，顺序也按后端 */
export function formatTurnCalls(snap?: LlmCallsSnapshot | null): string {
    const channels = llmCallChannels(snap);
    if (channels.length === 0) return "";
    return channels
        .map((ch) => `${snap!.labelsZh?.[ch] ?? ch} ${snap!.turn![ch] ?? 0}`)
        .join(" · ");
}

/** 一句话总览；后端没下发 llmCalls（老进程）时返回空串，界面就不显示这一行 */
export function formatLlmCallsLine(snap?: LlmCallsSnapshot | null): string {
    if (!snap || !snap.turn || !snap.lastHour) return "";
    const turnTotal = snap.turn.total ?? 0;
    const hourTotal = snap.lastHour.total ?? 0;
    const detail = formatTurnCalls(snap);
    const minutes = Math.max(1, Math.round(((snap.lastHour.windowMs ?? 3_600_000) as number) / 60_000));
    const head = `本轮 ${turnTotal} 次${detail ? `（${detail}）` : ""}｜近 ${minutes} 分钟共 ${hourTotal} 次`;
    return snap.turnId ? `第 ${snap.turnId} 轮 · ${head}` : head;
}
