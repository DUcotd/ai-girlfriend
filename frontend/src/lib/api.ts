/**
 * 后端 API 客户端 —— 所有 fetch 调用集中在此，组件不再自己拼 URL。
 */
import type {
  AffinityTraceEntry,
  AppState,
  BackupReport,
  BackupStatus,
  ChatResponse,
  CurrentActivity,
  FactItem,
  MemoriesResponse,
  PersonalityLedgerEntry,
  PersonalityState,
  PersonalityUpdatePayload,
  ProactiveConfig,
  ProactiveMessage,
  Task,
} from "@/types";
import type { ReasoningEffort } from "./chatParams";

export const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

/**
 * 后端访问令牌在 localStorage 中的 key。
 * 后端启用鉴权后（bearer token），前端所有请求都要带上 `Authorization` 头。
 * 与后端环境变量 `AI_GIRLFRIEND_TOKEN` 对应，用户自行填入同名密钥即可。
 */
export const AUTH_TOKEN_STORAGE_KEY = "ai-girlfriend-token";

/**
 * 读取本地访问令牌；无 token / 非浏览器环境返回 undefined。
 * 为空则不带 Authorization 头——兼容「后端未配置 token、本机守卫」的开箱场景。
 */
function getAuthToken(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const token = window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
    return token && token.trim() ? token.trim() : undefined;
  } catch {
    // localStorage 在隐私模式 / 禁用 Cookie 时可能抛异常，降级为「无 token」
    return undefined;
  }
}

/**
 * 按需附加 Authorization 头：无 token 时保持原 headers 不变，
 * 避免因多出空头导致后端 / 代理的兼容问题。
 */
function withAuth(headers: HeadersInit | undefined): HeadersInit | undefined {
  const token = getAuthToken();
  if (!token) return headers;
  return { ...(headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` };
}

/**
 * UI 侧配置对象（camelCase，即 `lib/storage.getChatConfig()` 的返回形状）。
 *
 * ⚠️ 后端 `/config` 只认 snake_case（见 `toBackendConfigPayload`）。
 * 历史上「挂载时自动同步」把 camelCase 整包直发，后端全部字段收不到、
 * 静默失效——表现是：后端重启后前端不会自动重新下发 Key，聊天报
 * 「API Key not configured / 连接中断」，必须手动去设置里保存一次。
 * （2026-09-28 冒烟回归发现，重构前即存在。）所有下发路径必须走 `syncConfig`。
 */
export interface UiChatConfig {
  apiKey?: string;
  baseUrl?: string;
  modelName?: string;
  ttsApiKey?: string;
  embApiKey?: string;
  embBaseUrl?: string;
  embModelName?: string;
  /** 发给 LLM 的最近历史条数（对应后端 config.chat.maxPromptHistory，默认 30） */
  maxPromptHistory?: number;
  /** 无限上下文：true = 带上全部保留的对话，忽略条数限制 */
  unlimitedContext?: boolean;
  /** 采样温度（0–2，默认 0.75） */
  temperature?: number;
  /** 最大输出 tokens；留空（undefined / 0）表示不传该参数 */
  maxTokens?: number;
  /** 思考强度；空串 = 不传（普通模型收到会 400，故默认空） */
  reasoningEffort?: ReasoningEffort;
  /** 记忆事实提取开关（默认 true） */
  memoryFactsEnabled?: boolean;
  /** 检索模式：auto（配置了嵌入 Key 用语义，否则关键词）/ embedding / keyword */
  memoryRetrievalMode?: "auto" | "embedding" | "keyword";
  /** 用户情绪识别通道（REQ-01） */
  userEmotionEnabled?: boolean;
  /** 共同经历叙事层（REQ-03） */
  narrativeEnabled?: boolean;
  /** 事件驱动主动消息（REQ-04） */
  triggerEnabled?: boolean;
}

/**
 * camelCase UI 配置 → 后端 /config 契约（snake_case）；空串归一为 undefined。
 *
 * ⚠️ 高级参数同理：后端 POST /config 只解构 snake_case（max_prompt_history 等），
 * camelCase 会被静默忽略。新增 UI 字段时这里必须同步加映射。
 *
 * ⚠️⚠️ 高级参数**绝不能**写 `|| undefined`：max_tokens 的「不限制」就是 0、
 * reasoning_effort 的「不传」就是空串，两者都是 falsy，会被吞成 undefined，
 * JSON.stringify 丢掉整个字段 → 后端 `_applyChatParams` 对 undefined 一律跳过 →
 * 旧值（如 high / 1024）永远改不回来，用户只能重启后端（2026-10 BUG-1 回归）。
 * 需要「清空」语义的字段一律用 `?? 清空值`。
 */
export function toBackendConfigPayload(cfg: UiChatConfig) {
  return {
    api_key: cfg.apiKey || undefined,
    base_url: cfg.baseUrl || undefined,
    model_name: cfg.modelName || undefined,
    // TTS Key 用 ??：空串 = 用户想清除语音配置，必须原样送达后端（后端会把引擎重置为未配置态）；
    // `|| undefined` 会吞掉空串，清除在运行时永远不生效
    tts_api_key: cfg.ttsApiKey ?? undefined,
    // 嵌入三件套用 ??：空串 = 用户想清空（回退「使用主 Key」），必须原样送达后端，
    // 由后端归一化成 null。`|| undefined` 会把空串吞掉，清空在运行时永远不生效。
    embedding_api_key: cfg.embApiKey ?? undefined,
    embedding_base_url: cfg.embBaseUrl ?? undefined,
    embedding_model_name: cfg.embModelName ?? undefined,
    // 这两项没有「清空」语义：undefined（调用方没给，如首启向导只发 Key/URL/模型）
    // 就整项省略，让后端保留当前值；给了则原值下发——temperature: 0 必须能发出去。
    max_prompt_history: cfg.maxPromptHistory,
    // 布尔开关必须显式下发 false：?? 不会吞掉 false（false ?? undefined === false），
    // 只有调用方没带该字段（undefined）才省略、让后端保留当前值
    unlimited_context: cfg.unlimitedContext ?? undefined,
    temperature: cfg.temperature,
    // 这两项必须显式下发「清空值」：undefined 也要压成 0 / ""，
    // 否则用户把思考强度改回「不传」、最大输出清空后，后端仍停在 high / 1024。
    max_tokens: cfg.maxTokens ?? 0,
    reasoning_effort: cfg.reasoningEffort ?? "",
    // 记忆选项：布尔开关必须显式下发 false，不能写 || undefined（会被吞成「没传」）
    memory_facts_enabled: cfg.memoryFactsEnabled ?? undefined,
    memory_retrieval_mode: cfg.memoryRetrievalMode,
    // 陪伴感三开关（后端 configRoutes 解构的就是这三个 snake_case 名）：
    // 用 ?? undefined 保证 false 能发出去、没带字段时后端保留原值（审计 HTTP-10）
    user_emotion_enabled: cfg.userEmotionEnabled ?? undefined,
    narrative_enabled: cfg.narrativeEnabled ?? undefined,
    trigger_enabled: cfg.triggerEnabled ?? undefined,
  };
}

/**
 * 统一请求封装：
 * - 自动带 Content-Type 与鉴权 Authorization 头
 * - 区分「业务 4xx」与「网络错误」，失败时抛出带 detail 的 Error
 */
async function request<T>(
  path: string,
  options: RequestInit & { raw?: boolean } = {}
): Promise<T> {
  const { raw, headers, ...rest } = options;
  // 先合并业务头，再统一附加 Authorization（token 为空则不带头，兼容本地未配置场景）
  const mergedHeaders = raw
    ? headers
    : { "Content-Type": "application/json", ...headers };
  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...rest,
    headers: withAuth(mergedHeaders),
  });

  if (!res.ok && !raw) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.detail || `Request failed: ${res.status}`);
  }

  return raw ? ((await res) as unknown as T) : res.json();
}

export const api = {
  // ---------- 状态 / 历史 / 记忆 ----------
  getState: () => request<AppState>("/state"),

  /** 好感度变更账本（时间升序，≤200 条）；路由挂根路径，无 /api 前缀 */
  getAffinityLedger: () => request<AffinityTraceEntry[]>("/affinity/ledger"),

  getHistory: () => request<import("@/types").Message[]>("/history"),

  /** 只清对话历史，保留好感度与记忆（「新对话」用） */
  clearHistory: () => request<{ status: string }>("/history", { method: "DELETE" }),

  /**
   * 完全重置：清空对话历史 + 记忆 + 好感度 + 性格 + 情绪 + 任务
   * （设置页的「完全重置」用；「新对话」不要用它）。
   * status === "partial" 表示有引擎重置失败，failed 列出失败步骤。
   */
  resetAll: () =>
    request<{
      status: "reset" | "partial";
      reset: string[];
      failed: { step: string; message: string }[];
    }>("/reset", { method: "POST" }),

  getMemories: () => request<MemoriesResponse>("/memories"),

  /** 手动添加事实记忆；与既有事实重复时后端返回 409 */
  addFact: (content: string, importance?: number) =>
    request<{ status: string; fact: FactItem }>("/memories/facts", {
      method: "POST",
      body: JSON.stringify({ content, importance }),
    }),

  /** 编辑事实记忆（内容 / 重要度） */
  updateFact: (id: string, updates: { content?: string; importance?: number }) =>
    request<{ status: string; fact: FactItem }>(`/memories/facts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    }),

  /** 删除单条记忆（事实或情节，按 id） */
  deleteMemory: (id: string) =>
    request<{ status: string; type: string }>(`/memories/${id}`, { method: "DELETE" }),

  clearMemories: () =>
    request<{ status: string }>("/memories", { method: "DELETE" }),

  updateState: (payload: { affinity?: number; nickname?: string }) =>
    request<AppState & { status: string }>("/state", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  // ---------- 配置 ----------
  // （updateConfig 已删除：它接收裸 payload、绕过 snake_case 映射，是「静默失效」的footgun；
  //   所有下发路径统一走 syncConfig。）

  /** 下发 UI 配置（camelCase）——自动完成字段映射，所有调用方都用它，勿直发 camelCase */
  syncConfig: (cfg: UiChatConfig) =>
    request<{ status: string; current_model?: string }>("/config", {
      method: "POST",
      body: JSON.stringify(toBackendConfigPayload(cfg)),
    }),

  /**
   * 后端当前生效的配置快照（排查用 + 陪伴感开关的服务端真值）。
   * ⚠️ 只回非敏感字段：不含任何 API Key。
   */
  getConfigStatus: () =>
    request<{
      isConfigured: boolean;
      hasEmbeddingConfig: boolean;
      currentModel: string | null;
      baseUrl: string | null;
      chat?: Partial<import("./chatParams").AdvancedChatConfig>;
      memory?: { episodeCount: number; factCount: number; retrievalMode: string; factsEnabled: boolean };
      companion?: {
        userEmotionEnabled: boolean;
        narrativeEnabled: boolean;
        triggerEnabled: boolean;
        triggerRegistry?: Record<string, unknown>;
      };
    }>("/config/status"),

  getProactiveConfig: () =>
    request<{
      config: ProactiveConfig;
      availableTypes: import("@/types").ProactiveTypeInfo[];
      groups?: import("@/types").ProactiveGroupInfo[];
    }>("/config/proactive"),

  /**
   * 下发主动消息配置。
   * ⚠️ 与 /config 不同，这个路由**就是 camelCase 契约**（后端直接解构同名 key），
   * 不要顺手按 syncConfig 那套改成 snake_case。
   */
  updateProactiveConfig: (payload: Partial<ProactiveConfig>) =>
    request<{ status: string; config: ProactiveConfig }>("/config/proactive", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /** 主动消息引擎运行时状态（今日已发/上限、排队数、静音时段、下次可发时间…） */
  getProactiveStatus: () =>
    request<{
      queue: { size: number; messages: unknown[] };
      engine: import("@/types").ProactiveEngineStatus;
    }>("/chat/proactive/status"),

  /** 立刻让小爱生成一条主动消息（设置页的「现在发一条」），会真正调用一次 LLM */
  triggerProactive: (reason: string = "random_chat") =>
    request<{ status: string; reason: string; queueSize: number }>(
      "/chat/proactive/trigger",
      { method: "POST", body: JSON.stringify({ reason }) }
    ),

  // ---------- 性格 ----------
  /**
   * 完整公开性格状态（GET /personality）。
   * ⚠️ 与 /config/proactive 同理：这个路由族就是 camelCase 契约（挂根路径、无 /api 前缀），
   * 不要走 syncConfig 的 snake_case 映射。
   */
  getPersonality: () => request<PersonalityState>("/personality"),

  /** 更新性格：presetId → traits → flags 依次生效；未知维度 / presetId 返回 400 */
  updatePersonality: (payload: PersonalityUpdatePayload) =>
    request<PersonalityState>("/personality", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /** 性格变化账本（时间升序，≤200 条，空时为 []） */
  getPersonalityLedger: () => request<PersonalityLedgerEntry[]>("/personality/ledger"),

  /** 仅重置性格为默认预设并清空账本；不影响好感度、记忆与对话记录 */
  resetPersonality: () =>
    request<{ status: string } & PersonalityState & { ledger: PersonalityLedgerEntry[] }>(
      "/personality/reset",
      { method: "POST" }
    ),

  // ---------- 聊天 ----------
  sendChat: (message: string) =>
    request<ChatResponse>("/chat", {
      method: "POST",
      body: JSON.stringify({ message }),
    }),

  /**
   * 流式对话（SSE）。onDelta 会在每个文本片段到达时被调用，
   * 让界面在模型还在生成时就显示内容，而不是等整段完成。
   *
   * 出错时抛出 Error，调用方应回退到 sendChat。
   */
  async streamChat(
    message: string,
    onDelta: (text: string) => void,
    signal?: AbortSignal
  ): Promise<ChatResponse> {
    const res = await fetch(`${BACKEND_URL}/chat/stream`, {
      method: "POST",
      headers: withAuth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ message }),
      signal,
    });

    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.detail || `Stream failed: ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let final: ChatResponse | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 以空行分隔事件
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const event of events) {
        const line = event
          .split("\n")
          .find((l) => l.startsWith("data:"))
          ?.slice(5)
          .trim();
        if (!line) continue;

        const payload = JSON.parse(line);
        if (payload.type === "delta") {
          if (payload.text) onDelta(payload.text);
        } else if (payload.type === "done") {
          final = {
            reply: payload.reply ?? "",
            emotion: payload.emotion,
            affinity: payload.affinity,
            emotionalState: payload.emotionalState,
            special_action: payload.special_action ?? undefined,
            // ⚠️ 这两个字段必须带回来：inner_thought 是 <monologue> 人设独白
            //（丢失的后果是气泡旁的「心声」图标永远不出现），漏映射过一次，别再删
            inner_thought: payload.inner_thought ?? null,
            model_reasoning: payload.model_reasoning ?? null,
            // 好感度阶段元数据 + 变化轨迹：ChatResponse 现在继承 AffinityStageMeta，
            // 这些字段必须逐一映射，否则 store 读不到、面板会一直是空占位。
            affinityTrace: payload.affinityTrace ?? [],
            stage: payload.stage,
            stageLabel: payload.stageLabel,
            stageShortLabel: payload.stageShortLabel,
            nextStage: payload.nextStage ?? null,
            nextStageLabel: payload.nextStageLabel ?? null,
            pointsToNextStage: payload.pointsToNextStage ?? 0,
            stageProgress: payload.stageProgress ?? 0,
            recentChange: payload.recentChange ?? 0,
            recentChangeReason: payload.recentChangeReason ?? null,
            decaying: payload.decaying ?? false,
            dailyCapReached: payload.dailyCapReached ?? false,
            // 任务动作必须与非流式 ChatResponse 同步，否则 AI 建单无法进入 taskStore。
            taskResult: payload.taskResult ?? null,
          };
        } else if (payload.type === "error") {
          throw new Error(payload.detail || "stream failed");
        }
      }
    }

    if (!final) throw new Error("stream ended without result");
    return final;
  },

  /**
   * 取走一条待展示的主动消息；无消息时返回 null（后端 204）。
   *
   * ⚠️ 必须是 POST：这个动作会把消息**出队**，GET 语义下任何预取、`<img src>`、
   * 浏览器重播或跨站请求都会让她刚生成的那条消息凭空消失（审计 HTTP-13）。
   * 旧版 GET /chat/proactive 现在返回 405，不会再静默消耗。
   */
  async fetchProactiveMessage(): Promise<ProactiveMessage | null> {
    const res = await fetch(`${BACKEND_URL}/chat/proactive/consume`, {
      method: "POST",
      headers: withAuth({ "Content-Type": "application/json" }),
    });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error("Failed to fetch proactive message");
    return res.json();
  },

  // ---------- 全量档案：导出 / 导入 / 快照（B5-12）----------
  /** 档案与快照的当前状态（数据目录、备份目录、快照列表） */
  getBackupStatus: () => request<BackupStatus>("/backup/status"),

  /**
   * 导出整份档案。
   * 走 raw 拿原始 Response：要读 `Content-Disposition` 里的文件名、
   * 也要能在失败时区分「后端自检发现档案含密钥而中止」（500）这种情况。
   */
  async exportArchive(): Promise<{ blob: Blob; filename: string }> {
    // raw: true → 由调用方自己处理错误（要读响应头，也要把「后端自检发现档案含密钥
    // 而中止导出」这类失败说清楚），所以这里不再附加 headers，交给 request() 统一加
    const res = await request<Response>("/backup/export", { raw: true });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.detail || `导出失败：${res.status}`);
    }
    const disposition = res.headers.get("content-disposition") || "";
    const filename = /filename="?([^";]+)"?/.exec(disposition)?.[1] || "ai-girlfriend-archive.json";
    return { blob: await res.blob(), filename };
  },

  /** 导入一份档案（会覆盖当前全部数据；后端在导入前自动做快照） */
  importArchive: (archive: unknown) =>
    request<BackupReport>("/backup/import", { method: "POST", body: JSON.stringify(archive) }),

  /** 只在服务器本地留一份当前状态，不下载 */
  createSnapshot: (reason = "manual") =>
    request<{ status: string; dir: string; files: string[] }>("/backup/snapshot", {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  /** 从某份快照恢复（同样会先做一次 pre-restore 快照） */
  restoreSnapshot: (id: string) =>
    request<BackupReport & { restoredFrom: string }>("/backup/restore", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),

  // ---------- 生活模拟 ----------
  getCurrentActivity: () => request<CurrentActivity>("/life/current"),

  // ---------- 任务 ----------
  getTasks: () => request<Task[]>("/tasks"),

  addTask: (payload: { title: string; dueTime?: string }) =>
    request<Task>("/tasks", { method: "POST", body: JSON.stringify(payload) }),

  updateTask: (id: string, updates: Partial<Task>) =>
    request<Task>(`/tasks/${id}`, {
      method: "PUT",
      body: JSON.stringify(updates),
    }),

  deleteTask: (id: string) => request<Task>(`/tasks/${id}`, { method: "DELETE" }),

  // ---------- 语音 ----------
  textToSpeech: (text: string) =>
    request<{ audio_url: string }>("/audio/speak", {
      method: "POST",
      body: JSON.stringify({ text }),
    }),

  async transcribe(audioBlob: Blob): Promise<string | null> {
    const formData = new FormData();
    formData.append("file", audioBlob, "recording.webm");
    const res = await fetch(`${BACKEND_URL}/audio/transcribe`, {
      method: "POST",
      // FormData 场景不能手动设 Content-Type（浏览器需自行补 boundary），
      // 但仍需带 Authorization
      headers: withAuth(undefined),
      body: formData,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data?.text ?? null;
  },
};
