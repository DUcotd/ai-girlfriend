"use client";

import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    size?: ButtonSize;
}

const variantClasses: Record<ButtonVariant, string> = {
    // 原 .btn-cute：accent 渐变 + 浮起阴影
    primary:
        "bg-gradient-to-br from-accent-1 to-accent-2 text-white shadow-accent hover:-translate-y-0.5 hover:shadow-accent-hover active:translate-y-0 active:scale-[0.98]",
    secondary:
        "bg-surface-1 border border-line-subtle text-content-secondary hover:bg-surface-2 hover:text-content-primary",
    danger:
        "border border-status-danger/40 text-status-danger shadow-sm hover:bg-status-danger hover:text-white",
    ghost: "text-content-muted hover:bg-surface-2 hover:text-content-secondary",
};

const sizeClasses: Record<ButtonSize, string> = {
    sm: "px-3 py-1.5 text-xs",
    md: "px-4 py-2 text-sm",
};

/** 通用按钮：primary（渐变胶囊）/ secondary / danger / ghost。 */
export default forwardRef<HTMLButtonElement, ButtonProps>(function Button(
    { variant = "primary", size = "md", className, type = "button", ...props },
    ref
) {
    return (
        <button
            ref={ref}
            type={type}
            className={cn(
                "rounded-full font-medium transition-all",
                "disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none disabled:shadow-none",
                variantClasses[variant],
                sizeClasses[size],
                className
            )}
            {...props}
        />
    );
});
