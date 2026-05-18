"use client";

import { useState, useRef, useEffect } from "react";
import { Volume2, Loader2, Square } from "lucide-react";

interface VoiceButtonProps {
    text: string;
    backendUrl: string;
    size?: number;
    engine?: "openai" | "local";
}

type PlayState = "idle" | "loading" | "playing";

export default function VoiceButton({ text, backendUrl, size = 16, engine = "openai" }: VoiceButtonProps) {
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

    const speakLocal = () => {
        if (!("speechSynthesis" in window)) return;
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = "zh-CN";
        utterance.rate = 1.1;
        utterance.pitch = 1.2;

        const voices = window.speechSynthesis.getVoices();
        const femaleVoice = voices.find(v =>
            (v.name.includes("Xiaoxiao") || v.name.includes("Huihui") || v.name.includes("Ting-Ting") || v.name.includes("female")) && v.lang.includes("zh")
        );
        if (femaleVoice) utterance.voice = femaleVoice;

        utterance.onstart = () => setState("playing");
        utterance.onend = () => setState("idle");
        utterance.onerror = () => setState("idle");

        window.speechSynthesis.speak(utterance);
    };

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
            speakLocal();
            return;
        }

        setState("loading");

        try {
            const res = await fetch(`${backendUrl}/audio/speak`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text }),
            });

            if (!res.ok) {
                const errorData = await res.json().catch(() => ({}));
                const errorMsg = errorData.detail || res.statusText;

                // 检查是否是 API Key 相关错误 (不区分大小写)
                const lowerMsg = errorMsg.toLowerCase();
                const isAuthError = lowerMsg.includes("api key") || lowerMsg.includes("401") || lowerMsg.includes("not configured") || lowerMsg.includes("invalid");

                if (isAuthError) {
                    alert("语音功能需要 OpenAI 官方 API 密钥，请在设置中配置有效且有额度的 TTS API 密钥 ✨");
                } else {
                    console.error("TTS Error:", errorMsg);
                }

                setState("idle");
                return;
            }

            const data = await res.json();
            if (data.audio_url) {
                const audio = new Audio(`${backendUrl}${data.audio_url}`);
                audioRef.current = audio;

                audio.onplay = () => setState("playing");
                audio.onended = () => setState("idle");
                audio.onerror = () => setState("idle");

                await audio.play();
            } else {
                setState("idle");
            }
        } catch (e) {
            console.error("TTS failed", e);
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
