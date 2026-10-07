"use client";

import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { tabStopIndex } from "@/lib/radioGroup";
import { useRadioGroup } from "@/hooks/useRadioGroup";

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
    /** Field 注入的关联属性（见 ui/Field.tsx）：组本身不是 labelable 元素，只能靠 id + aria-* */
    id?: string;
    "aria-label"?: string;
    "aria-labelledby"?: string;
    "aria-describedby"?: string;
}

/**
 * 分段选择器（原服务商预设 / 语音引擎 / 消息频率的胶囊行）。
 *
 * 语义是「单选」而不是「一串按钮」：radiogroup + radio + aria-checked，
 * 读屏才会念出「第 2 项，共 3 项，已选中」。键盘走 WAI-ARIA 的 radio 模式
 * （Tab 进组一次 → 方向键换档并即时生效 → Enter/Space 确认），
 * 规则实现在 lib/radioGroup（纯函数，可单测）。
 * 改之前只有 onClick，键盘用户完全切不了档位。
 */
export default function SegmentedControl<T extends string>({
    options,
    value,
    onChange,
    className,
    id,
    ...aria
}: SegmentedControlProps<T>) {
    const { refs, onKeyDown } = useRadioGroup({
        options,
        value,
        // useRadioGroup 的类型要求必传，这里保持 onChange 可选的对外契约
        onChange: (next) => onChange?.(next),
    });
    const stop = tabStopIndex(options, value);

    return (
        <div
            id={id}
            role="radiogroup"
            {...(aria["aria-label"]
                ? { "aria-label": aria["aria-label"] }
                : { "aria-labelledby": aria["aria-labelledby"] ?? undefined })}
            aria-describedby={aria["aria-describedby"]}
            className={cn(
                "flex gap-2 rounded-2xl border border-line-subtle bg-surface-2 p-1",
                className
            )}
        >
            {options.map((opt, index) => {
                const active = value === opt.value;
                return (
                    <button
                        key={opt.value}
                        ref={(node) => {
                            refs.current[index] = node;
                        }}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={opt.disabled}
                        // roving tabindex：整组只占一个 Tab 停靠点（选中项），
                        // 其余项靠方向键到达
                        tabIndex={index === stop ? 0 : -1}
                        onClick={() => onChange?.(opt.value)}
                        onKeyDown={(event: ReactKeyboardEvent<HTMLButtonElement>) =>
                            onKeyDown(event, index)
                        }
                        className={cn(
                            "flex-1 rounded-xl py-2 text-xs font-bold transition-all",
                            // 焦点环挂在按钮上：未选中项原本只靠 hover 变色提示可点，
                            // 键盘用户看不到 hover，必须有可见焦点
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-1/60",
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
