"use client";

import { useCallback, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { resolveRadioKey, tabStopIndex, type RadioOption } from "@/lib/radioGroup";

interface UseRadioGroupProps<T extends string> {
    options: readonly (RadioOption & { value: T })[];
    value: T;
    onChange: (value: T) => void;
}

/**
 * radiogroup 的 DOM 胶水：把 lib/radioGroup 的纯规则接到 refs / focus / onChange 上。
 * 纯规则单独可测，这里只负责「移动到某项 = 选中它并把焦点搬过去」。
 */
export function useRadioGroup<T extends string>({
    options,
    value,
    onChange,
}: UseRadioGroupProps<T>) {
    const refs = useRef<(HTMLElement | null)[]>([]);

    const onKeyDown = useCallback(
        (event: ReactKeyboardEvent, index: number) => {
            const result = resolveRadioKey(event.key, index, options);
            if (!result) return; // 无关按键交给浏览器（Tab 照常离开整组）
            event.preventDefault();
            if (result.kind === "confirm") {
                onChange(options[index].value);
                return;
            }
            onChange(options[result.index].value);
            refs.current[result.index]?.focus();
        },
        [options, onChange]
    );

    /** roving tabindex：整组只留一个 Tab 停靠点，落在选中项上 */
    const tabIndexFor = useCallback(
        (index: number) => (index === tabStopIndex(options, value) ? 0 : -1),
        [options, value]
    );

    return { refs, onKeyDown, tabIndexFor };
}
