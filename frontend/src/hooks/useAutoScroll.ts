"use client";

import { useEffect, useRef } from "react";
import { useChatStore } from "@/stores/chatStore";

/**
 * prefers-reduced-motion 的 MediaQueryList 单例。
 *
 * 以前是在自动跟随的 effect 里每次 `window.matchMedia(...)` —— 那个 effect 依赖
 * [messages, isLoading]，流式回复每来一个 delta 就重跑一遍，等于每帧新建一个
 * MediaQueryList（还要挂/摘底层监听），纯浪费。
 * 实例只建一次并复用：MQL 的 `matches` 本身是实时的，读取处不需要重新查询。
 */
let reduceMotionQuery: MediaQueryList | null = null;
function getReduceMotionQuery(): MediaQueryList | null {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
    if (!reduceMotionQuery) reduceMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    return reduceMotionQuery;
}

/**
 * 消息列表滚动跟随：用户贴底时才自动滚到底，翻历史不打断。
 * 返回 listRef 挂到滚动容器；stickToBottom 用于主动发言时强制跟底。
 */
export function useAutoScroll() {
  const listRef = useRef<HTMLDivElement>(null);
  /** 用户是否贴着底部 */
  const atBottomRef = useRef(true);
  const messages = useChatStore((s) => s.messages);
  const isLoading = useChatStore((s) => s.isLoading);

  // 监听滚动，判断用户是否还贴着底部
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // 自动跟随：贴底时才滚。流式输出中用 auto（逐字追加时 smooth 会互相打断、抖动）；
  // 用户开启「减少动态效果」时同样退化为瞬时跳转
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const query = getReduceMotionQuery();
    const scrollToBottom = () => {
      if (!atBottomRef.current) return;
      el.scrollTo({
        top: el.scrollHeight,
        behavior: isLoading || query?.matches ? "auto" : "smooth",
      });
    };
    scrollToBottom();

    // 偏好中途被改动时（系统设置里拨开关）立刻按新行为归位一次，
    // 而不是等下一条消息才生效
    if (!query) return;
    query.addEventListener("change", scrollToBottom);
    return () => query.removeEventListener("change", scrollToBottom);
  }, [messages, isLoading]);

  return {
    listRef,
    stickToBottom: () => {
      atBottomRef.current = true;
    },
  };
}
