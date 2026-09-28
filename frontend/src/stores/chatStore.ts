import { create } from "zustand";
import { streamSendMessage } from "@/hooks/useChatStream";
import { api } from "@/lib/api";
import { setStoredAffinity } from "@/lib/storage";
import type { ChatResponse, EmotionalState, Message, ProactiveMessage } from "@/types";
import { useUiStore } from "./uiStore";

/** 消息 id：稳定且唯一，供列表 key 与 memo 复用判断 */
let messageSeq = 0;
const nextMessageId = () => `m${++messageSeq}`;

/** 后端历史不带 id，补一个 */
const withIds = (list: Message[]): Message[] =>
  list.map((m) => (m.id ? m : { ...m, id: nextMessageId() }));

/** 主动消息 typing 延时器：模块级，避免组件卸载后仍触发 set */
let proactiveTimer: ReturnType<typeof setTimeout> | null = null;

interface ChatState {
  messages: Message[];
  isLoading: boolean;
  affinity: number;
  emotion: string;
  emotionalState: EmotionalState | null;
  setAffinity: (value: number) => void;
  sendMessage: (text: string) => Promise<void>;
  fetchHistory: () => Promise<void>;
  clearChat: () => Promise<void>;
  syncState: () => Promise<void>;
  /** 主动消息：先显示「思考中」，再按字数延迟出场（语义与原 page.tsx 编排一致） */
  appendProactiveMessage: (message: ProactiveMessage) => void;
}

/**
 * 会话状态（不持久化；affinity 手动落 localStorage）。
 * 发送管线（SSE 优先 + /chat 回退 + 60s 超时 + settle 语义）
 * 在 hooks/useChatStream.ts，与 useChat.ts 时代逐行一致。
 */
export const useChatStore = create<ChatState>()((set, get) => {
  const applyMeta = (data: Partial<ChatResponse>) => {
    if (data.emotion) set({ emotion: data.emotion });
    if (typeof data.affinity === "number") get().setAffinity(data.affinity);
    if (data.emotionalState) set({ emotionalState: data.emotionalState });
  };

  const pushMessage = (msg: Omit<Message, "id"> & { id?: string }) =>
    set((state) => ({
      messages: [...state.messages, { ...msg, id: msg.id ?? nextMessageId() }],
    }));

  /** 把最后一条（占位）assistant 替换成指定内容，并挂上内心独白（若有） */
  const finishWith = (content: string, thought?: string | null) =>
    set((state) => {
      if (state.messages.length === 0) return state;
      const next = [...state.messages];
      const last = next[next.length - 1];
      next[next.length - 1] =
        last.role === "assistant" ? { ...last, content, thought: thought ?? null } : last;
      return { messages: next };
    });

  /** Ghosting：把占位换成系统提示 */
  const markGhosting = () =>
    set((state) => ({
      messages: [
        ...state.messages.slice(0, -1),
        { id: nextMessageId(), role: "system", content: "💔 已读不回..." },
      ],
    }));

  const appendDelta = (chunk: string) =>
    set((state) => {
      if (state.messages.length === 0) return state;
      const next = [...state.messages];
      const last = next[next.length - 1];
      if (last.role !== "assistant") return state;
      next[next.length - 1] = { ...last, content: last.content + chunk };
      return { messages: next };
    });

  return {
    messages: [],
    isLoading: false,
    affinity: 35,
    emotion: "平静",
    emotionalState: null,

    setAffinity: (value) => {
      set({ affinity: value });
      setStoredAffinity(value);
    },

    sendMessage: async (text) => {
      if (!text.trim()) return;

      pushMessage({ role: "user", content: text });
      set({ isLoading: true });
      // 先放一条空的 assistant 占位，流式过程中往里面追加文本
      pushMessage({ role: "assistant", content: "" });

      try {
        await streamSendMessage(text, { appendDelta, finishWith, markGhosting, applyMeta });
      } finally {
        set({ isLoading: false });
      }
    },

    fetchHistory: async () => {
      try {
        const history = await api.getHistory();
        set({ messages: withIds(history) });
      } catch {
        useUiStore.getState().pushToast("无法加载历史记录", "error");
      }
    },

    clearChat: async () => {
      try {
        await api.clearHistory();
        set({ messages: [] });
      } catch {
        useUiStore.getState().pushToast("清空失败", "error");
      }
    },

    syncState: async () => {
      try {
        const state = await api.getState();
        if (typeof state.affinity === "number") get().setAffinity(state.affinity);
        if (state.emotionalState) set({ emotionalState: state.emotionalState });
      } catch {
        // 后端未启动时不阻断页面渲染
      }
    },

    appendProactiveMessage: (message) => {
      useUiStore.getState().setTypingProactive(true);
      const typingDelay = Math.min(2000, Math.max(800, message.content.length * 30));
      if (proactiveTimer) clearTimeout(proactiveTimer);
      proactiveTimer = setTimeout(() => {
        proactiveTimer = null;
        useUiStore.getState().setTypingProactive(false);
        pushMessage({
          id: `proactive-${message.id}`,
          role: "assistant",
          content: message.content,
        });
      }, typingDelay);
    },
  };
});
