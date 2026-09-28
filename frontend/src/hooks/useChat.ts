"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { setStoredAffinity } from "@/lib/storage";
import type { ChatResponse, EmotionalState, Message } from "@/types";

const REQUEST_TIMEOUT_MS = 60_000;

/** 消息 id：稳定且唯一，供列表 key 与 memo 复用判断 */
let messageSeq = 0;
const nextMessageId = () => `m${++messageSeq}`;

/** 后端历史不带 id，补一个 */
const withIds = (list: Message[]): Message[] =>
  list.map((m) => (m.id ? m : { ...m, id: nextMessageId() }));

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
      setMessages(withIds(history));
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

      setMessages((prev) => [...prev, { id: nextMessageId(), role: "user", content: text }]);
      setIsLoading(true);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      // 先放一条空的 assistant 占位，流式过程中往里面追加文本
      setMessages((prev) => [...prev, { id: nextMessageId(), role: "assistant", content: "" }]);

      /** 把最后一条（占位）替换成指定内容，并挂上内心独白（若有） */
      const finishWith = (content: string, thought?: string | null) =>
        setMessages((prev) => {
          if (prev.length === 0) return prev;
          const next = [...prev];
          const last = next[next.length - 1];
          next[next.length - 1] =
            last.role === "assistant" ? { ...last, content, thought: thought ?? null } : last;
          return next;
        });

      /** Ghosting：把占位换成系统提示 */
      const markGhosting = () =>
        setMessages((prev) => {
          const next = prev.slice(0, -1);
          return [...next, { id: nextMessageId(), role: "system", content: "💔 已读不回..." }];
        });

      const applyMeta = (data: Partial<ChatResponse>) => {
        if (data.emotion) setEmotion(data.emotion);
        if (typeof data.affinity === "number") applyAffinity(data.affinity);
        if (data.emotionalState) setEmotionalState(data.emotionalState);
      };

      const settle = (data: ChatResponse) => {
        applyMeta(data);
        if (data.special_action === "ghosting") {
          markGhosting();
          return;
        }
        const reply = data.reply || "";
        finishWith(reply, data.inner_thought ?? null);
        if (voiceModeRef.current && reply) speakRef.current?.(reply);
      };

      try {
        // 优先流式：模型一边生成，界面一边渲染，首字时间大幅提前
        const data = await api.streamChat(
          text,
          (chunk) =>
            setMessages((prev) => {
              if (prev.length === 0) return prev;
              const next = [...prev];
              const last = next[next.length - 1];
              if (last.role !== "assistant") return prev;
              next[next.length - 1] = {
                ...last,
                content: last.content + chunk,
              };
              return next;
            }),
          controller.signal
        );
        clearTimeout(timeoutId);
        settle(data);
        return;
      } catch (error) {
        const isTimeout = error instanceof Error && error.name === "AbortError";
        clearTimeout(timeoutId);

        // 超时不必重试；其余情况（后端不支持流式等）回退到非流式
        if (!isTimeout) {
          try {
            const data = await api.sendChat(text);
            settle(data);
            return;
          } catch {
            // 两条路都失败，落到下面的统一提示
          }
        }

        finishWith(
          isTimeout ? "⏰ 响应时间过长，请重试..." : "⚠️ 连接中断..."
        );
      } finally {
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
