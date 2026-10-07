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
                // 触达区域扩到 44×44（WCAG 2.5.5 / Apple HMI 尺寸）：
                // 用伪元素向外撑，不占布局也不改变视觉大小——
                // 拨杆本身只有 24px 高，手机上按不准，但直接给 h-11 会把整行撑高。
                "after:absolute after:-inset-y-2.5 after:-inset-x-1 after:content-['']",
                // 开关是表单控件，键盘全靠这一圈焦点环认它
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-1/60 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1",
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
