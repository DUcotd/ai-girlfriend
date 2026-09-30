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

/**
 * 角色立绘：光晕 + 呼吸中的圆形立绘 + 闪烁星星装饰。
 * 情绪切换用 crossfade：旧立绘作为覆盖层渐隐（300ms），露出底层新立绘；
 * 图片加载失败时按情绪各自回退 emoji（覆盖层沿用旧情绪当时的形态）。
 */
export default function CharacterAvatar({ emotion, onCycle }: CharacterAvatarProps) {
    const [imageError, setImageError] = useState(false);
    const [lastEmotion, setLastEmotion] = useState(emotion);
    /** crossfade 覆盖层：旧情绪 + 其当时的显示形态（是否已回退 emoji） */
    const [prev, setPrev] = useState<{ emotion: EmotionKey; wasError: boolean } | null>(null);

    // emotion prop 变化时：重置图片错误、并把旧情绪交给覆盖层渐隐
    // （React 官方推荐的「随 props 调整 state」写法）
    if (emotion !== lastEmotion) {
        setPrev({ emotion: lastEmotion, wasError: imageError });
        setLastEmotion(emotion);
        setImageError(false);
    }

    const artFor = (e: EmotionKey, useEmoji: boolean, onImgError?: () => void) =>
        useEmoji || !emotionImages[e] ? (
            <span className="text-7xl">{emotionEmojis[e]}</span>
        ) : (
            <img
                src={emotionImages[e]}
                alt={`小爱 - ${emotionLabels[e]}`}
                className="h-full w-full object-cover"
                onError={onImgError}
            />
        );

    return (
        <>
            {/* 光晕 */}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="h-56 w-56 rounded-full bg-gradient-to-br from-accent-1/30 to-accent-2/30 blur-2xl" />
            </div>

            <div className="relative z-10 text-center">
                {/* 外层：hover 缩放 + 点击循环切换情绪；内层单独跑呼吸动画，避免 transform 互相覆盖 */}
                <div
                    className="relative h-52 w-52 cursor-pointer rounded-full transition-transform duration-fast ease-out-expo hover:scale-105"
                    onClick={() => {
                        const nextIdx = (EMOTION_ORDER.indexOf(emotion) + 1) % EMOTION_ORDER.length;
                        onCycle(EMOTION_ORDER[nextIdx]);
                    }}
                >
                    <div className="animate-breathe flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-accent-1/20 to-accent-2/20 shadow-xl">
                        {artFor(emotion, imageError, () => setImageError(true))}
                    </div>

                    {/* crossfade 覆盖层：旧立绘渐隐后自动卸载 */}
                    {prev && (
                        <div
                            key={`${prev.emotion}->${lastEmotion}`}
                            className="animate-avatar-fade-out pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-accent-1/20 to-accent-2/20"
                            onAnimationEnd={() => setPrev(null)}
                        >
                            {artFor(prev.emotion, prev.wasError)}
                        </div>
                    )}
                </div>
            </div>

            <span className="star absolute right-4 top-4 text-xl">✨</span>
            <span className="star absolute bottom-8 left-4 text-xl" style={{ animationDelay: "0.5s" }}>💫</span>
            <span className="star absolute left-2 top-1/3 text-sm" style={{ animationDelay: "1s" }}>⭐</span>
        </>
    );
}
