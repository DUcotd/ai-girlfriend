"use client";

import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    /** 激活态（如语音模式已开启、正在录音） */
    active?: boolean;
    /** 激活时的高亮色 */
    tone?: "accent" | "danger";
}

/** 工具栏图标按钮：未激活灰色 hover 浅底，激活时按 tone 高亮。 */
export default function IconButton({
    active = false,
    tone = "accent",
    className,
    type = "button",
    ...props
}: IconButtonProps) {
    return (
        <button
            type={type}
            className={cn(
                "p-3 rounded-xl transition-all text-content-muted hover:bg-surface-2",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                active &&
                    (tone === "accent"
                        ? "bg-accent-1/15 text-accent-1 hover:bg-accent-1/20"
                        : "bg-status-danger/10 text-status-danger hover:bg-status-danger/15"),
                className
            )}
            {...props}
        />
    );
}
