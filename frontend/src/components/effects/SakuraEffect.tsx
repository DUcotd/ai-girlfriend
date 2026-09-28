"use client";

import { useSakuraEffect } from "@/hooks/useSakuraEffect";

/**
 * 樱花飘落背景特效（全局唯一，挂 layout）。
 * 花瓣是命令式 DOM 注入（useSakuraEffect），本组件只是其 React 挂载点。
 */
export default function SakuraEffect() {
    useSakuraEffect();
    return null;
}
