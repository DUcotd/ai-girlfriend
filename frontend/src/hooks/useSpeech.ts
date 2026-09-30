"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { speakBus } from "@/hooks/useChatStream";
import { api, BACKEND_URL } from "@/lib/api";
import { speakLocal } from "@/lib/speech";
import { useSettingsStore } from "@/stores/settingsStore";
import { useUiStore } from "@/stores/uiStore";

/**
 * TTS 朗读：云端（后端 OpenAI TTS）或本地（浏览器 Web Speech API）。
 * 引擎从 settingsStore 读取；实现注册到 speakBus，
 * 供发送管线/主动消息轮询等非组件环境调用。
 */
export function useSpeech() {
  const engine = useSettingsStore((s) => s.ttsEngine);
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
        setIsSpeaking(true);
        // onend 复位 speaking 状态：此前本地分支没有任何复位路径
        speakLocal(text, () => setIsSpeaking(false));
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
      } catch (e: unknown) {
        setIsSpeaking(false);
        // 云端 TTS 失败此前完全静默：key 未配置/无效/无额度时用户点了没任何反应。
        // 语音模式自动朗读与主动消息朗读也走这里，必须给一条可感知的提示
        console.warn("[Speech] TTS failed:", e);
        useUiStore.getState().pushToast(
          e instanceof Error && e.message ? `朗读失败：${e.message}` : "朗读失败",
          "error",
        );
      }
    },
    [engine]
  );

  // 注册全局朗读者（组件卸载时注销）
  useEffect(() => {
    speakBus.register(speak);
    return () => speakBus.register(null);
  }, [speak]);

  return { speak, stop, isSpeaking };
}
