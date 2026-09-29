"use client";

import ProgressBar from "../ui/ProgressBar";
import type { AffinityStageMeta } from "@/types";

interface StageProgressProps {
  /** 后端下发的阶段元数据；null（首帧未同步）时保持空占位，防抽动 */
  meta: AffinityStageMeta | null;
}

/**
 * 阶段进度：本阶段内进度条 + 「距离下一阶段还差 N 点」。
 * 全程零阈值——阶段名、下一阶段、差几点、进度均由后端下发（PRD P0-a）。
 *
 * 固定高度（min-h-[40px]）：元数据未到时也占位，避免 settle 后内容突然出现抽动布局。
 */
export default function StageProgress({ meta }: StageProgressProps) {
  if (!meta) {
    return <div className="mt-2 min-h-[40px]" aria-hidden />;
  }

  const pct = Math.max(0, Math.min(100, meta.stageProgress * 100));

  return (
    <div className="mt-2 min-h-[40px]">
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[11px] text-content-secondary">
        <span className="shrink-0 font-medium text-content-primary/80">{meta.stageShortLabel}</span>
        <span className="truncate">
          {meta.nextStageLabel
            ? `距离「${meta.nextStageLabel}」还差 ${meta.pointsToNextStage} 点`
            : "已达最高关系"}
        </span>
      </div>
      <ProgressBar value={pct} />
    </div>
  );
}
