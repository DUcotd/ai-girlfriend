"use client";

import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

interface SelectOption<T extends string> {
    value: T;
    label: string;
}

interface SelectProps<T extends string> {
    options: readonly SelectOption<T>[];
    value: T;
    onChange: (value: T) => void;
    /** 无障碍/表单关联用；同时作为下拉的无标签场景兜底 */
    ariaLabel?: string;
    className?: string;
}

/**
 * 原生 <select> 的样式包装：键盘、移动端滚轮与系统弹层都由浏览器负责，
 * 比自制弹层稳（尤其是设置弹窗里嵌套浮层的定位问题）。
 *
 * 视觉与 Input 对齐（rounded-2xl + border-2 + focus ring），箭头用图标自绘
 * 以便跟随主题色。options 的 bg/text 也显式给深色值，避免 Windows 上
 * 系统下拉跟随亮色主题导致白底黑字看不清。
 */
export default function Select<T extends string>({
    options,
    value,
    onChange,
    ariaLabel,
    className,
}: SelectProps<T>) {
    return (
        <div className="relative">
            <select
                aria-label={ariaLabel}
                value={value}
                onChange={(e) => onChange(e.target.value as T)}
                className={cn(
                    "w-full appearance-none rounded-2xl border-2 border-line-subtle bg-surface-1/90",
                    "px-4 py-3 pr-10 text-sm text-content-primary transition-all",
                    "focus:outline-none focus:border-accent-1 focus:ring-4 focus:ring-accent-1/15",
                    className
                )}
            >
                {options.map((opt) => (
                    <option
                        key={opt.value}
                        value={opt.value}
                        className="bg-surface-1 text-content-primary"
                    >
                        {opt.label}
                    </option>
                ))}
            </select>
            {/* pointer-events-none：箭头不拦截点击，点击穿透到 select 本身 */}
            <ChevronDown
                aria-hidden
                className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-content-muted"
            />
        </div>
    );
}
