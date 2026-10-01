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
    /*
     * 情绪徽章必须等宽（min-w 取 3 字标签的自然宽度）：行宽一旦随情绪标签字数
     * （2~3 字）变化，点击立绘切换情绪就会把整行在「一行 / 两行」之间来回翻转。
     * 等宽后行宽与当前情绪无关，折行只由活动/心理标签的内容决定。
     */
    return (
        <div className="mt-2 flex flex-wrap justify-center gap-1.5 whitespace-nowrap">
            <Badge className="min-w-[88px] justify-center px-2.5">
                {emotionEmojis[currentEmotion]} {emotionLabels[currentEmotion]}
            </Badge>
            {currentActivity && (
                <Badge className="border border-accent-1/20 bg-gradient-to-r from-accent-1/10 to-accent-2/10 px-2.5">
                    {currentActivity.emoji} {currentActivity.activity}
                </Badge>
            )}
            {emotionalState?.label && emotionalState.label !== emotionLabels[currentEmotion] && (
                <Badge tone="info" className="border border-status-info/20 px-2.5">
                    💭 {emotionalState.label}
                </Badge>
            )}
        </div>
    );
}
