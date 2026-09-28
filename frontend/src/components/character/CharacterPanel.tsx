"use client";

import { useState } from "react";
import Card from "../ui/Card";
import ProgressBar from "../ui/ProgressBar";
import AffinityHearts from "./AffinityHearts";
import CharacterAvatar from "./CharacterAvatar";
import EmotionBadges from "./EmotionBadges";
import PadStateBars from "./PadStateBars";
import { emotionLabels, normalizeEmotion } from "./emotionMap";
import type { EmotionKey } from "./emotionMap";
import { useChatStore } from "@/stores/chatStore";
import type { CurrentActivity } from "@/types";

interface CharacterPanelProps {
    currentActivity?: CurrentActivity | null;
}

/**
 * 角色面板编排：好感度 / 立绘 / 情绪徽章 / PAD 心理状态。
 * 会话状态从 chatStore 订阅；展示拆分在同目录子组件中。
 */
export default function CharacterPanel({ currentActivity }: CharacterPanelProps) {
    const emotion = useChatStore((s) => s.emotion);
    const affinity = useChatStore((s) => s.affinity);
    const emotionalState = useChatStore((s) => s.emotionalState);

    // 点击立绘可手动切换情绪（预览用）；后端情绪变化时清除手动覆盖
    const [override, setOverride] = useState<EmotionKey | null>(null);
    const [lastEmotion, setLastEmotion] = useState(emotion);

    // emotion 变化时同步重置（React 官方推荐的「随 props 调整 state」写法）
    if (emotion !== lastEmotion) {
        setLastEmotion(emotion);
        setOverride(null);
    }

    const currentEmotion = override ?? normalizeEmotion(emotion);

    const getAffinityTitle = () => {
        if (affinity >= 80) return "最爱的人";
        if (affinity >= 60) return "亲密恋人";
        if (affinity >= 40) return "甜蜜约会";
        if (affinity >= 20) return "好感上升";
        return "初次相识";
    };

    return (
        <Card className="flex h-full flex-col p-6">
            <div className="mb-4 text-center">
                <h2 className="gradient-text text-2xl font-bold">小爱</h2>
                <p className="mt-1 text-sm text-content-secondary">
                    {getAffinityTitle()} · {emotionLabels[currentEmotion]}
                </p>
            </div>

            <AffinityHearts affinity={affinity} />

            <div className="mb-6">
                <div className="mb-1 flex justify-between text-xs text-content-secondary">
                    <span>好感度</span>
                    <span>{affinity}/100</span>
                </div>
                <ProgressBar value={affinity} />
            </div>

            <div className="relative flex flex-1 items-center justify-center">
                <CharacterAvatar emotion={currentEmotion} onCycle={setOverride} />
            </div>

            <EmotionBadges
                currentEmotion={currentEmotion}
                currentActivity={currentActivity}
                emotionalState={emotionalState}
            />

            {emotionalState && <PadStateBars emotionalState={emotionalState} />}
        </Card>
    );
}
