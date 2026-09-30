"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import Field from "./Field";
import Input from "./Input";

interface NumberFieldProps {
    label: ReactNode;
    /** undefined = 留空（语义由调用方定义，如 maxTokens 留空 = 不传该参数） */
    value: number | undefined;
    min: number;
    max: number;
    step: number;
    /** 留空或非法输入在失焦时回落到此值 */
    fallback: number;
    /** 是否允许留空；false 时空值直接回落 fallback */
    allowEmpty?: boolean;
    placeholder?: string;
    hint?: ReactNode;
    onChange: (value: number | undefined) => void;
}

/**
 * 数值输入：内部持有字符串草稿，让用户可以自由输入（含清空、输入 "0." 这类中间态），
 * 失焦时才钳制到 [min,max] 并向上冒泡——避免每敲一个字符就把脏值（NaN）写进状态。
 */
export default function NumberField({
    label,
    value,
    min,
    max,
    step,
    fallback,
    allowEmpty = false,
    placeholder,
    hint,
    onChange,
}: NumberFieldProps) {
    const [draft, setDraft] = useState<string>(() =>
        value === undefined ? "" : String(value)
    );

    /** 失焦/回车时提交：空值按 allowEmpty 处理，非法值回落 fallback */
    const commit = () => {
        const raw = draft.trim();
        if (raw === "") {
            if (allowEmpty) {
                onChange(undefined);
                setDraft("");
                return;
            }
            onChange(fallback);
            setDraft(String(fallback));
            return;
        }

        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
            onChange(fallback);
            setDraft(String(fallback));
            return;
        }

        const clamped = Math.min(max, Math.max(min, parsed));
        onChange(clamped);
        setDraft(String(clamped));
    };

    return (
        <Field label={label} hint={hint}>
            <Input
                type="number"
                inputMode="decimal"
                value={draft}
                min={min}
                max={max}
                step={step}
                placeholder={placeholder}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === "Enter") commit();
                }}
            />
        </Field>
    );
}
