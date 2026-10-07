"use client";

import { Children, cloneElement, isValidElement, useId } from "react";
import type { ReactElement, ReactNode } from "react";

interface FieldProps {
    label: ReactNode;
    /** 控件下方的说明文字 */
    hint?: ReactNode;
    /** 错误/警示文字（同样通过 aria-describedby 挂到控件上） */
    error?: ReactNode;
    /**
     * 控件已有 id 时（如调用方自己写了 id 或用 useId 生成）传进来，
     * 否则 Field 会用 useId 生成一个稳定 id 注入到第一个控件上。
     */
    controlId?: string;
    children: ReactNode;
}

/** 可注入控件的无障碍属性（Input / 我们的原语都会把多余 props 转发到真实控件上） */
type ControlProps = {
    id?: string;
    "aria-labelledby"?: string;
    "aria-describedby"?: string;
};

/**
 * 表单字段：小号大写 label + 控件 + 可选说明（设置页/向导的通用行）。
 *
 * 无障碍：label 必须和控件建立**程序可读**的关联（htmlFor ↔ id），
 * 否则读屏只念得出 label 文字、却说不清它属于哪个输入框；
 * 说明/错误文字再用 aria-describedby 挂上，读屏聚焦控件时会连说明一起念。
 * 注入方式是把 id 与 aria-describedby 透传给第一个元素子节点——
 * 原生 Input / 我们自己的原语都会把多余 props 转发到真实控件上；
 * 个别只白名单 props 的组件（如 Select 走 ariaLabel）本来就自带名称，
 * 注入不进去也不影响可读性，此时用 controlId 显式指定或直接依赖其 aria-label。
 */
export default function Field({ label, hint, error, controlId, children }: FieldProps) {
    // useId：同一棵树里稳定唯一，服务端/客户端 hydration 也一致（不能写死自增计数）。
    // 顺手剥掉 React 前后的 :r: / «r» 标点，让 id 也能安全用于 CSS 选择器。
    const generatedId = `field-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
    const kids = Children.toArray(children);
    const firstIndex = kids.findIndex(isValidElement);
    const firstChild = firstIndex >= 0 ? kids[firstIndex] : null;
    // 控件自带 id 时优先用它，避免同一个控件被换上两个 id
    const existingId = isValidElement(firstChild)
        ? ((firstChild.props as ControlProps | undefined)?.id ?? null)
        : null;
    const resolvedId = controlId ?? existingId ?? generatedId;

    const labelId = `${resolvedId}-label`;
    const hintId = hint ? `${resolvedId}-hint` : null;
    const errorId = error ? `${resolvedId}-error` : null;
    const describedBy = [hintId, errorId].filter(Boolean).join(" ");

    // 只给第一个控件注入属性；后面的兄弟节点是说明文案，不该被当成控件。
    // 除了 htmlFor（只对 labelable 元素生效）再补一份 aria-labelledby：
    // radiogroup / slider 这类 role 元素不是 labelable，光有 htmlFor 关联不上。
    const content = kids.map((kid, i) => {
        if (i !== firstIndex || !isValidElement(kid)) return kid;
        const injected: ControlProps = { id: resolvedId, "aria-labelledby": labelId };
        if (describedBy) injected["aria-describedby"] = describedBy;
        return cloneElement(kid as ReactElement<ControlProps>, injected);
    });

    return (
        <div className="space-y-1">
            <label
                id={labelId}
                htmlFor={resolvedId}
                className="block pl-1 text-[10px] font-bold uppercase tracking-widest text-content-muted"
            >
                {label}
            </label>
            {content}
            {hint && (
                <p id={hintId ?? undefined} className="pl-1 text-[10px] text-content-muted">
                    {hint}
                </p>
            )}
            {error && (
                <p id={errorId ?? undefined} className="pl-1 text-[10px] text-status-danger">
                    {error}
                </p>
            )}
        </div>
    );
}
