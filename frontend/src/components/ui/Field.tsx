"use client";

import type { ReactNode } from "react";

interface FieldProps {
    label: ReactNode;
    /** 控件下方的说明文字 */
    hint?: ReactNode;
    children: ReactNode;
}

/** 表单字段：小号大写 label + 控件 + 可选说明（设置页/向导的通用行）。 */
export default function Field({ label, hint, children }: FieldProps) {
    return (
        <div className="space-y-1">
            <label className="block pl-1 text-[10px] font-bold uppercase tracking-widest text-content-muted">
                {label}
            </label>
            {children}
            {hint && <p className="pl-1 text-[10px] text-content-muted">{hint}</p>}
        </div>
    );
}
