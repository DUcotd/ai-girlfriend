"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import ProgressBar from "../ui/ProgressBar";
import { cn } from "@/lib/cn";
import type { EmotionalState } from "@/types";

interface PadStateBarsProps {
    emotionalState: EmotionalState;
}

/**
 * PAD 三维情绪面板（Pleasure/Arousal/Dominance）。默认展开，点击标题行收起。
 * 轴向配色是数据可视化语义（正/负极），不随主题色相变化；轨道吃 token。
 */
export default function PadStateBars({ emotionalState }: PadStateBarsProps) {
    const [expanded, setExpanded] = useState(true);
    const { P, A, D } = emotionalState.current;

    const axes = [
        {
            value: P,
            emoji: P > 0 ? "😄" : "😢",
            fill: P > 0 ? "bg-green-400" : "bg-blue-400",
            // P 轴正负分侧：正值条靠右、负值靠左
            style: { marginLeft: P < 0 ? 0 : "auto", marginRight: P > 0 ? 0 : "auto" } as const,
        },
        {
            value: A,
            emoji: A > 0 ? "⚡" : "💤",
            fill: A > 0 ? "bg-red-400" : "bg-purple-400",
            style: undefined,
        },
        {
            value: D,
            emoji: D > 0 ? "👑" : "🥺",
            fill: D > 0 ? "bg-amber-400" : "bg-pink-400",
            style: undefined,
        },
    ];

    return (
        <div className="mt-4 rounded-xl border border-line-subtle bg-surface-2/60 p-3 text-xs">
            <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="flex w-full items-center justify-between font-medium text-content-muted transition-colors duration-fast hover:text-content-secondary"
            >
                <span>🧠 心理状态</span>
                <span className="flex items-center gap-1 text-[10px] opacity-70">
                    P/A/D 三维情绪模型
                    <ChevronDown
                        size={14}
                        className={cn(
                            "transition-transform duration-normal ease-out-expo",
                            expanded && "rotate-180"
                        )}
                    />
                </span>
            </button>

            {expanded && (
                <div className="mt-2 space-y-2">
                    {axes.map((axis, i) => (
                        <div key={i} className="flex items-center gap-2">
                            <span className="w-4 text-center">{axis.emoji}</span>
                            <ProgressBar
                                value={Math.abs(axis.value) * 100}
                                gradient={false}
                                className="h-1.5 flex-1 bg-content-muted/15"
                                fillClassName={axis.fill}
                                fillStyle={axis.style}
                            />
                            <span className="w-8 text-right font-mono text-content-secondary">
                                {axis.value.toFixed(1)}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
