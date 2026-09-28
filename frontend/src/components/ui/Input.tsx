"use client";

import { forwardRef } from "react";
import type { InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/** 原 .input-cute 的组件化：surface/accent token 驱动，暗色模式自然适配。 */
export default forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
    function Input({ className, ...props }, ref) {
        return (
            <input
                ref={ref}
                className={cn(
                    "w-full px-4 py-3 rounded-2xl border-2 border-line-subtle bg-surface-1/90",
                    "text-content-primary placeholder:text-content-muted transition-all",
                    "focus:outline-none focus:border-accent-1 focus:ring-4 focus:ring-accent-1/15",
                    className
                )}
                {...props}
            />
        );
    }
);
