/** 全局共享类型定义 */

export type MessageRole = "user" | "assistant" | "system";

export interface Message {
  role: MessageRole;
  content: string;
}

/** PAD 三维情绪模型状态 */
export interface EmotionalState {
  current: { P: number; A: number; D: number };
  baseline: { P: number; A: number; D: number };
  label: string;
  style: {
    style: string;
    guide: string;
    punctuation: string;
    emojiFrequency: "high" | "medium" | "low" | "none";
  };
  shouldGhost: boolean;
}

/** GET /state */
export interface AppState {
  affinity: number;
  nickname: string;
  historyCount: number;
  memoryCount: number;
  emotionalState: EmotionalState | null;
}

/** POST /chat 响应 */
export interface ChatResponse {
  reply: string | null;
  token_usage?: Record<string, number>;
  context_count?: number;
  emotion?: string;
  affinity?: number;
  emotionalState?: EmotionalState | null;
  special_action?: "ghosting";
}

/** GET /chat/proactive 单条主动消息 */
export interface ProactiveMessage {
  id: string;
  content: string;
  emotion: string;
  timestamp: string;
  reason: string;
  priority: number;
}

export type ProactiveReason =
  | "morning_greeting"
  | "night_greeting"
  | "task_reminder"
  | "miss_you"
  | "mood_check"
  | "memory_share"
  | "random_chat"
  | "life_update";

export interface ProactiveTypeInfo {
  id: string;
  label: string;
  description: string;
}

export interface ProactiveConfig {
  enabled: boolean;
  frequencyLevel: "low" | "medium" | "high";
  customDailyLimit: number | null;
  enabledTypes: string[];
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  dueTime?: string | null;
  reminderTime?: string | null;
  completed: boolean;
  createdAt?: string;
}

export interface MemoryItem {
  id: string;
  text: string;
  timestamp: number;
}

export interface CurrentActivity {
  activity: string;
  emoji: string;
  mood?: string;
  since?: string;
  duration?: number;
  period?: string;
}

/** 用户在设置中选择的 TTS 引擎 */
export type TtsEngine = "openai" | "local";
