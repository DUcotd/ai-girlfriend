import { create } from "zustand";
import {
  applyTheme,
  applyThemeMode,
  getStoredTheme,
  getStoredThemeMode,
} from "@/lib/storage";
import type { ThemeMode, ThemeName } from "@/types";

const THEME_NAMES: readonly ThemeName[] = ["sakura", "starry", "ocean", "forest"];

function resolveInitialTheme(): ThemeName {
  const stored = getStoredTheme();
  return THEME_NAMES.includes(stored as ThemeName) ? (stored as ThemeName) : "sakura";
}

/**
 * 旧版没有独立模式：星空紫用户习惯于暗色观感，
 * 无 themeMode 记录时一次性迁移为 starry+dark（与 layout 防 FOUC 脚本同一规则）。
 */
function resolveInitialMode(theme: ThemeName): ThemeMode {
  const stored = getStoredThemeMode();
  if (stored === "light" || stored === "dark") return stored;
  return theme === "starry" ? "dark" : "light";
}

interface ThemeState {
  theme: ThemeName;
  mode: ThemeMode;
  setTheme: (theme: ThemeName) => void;
  setMode: (mode: ThemeMode) => void;
}

/**
 * 主题状态。html 属性由防 FOUC 脚本在首帧前设置，
 * store 初始值与之同规则，仅作为组件内响应式真源；
 * 写操作同时落 localStorage（手动持久化，不用 persist 中间件）。
 */
export const useThemeStore = create<ThemeState>()((set) => {
  const theme = resolveInitialTheme();
  return {
    theme,
    mode: resolveInitialMode(theme),
    setTheme: (next) => {
      applyTheme(next);
      set({ theme: next });
    },
    setMode: (next) => {
      applyThemeMode(next);
      set({ mode: next });
    },
  };
});
