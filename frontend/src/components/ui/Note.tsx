"use client";

import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type NoteTone = "accent" | "info" | "success" | "warning" | "danger";

interface NoteProps extends HTMLAttributes<HTMLDivElement> {
    tone?: NoteTone;
}

const toneClasses: Record<NoteTone, string> = {
    accent: "bg-accent-1/10 border-accent-1/20 text-accent-strong dark:text-accent-1",
    info: "bg-status-info/10 border-status-info/20 text-status-info",
    success: "bg-status-success/10 border-status-success/20 text-status-success",
    warning: "bg-status-warning/10 border-status-warning/20 text-status-warning",
    danger: "bg-status-danger/10 border-status-danger/20 text-status-danger",
};

/** 设置页/向导里的提示条（💡 提示、🧠 说明这类）。 */
export default function Note({ tone = "accent", className, ...props }: NoteProps) {
    return (
        <div
            className={cn(
                "rounded-2xl border p-4 text-[11px] leading-relaxed",
                toneClasses[tone],
                className
            )}
            {...props}
        />
    );
}
