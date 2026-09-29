"use client";

import { cn } from "@/lib/cn";
import type { AffinityTraceEntry } from "@/types";

interface AffinityReasonProps {
  /** 最近一次变化的可读原因（账本末条 trace 的 reason） */
  recentReason: string | null;
  /** 好感度修正轨迹；取末条的 to 符号做涨跌着色 */
  trace: AffinityTraceEntry[];
  /** 是否处于时间衰减中 */
  decaying: boolean;
  /** 今日正向涨分是否已达上限 */
  dailyCapReached: boolean;
}

/**
 * 好感度变化原因：一句人话解释「这次为什么变」。
 *
 * 变化数字着色说明（通用涨跌色，**不是**股市红涨绿跌）：
 *   to > 0 → 绿；to < 0 → 红；to === 0 → 中性灰。
 *
 * 固定高度（min-h-[44px]）：无论有无内容都占位，两行区域不会在数据到达时抽动。
 */
export default function AffinityReason({
  recentReason,
  trace,
  decaying,
  dailyCapReached,
}: AffinityReasonProps) {
  const last = trace.length > 0 ? trace[trace.length - 1] : null;
  const delta = last ? last.to : 0;
  const deltaClass =
    delta > 0 ? "text-emerald-500" : delta < 0 ? "text-red-500" : "text-content-secondary";

  const hint = decaying
    ? "好像有点疏远了…"
    : dailyCapReached
      ? "今天的好感已经涨到上限了"
      : "";

  return (
    <div className="min-h-[44px] text-xs">
      <div className="flex items-baseline gap-1.5 text-content-secondary">
        <span className="truncate">
          {recentReason ? `最近一次：${recentReason}` : "最近还没有变化"}
        </span>
        {last && (
          <span className={cn("shrink-0 font-semibold tabular-nums", deltaClass)}>
            {delta > 0 ? `+${delta}` : delta}
          </span>
        )}
      </div>
      <div className="mt-1 min-h-[16px] text-content-secondary/80">{hint}</div>
    </div>
  );
}
