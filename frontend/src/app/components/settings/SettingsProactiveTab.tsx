"use client";

import { motion } from "framer-motion";
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
      <div className="flex items-center justify-between p-4 bg-white/50 rounded-2xl border border-pink-100">
        <div>
          <h4 className="text-sm font-bold text-gray-700">启用主动消息</h4>
          <p className="text-[10px] text-gray-400 mt-0.5">小爱会根据时间和场景主动找你聊天</p>
        </div>
        <button
          type="button"
          aria-label="启用主动消息"
          aria-pressed={enabled}
          onClick={() => onToggleEnabled(!enabled)}
          className={`w-12 h-6 rounded-full transition-all relative ${enabled ? "bg-pink-400" : "bg-gray-200"}`}
        >
          <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all ${enabled ? "right-1" : "left-1"}`} />
        </button>
      </div>

      {enabled && (
        <motion.div initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
          {/* 频率选择 */}
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest pl-1">消息频率</label>
            <div className="flex gap-2 p-1 bg-gray-100/50 rounded-2xl border border-gray-100">
              {(["low", "medium", "high"] as const).map((level) => (
                <button
                  key={level}
                  type="button"
                  onClick={() => onFrequencyChange(level)}
                  className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${frequencyLevel === level ? "bg-white text-pink-600 shadow-sm" : "text-gray-400 hover:text-gray-500"}`}
                >
                  {level === "low" ? "🐢 低频" : level === "medium" ? "🐰 中频" : "🚀 高频"}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-gray-400 pl-1">
              {frequencyLevel === "low" && "安静模式：减少消息打扰，冷却时间加倍"}
              {frequencyLevel === "medium" && "平衡模式：适度互动（默认推荐）"}
              {frequencyLevel === "high" && "活跃模式：更频繁的互动，适合想要陪伴的时刻"}
            </p>
          </div>

          {/* 每日上限 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest pl-1">每日消息上限</label>
              <button
                type="button"
                onClick={() => onCustomDailyLimitChange(customDailyLimit === null ? 8 : null)}
                className={`text-[10px] px-2 py-1 rounded-lg transition-all ${customDailyLimit !== null ? "bg-pink-100 text-pink-600" : "bg-gray-100 text-gray-400"}`}
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
                  className="flex-1 accent-pink-400"
                />
                <span className="text-sm font-bold text-pink-600 min-w-[3rem] text-right">{customDailyLimit} 条/天</span>
              </div>
            )}
          </div>

          {/* 消息类型 */}
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest pl-1">消息类型</label>
            <div className="grid grid-cols-1 gap-2">
              {availableTypes.map((type) => (
                <label
                  key={type.id}
                  className={`flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-all ${enabledTypes.includes(type.id) ? "bg-pink-50 border border-pink-200" : "bg-white/50 border border-gray-100 hover:border-gray-200"}`}
                >
                  <input
                    type="checkbox"
                    checked={enabledTypes.includes(type.id)}
                    onChange={(e) => {
                      if (e.target.checked) onEnabledTypesChange([...enabledTypes, type.id]);
                      else onEnabledTypesChange(enabledTypes.filter((t) => t !== type.id));
                    }}
                    className="w-4 h-4 accent-pink-400"
                  />
                  <div className="flex-1">
                    <span className="text-sm font-medium text-gray-700">{type.label}</span>
                    <p className="text-[10px] text-gray-400">{type.description}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>
        </motion.div>
      )}

      <div className="p-4 bg-purple-50/50 rounded-2xl border border-purple-100 text-[11px] text-purple-500 leading-relaxed">
        💝 主动消息让小爱更加主动关心你！她会在合适的时间发送问候、想念消息和情绪关怀。
      </div>
    </>
  );
}
