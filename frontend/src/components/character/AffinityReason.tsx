"use client";

import { cn } from "@/lib/cn";

interface AffinityReasonProps {
  /** 最近一次变化的可读原因（后端保证：有真实变化时非 null；从未变化才为 null） */
  recentReason: string | null;
  /** 最近一次**真正发生**的变化量（决定数字与着色；从未变化为 0） */
  recentChange: number;
  /** 是否处于时间衰减中 */
  decaying: boolean;
  /** 今日正向涨分是否已达上限 */
  dailyCapReached: boolean;
}

/**
 * 好感度变化原因：一句人话解释「最近一次为什么变」。
 *
 * 数字与着色取后端下发的 `recentChange`（最近一次真实变化量），**不再**从 trace 末项推——
 * trace 只记录规则介入，正常回合为空，用它推会导致涨了分却不显示、原因误报为「没有变化」。
 *
 * 变化数字着色（通用涨跌色，**不是**股市红涨绿跌）：
 *   recentChange > 0 → 绿；< 0 → 红；=== 0 → 中性灰。
 *
 * 固定高度（min-h-[44px]）：无论有无内容都占位，两行区域不会在数据到达时抽动。
 */
export default function AffinityReason({
  recentReason,
  recentChange,
  decaying,
  dailyCapReached,
}: AffinityReasonProps) {
  const deltaClass =
    recentChange > 0
      ? "text-status-success"
      : recentChange < 0
        ? "text-status-danger"
        : "text-content-secondary";

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
        {recentChange !== 0 && (
          <span className={cn("shrink-0 font-semibold tabular-nums", deltaClass)}>
            {recentChange > 0 ? `+${recentChange}` : recentChange}
          </span>
        )}
      </div>
      <div className="mt-1 min-h-[16px] text-content-secondary/80">{hint}</div>
    </div>
  );
}
