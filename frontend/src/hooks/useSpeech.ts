"use client";

import { useCallback, useRef, useState } from "react";
import { api, BACKEND_URL } from "@/lib/api";
import { speakLocal } from "@/lib/speech";
import type { TtsEngine } from "@/types";

/**
 * TTS 朗读：云端（后端 OpenAI TTS）或本地（浏览器 Web Speech API）。
 */
export function useSpeech(engine: TtsEngine) {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stop = useCallback(() => {
    if (engine === "local") {
      window.speechSynthesis?.cancel();
    } else if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setIsSpeaking(false);
  }, [engine]);

  const speak = useCallback(
    async (text: string) => {
      if (!text) return;

      if (engine === "local") {
        speakLocal(text);
        setIsSpeaking(true);
        return;
      }

      try {
        setIsSpeaking(true);
        const { audio_url } = await api.textToSpeech(text);
        const audio = new Audio(`${BACKEND_URL}${audio_url}`);
        audioRef.current = audio;
        audio.onended = () => setIsSpeaking(false);
        audio.onerror = () => setIsSpeaking(false);
        await audio.play();
      } catch {
        setIsSpeaking(false);
      }
    },
    [engine]
  );

  return { speak, stop, isSpeaking };
}
