"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/cn";

interface CheckboxProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    /** 无障碍标签 */
    label: string;
    className?: string;
}

/**
 * 勾选框（主动消息类型列表用）。
 *
 * 边框在两种状态下都常驻（只换颜色），勾选时不会因为增删描边改变盒子尺寸 ——
 * 同一行里的图标/文字就不会跟着抖（见 UI 稳定性约定①）。
 */
export default function Checkbox({ checked, onChange, label, className }: CheckboxProps) {
    return (
        <button
            type="button"
            role="checkbox"
            aria-checked={checked}
            aria-label={label}
            onClick={() => onChange(!checked)}
            className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border-2",
                "transition-colors duration-normal ease-out-expo",
                checked
                    ? "border-accent-1/60 bg-accent-1/25 text-accent-strong dark:text-accent-1"
                    : "border-line-subtle bg-surface-1/50 text-transparent hover:border-content-muted/40",
                className
            )}
        >
            <Check size={14} strokeWidth={3} />
        </button>
    );
}
