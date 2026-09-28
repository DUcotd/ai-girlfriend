"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { setStoredAffinity } from "@/lib/storage";
import type { ChatResponse, EmotionalState, Message } from "@/types";

const REQUEST_TIMEOUT_MS = 60_000;

interface UseChatOptions {
  /** 语音模式开启时，收到回复后自动朗读 */
  voiceMode: boolean;
  speak?: (text: string) => void;
  onError?: (message: string) => void;
}

/**
 * 聊天核心逻辑：消息列表、发送、加载状态、好感度与情绪状态同步。
 */
export function useChat({ voiceMode, speak, onError }: UseChatOptions) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [affinity, setAffinity] = useState(35);
  const [emotion, setEmotion] = useState("平静");
  const [emotionalState, setEmotionalState] = useState<EmotionalState | null>(null);

  // 用 ref 保存最新回调，避免因依赖变化而频繁重建函数
  const speakRef = useRef(speak);
  const voiceModeRef = useRef(voiceMode);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    speakRef.current = speak;
    voiceModeRef.current = voiceMode;
    onErrorRef.current = onError;
  }, [speak, voiceMode, onError]);

  const applyAffinity = useCallback((value: number) => {
    setAffinity(value);
    setStoredAffinity(value);
  }, []);

  /** 拉取服务端历史 */
  const fetchHistory = useCallback(async () => {
    try {
      const history = await api.getHistory();
      setMessages(history);
    } catch {
      onErrorRef.current?.("无法加载历史记录");
    }
  }, []);

  const clearChat = useCallback(async () => {
    try {
      await api.clearHistory();
      setMessages([]);
    } catch {
      onErrorRef.current?.("清空失败");
    }
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim()) return;

      setMessages((prev) => [...prev, { role: "user", content: text }]);
      setIsLoading(true);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const data = await api.sendChat(text);
        clearTimeout(timeoutId);

        if (data.emotion) setEmotion(data.emotion);
        if (typeof data.affinity === "number") applyAffinity(data.affinity);
        if (data.emotionalState) setEmotionalState(data.emotionalState);

        // Ghosting：AI 已读不回
        if (data.special_action === "ghosting") {
          setMessages((prev) => [
            ...prev,
            { role: "system", content: "💔 已读不回..." },
          ]);
          return;
        }

        const reply = data.reply || "";
        setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
        if (voiceModeRef.current && reply) speakRef.current?.(reply);
      } catch (error) {
        const isTimeout = error instanceof Error && error.name === "AbortError";
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: isTimeout
              ? "⏰ 响应时间过长，请重试..."
              : "⚠️ 连接中断...",
          },
        ]);
      } finally {
        clearTimeout(timeoutId);
        setIsLoading(false);
      }
    },
    [applyAffinity]
  );

  /** 启动时同步一次服务端状态 */
  const syncState = useCallback(async () => {
    try {
      const state = await api.getState();
      if (typeof state.affinity === "number") applyAffinity(state.affinity);
      if (state.emotionalState) setEmotionalState(state.emotionalState);
    } catch {
      // 后端未启动时不阻断页面渲染
    }
  }, [applyAffinity]);

  return {
    messages,
    setMessages,
    isLoading,
    affinity,
    setAffinity: applyAffinity,
    emotion,
    emotionalState,
    sendMessage,
    fetchHistory,
    clearChat,
    syncState,
  };
}

export type ChatApi = ReturnType<typeof useChat>;
export type { ChatResponse };
