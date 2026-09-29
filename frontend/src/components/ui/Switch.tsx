"use client";

import { cn } from "@/lib/cn";

interface SwitchProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    /** 无障碍标签 */
    label: string;
}

/** 开关（原主动消息总开关的拨杆）。 */
export default function Switch({ checked, onChange, label }: SwitchProps) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            onClick={() => onChange(!checked)}
            className={cn(
                "relative h-6 w-12 shrink-0 rounded-full transition-colors duration-normal ease-out-expo",
                checked ? "bg-accent-1" : "bg-content-muted/30"
            )}
        >
            {/* 用 translate 而不是 left/right 切换：left↔right 之间无法插值，
                会让滑块瞬移而非平滑过渡 */}
            <span
                className={cn(
                    "absolute left-1 top-1 h-4 w-4 rounded-full bg-white shadow",
                    "transition-transform duration-normal ease-out-expo",
                    checked ? "translate-x-6" : "translate-x-0"
                )}
            />
        </button>
    );
}
