"use client";

import { useId } from "react";
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
  // 低/高值含义那段说明是「这条轴在读什么」的关键信息，用 aria-describedby 挂到滑块上
  const axisHintId = useId();

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

          {/* 原生 range：透明全覆盖，负责拖动 / 键盘 / 无障碍。
              type=range 自带 role="slider" 与 aria-valuenow/min/max，方向键/Home/End 全都白送，
              所以这里不去手写 role，只补齐读屏需要的「值文本 + 名称 + 说明」：
              · aria-valuetext：轴的含义（如「外向 70」）比裸数字好读；
              · aria-describedby：把下面的低/高值含义一起念出来。
              注意 opacity-0 只是让原生控件不可见，焦点环也随之消失 ——
              可见焦点改由下面的把手承担（peer + peer-focus-visible）。 */}
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(baseline)}
            onChange={(e) => onChange(Number.parseInt(e.target.value, 10))}
            aria-label={meta.label}
            aria-valuetext={`${meta.label} 基线 ${Math.round(baseline)}`}
            aria-describedby={axisHintId}
            className="peer absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0"
          />

          {/* current 小三角：外层 motion 只管 x，内层 Tailwind 管居中。
              pointer-events-none：这两层只是画法，不能让它们盖住上面的 range 输入框
              （把手正好压在输入框最常被按到的位置上） */}
          <motion.div
            className="pointer-events-none absolute left-0 top-[26px] w-full"
            initial={false}
            animate={{ x: `${current}%` }}
            transition={{ duration: 0.2 }}
          >
            <div className="h-0 w-0 -translate-x-1/2 border-x-4 border-b-[6px] border-x-transparent border-b-accent-strong" />
          </motion.div>

          {/* baseline 把手（拖动对象；current 的跟随由后端按「保留相对偏移」计算） */}
          <motion.div
            className="pointer-events-none absolute left-0 top-3 w-full"
            initial={false}
            animate={{ x: `${baseline}%` }}
            transition={{ duration: 0.2 }}
          >
            <div className="h-4 w-4 -translate-x-1/2 rounded-full border-2 border-accent-1 bg-white shadow" />
          </motion.div>

          {/* 键盘焦点环。为什么要多一层：
              ① 输入框是 opacity-0 的，它自带的 focus ring 跟着一起看不见；
              ② Tailwind 的 peer-* 只会作用到「peer 之后的兄弟节点」，
                 而把手圆点被包在整宽（w-full）的 motion wrapper 里——百分比位移必须整宽，
                 环画在 wrapper 上会横满整条轨道。
              于是再来一个与把手同位移、同过渡的兄弟层，只在 focus-visible 时显出圆环，
              hover 才可见的「可拖动」暗示从此对键盘同样可见。 */}
          <motion.div
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-3 w-full opacity-0 peer-focus-visible:opacity-100"
            initial={false}
            animate={{ x: `${baseline}%` }}
            transition={{ duration: 0.2 }}
          >
            <div className="h-4 w-4 -translate-x-1/2 rounded-full ring-2 ring-accent-strong ring-offset-2 ring-offset-surface-1 dark:ring-accent-1" />
          </motion.div>
        </div>

        {/* 数值区：固定宽度 + tabular-nums，位数变化不引起布局跳动 */}
        <div className={cn("min-w-[4.5rem] text-right tabular-nums")}>
          <span className="text-sm font-bold text-accent-strong dark:text-accent-1">
            {Math.round(current)}
          </span>
          <span className="ml-1 text-[11px] text-content-muted">基线 {Math.round(baseline)}</span>
        </div>
      </div>

      {/* 低值含义 ←→ 高值含义（来自后端 dims 的 low/high）。
          10px 的说明文字是正文信息，不是装饰，提到 11px 后手机上也读得动。 */}
      <p id={axisHintId} className="pl-1 text-[11px] text-content-muted">
        {meta.low} ←→ {meta.high}
      </p>
    </div>
  );
}
