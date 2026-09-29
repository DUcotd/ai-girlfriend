"use client";

import Checkbox from "@/components/ui/Checkbox";
import { cn } from "@/lib/cn";
import type { ProactiveTypeInfo } from "@/types";

interface TypeToggleCardProps {
    type: ProactiveTypeInfo;
    checked: boolean;
    /** 总开关关闭时整块只读 */
    disabled?: boolean;
    onToggle: (id: string, checked: boolean) => void;
}

/**
 * 单个主动消息类型的开关卡片。
 * 整行可点（等价原来的 <label> 包 input），勾选框外包一层 span 阻断冒泡，
 * 否则点勾选框会触发两次 toggle、看起来"点不动"。
 */
export default function TypeToggleCard({ type, checked, disabled, onToggle }: TypeToggleCardProps) {
    const title = type.labelZh || type.label;

    return (
        <div
            role="button"
            tabIndex={disabled ? -1 : 0}
            aria-pressed={checked}
            onClick={() => !disabled && onToggle(type.id, !checked)}
            onKeyDown={(e) => {
                if (disabled) return;
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onToggle(type.id, !checked);
                }
            }}
            // 英文说明留给 tooltip：卡片上放更有用的中文「什么时候发」
            title={`${type.label} · ${type.description}`}
            className={cn(
                // 边框常驻（两个状态都是 border），勾选不改变盒子尺寸
                "flex items-center gap-3 rounded-xl border p-3 transition-colors",
                "duration-fast ease-out-expo",
                checked
                    ? "border-accent-1/30 bg-accent-1/10"
                    : "border-line-subtle bg-surface-1/50 hover:border-content-muted/30",
                disabled && "cursor-not-allowed opacity-50"
            )}
        >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-base">
                {type.icon || "✨"}
            </span>

            <div className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-content-primary">{title}</span>
                <p className="truncate text-[10px] text-content-muted">
                    {type.schedule || type.description}
                </p>
            </div>

            <span onClick={(e) => e.stopPropagation()}>
                <Checkbox
                    checked={checked}
                    label={title}
                    onChange={(next) => !disabled && onToggle(type.id, next)}
                />
            </span>
        </div>
    );
}
