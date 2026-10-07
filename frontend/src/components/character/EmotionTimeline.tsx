"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { describeTrend, toEmotionPoints, toPolyline, type EmotionPoint } from "@/lib/emotionSeries";

const WIDTH = 280;
const HEIGHT = 48;

/**
 * 她的情绪时间线（REQ-10）。
 *
 * `EmotionEngine.history` 早就在记每一次情绪结算（before / delta / after，上限 50 条），
 * 但界面一直没用过 —— 「我最近心情怎么样」她只能说个当下标签，
 * 有了这条线，面板里就多了「这几天她是怎么走过来的」这一层连续感。
 *
 * 数据缺失/后端没起来时整块不渲染（一个展示组件不该制造错误态）。
 */
export default function EmotionTimeline() {
    const [points, setPoints] = useState<EmotionPoint[]>([]);
    const [sentence, setSentence] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        api.getEmotionHistory()
            .then((data) => {
                if (cancelled) return;
                const list = toEmotionPoints(data.history, 50);
                setPoints(list);
                setSentence(describeTrend(list).sentence);
            })
            .catch(() => {
                // 离线或未启用：不显示，也不弹错误（这里没有用户能做的操作）
            });
        return () => {
            cancelled = true;
        };
    }, []);

    if (points.length < 4) return null;
    const line = toPolyline(points, WIDTH, HEIGHT);

    return (
        <div className="mt-3 rounded-xl border border-line-subtle bg-surface-2/60 p-3">
            <p className="mb-1 flex items-center justify-between text-[10px] font-bold text-content-muted">
                <span>📈 情绪走势</span>
                <span className="font-normal opacity-80">近 {points.length} 次心情变化</span>
            </p>
            <svg
                width="100%"
                viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                role="img"
                aria-label={sentence ?? "她的情绪走势折线"}
                preserveAspectRatio="none"
                className="h-12"
            >
                {/* 中性线：P=0 的位置，折线在它上方就是偏开心 */}
                <line x1="0" y1={HEIGHT / 2} x2={WIDTH} y2={HEIGHT / 2} stroke="currentColor" className="text-content-muted opacity-25" strokeWidth="1" strokeDasharray="3 3" />
                <polyline
                    points={line}
                    fill="none"
                    strokeWidth="1.6"
                    strokeLinejoin="round"
                    className="text-accent-1"
                    stroke="currentColor"
                />
            </svg>
            {sentence && <p className="mt-1 text-[10px] text-content-secondary">{sentence}</p>}
        </div>
    );
}
