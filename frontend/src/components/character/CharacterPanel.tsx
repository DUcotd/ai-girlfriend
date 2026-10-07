"use client";

import { useState } from "react";
import Card from "../ui/Card";
import ProgressBar from "../ui/ProgressBar";
import AffinityHearts from "./AffinityHearts";
import AffinityReason from "./AffinityReason";
import CharacterAvatar from "./CharacterAvatar";
import EmotionBadges from "./EmotionBadges";
import EmotionTimeline from "./EmotionTimeline";
import PadStateBars from "./PadStateBars";
import StageProgress from "./StageProgress";
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
 *
 * 阶段标签、阶段进度、变化原因全部来自后端下发的元数据（前端零阈值，PRD P0-a/D）：
 * 这里不再有 16/35/60/85 这类本地镜像。
 */
export default function CharacterPanel({ currentActivity }: CharacterPanelProps) {
    const emotion = useChatStore((s) => s.emotion);
    const affinity = useChatStore((s) => s.affinity);
    const emotionalState = useChatStore((s) => s.emotionalState);
    const stageMeta = useChatStore((s) => s.stageMeta);
    const recentChange = useChatStore((s) => s.recentChange);
    const recentReason = useChatStore((s) => s.recentReason);
    const decaying = useChatStore((s) => s.decaying);
    const dailyCapReached = useChatStore((s) => s.dailyCapReached);

    // 点击立绘可手动切换情绪（预览用）；后端情绪变化时清除手动覆盖
    const [override, setOverride] = useState<EmotionKey | null>(null);
    const [lastEmotion, setLastEmotion] = useState(emotion);

    // emotion 变化时同步重置（React 官方推荐的「随 props 调整 state」写法）
    if (emotion !== lastEmotion) {
        setLastEmotion(emotion);
        setOverride(null);
    }

    const currentEmotion = override ?? normalizeEmotion(emotion);

    // 标题行：阶段元数据未到（首帧）时只显示情绪，绝不本地兜底推阶段
    const subtitle = stageMeta
        ? `${stageMeta.stageLabel} · ${emotionLabels[currentEmotion]}`
        : emotionLabels[currentEmotion];

    /*
     * overflow-y-auto + scrollbar-gutter:stable（硬规则③）：侧栏高度随视口变化，
     * 内容超高时可纵向滚动兜底，且滚动条出现时内容不会横跳。
     * 只开纵向：不设 overflow-x-hidden，避免裁掉 hover:scale-105 的立绘与光晕。
     */
    return (
        <Card className="flex h-full flex-col overflow-y-auto p-6 [scrollbar-gutter:stable]">
            <div className="mb-3 text-center">
                <h2 className="gradient-text text-2xl font-bold">小爱</h2>
                <p className="mt-1 text-sm text-content-secondary">{subtitle}</p>
            </div>

            <AffinityHearts affinity={affinity} />

            <div className="mb-4">
                <div className="mb-1 flex justify-between text-xs text-content-secondary">
                    <span>好感度</span>
                    <span>{affinity}/100</span>
                </div>
                <ProgressBar value={affinity} />
                <StageProgress meta={stageMeta} />
            </div>

            <AffinityReason
                recentReason={recentReason}
                recentChange={recentChange}
                decaying={decaying}
                dailyCapReached={dailyCapReached}
            />

            <div className="relative flex flex-1 items-center justify-center">
                <CharacterAvatar emotion={currentEmotion} onCycle={setOverride} />
            </div>

            <EmotionBadges
                currentEmotion={currentEmotion}
                currentActivity={currentActivity}
                emotionalState={emotionalState}
            />

            {emotionalState && <PadStateBars emotionalState={emotionalState} />}

            {/* 情绪走势（REQ-10）：数据点数不够时组件自己不出场，面板不会多一块空框 */}
            <EmotionTimeline />
        </Card>
    );
}
