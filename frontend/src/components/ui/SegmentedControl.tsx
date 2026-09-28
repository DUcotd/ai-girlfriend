"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface SegmentedOption<T extends string> {
    value: T;
    label: ReactNode;
    /** 仅展示不可点（如服务商行的「自定义」指示） */
    disabled?: boolean;
}

interface SegmentedControlProps<T extends string> {
    options: readonly SegmentedOption<T>[];
    value: T;
    onChange?: (value: T) => void;
    className?: string;
}

/** 分段选择器（原服务商预设 / 语音引擎 / 消息频率的胶囊行）。 */
export default function SegmentedControl<T extends string>({
    options,
    value,
    onChange,
    className,
}: SegmentedControlProps<T>) {
    return (
        <div
            className={cn(
                "flex gap-2 rounded-2xl border border-line-subtle bg-surface-2 p-1",
                className
            )}
        >
            {options.map((opt) => {
                const active = value === opt.value;
                return (
                    <button
                        key={opt.value}
                        type="button"
                        disabled={opt.disabled}
                        onClick={() => onChange?.(opt.value)}
                        className={cn(
                            "flex-1 rounded-xl py-2 text-xs font-bold transition-all",
                            active
                                ? "bg-surface-1 text-accent-strong shadow-sm dark:text-accent-1"
                                : "text-content-muted",
                            !opt.disabled && !active && "hover:text-content-secondary",
                            opt.disabled && "cursor-default"
                        )}
                    >
                        {opt.label}
                    </button>
                );
            })}
        </div>
    );
}
