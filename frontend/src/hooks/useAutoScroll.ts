"use client";

import { useEffect, useRef } from "react";
import { useChatStore } from "@/stores/chatStore";

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

  // 自动跟随：贴底时才滚。流式输出中用 auto（逐字追加时 smooth 会互相打断、抖动）
  useEffect(() => {
    const el = listRef.current;
    if (!el || !atBottomRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: isLoading ? "auto" : "smooth" });
  }, [messages, isLoading]);

  return {
    listRef,
    stickToBottom: () => {
      atBottomRef.current = true;
    },
  };
}
