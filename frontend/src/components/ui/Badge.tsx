"use client";

import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type BadgeTone = "accent" | "info" | "neutral";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
    tone?: BadgeTone;
}

const toneClasses: Record<BadgeTone, string> = {
    // 原 .emotion-badge（含暗色下文字调亮的修正）
    accent: "bg-accent-1/15 text-accent-strong dark:text-accent-1",
    info: "bg-status-info/10 text-status-info",
    neutral: "bg-surface-2/80 text-content-secondary",
};

/** 胶囊徽章：情绪标签、状态标记等。 */
export default function Badge({ tone = "accent", className, ...props }: BadgeProps) {
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-medium",
                toneClasses[tone],
                className
            )}
            {...props}
        />
    );
}
