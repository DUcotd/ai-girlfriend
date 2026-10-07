"use client";

import { useEffect, useRef } from "react";
import { speakBus } from "@/hooks/useChatStream";
import { api } from "@/lib/api";
import { toApiError } from "@/lib/apiError";
import { LOCAL_ERROR_CODES } from "@/lib/errorCodes";
import { get } from "@/lib/storage";
import {
  notificationBody,
  parseNotifyPrivacy,
  type NotifyPrivacy,
} from "@/lib/notifyPrivacy";
import { playNotificationSound } from "@/lib/notifySound";
import { shouldSpeakProactive } from "@/lib/proactiveDisplay";
import { useUiStore, toast } from "@/stores/uiStore";
import type { ProactiveMessage } from "@/types";

const IDLE_THRESHOLD_MS = 5 * 60 * 1000;
const ACTIVE_INTERVAL_MS = 15_000;
const IDLE_INTERVAL_MS = 60_000;

/**
 * 主动消息类型 → 通知图标。
 * ⚠️ 必须覆盖 proactiveTypes.js 里的全部 id：漏一个就显示成兜底图标，
 * 而「跃迁」「纪念日回顾」这些恰恰是最该一眼认出来的。
 */
const REASON_ICONS: Record<string, string> = {
  morning_greeting: "🌅",
  night_greeting: "🌙",
  miss_you: "💕",
  mood_check: "💝",
  task_reminder: "📝",
  random_chat: "✨",
  memory_share: "💭",
  life_update: "🏡",
  emotion_resonance: "🫂",
  anniversary_recall: "🎂",
  promise_followup: "🔔",
  stage_transition: "💞",
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
    /** 401 只提示一次：轮询每 15 秒撞一次「令牌不对」会变成弹窗轰炸（FE-08） */
    let authHintShown = false;

    const poll = async () => {
      if (cancelled) return;
      // 页面隐藏时也要照常拉取：桌面通知的承诺（切走后收通知）就在这里兑现。
      // 此前入口处 document.hidden 直接 return，而通知分支又只在取到消息后执行，
      // 两者互相矛盾——通知代码永不可达，整个功能实际不存在
      try {
        const message = await api.fetchProactiveMessage();
        if (!message) return;
        onMessageRef.current(message);

        // 朗读：页面可见 + 总朗读开 + 「主动消息朗读」单独开关没被关掉（FE-15）
        if (
          shouldSpeakProactive({
            voiceMode: useUiStore.getState().voiceMode,
            speakProactive: get("speakProactive") !== "false",
            hidden: document.hidden,
          })
        ) {
          speakBus.speak(message.content);
        }

        // 页面不可见时发桌面通知 + 提示音。
        // 锁屏默认不露正文（P8）：她说的话可能写着「你昨天说和谁吃了饭」，
        // 落在锁屏上就是隐私事故；要预览正文得在设置里显式打开。
        if (document.hidden && "Notification" in window && Notification.permission === "granted") {
          const mode: NotifyPrivacy = parseNotifyPrivacy(get("notifyPrivacy"));
          new Notification(`${REASON_ICONS[message.reason] ?? "💕"} 小爱`, {
            body: notificationBody(message.content, mode),
            icon: "/favicon.ico",
            tag: "proactive-message",
          });
        }
        // 提示音：WebAudio 即时合成（此前是 404 的 /notification.mp3）
        playNotificationSound();
      } catch (e) {
        const err = toApiError(e);
        // 后端要求访问令牌 / 令牌不对：这是**用户能自己修**的失败，
        // 静默重试等于让它每 15 秒失败一次而界面永远不说为什么（FE-08）
        const isAuth =
          err.code === LOCAL_ERROR_CODES.UNAUTHORIZED_TOKEN ||
          err.code === LOCAL_ERROR_CODES.UNAUTHORIZED_MISSING ||
          err.code === LOCAL_ERROR_CODES.UNAUTHORIZED_OPEN;
        if (isAuth && !authHintShown) {
          authHintShown = true;
          toast("后端要求访问令牌：请在 设置 → 系统 里填写访问令牌", "error");
          return;
        }
        // 其余（后端未连接等）静默重试：离线横幅已经负责说这件事
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
