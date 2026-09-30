"use client";

import { cn } from "@/lib/cn";

interface AffinityHeartsProps {
    affinity: number;
}

/** 五颗好感度心心：每 20 点点亮一颗。 */
export default function AffinityHearts({ affinity }: AffinityHeartsProps) {
    const hearts = Array.from({ length: 5 }, (_, i) => affinity >= (i + 1) * 20);

    return (
        <div className="mb-3 flex justify-center gap-1">
            {hearts.map((filled, idx) => (
                <span
                    key={idx}
                    className={cn(
                        "inline-block text-xl transition-all duration-300",
                        filled
                            ? "drop-shadow-[0_0_4px_hsl(var(--accent-pop)/0.5)]"
                            : "opacity-40"
                    )}
                >
                    {filled ? "❤️" : "🤍"}
                </span>
            ))}
        </div>
    );
}
