"use client";

import { cn } from "@/lib/cn";

interface ProgressBarProps {
    /** 0~100，越界自动截断 */
    value: number;
    className?: string;
    /** 覆盖填充条样式（默认 accent 渐变） */
    fillClassName?: string;
    /** 填充条内联样式（如 PAD 轴的对齐 margin） */
    fillStyle?: React.CSSProperties;
    /** false 时填充条不加渐变，纯色由 fillClassName 提供 */
    gradient?: boolean;
}

/** 进度条：轨道吃 accent-1/15（随主题变色），填充默认 accent 渐变。 */
export default function ProgressBar({ value, className, fillClassName, fillStyle, gradient = true }: ProgressBarProps) {
    const clamped = Math.max(0, Math.min(100, value));
    return (
        <div className={cn("h-2 overflow-hidden rounded-full bg-accent-1/15", className)}>
            <div
                className={cn(
                    "h-full rounded-full transition-all duration-500",
                    gradient && "bg-gradient-to-r from-accent-1 to-accent-strong",
                    fillClassName
                )}
                style={{ width: `${clamped}%`, ...fillStyle }}
            />
        </div>
    );
}
