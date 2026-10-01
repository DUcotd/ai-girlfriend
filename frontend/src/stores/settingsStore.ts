import { create } from "zustand";
import { get, set } from "@/lib/storage";
import type { TtsEngine } from "@/types";

interface SettingsState {
  ttsEngine: TtsEngine;
  setTtsEngine: (engine: TtsEngine) => void;
}

/**
 * 配置状态。现有 localStorage key 平铺结构不动，
 * store 是运行时真源，写操作同时落 storage（手动持久化，不用 persist 中间件）。
 * 初始值在模块加载时从 storage 读取（含 SSR 保护），替代原 page.tsx 的恢复 effect。
 */
export const useSettingsStore = create<SettingsState>()((setStore) => ({
  // 只有显式存过 "openai" 才用云端；未配置/脏值一律回浏览器本地语音（云端需要专属 TTS Key）
  ttsEngine: get("ttsEngine") === "openai" ? "openai" : "local",
  setTtsEngine: (engine) => {
    set("ttsEngine", engine);
    setStore({ ttsEngine: engine });
  },
}));
