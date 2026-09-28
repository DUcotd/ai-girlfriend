"use client";

import ProgressBar from "../ui/ProgressBar";
import type { EmotionalState } from "@/types";

interface PadStateBarsProps {
    emotionalState: EmotionalState;
}

/**
 * PAD 三维情绪面板（Pleasure/Arousal/Dominance）。
 * 轴向配色是数据可视化语义（正/负极），不随主题色相变化；轨道吃 token。
 */
export default function PadStateBars({ emotionalState }: PadStateBarsProps) {
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
        <div className="mt-6 rounded-xl border border-line-subtle bg-surface-2/60 p-3 text-xs">
            <div className="mb-2 flex justify-between font-medium text-content-muted">
                <span>🧠 心理状态</span>
                <span className="text-[10px] opacity-70">P/A/D 三维情绪模型</span>
            </div>

            <div className="space-y-2">
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
        </div>
    );
}
