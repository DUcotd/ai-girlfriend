"use client";

import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/** 原 .card-cute：玻璃拟态卡片（surface token + accent 描边 + shadow-card）。 */
export default function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn(
                "rounded-[24px] border border-accent-1/15 bg-surface-1/85 backdrop-blur-xl shadow-card",
                className
            )}
            {...props}
        />
    );
}
