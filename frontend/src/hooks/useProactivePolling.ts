"use client";

import { useEffect, useRef } from "react";
import { speakBus } from "@/hooks/useChatStream";
import { api } from "@/lib/api";
import { playNotificationSound } from "@/lib/notifySound";
import { useUiStore } from "@/stores/uiStore";
import type { ProactiveMessage } from "@/types";

const IDLE_THRESHOLD_MS = 5 * 60 * 1000;
const ACTIVE_INTERVAL_MS = 15_000;
const IDLE_INTERVAL_MS = 60_000;

const REASON_ICONS: Record<string, string> = {
  morning_greeting: "🌅",
  night_greeting: "🌙",
  miss_you: "💕",
  mood_check: "💝",
  task_reminder: "📝",
  random_chat: "✨",
  memory_share: "💭",
};

/**
 * 主动消息轮询。
 *
 * 递归 setTimeout：每次触发后按当前空闲状态重新计算下一次间隔，
 * 间隔变化即时生效且不会叠加多个定时器。
 * 语音朗读改经 speakBus（useSpeech 注册），voiceMode 读 uiStore。
 */
export function useProactivePolling({
  onMessage,
}: {
  onMessage: (message: ProactiveMessage) => void;
}) {
  // null 表示尚未记录到任何用户活动（首次轮询按「活跃」处理）
  const lastActivityRef = useRef<number | null>(null);

  // 最新回调通过 ref 传递给常驻定时器，避免因依赖变化反复重启轮询
  const onMessageRef = useRef(onMessage);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  // 用户活跃追踪：决定轮询频率
  useEffect(() => {
    const markActive = () => {
      lastActivityRef.current = Date.now();
    };
    const events: (keyof WindowEventMap)[] = ["mousemove", "keydown", "click", "scroll"];
    events.forEach((e) => window.addEventListener(e, markActive));
    return () => events.forEach((e) => window.removeEventListener(e, markActive));
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const poll = async () => {
      if (cancelled || document.hidden) return;
      try {
        const message = await api.fetchProactiveMessage();
        if (message) {
          onMessageRef.current(message);
          if (useUiStore.getState().voiceMode) speakBus.speak(message.content);

          // 页面不可见时发桌面通知 + 提示音
          if (document.hidden && Notification.permission === "granted") {
            new Notification(REASON_ICONS[message.reason] || "Xiao Ai", {
              body: message.content,
              icon: "/favicon.ico",
              tag: "proactive-message",
            });
          }
          // 提示音：WebAudio 即时合成（此前是 404 的 /notification.mp3）
          playNotificationSound();
        }
      } catch {
        // 后端未连接时静默重试
      }
    };

    const schedule = () => {
      if (cancelled) return;
      const lastActivity = lastActivityRef.current;
      const idleTime = lastActivity === null ? 0 : Date.now() - lastActivity;
      const delay = idleTime > IDLE_THRESHOLD_MS ? IDLE_INTERVAL_MS : ACTIVE_INTERVAL_MS;
      timer = setTimeout(async () => {
        await poll();
        schedule();
      }, delay);
    };

    schedule();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);
}
