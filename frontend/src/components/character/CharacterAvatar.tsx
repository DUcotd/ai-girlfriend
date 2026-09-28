"use client";

/* 立绘是 public/characters 下的静态小图，且图片缺失时需要 onError 回退到 emoji，
   next/image 无法提供该回退，故本文件保留原生 <img> */
/* eslint-disable @next/next/no-img-element */

import { useState } from "react";
import { EMOTION_ORDER, emotionEmojis, emotionImages, emotionLabels } from "./emotionMap";
import type { EmotionKey } from "./emotionMap";

interface CharacterAvatarProps {
    emotion: EmotionKey;
    /** 点击立绘循环切换情绪（预览用） */
    onCycle: (next: EmotionKey) => void;
}

/** 角色立绘：光晕 + 圆形立绘 + 闪烁星星装饰。 */
export default function CharacterAvatar({ emotion, onCycle }: CharacterAvatarProps) {
    const [imageError, setImageError] = useState(false);
    const [lastEmotion, setLastEmotion] = useState(emotion);

    // emotion prop 变化时重置图片错误（React 官方推荐的「随 props 调整 state」写法）
    if (emotion !== lastEmotion) {
        setLastEmotion(emotion);
        setImageError(false);
    }

    return (
        <>
            {/* 光晕 */}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="h-48 w-48 rounded-full bg-gradient-to-br from-accent-1/30 to-accent-2/30 blur-2xl" />
            </div>

            <div className="relative z-10 text-center">
                <div
                    className="flex h-48 w-48 cursor-pointer items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-accent-1/20 to-accent-2/20 shadow-xl transition-all duration-300 hover:scale-105"
                    onClick={() => {
                        const nextIdx = (EMOTION_ORDER.indexOf(emotion) + 1) % EMOTION_ORDER.length;
                        onCycle(EMOTION_ORDER[nextIdx]);
                    }}
                >
                    {imageError || !emotionImages[emotion] ? (
                        <span className="text-6xl">{emotionEmojis[emotion]}</span>
                    ) : (
                        <img
                            src={emotionImages[emotion]}
                            alt={`小爱 - ${emotionLabels[emotion]}`}
                            className="h-full w-full object-cover"
                            onError={() => setImageError(true)}
                        />
                    )}
                </div>
            </div>

            <span className="star absolute right-4 top-4 text-xl">✨</span>
            <span className="star absolute bottom-8 left-4 text-xl" style={{ animationDelay: "0.5s" }}>💫</span>
            <span className="star absolute left-2 top-1/3 text-sm" style={{ animationDelay: "1s" }}>⭐</span>
        </>
    );
}
