"use client";

import Button from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import type { PersonalityPreset } from "@/types";

interface PersonalityPresetGridProps {
  presets: PersonalityPreset[];
  /** 当前生效的 presetId（含 'custom'） */
  activePresetId: string;
  /** 当前预设中文名；'custom'（迁移遗留）时为 null */
  presetName: string | null;
  /** baseline 与当前预设是否不一致 */
  customized: boolean;
  /** 与预设不一致的维度数 */
  customizedCount: number;
  onSelect: (presetId: string) => void;
  /** 「恢复到该预设」= 重新应用当前 presetId（custom 时按钮不展示） */
  onRestore: () => void;
}

/**
 * 6 张预设性格卡片（grid-cols-3 gap-2）。
 * ⚠️ 防抽动规则①：边框常驻——未激活写 border-transparent，激活态只换边框颜色，
 * 避免点击时边框增删引起 2px 位移。
 */
export default function PersonalityPresetGrid({
  presets,
  activePresetId,
  presetName,
  customized,
  customizedCount,
  onSelect,
  onRestore,
}: PersonalityPresetGridProps) {
  return (
    <div className="space-y-2">
      {/* 区块标题 + 常驻提示（切换预设会清零浮动，必须让用户在点击前知道） */}
      <div className="flex items-center justify-between">
        <label className="block pl-1 text-[10px] font-bold uppercase tracking-widest text-content-muted">
          预设性格
        </label>
        <span className="text-[10px] text-content-muted">切换预设会把当前浮动清零</span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {presets.map((preset) => {
          const isActive = preset.id === activePresetId;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => onSelect(preset.id)}
              className={cn(
                "flex flex-col items-center gap-1 rounded-2xl border p-2.5 text-center",
                "transition-colors duration-fast ease-out-expo",
                isActive
                  ? "border-accent-1 bg-accent-1/10"
                  : "border-transparent hover:bg-surface-1"
              )}
            >
              <span className="text-2xl leading-none" aria-hidden>
                {preset.emoji}
              </span>
              <span className="text-xs font-bold text-content-primary">{preset.name}</span>
              <span className="line-clamp-2 text-[10px] leading-tight text-content-muted">
                {preset.tagline}
              </span>
            </button>
          );
        })}
      </div>

      {/* 手动微调状态：文案长短不一，按钮固定在右侧，整行 min-h 防显示/隐藏时下方跳变 */}
      <div className="flex min-h-[26px] items-center justify-between pl-1">
        {customized ? (
          <>
            <p className="text-[10px] text-content-secondary">
              当前：{presetName ?? "自定义"}
              {customizedCount > 0 && ` · 已微调 ${customizedCount} 项`}
            </p>
            {presetName && (
              <Button variant="ghost" size="sm" onClick={onRestore}>
                恢复到该预设
              </Button>
            )}
          </>
        ) : (
          <p className="text-[10px] text-content-muted">当前：{presetName ?? "自定义"}</p>
        )}
      </div>
    </div>
  );
}
