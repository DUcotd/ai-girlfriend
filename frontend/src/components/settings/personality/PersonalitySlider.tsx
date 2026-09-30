"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/cn";
import type { PersonalityDimMeta } from "@/types";

interface PersonalitySliderProps {
  /** 维度元数据（label / low / high 均来自后端 dims[]，前端零文案镜像） */
  meta: PersonalityDimMeta;
  /** 基线（整数）= 滑块拖动对象 = 把手位置 */
  baseline: number;
  /** 实际生效值（1 位小数）= 小三角位置 */
  current: number;
  /** 浮动带宽度（后端下发，当前恒为 15） */
  band: number;
  /** 拖动回调（父级做乐观更新 + debounce 提交） */
  onChange: (value: number) => void;
}

/**
 * 单个维度的性格滑块。
 *
 * 轨道同时呈现三个视觉元素：baseline 把手（可拖）、current 小三角、
 * 半透明浮动带 [baseline-band, baseline+band]。
 *
 * ⚠️ framer-motion 与 Tailwind 平移冲突（双层解法）：
 * motion 的内联 transform 会整个覆盖同一元素上的 Tailwind translate 类。
 * 因此外层 motion.div 只写 style={{ left: 0 }} + animate={{ x: "pct%" }}（百分比
 * 相对自身宽度 = 轨道宽度，数学正确）；居中偏移交给内层普通 div 的 -translate-x-1/2。
 * 浮动带同理：全宽 wrapper 只做 translateX（相对轨道宽），带宽由内层 width% 表示。
 *
 * ⚠️ 防抽动规则④：指示器定位一律用 translate-x，不用 left/right（无法插值，会瞬移）。
 */
export default function PersonalitySlider({
  meta,
  baseline,
  current,
  band,
  onChange,
}: PersonalitySliderProps) {
  // 端点先夹 0/100（与后端 clampCurrent 同口径）：baseline=95 时带的上界是 100 不是 110
  const lo = Math.max(0, baseline - band);
  const hi = Math.min(100, baseline + band);

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-3">
        <span className="w-14 shrink-0 text-xs font-bold text-content-primary">{meta.label}</span>

        <div className="relative h-10 flex-1">
          {/* 轨道 */}
          <div className="absolute inset-x-0 top-4 h-2 rounded-full bg-surface-2">
            {/* 浮动带：全宽 wrapper translateX(lo%)（% 相对自身 = 轨道宽），内层表示带宽 */}
            <div
              className="absolute inset-x-0 inset-y-0"
              style={{ transform: `translateX(${lo}%)` }}
            >
              <div
                className="h-full rounded-full bg-accent-1/25"
                style={{ width: `${hi - lo}%` }}
              />
            </div>
          </div>

          {/* 原生 range：透明全覆盖，负责拖动 / 键盘 / 无障碍 */}
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(baseline)}
            onChange={(e) => onChange(Number.parseInt(e.target.value, 10))}
            aria-label={`${meta.label}（当前基线 ${Math.round(baseline)}）`}
            className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0"
          />

          {/* current 小三角：外层 motion 只管 x，内层 Tailwind 管居中 */}
          <motion.div
            className="absolute left-0 top-[26px] w-full"
            initial={false}
            animate={{ x: `${current}%` }}
            transition={{ duration: 0.2 }}
          >
            <div className="h-0 w-0 -translate-x-1/2 border-x-4 border-b-[6px] border-x-transparent border-b-accent-strong" />
          </motion.div>

          {/* baseline 把手（拖动对象；current 的跟随由后端按「保留相对偏移」计算） */}
          <motion.div
            className="absolute left-0 top-3 w-full"
            initial={false}
            animate={{ x: `${baseline}%` }}
            transition={{ duration: 0.2 }}
          >
            <div className="h-4 w-4 -translate-x-1/2 rounded-full border-2 border-accent-1 bg-white shadow" />
          </motion.div>
        </div>

        {/* 数值区：固定宽度 + tabular-nums，位数变化不引起布局跳动 */}
        <div className={cn("min-w-[4.5rem] text-right tabular-nums")}>
          <span className="text-sm font-bold text-accent-strong dark:text-accent-1">
            {Math.round(current)}
          </span>
          <span className="ml-1 text-[10px] text-content-muted">基线 {Math.round(baseline)}</span>
        </div>
      </div>

      {/* 低值含义 ←→ 高值含义（来自后端 dims 的 low/high） */}
      <p className="pl-1 text-[10px] text-content-muted">
        {meta.low} ←→ {meta.high}
      </p>
    </div>
  );
}
