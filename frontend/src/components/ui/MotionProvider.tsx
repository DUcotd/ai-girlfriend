"use client";

import { MotionConfig } from "framer-motion";
import type { ReactNode } from "react";

/**
 * 全局动效配置：reducedMotion="user" 让 framer-motion 的进出场/缩放动画
 * 跟随系统「减少动态效果」设置——utilities.css 的 CSS transition 压缩
 * 对 JS 驱动的 framer-motion 动画无效，必须靠这层配置补齐。
 */
export default function MotionProvider({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
