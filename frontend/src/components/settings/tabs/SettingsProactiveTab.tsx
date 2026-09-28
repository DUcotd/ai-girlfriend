"use client";

import { motion } from "framer-motion";
import Note from "@/components/ui/Note";
import SegmentedControl from "@/components/ui/SegmentedControl";
import Switch from "@/components/ui/Switch";
import { cn } from "@/lib/cn";
import type { ProactiveTypeInfo } from "@/types";

interface SettingsProactiveTabProps {
  enabled: boolean;
  onToggleEnabled: (value: boolean) => void;
  frequencyLevel: "low" | "medium" | "high";
  onFrequencyChange: (level: "low" | "medium" | "high") => void;
  customDailyLimit: number | null;
  onCustomDailyLimitChange: (value: number | null) => void;
  enabledTypes: string[];
  onEnabledTypesChange: (types: string[]) => void;
  availableTypes: ProactiveTypeInfo[];
}

/**
 * 设置 → 主动消息页签。
 * 这块自带 5 个状态且 UI 最长，从 SettingsDialog 里拆出来，主文件只负责持有状态。
 */
export default function SettingsProactiveTab({
  enabled,
  onToggleEnabled,
  frequencyLevel,
  onFrequencyChange,
  customDailyLimit,
  onCustomDailyLimitChange,
  enabledTypes,
  onEnabledTypesChange,
  availableTypes,
}: SettingsProactiveTabProps) {
  return (
    <>
      {/* 总开关 */}
      <div className="flex items-center justify-between rounded-2xl border border-line-subtle bg-surface-1/50 p-4">
        <div>
          <h4 className="text-sm font-bold text-content-primary">启用主动消息</h4>
          <p className="mt-0.5 text-[10px] text-content-muted">小爱会根据时间和场景主动找你聊天</p>
        </div>
        <Switch checked={enabled} onChange={onToggleEnabled} label="启用主动消息" />
      </div>

      {enabled && (
        <motion.div initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
          {/* 频率选择 */}
          <div className="space-y-2">
            <label className="block pl-1 text-[10px] font-bold uppercase tracking-widest text-content-muted">
              消息频率
            </label>
            <SegmentedControl
              options={[
                { value: "low", label: "🐢 低频" },
                { value: "medium", label: "🐰 中频" },
                { value: "high", label: "🚀 高频" },
              ]}
              value={frequencyLevel}
              onChange={onFrequencyChange}
            />
            <p className="pl-1 text-[10px] text-content-muted">
              {frequencyLevel === "low" && "安静模式：减少消息打扰，冷却时间加倍"}
              {frequencyLevel === "medium" && "平衡模式：适度互动（默认推荐）"}
              {frequencyLevel === "high" && "活跃模式：更频繁的互动，适合想要陪伴的时刻"}
            </p>
          </div>

          {/* 每日上限 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="pl-1 text-[10px] font-bold uppercase tracking-widest text-content-muted">
                每日消息上限
              </label>
              <button
                type="button"
                onClick={() => onCustomDailyLimitChange(customDailyLimit === null ? 8 : null)}
                className={cn(
                  "rounded-lg px-2 py-1 text-[10px] transition-all",
                  customDailyLimit !== null
                    ? "bg-accent-1/15 text-accent-strong dark:text-accent-1"
                    : "bg-surface-2 text-content-muted"
                )}
              >
                {customDailyLimit !== null ? "自定义" : "自动（按好感度）"}
              </button>
            </div>
            {customDailyLimit !== null && (
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min="1"
                  max="20"
                  value={customDailyLimit}
                  onChange={(e) => onCustomDailyLimitChange(parseInt(e.target.value))}
                  className="flex-1 accent-accent-1"
                />
                <span className="min-w-[3rem] text-right text-sm font-bold text-accent-strong dark:text-accent-1">
                  {customDailyLimit} 条/天
                </span>
              </div>
            )}
          </div>

          {/* 消息类型 */}
          <div className="space-y-2">
            <label className="block pl-1 text-[10px] font-bold uppercase tracking-widest text-content-muted">
              消息类型
            </label>
            <div className="grid grid-cols-1 gap-2">
              {availableTypes.map((type) => {
                const checked = enabledTypes.includes(type.id);
                return (
                  <label
                    key={type.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-all",
                      checked
                        ? "border-accent-1/30 bg-accent-1/10"
                        : "border-line-subtle bg-surface-1/50 hover:border-content-muted/30"
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        if (e.target.checked) onEnabledTypesChange([...enabledTypes, type.id]);
                        else onEnabledTypesChange(enabledTypes.filter((t) => t !== type.id));
                      }}
                      className="h-4 w-4 accent-accent-1"
                    />
                    <div className="flex-1">
                      <span className="text-sm font-medium text-content-primary">{type.label}</span>
                      <p className="text-[10px] text-content-muted">{type.description}</p>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        </motion.div>
      )}

      <Note tone="accent">
        💝 主动消息让小爱更加主动关心你！她会在合适的时间发送问候、想念消息和情绪关怀。
      </Note>
    </>
  );
}
