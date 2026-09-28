/**
 * 后端 API 客户端 —— 所有 fetch 调用集中在此，组件不再自己拼 URL。
 */
import type {
  AppState,
  ChatResponse,
  CurrentActivity,
  MemoryItem,
  ProactiveConfig,
  ProactiveMessage,
  Task,
} from "@/types";

export const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

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
}

/** camelCase UI 配置 → 后端 /config 契约（snake_case）；空串归一为 undefined。 */
export function toBackendConfigPayload(cfg: UiChatConfig) {
  return {
    api_key: cfg.apiKey || undefined,
    base_url: cfg.baseUrl || undefined,
    model_name: cfg.modelName || undefined,
    tts_api_key: cfg.ttsApiKey || undefined,
    embedding_api_key: cfg.embApiKey || undefined,
    embedding_base_url: cfg.embBaseUrl || undefined,
    embedding_model_name: cfg.embModelName || undefined,
  };
}

/**
 * 统一请求封装：
 * - 自动带 Content-Type
 * - 区分「业务 4xx」与「网络错误」，失败时抛出带 detail 的 Error
 */
async function request<T>(
  path: string,
  options: RequestInit & { raw?: boolean } = {}
): Promise<T> {
  const { raw, headers, ...rest } = options;
  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...rest,
    headers: raw
      ? headers
      : { "Content-Type": "application/json", ...headers },
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

  getHistory: () => request<import("@/types").Message[]>("/history"),

  clearHistory: () => request<{ status: string }>("/history", { method: "DELETE" }),

  getMemories: () => request<MemoryItem[]>("/memories"),

  clearMemories: () =>
    request<{ status: string }>("/memories", { method: "DELETE" }),

  updateState: (payload: { affinity?: number; nickname?: string }) =>
    request<AppState & { status: string }>("/state", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  // ---------- 配置 ----------
  updateConfig: (payload: Record<string, unknown>) =>
    request<{ status: string; current_model?: string }>("/config", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /** 下发 UI 配置（camelCase）——自动完成字段映射，所有调用方都用它，勿直发 camelCase */
  syncConfig: (cfg: UiChatConfig) =>
    request<{ status: string; current_model?: string }>("/config", {
      method: "POST",
      body: JSON.stringify(toBackendConfigPayload(cfg)),
    }),

  getProactiveConfig: () =>
    request<{
      config: ProactiveConfig;
      availableTypes: import("@/types").ProactiveTypeInfo[];
    }>("/config/proactive"),

  updateProactiveConfig: (payload: Partial<ProactiveConfig>) =>
    request<{ status: string; config: ProactiveConfig }>("/config/proactive", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

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
      headers: { "Content-Type": "application/json" },
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
          };
        } else if (payload.type === "error") {
          throw new Error(payload.detail || "stream failed");
        }
      }
    }

    if (!final) throw new Error("stream ended without result");
    return final;
  },

  /** 拉取一条待展示的主动消息；无消息时返回 null（后端 204） */
  async fetchProactiveMessage(): Promise<ProactiveMessage | null> {
    const res = await fetch(`${BACKEND_URL}/chat/proactive`);
    if (res.status === 204) return null;
    if (!res.ok) throw new Error("Failed to fetch proactive message");
    return res.json();
  },

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
      body: formData,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data?.text ?? null;
  },
};
