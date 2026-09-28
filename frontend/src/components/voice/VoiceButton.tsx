"use client";

import { useState, useRef, useEffect } from "react";
import { Volume2, Loader2, Square } from "lucide-react";
import { api, BACKEND_URL } from "@/lib/api";
import { speakLocal } from "@/lib/speech";
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
            // 鉴权类错误给出可操作的提示，其余仅打日志
            const msg = (e instanceof Error ? e.message : "").toLowerCase();
            if (
                msg.includes("api key") ||
                msg.includes("invalid") ||
                msg.includes("not configured")
            ) {
                alert("语音功能需要 OpenAI 官方 API 密钥，请在设置中配置有效且有额度的 TTS API 密钥 ✨");
            } else {
                console.error("TTS failed", e);
            }
            setState("idle");
        }
    };

    return (
        <button
            onClick={handleClick}
            className={`p-1.5 rounded-full transition-all hover:bg-pink-100 ${state === "playing" ? "text-pink-500 bg-pink-50" : "text-gray-400"
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
