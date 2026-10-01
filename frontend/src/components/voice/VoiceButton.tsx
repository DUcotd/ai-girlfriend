"use client";

import { useState, useRef, useEffect } from "react";
import { Volume2, Loader2, Square } from "lucide-react";
import { api, BACKEND_URL } from "@/lib/api";
import { speakLocal } from "@/lib/speech";
import { isTtsConfigured } from "@/lib/storage";
import { toast } from "@/stores/uiStore";
import type { TtsEngine } from "@/types";

interface VoiceButtonProps {
    text: string;
    size?: number;
    engine?: TtsEngine;
}

type PlayState = "idle" | "loading" | "playing";

export default function VoiceButton({ text, size = 16, engine = "openai" }: VoiceButtonProps) {
    const [state, setState] = useState<PlayState>("idle");
    const audioRef = useRef<HTMLAudioElement | null>(null);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current = null;
            }
            if (engine === "local") {
                window.speechSynthesis.cancel();
            }
        };
    }, [engine]);

    const handleClick = async () => {
        // If playing, stop
        if (state === "playing") {
            if (engine === "local") {
                window.speechSynthesis.cancel();
            } else if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current.currentTime = 0;
            }
            setState("idle");
            return;
        }

        // If loading, do nothing
        if (state === "loading") return;

        if (engine === "local") {
            speakLocal(text);
            return;
        }

        // 选了云端引擎但没配专属 TTS Key → 云端不启用，回退本地朗读（与 useSpeech 同一语义）
        if (!isTtsConfigured()) {
            toast("云端语音未配置 TTS 密钥，已使用浏览器本地语音", "info");
            speakLocal(text);
            return;
        }

        setState("loading");

        try {
            const { audio_url } = await api.textToSpeech(text);
            if (audio_url) {
                const audio = new Audio(`${BACKEND_URL}${audio_url}`);
                audioRef.current = audio;

                audio.onplay = () => setState("playing");
                audio.onended = () => setState("idle");
                audio.onerror = () => setState("idle");

                await audio.play();
            } else {
                setState("idle");
            }
        } catch (e) {
            // 后端现在会把 4xx 的 detail（key 未配置/无效）原样透传，关键字分支可以命中；
            // 其余（网络错误等）也必须有反馈，不能让用户点了没任何反应
            const msg = (e instanceof Error ? e.message : "").toLowerCase();
            if (
                msg.includes("api key") ||
                msg.includes("invalid") ||
                msg.includes("not configured")
            ) {
                toast("语音功能需要 OpenAI 官方 API 密钥，请在设置中配置有效且有余量的 TTS 密钥 ✨", "error");
            } else {
                console.error("TTS failed", e);
                toast("语音服务暂时不可用，请稍后再试", "error");
            }
            setState("idle");
        }
    };

    return (
        <button
            onClick={handleClick}
            className={`rounded-full p-1.5 transition-all hover:bg-accent-1/15 ${state === "playing" ? "bg-accent-1/10 text-accent-1" : "text-content-muted"
                }`}
            title={state === "playing" ? "停止播放" : "播放语音"}
        >
            {state === "loading" && (
                <Loader2 size={size} className="animate-spin" />
            )}
            {state === "playing" && (
                <Square size={size} className="fill-current" />
            )}
            {state === "idle" && (
                <Volume2 size={size} />
            )}
        </button>
    );
}
