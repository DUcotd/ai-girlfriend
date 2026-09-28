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
