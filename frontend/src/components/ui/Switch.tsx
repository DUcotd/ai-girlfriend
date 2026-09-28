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
                "relative h-6 w-12 shrink-0 rounded-full transition-all",
                checked ? "bg-accent-1" : "bg-content-muted/30"
            )}
        >
            <span
                className={cn(
                    "absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-all",
                    checked ? "right-1" : "left-1"
                )}
            />
        </button>
    );
}
