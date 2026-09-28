"use client";

import Badge from "../ui/Badge";
import { emotionEmojis, emotionLabels } from "./emotionMap";
import type { EmotionKey } from "./emotionMap";
import type { CurrentActivity, EmotionalState } from "@/types";

interface EmotionBadgesProps {
    currentEmotion: EmotionKey;
    currentActivity?: CurrentActivity | null;
    emotionalState?: EmotionalState | null;
}

/** 情绪徽章行：当前情绪 + 正在做的事 + PAD 心理标签。 */
export default function EmotionBadges({
    currentEmotion,
    currentActivity,
    emotionalState,
}: EmotionBadgesProps) {
    return (
        <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Badge>
                {emotionEmojis[currentEmotion]} {emotionLabels[currentEmotion]}
            </Badge>
            {currentActivity && (
                <Badge className="border border-accent-1/20 bg-gradient-to-r from-accent-1/10 to-accent-2/10">
                    {currentActivity.emoji} {currentActivity.activity}
                </Badge>
            )}
            {emotionalState?.label && emotionalState.label !== emotionLabels[currentEmotion] && (
                <Badge tone="info" className="border border-status-info/20">
                    💭 {emotionalState.label}
                </Badge>
            )}
        </div>
    );
}
