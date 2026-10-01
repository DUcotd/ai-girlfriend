/**
 * localStorage 集中管理 —— 所有读写集中在此，避免 key 字符串散落在组件里。
 */

import {
  clampChatNumber,
  normalizeReasoningEffort,
  parseOptionalChatNumber,
} from "./chatParams";
import type { AdvancedChatConfig } from "./chatParams";
import { DEFAULT_PROVIDER } from "./providers";

/**
 * localStorage 在服务端渲染阶段不存在，所有访问都走这层保护，
 * 便于组件在 useState 惰性初始化里直接读取（避免 useEffect 中 setState）。
 */
function read(key: string): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(key);
}

function write(key: string, value: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(key, value);
}

function erase(key: string): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(key);
}

const KEYS = {
  apiKey: "apiKey",
  baseUrl: "baseUrl",
  modelName: "modelName",
  ttsApiKey: "ttsApiKey",
  ttsEngine: "ttsEngine",
  embApiKey: "embApiKey",
  embBaseUrl: "embBaseUrl",
  embModelName: "embModelName",
  affinity: "affinity",
  theme: "theme",
  themeMode: "themeMode",
  hasCompletedSetup: "hasCompletedSetup",
  proactiveEnabled: "proactiveEnabled",
  frequencyLevel: "frequencyLevel",
  customDailyLimit: "customDailyLimit",
  enabledTypes: "enabledTypes",
  /** 通知权限是否已问过（只问一次，避免每次进页面都弹） */
  notificationAsked: "notificationAsked",
  // 记忆设置（设置页 → 记忆）：事实提取开关与检索模式
  memoryFactsEnabled: "memoryFactsEnabled",
  memoryRetrievalMode: "memoryRetrievalMode",
  // 以下四项为「高级选项」（设置页 → 通用 → 高级选项），语义见 lib/chatParams.ts
  maxPromptHistory: "maxPromptHistory",
  temperature: "temperature",
  maxTokens: "maxTokens",
  reasoningEffort: "reasoningEffort",
  /** 无限上下文开关（高级选项第五项） */
  unlimitedContext: "unlimitedContext",
} as const;

export const StorageKeys = KEYS;

/** 首次运行是否已完成引导 */
export function isSetupComplete(): boolean {
  return Boolean(read(KEYS.apiKey) && read(KEYS.hasCompletedSetup));
}

/** 检索模式合法档位；auto = 配置了嵌入 Key 用语义，否则关键词 */
const RETRIEVAL_MODES = ["auto", "embedding", "keyword"] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];

/** 读取记忆设置（读取即归一化：脏值/跨版本残留回落默认） */
export function getMemoryConfig(): { memoryFactsEnabled: boolean; memoryRetrievalMode: RetrievalMode } {
  const rawMode = read(KEYS.memoryRetrievalMode);
  return {
    memoryFactsEnabled: read(KEYS.memoryFactsEnabled) !== "false",
    memoryRetrievalMode: (RETRIEVAL_MODES as readonly string[]).includes(rawMode ?? "")
      ? (rawMode as RetrievalMode)
      : "auto",
  };
}

/**
 * 云端语音（TTS/ASR）是否已配置专属 Key。
 * 语音与主 Key 完全独立：未配置时云端引擎不启用，运行时回退浏览器本地语音。
 */
export function isTtsConfigured(): boolean {
  return !!read(KEYS.ttsApiKey)?.trim();
}

/**
 * 清理旧版「默认预填」残留。
 *
 * 旧设置弹窗给嵌入 URL/模型预填了默认值，且每次保存都会把它们原样写回
 * localStorage——从没配置过嵌入服务的用户也会带着这两个值。
 * 嵌入配置改为「按需折叠填写」后，与旧默认值完全相同的存储视为预填残留，一次性清掉。
 */
export function cleanupLegacyEmbeddingDefaults(): void {
  if (read(KEYS.embBaseUrl) === "https://api.siliconflow.cn/v1") {
    erase(KEYS.embBaseUrl);
  }
  if (read(KEYS.embModelName) === "BAAI/bge-large-zh-v1.5") {
    erase(KEYS.embModelName);
  }
}

/**
 * 读取当前 LLM 配置（用于启动时同步给后端）。
 *
 * 高级选项四项都在这里补默认值/钳制：localStorage 可能被手改或跨版本残留脏值，
 * 读取即归一化，保证下发到后端的一定是合法值。
 */
export function getChatConfig() {
  return {
    apiKey: read(KEYS.apiKey) || "",
    baseUrl: read(KEYS.baseUrl) || DEFAULT_PROVIDER.baseUrl,
    modelName: read(KEYS.modelName) || DEFAULT_PROVIDER.modelName,
    ttsApiKey: read(KEYS.ttsApiKey) || undefined,
    embApiKey: read(KEYS.embApiKey) || undefined,
    embBaseUrl: read(KEYS.embBaseUrl) || undefined,
    embModelName: read(KEYS.embModelName) || undefined,
    // 高级选项四项：读取即归一化（补默认 + 钳制）
    ...getAdvancedChatConfig(),
    // 记忆设置：后端重启后需要重新下发（与嵌入配置同款生命周期）
    ...getMemoryConfig(),
  };
}

/** 只读取「高级选项」五项（设置页初始化用，语义同 getChatConfig 的末五项） */
export function getAdvancedChatConfig(): AdvancedChatConfig {
  return {
    maxPromptHistory: clampChatNumber(read(KEYS.maxPromptHistory), "maxPromptHistory"),
    unlimitedContext: read(KEYS.unlimitedContext) === "true",
    temperature: clampChatNumber(read(KEYS.temperature), "temperature"),
    maxTokens: parseOptionalChatNumber(read(KEYS.maxTokens), "maxTokens"),
    reasoningEffort: normalizeReasoningEffort(read(KEYS.reasoningEffort)),
  };
}

/** 写回「高级选项」五项（空 maxTokens 与空 reasoningEffort 都写成空串 = 不传） */
export function setAdvancedChatConfig(cfg: AdvancedChatConfig): void {
  write(KEYS.maxPromptHistory, String(cfg.maxPromptHistory));
  write(KEYS.unlimitedContext, cfg.unlimitedContext ? "true" : "false");
  write(KEYS.temperature, String(cfg.temperature));
  write(KEYS.maxTokens, cfg.maxTokens ? String(cfg.maxTokens) : "");
  write(KEYS.reasoningEffort, cfg.reasoningEffort);
}

/** 主题应用与读取 */
export function getStoredTheme(): string | null {
  return read(KEYS.theme);
}

export function applyTheme(theme: string): void {
  if (typeof window === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  write(KEYS.theme, theme);
}

/** 显示模式（light/dark）的读取与应用，与主题（data-theme）正交 */
export function getStoredThemeMode(): string | null {
  return read(KEYS.themeMode);
}

export function applyThemeMode(mode: string): void {
  if (typeof window === "undefined") return;
  document.documentElement.setAttribute("data-mode", mode);
  write(KEYS.themeMode, mode);
}

export function getStoredAffinity(): number | null {
  const raw = read(KEYS.affinity);
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

export function setStoredAffinity(affinity: number): void {
  write(KEYS.affinity, affinity.toString());
}

export function set(key: keyof typeof KEYS, value: string): void {
  write(KEYS[key], value);
}

export function get(key: keyof typeof KEYS): string | null {
  return read(KEYS[key]);
}

export function remove(key: keyof typeof KEYS): void {
  erase(KEYS[key]);
}
