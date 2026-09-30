import { create } from "zustand";
import { streamSendMessage } from "@/hooks/useChatStream";
import { api } from "@/lib/api";
import { getStoredAffinity, setStoredAffinity } from "@/lib/storage";
import type {
  AffinityStageMeta,
  AffinityTraceEntry,
  ChatResponse,
  EmotionalState,
  Message,
  ProactiveMessage,
} from "@/types";
import { useUiStore } from "./uiStore";

/** 消息 id：稳定且唯一，供列表 key 与 memo 复用判断 */
let messageSeq = 0;
const nextMessageId = () => `m${++messageSeq}`;

/** 后端历史不带 id，补一个 */
const withIds = (list: Message[]): Message[] =>
  list.map((m) => (m.id ? m : { ...m, id: nextMessageId() }));

/**
 * 从响应/状态的平铺字段里挑出阶段元数据。
 * stage 缺失（旧后端 / 首帧未同步）时返回 null，交给组件保持空占位——
 * 组件里**禁止**用本地阈值兜底（那正是本次要消灭的第三份阈值镜像）。
 */
function pickStageMeta(data: Partial<AffinityStageMeta>): AffinityStageMeta | null {
  if (!data.stage) return null;
  return {
    stage: data.stage,
    stageLabel: data.stageLabel ?? "",
    stageShortLabel: data.stageShortLabel ?? "",
    nextStage: data.nextStage ?? null,
    nextStageLabel: data.nextStageLabel ?? null,
    pointsToNextStage: data.pointsToNextStage ?? 0,
    stageProgress: data.stageProgress ?? 0,
  };
}

/** 主动消息 typing 延时器：模块级，避免组件卸载后仍触发 set */
let proactiveTimer: ReturnType<typeof setTimeout> | null = null;

interface ChatState {
  messages: Message[];
  isLoading: boolean;
  affinity: number;
  emotion: string;
  emotionalState: EmotionalState | null;
  /** 后端下发的阶段元数据（零阈值展示）；首帧为 null，等到 syncState/首次对话后填充 */
  stageMeta: AffinityStageMeta | null;
  /** 最近一次好感度修正轨迹（取末条 to 的符号做涨跌着色） */
  affinityTrace: AffinityTraceEntry[];
  /** 最近一次**真正发生**的好感度变化量（无规则介入时也非 0） */
  recentChange: number;
  /** 最近一次变化的可读原因 */
  recentReason: string | null;
  /** 是否处于时间衰减中 */
  decaying: boolean;
  /** 今日正向涨分是否已达上限 */
  dailyCapReached: boolean;
  setAffinity: (value: number) => void;
  sendMessage: (text: string) => Promise<void>;
  fetchHistory: () => Promise<void>;
  /** 「新对话」：只清对话记录，保留好感度与记忆 */
  newConversation: () => Promise<void>;
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

    // 阶段元数据 / 变化轨迹 / 衰减与日上限提示（服务端派生量，前端原样消费）
    const meta = pickStageMeta(data);
    if (meta) set({ stageMeta: meta });
    if (Array.isArray(data.affinityTrace)) set({ affinityTrace: data.affinityTrace });
    if (typeof data.recentChange === "number") set({ recentChange: data.recentChange });
    if (data.recentChangeReason !== undefined) set({ recentReason: data.recentChangeReason });
    if (typeof data.decaying === "boolean") set({ decaying: data.decaying });
    if (typeof data.dailyCapReached === "boolean") set({ dailyCapReached: data.dailyCapReached });
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
    // 首帧先取 localStorage 的镜像，避免离线/后端未就绪时永远显示默认 35；
    // 在线时 syncState 会立刻用后端真值校正
    affinity: getStoredAffinity() ?? 35,
    emotion: "平静",
    emotionalState: null,
    stageMeta: null,
    affinityTrace: [],
    recentChange: 0,
    recentReason: null,
    decaying: false,
    dailyCapReached: false,

    setAffinity: (value) => {
      set({ affinity: value });
      setStoredAffinity(value);
    },

    sendMessage: async (text) => {
      if (!text.trim()) return;
      // 重入保护：上一轮流式进行中时忽略新的发送请求。
      // 语音「自动发送」此前没有这层闸，AI 回复期间完成录音转写会并发第二条流，
      // appendDelta/finishWith 都无条件操作最后一条 assistant，两条回复内容串位混写
      if (get().isLoading) return;

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

    /**
     * 「新对话」：只清对话记录。
     *
     * 后端 DELETE /history 现在只清历史，好感度与记忆都不动，所以这里**绝不能**
     * 再碰 affinity / stageMeta / recentReason / recentChange / affinityTrace，
     * 也不该调 syncState()——那会多发一次请求，还会让人误以为刚发生了重置。
     */
    newConversation: async () => {
      try {
        await api.clearHistory();
        set({ messages: [] });
      } catch {
        useUiStore.getState().pushToast("清空失败", "error");
      }
    },

    /**
     * 「完全重置」的实现保留在设置页（api.resetAll + 整页刷新）；
     * store 层不再维护第二套复位逻辑（此前 resetEverything 零调用且复位不全，已删除）。
     */
    syncState: async () => {
      try {
        const state = await api.getState();
        if (typeof state.affinity === "number") get().setAffinity(state.affinity);
        // 回填主情绪标签：后端 /state 现在下发平铺 emotion，刷新后徽章/立绘
        // 立即复位为真实情绪，而不是停在初始「平静」映射出的「😊 开心」
        if (state.emotion) set({ emotion: state.emotion });
        if (state.emotionalState) set({ emotionalState: state.emotionalState });
        const meta = pickStageMeta(state);
        if (meta) {
          set({
            stageMeta: meta,
            recentChange: state.recentChange ?? 0,
            recentReason: state.recentChangeReason ?? null,
            decaying: state.decaying ?? false,
            dailyCapReached: state.dailyCapReached ?? false,
          });
        }
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
