import type { ThemeMode, ThemeName } from "@/types";

/** 主题元数据：名称/emoji/描述 + 明暗两种模式下的预览渐变 */
export interface ThemeMeta {
  id: ThemeName;
  name: string;
  emoji: string;
  description: string;
  preview: Record<ThemeMode, string>;
}

export const THEMES: ThemeMeta[] = [
  {
    id: "sakura",
    name: "樱花粉",
    emoji: "🌸",
    description: "柔和粉色系",
    preview: {
      light: "linear-gradient(135deg, #fff0f3, #ffe6f0)",
      dark: "linear-gradient(135deg, #331720, #241019)",
    },
  },
  {
    id: "starry",
    name: "星空紫",
    emoji: "🌙",
    description: "神秘夜空色",
    preview: {
      light: "linear-gradient(135deg, #efe9f7, #e3dcf2)",
      dark: "linear-gradient(135deg, #2d1f4f, #1a1230)",
    },
  },
  {
    id: "ocean",
    name: "海洋蓝",
    emoji: "🌊",
    description: "清新海洋色",
    preview: {
      light: "linear-gradient(135deg, #e6f4f8, #d4eef5)",
      dark: "linear-gradient(135deg, #122a38, #0c1e29)",
    },
  },
  {
    id: "forest",
    name: "森林绿",
    emoji: "🌿",
    description: "自然清新色",
    preview: {
      light: "linear-gradient(135deg, #e8f5e9, #dcedc8)",
      dark: "linear-gradient(135deg, #16281b, #0f1e14)",
    },
  },
];

export const MODES: { id: ThemeMode; name: string; emoji: string }[] = [
  { id: "light", name: "浅色", emoji: "☀️" },
  { id: "dark", name: "深色", emoji: "🌙" },
];
