/** 全局共享类型定义 */

export type MessageRole = "user" | "assistant" | "system";

export interface Message {
  /**
   * 列表 key。流式渲染时每个增量都会生成新的 messages 数组，
   * 用稳定 id 而不是数组下标，React/memo 才能只重渲染真正变化的那一条。
   */
  id: string;
  role: MessageRole;
  content: string;
  /** 小爱的人设内心独白（hover 小图标可见）；与模型 CoT 无关，CoT 不下发到前端 */
  thought?: string | null;
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
  /** 人设内心独白：<monologue> 里的内容，默认隐藏，hover 可见 */
  inner_thought?: string | null;
  /** 模型自己的推理链 CoT，仅用于排障，前端不使用（也不该展示） */
  model_reasoning?: string | null;
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

/** 主题（色相）与显示模式（明度），正交组合成 4×2=8 种外观 */
export type ThemeName = "sakura" | "starry" | "ocean" | "forest";
export type ThemeMode = "light" | "dark";
