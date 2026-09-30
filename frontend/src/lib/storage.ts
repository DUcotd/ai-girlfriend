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
  // 以下四项为「高级选项」（设置页 → 通用 → 高级选项），语义见 lib/chatParams.ts
  maxPromptHistory: "maxPromptHistory",
  temperature: "temperature",
  maxTokens: "maxTokens",
  reasoningEffort: "reasoningEffort",
} as const;

export const StorageKeys = KEYS;

/** 首次运行是否已完成引导 */
export function isSetupComplete(): boolean {
  return Boolean(read(KEYS.apiKey) && read(KEYS.hasCompletedSetup));
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
  };
}

/** 只读取「高级选项」四项（设置页初始化用，语义同 getChatConfig 的末四项） */
export function getAdvancedChatConfig(): AdvancedChatConfig {
  return {
    maxPromptHistory: clampChatNumber(read(KEYS.maxPromptHistory), "maxPromptHistory"),
    temperature: clampChatNumber(read(KEYS.temperature), "temperature"),
    maxTokens: parseOptionalChatNumber(read(KEYS.maxTokens), "maxTokens"),
    reasoningEffort: normalizeReasoningEffort(read(KEYS.reasoningEffort)),
  };
}

/** 写回「高级选项」四项（空 maxTokens 与空 reasoningEffort 都写成空串 = 不传） */
export function setAdvancedChatConfig(cfg: AdvancedChatConfig): void {
  write(KEYS.maxPromptHistory, String(cfg.maxPromptHistory));
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
