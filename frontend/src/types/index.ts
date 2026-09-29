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

/** 后端下发的阶段元数据（字段名与后端 buildStageMeta() 逐字一致；前端零阈值） */
export interface AffinityStageMeta {
  stage: string;
  stageLabel: string;
  stageShortLabel: string;
  nextStage: string | null;
  nextStageLabel: string | null;
  pointsToNextStage: number;
  /** 当前阶段内 0-1 进度 */
  stageProgress: number;
}

/** 一条好感度修正记录（可追溯「为什么变、被哪些规则改过」） */
export interface AffinityTraceEntry {
  rule: string;
  from: number;
  to: number;
  reason: string;
}

/** GET /state */
export interface AppState extends AffinityStageMeta {
  affinity: number;
  nickname: string;
  historyCount: number;
  memoryCount: number;
  emotionalState: EmotionalState | null;
  /** 最近一次**真正发生**的好感度变化量（无规则介入时也非 0；从未变化为 0） */
  recentChange: number;
  /** 最近一次变化的可读原因（无规则介入时由后端按符号合成兜底文案） */
  recentChangeReason: string | null;
  /** 是否处于时间衰减中 */
  decaying: boolean;
  /** 今日正向涨分是否已达上限 */
  dailyCapReached: boolean;
}

/** POST /chat 响应 */
export interface ChatResponse extends AffinityStageMeta {
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
  /** 好感度修正轨迹（可空数组；仅记录**规则介入**，正常回合为空） */
  affinityTrace?: AffinityTraceEntry[];
  /** 最近一次**真正发生**的好感度变化量 */
  recentChange: number;
  /** 最近一次变化的可读原因 */
  recentChangeReason: string | null;
  /** 是否处于时间衰减中 */
  decaying: boolean;
  /** 今日正向涨分是否已达上限 */
  dailyCapReached: boolean;
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

/**
 * 单个主动消息类型。
 * 真源在后端 `core/proactiveTypes.js`；前端不做本地目录镜像，
 * 只在后端不可用时按 id 兜底展示。
 */
export interface ProactiveTypeInfo {
  id: string;
  /** 英文短名（历史契约字段） */
  label: string;
  /** 中文标题（设置页展示） */
  labelZh?: string;
  /** 英文说明（历史契约字段） */
  description: string;
  /** 中文「什么时候会发」说明 */
  schedule?: string;
  /** emoji 图标 */
  icon?: string;
  /** 归属分组 id，见 ProactiveGroupInfo.id */
  group?: string;
  defaultEnabled?: boolean;
}

/** 主动消息类型分组（设置页分组标题） */
export interface ProactiveGroupInfo {
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

/** GET /chat/proactive/status → engine 字段 */
export interface ProactiveEngineStatus {
  config: ProactiveConfig;
  queueSize: number;
  dailyMessagesSent: number;
  dailyLimit: number;
  /** 自动档（按好感度阶段 × 频率倍率）算出的上限，供 UI 对照 */
  autoDailyLimit: number;
  /** 关系阶段 id：stranger / acquaintance / friend / close / lover */
  stage: string;
  /** 阶段中文短标签：陌生 / 初识 / 朋友 / 挚友 / 恋人 */
  stageLabel: string;
  affinity: number;
  affinityBonus: number;
  quietHours: { active: boolean; from: string; to: string };
  lastTriggerTime: number;
  lastUserActiveTime: number;
  /** 每种类型下次可发的时间戳（null = 现在就可以） */
  nextEligible: Record<string, number | null>;
  /** 定时问候类今天是否已发过 */
  sentToday: Record<string, boolean>;
  currentCooldowns: Record<string, number>;
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
