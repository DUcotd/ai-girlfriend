/**
 * localStorage 集中管理 —— 所有读写集中在此，避免 key 字符串散落在组件里。
 */

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
  hasCompletedSetup: "hasCompletedSetup",
  proactiveEnabled: "proactiveEnabled",
  frequencyLevel: "frequencyLevel",
  customDailyLimit: "customDailyLimit",
  enabledTypes: "enabledTypes",
  /** 通知权限是否已问过（只问一次，避免每次进页面都弹） */
  notificationAsked: "notificationAsked",
} as const;

export const StorageKeys = KEYS;

/** 首次运行是否已完成引导 */
export function isSetupComplete(): boolean {
  return Boolean(read(KEYS.apiKey) && read(KEYS.hasCompletedSetup));
}

/** 读取当前 LLM 配置（用于启动时同步给后端） */
export function getChatConfig() {
  return {
    apiKey: read(KEYS.apiKey) || "",
    baseUrl: read(KEYS.baseUrl) || "https://api.openai.com/v1",
    modelName: read(KEYS.modelName) || "gpt-3.5-turbo",
    ttsApiKey: read(KEYS.ttsApiKey) || undefined,
    embApiKey: read(KEYS.embApiKey) || undefined,
    embBaseUrl: read(KEYS.embBaseUrl) || undefined,
    embModelName: read(KEYS.embModelName) || undefined,
  };
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
