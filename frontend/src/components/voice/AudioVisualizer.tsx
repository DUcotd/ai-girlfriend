"use client";

import { useEffect, useRef } from "react";

interface AudioVisualizerProps {
    stream: MediaStream | null;
    isRecording: boolean;
}

/** 画布的逻辑（CSS）尺寸：改变它只会改清晰度，不会改版面 */
const CSS_WIDTH = 120;
const CSS_HEIGHT = 32;
/** dpr 上限 2：3x 屏上按真实 dpr 铺Backing store 会让每帧代价再翻一倍，肉眼看不出差别 */
const MAX_DPR = 2;

/**
 * 录音电平条。
 *
 * 性能要点（都是原来实现在录音时每帧在做的事）：
 * ① 渐变以前是「每根柱子 × 每帧」新建一个 CanvasGradient（32 根 × 60fps ≈ 每秒 2000 个对象），
 *    柱高变化只是柱子的高度不同，颜色走向其实一致 → 提到循环外建一次，整段共用。
 * ② 画布以前只有 120×32 的 backing store，在 2x/3x 屏上被拉伸显示 → 糊。
 *    现在按 devicePixelRatio 放大后备缓冲，再用 setTransform 把坐标归一回 CSS 像素，
 *    绘图代码仍旧按 120×32 的逻辑坐标写，视觉尺寸不变。
 */
export default function AudioVisualizer({ stream, isRecording }: AudioVisualizerProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
        canvas.width = Math.round(CSS_WIDTH * dpr);
        canvas.height = Math.round(CSS_HEIGHT * dpr);
        // setTransform 而不是 scale：effect 可能重跑，scale 会累乘
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, CSS_WIDTH, CSS_HEIGHT);

        // 不在录音时组件本身就不渲染（见下面 return null），这里只负责收尾状态
        if (!stream || !isRecording) return;

        const audioContext = new AudioContext();
        const analyser = audioContext.createAnalyser();
        const source = audioContext.createMediaStreamSource(stream);
        analyser.fftSize = 64;
        source.connect(analyser);

        // 柱条渐变色跟随主题 token（canvas 吃不了 Tailwind 类，从 CSS 变量读）
        const rootStyle = getComputedStyle(document.documentElement);
        const barColorStart = `hsl(${rootStyle.getPropertyValue("--accent-1").trim()})`;
        const barColorEnd = `hsl(${rootStyle.getPropertyValue("--accent-2").trim()})`;
        const gradient = ctx.createLinearGradient(0, CSS_HEIGHT, 0, 0);
        gradient.addColorStop(0, barColorStart);
        gradient.addColorStop(1, barColorEnd);

        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        const paint = () => {
            analyser.getByteFrequencyData(dataArray);
            ctx.clearRect(0, 0, CSS_WIDTH, CSS_HEIGHT);
            ctx.fillStyle = gradient;

            const slot = CSS_WIDTH / bufferLength;
            const barWidth = slot * 0.8;
            const gap = slot * 0.2;
            let x = 0;
            for (let i = 0; i < bufferLength; i++) {
                const barHeight = (dataArray[i] / 255) * CSS_HEIGHT * 0.9;
                ctx.beginPath();
                ctx.roundRect(x, CSS_HEIGHT - barHeight, barWidth, barHeight, 2);
                ctx.fill();
                x += barWidth + gap;
            }
        };

        let rafId: number | null = null;
        const stopLoop = () => {
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
        };
        const startLoop = () => {
            if (rafId !== null) return;
            const draw = () => {
                paint();
                rafId = requestAnimationFrame(draw);
            };
            rafId = requestAnimationFrame(draw);
        };

        // 「减少动态效果」：不跑 rAF 循环，只画一帧当前电平（静态条形同样读得出在录）
        const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
        const applyMotionPreference = () => {
            if (motionQuery.matches) {
                stopLoop();
                paint();
            } else {
                startLoop();
            }
        };
        applyMotionPreference();
        motionQuery.addEventListener("change", applyMotionPreference);

        return () => {
            stopLoop();
            motionQuery.removeEventListener("change", applyMotionPreference);
            source.disconnect();
            void audioContext.close();
        };
    }, [stream, isRecording]);

    if (!isRecording) return null;

    return (
        <canvas
            ref={canvasRef}
            // 逻辑尺寸交给 CSS，后备缓冲由 effect 按 dpr 写（width/height 属性会被 effect 覆盖）
            width={CSS_WIDTH}
            height={CSS_HEIGHT}
            style={{ width: CSS_WIDTH, height: CSS_HEIGHT }}
            className="rounded-lg"
        />
    );
}
