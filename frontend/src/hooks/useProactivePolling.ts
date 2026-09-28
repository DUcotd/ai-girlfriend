"use client";

import { useEffect, useRef } from "react";
import { api } from "@/lib/api";
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
 * 相比原实现（在 setInterval 回调里反复 clearInterval + 重建），
 * 这里改用递归 setTimeout：每次触发后按当前空闲状态重新计算下一次间隔，
 * 间隔变化即时生效且不会叠加多个定时器。
 */
export function useProactivePolling({
  onMessage,
  voiceMode,
  speak,
}: {
  onMessage: (message: ProactiveMessage) => void;
  voiceMode?: boolean;
  speak?: (text: string) => void;
}) {
  // null 表示尚未记录到任何用户活动（首次轮询按「活跃」处理）
  const lastActivityRef = useRef<number | null>(null);

  // 最新回调通过 ref 传递给常驻定时器，避免因依赖变化反复重启轮询
  const onMessageRef = useRef(onMessage);
  const speakRef = useRef(speak);
  const voiceModeRef = useRef(voiceMode);

  useEffect(() => {
    onMessageRef.current = onMessage;
    speakRef.current = speak;
    voiceModeRef.current = voiceMode;
  }, [onMessage, speak, voiceMode]);

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
          if (voiceModeRef.current) speakRef.current?.(message.content);

          // 页面不可见时发桌面通知 + 提示音
          if (document.hidden && Notification.permission === "granted") {
            new Notification(REASON_ICONS[message.reason] || "Xiao Ai", {
              body: message.content,
              icon: "/favicon.ico",
              tag: "proactive-message",
            });
          }
          try {
            const audio = new Audio("/notification.mp3");
            audio.volume = 0.3;
            await audio.play();
          } catch {
            // 浏览器可能禁止自动播放，忽略
          }
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
