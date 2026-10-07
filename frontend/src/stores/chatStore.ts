import { create } from "zustand";
import { streamSendMessage } from "@/hooks/useChatStream";
import { api } from "@/lib/api";
import { getStoredAffinity, setStoredAffinity } from "@/lib/storage";
import { ProactiveDeliveryQueue } from "@/lib/proactiveQueue";
import { proactiveTypingDelay } from "@/lib/proactiveDisplay";
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

/**
 * 主动消息投递：FIFO 队列（FE-02）。
 *
 * 旧写法是「一个模块级 timer + 每条新消息先 clearTimeout 旧的」，
 * 于是 200 ms 内连到 3 条时，前两条的「思考中」还没结束就被顶掉，**它们永远不会上屏**。
 * 队列保证每条都按顺序落地；流式回复进行中整体挂起（见 sendMessage），
 * 说完这一轮再补投 —— 她不会把话插进自己正在逐字流出的气泡中间（FE-03）。
 */

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
  /** 挂载后恢复好感度 localStorage 镜像（只能在客户端 effect 里调，见 useBootstrap） */
  restoreAffinity: () => void;
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
  /** 本轮流式回复所在气泡的 id（FE-03：所有流式写入按它点名，不看「最后一条」） */
  let streamingId: string | null = null;

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

  /**
   * 追加消息并返回它的 id。
   * 流式占位必须拿回 id：靠「最后一条 assistant」定位，在主动消息插进来之后就点错了位置。
   */
  const pushMessage = (msg: Omit<Message, "id"> & { id?: string }): string => {
    const id = msg.id ?? nextMessageId();
    set((state) => ({ messages: [...state.messages, { ...msg, id }] }));
    return id;
  };

  /**
   * 按 `streamingId` **点名**改这一轮流式气泡（FE-03）。
   * 找不到那条（已被「新对话」清掉 / 后端重启后历史重拉）就原样返回，
   * 绝不退化成「改最后一条」——那正是把一个气泡的字写进另一个气泡的串扰路径。
   */
  const patchStreaming = (patch: (m: Message) => Message, { allowFallback }: { allowFallback: boolean } = { allowFallback: false }) =>
    set((state) => {
      let idx = streamingId ? state.messages.findIndex((m) => m.id === streamingId) : -1;
      if (idx < 0 && allowFallback) {
        for (let i = state.messages.length - 1; i >= 0; i--) {
          if (state.messages[i].role === "assistant") {
            idx = i;
            break;
          }
        }
      }
      if (idx < 0) return state;
      const next = [...state.messages];
      next[idx] = patch(next[idx]);
      return { messages: next };
    });

  /** 收尾：把本轮流式气泡替换成最终内容，并挂上内心独白（若有） */
  const finishWith = (content: string, thought?: string | null) =>
    patchStreaming((m) => ({ ...m, content, thought: thought ?? null }), {
      // 收尾这一步要兜住「占位因异常丢失」：宁可把正文落在最后一条 assistant，
      // 也不能让这一轮的回复凭空消失（回复丢了比串气泡更难发现）
      allowFallback: true,
    });

  /** Ghosting：把本轮占位换成系统提示（id 保留，后续按点名的清理才不会找不到它） */
  const markGhosting = () =>
    patchStreaming((m) => ({ ...m, role: "system", content: "💔 已读不回..." }));

  /** 流式增量：只往本轮占位里追加，别的（含主动消息气泡）一律不碰 */
  const appendDelta = (chunk: string) =>
    patchStreaming((m) => ({ ...m, content: m.content + chunk }));

  /** 主动消息 FIFO 队列：入队永不取消已排队条目，流式进行中整体挂起 */
  const proactiveQueue = new ProactiveDeliveryQueue<ProactiveMessage>({
    deliver: (message) =>
      pushMessage({
        id: `proactive-${message.id}`,
        role: "assistant",
        content: message.content,
      }),
    setTyping: (on) => useUiStore.getState().setTypingProactive(on),
    // 流式回复进行中 = 挂起，等这一轮说完再按顺序补投
    isBusy: () => get().isLoading,
    typingDelay: proactiveTypingDelay,
    maxQueueSize: 20,
    onOverflow: (dropped) =>
      console.warn("[ChatStore] 主动消息排队溢出，丢弃最旧一条未出场的候选:", dropped.key),
  });

  return {
    messages: [],
    isLoading: false,
    // 初始值必须是常量：服务端渲染拿不到 localStorage，若在模块初始化时读镜像，
    // 客户端水合首帧就会与服务端 HTML 不一致（hydration mismatch）。
    // 离线/后端未就绪由挂载后的 restoreAffinity 恢复镜像兜底；在线时 syncState 用后端真值校正
    affinity: 35,
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

    restoreAffinity: () => {
      const stored = getStoredAffinity();
      if (stored !== null) set({ affinity: stored });
    },

    sendMessage: async (text) => {
      if (!text.trim()) return;
      // 重入保护：上一轮流式进行中时忽略新的发送请求。
      // 语音「自动发送」此前没有这层闸，AI 回复期间完成录音转写会并发第二条流，
      // appendDelta/finishWith 都无条件操作最后一条 assistant，两条回复内容串位混写
      if (get().isLoading) return;

      pushMessage({ role: "user", content: text });
      set({ isLoading: true });
      // 先放一条空的 assistant 占位，流式过程中往里面追加文本；
      // 这一轮的所有写入都按返回的 id 点名（FE-03）
      streamingId = pushMessage({ role: "assistant", content: "" });
      // 主动消息在这一轮说完之前一律不许插进消息流
      proactiveQueue.setPaused(true);

      try {
        await streamSendMessage(text, {
          appendDelta,
          finishWith,
          markGhosting,
          applyMeta,
          // 超时后这一轮在后端可能其实已经结算过了：用后端真值覆盖界面，别继续显示旧分数
          resyncAfterTimeout: () => void get().syncState(),
        });
      } finally {
        set({ isLoading: false });
        streamingId = null;
        proactiveQueue.setPaused(false);
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
        // 队列里那些「她想起刚才那段对话」的候选别再补进空白聊天
        proactiveQueue.dropAll();
        streamingId = null;
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

    /**
     * 主动消息：入队即返回，出场顺序由队列保证（先到先发，一条都不会被后到的顶掉）。
     * 「思考中」时长按字数算，与改造前的编排一致。
     */
    appendProactiveMessage: (message) => {
      proactiveQueue.enqueue({
        key: String(message.id),
        text: message.content,
        payload: message,
      });
    },
  };
});
