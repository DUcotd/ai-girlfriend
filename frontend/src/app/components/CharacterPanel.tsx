"use client";

/* 立绘是 public/characters 下的静态小图，且图片缺失时需要 onError 回退到 emoji，
   next/image 无法提供该回退，故本文件保留原生 <img> */
/* eslint-disable @next/next/no-img-element */

import { useState } from "react";
import type { CurrentActivity, EmotionalState } from "@/types";

interface CharacterPanelProps {
    emotion: string;
    affinity: number;
    currentActivity?: CurrentActivity | null;
    emotionalState?: EmotionalState | null;
}

/**
 * 立绘原图是 1024x1024 的 PNG（单张 600~800KB），而实际显示只有 192px 见方，
 * 已统一转成 512x512 的 WebP（单张 26~54KB，总体积 -95%）。
 * 缺失的情绪不列入此表，直接走 emoji 回退，避免发出无谓的 404 请求。
 */
const emotionImages: Record<string, string> = {
    default: "/characters/default.webp",
    happy: "/characters/happy.webp",
    shy: "/characters/shy.webp",
    thinking: "/characters/thinking.webp",
    sleepy: "/characters/sleepy.webp",
};

const emotionEmojis: Record<string, string> = {
    default: "😊",
    happy: "😆",
    shy: "😳",
    thinking: "🤔",
    sleepy: "😴",
    sad: "😢",
    angry: "😤",
};

/** 立绘支持的情绪种类（必须有对应图片与 emoji/label） */
type EmotionKey = keyof typeof emotionImages;
const EMOTION_ORDER: EmotionKey[] = ["default", "happy", "shy", "thinking", "sleepy", "sad", "angry"];

const emotionLabels: Record<string, string> = {
    default: "开心",
    happy: "超开心",
    shy: "害羞",
    thinking: "思考中",
    sleepy: "困困的",
    sad: "难过",
    angry: "傲娇",
};

const emotionMap: Record<string, string> = {
    // 正面
    "开心": "happy", "狂喜": "happy", "兴奋": "happy", "亢奋": "happy",
    "满足": "default", "平静": "default",
    // 害羞/顺从
    "害羞": "shy", "羞涩": "shy", "撒娇": "shy", "依赖": "shy", "傲娇": "shy",
    // 思考/强势
    "思考": "thinking", "强势": "thinking", "焦虑": "thinking",
    // 困倦
    "困": "sleepy", "困倦": "sleepy",
    // 负面
    "难过": "sad", "伤心": "sad", "抑郁": "sad", "低落": "sad",
    // 愤怒
    "生气": "angry", "愤怒": "angry", "暴躁": "angry", "烦躁": "angry",
    // 兼容旧标签
    "default": "default", "happy": "happy", "shy": "shy",
    "thinking": "thinking", "sleepy": "sleepy", "sad": "sad", "angry": "angry",
    "pleasant": "default", "friendly": "default",
};

/** 把后端返回的情绪标签映射到立绘支持的情绪种类 */
function normalizeEmotion(emotion: string): EmotionKey {
    return (emotionMap[emotion] || (emotionImages[emotion] ? emotion : "default")) as EmotionKey;
}

export default function CharacterPanel({ emotion, affinity, currentActivity, emotionalState }: CharacterPanelProps) {
    const [imageError, setImageError] = useState(false);
    // 点击立绘可手动切换情绪（预览用）；后端情绪变化时清除手动覆盖
    const [override, setOverride] = useState<EmotionKey | null>(null);
    const [lastEmotion, setLastEmotion] = useState(emotion);

    // emotion prop 变化时同步重置（React 官方推荐的「随 props 调整 state」写法）
    if (emotion !== lastEmotion) {
        setLastEmotion(emotion);
        setOverride(null);
        setImageError(false);
    }

    const currentEmotion = override ?? normalizeEmotion(emotion);

    const hearts = Array.from({ length: 5 }, (_, i) => {
        const threshold = (i + 1) * 20;
        return affinity >= threshold;
    });

    const getAffinityTitle = () => {
        if (affinity >= 80) return "最爱的人";
        if (affinity >= 60) return "亲密恋人";
        if (affinity >= 40) return "甜蜜约会";
        if (affinity >= 20) return "好感上升";
        return "初次相识";
    };

    return (
        <div className="card-cute p-6 h-full flex flex-col">
            <div className="text-center mb-4">
                <h2 className="text-2xl font-bold gradient-text">小爱</h2>
                <p className="text-sm text-gray-500 mt-1">
                    {getAffinityTitle()} · {emotionLabels[currentEmotion]}
                </p>
            </div>

            <div className="flex justify-center gap-1 mb-4">
                {hearts.map((filled, idx) => (
                    <span
                        key={idx}
                        className={`affinity-heart ${filled ? "filled" : "empty"}`}
                        style={{ animationDelay: `${idx * 0.1}s` }}
                    >
                        {filled ? "❤️" : "🤍"}
                    </span>
                ))}
            </div>

            <div className="mb-6">
                <div className="flex justify-between text-xs text-gray-500 mb-1">
                    <span>好感度</span>
                    <span>{affinity}/100</span>
                </div>
                <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{
                            width: `${affinity}%`,
                            background: "linear-gradient(90deg, #ffb7c5, #ff6b8a)",
                        }}
                    />
                </div>
            </div>

            <div className="flex-1 flex items-center justify-center relative character-container">
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="w-48 h-48 rounded-full bg-gradient-to-br from-pink-200/30 to-purple-200/30 blur-2xl" />
                </div>

                <div className="relative z-10 text-center">
                    <div
                        className="w-48 h-48 rounded-full overflow-hidden bg-gradient-to-br from-pink-100 to-purple-100 flex items-center justify-center shadow-xl transition-all duration-300 hover:scale-105 cursor-pointer"
                        onClick={() => {
                            const nextIdx = (EMOTION_ORDER.indexOf(currentEmotion) + 1) % EMOTION_ORDER.length;
                            setOverride(EMOTION_ORDER[nextIdx]);
                            setImageError(false);
                        }}
                    >
                        {imageError || !emotionImages[currentEmotion] ? (
                            <span className="text-6xl">{emotionEmojis[currentEmotion]}</span>
                        ) : (
                            <img
                                src={emotionImages[currentEmotion]}
                                alt={`小爱 - ${emotionLabels[currentEmotion]}`}
                                className="w-full h-full object-cover"
                                onError={() => setImageError(true)}
                            />
                        )}
                    </div>
                </div>

                <span className="star absolute top-4 right-4 text-xl">✨</span>
                <span className="star absolute bottom-8 left-4 text-xl" style={{ animationDelay: "0.5s" }}>💫</span>
                <span className="star absolute top-1/3 left-2 text-sm" style={{ animationDelay: "1s" }}>⭐</span>
            </div>

            <div className="mt-4 flex justify-center gap-2 flex-wrap">
                <span className="emotion-badge">
                    {emotionEmojis[currentEmotion]} {emotionLabels[currentEmotion]}
                </span>
                {currentActivity && (
                    <span className="emotion-badge bg-gradient-to-r from-pink-50 to-purple-50 border-pink-200">
                        {currentActivity.emoji} {currentActivity.activity}
                    </span>
                )}
                {emotionalState?.label && emotionalState.label !== emotionLabels[currentEmotion] && (
                    <span className="emotion-badge bg-blue-50 border-blue-200 text-blue-600">
                        💭 {emotionalState.label}
                    </span>
                )}
            </div>

            {emotionalState && (
                <div className="mt-6 bg-gray-50/80 rounded-xl p-3 text-xs border border-gray-100">
                    <div className="text-gray-400 mb-2 font-medium flex justify-between">
                        <span>🧠 心理状态</span>
                        <span className="text-[10px] opacity-70">P/A/D 三维情绪模型</span>
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <span className="w-4 text-center">{emotionalState.current.P > 0 ? "😄" : "😢"}</span>
                            <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                                <div
                                    className={`h-full rounded-full ${emotionalState.current.P > 0 ? "bg-green-400" : "bg-blue-400"}`}
                                    style={{ width: `${Math.abs(emotionalState.current.P) * 100}%`, marginLeft: emotionalState.current.P < 0 ? 0 : 'auto', marginRight: emotionalState.current.P > 0 ? 0 : 'auto' }}
                                />
                            </div>
                            <span className="w-8 text-right font-mono text-gray-500">{emotionalState.current.P.toFixed(1)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="w-4 text-center">{emotionalState.current.A > 0 ? "⚡" : "💤"}</span>
                            <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                                <div
                                    className={`h-full rounded-full ${emotionalState.current.A > 0 ? "bg-red-400" : "bg-purple-400"}`}
                                    style={{ width: `${Math.abs(emotionalState.current.A) * 100}%` }}
                                />
                            </div>
                            <span className="w-8 text-right font-mono text-gray-500">{emotionalState.current.A.toFixed(1)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="w-4 text-center">{emotionalState.current.D > 0 ? "👑" : "🥺"}</span>
                            <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                                <div
                                    className={`h-full rounded-full ${emotionalState.current.D > 0 ? "bg-amber-400" : "bg-pink-400"}`}
                                    style={{ width: `${Math.abs(emotionalState.current.D) * 100}%` }}
                                />
                            </div>
                            <span className="w-8 text-right font-mono text-gray-500">{emotionalState.current.D.toFixed(1)}</span>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
