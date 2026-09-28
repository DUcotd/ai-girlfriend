"use client";

import Dialog from "../ui/Dialog";
import { cn } from "@/lib/cn";
import { useThemeStore } from "@/stores/themeStore";
import { MODES, THEMES } from "./themeConfig";

interface ThemeDialogProps {
  onClose: () => void;
}

/**
 * 主题切换：主题（色相）与明暗模式两个独立维度。
 * 状态读写全部走 themeStore（防 FOUC 脚本保证首帧一致）。
 */
export default function ThemeDialog({ onClose }: ThemeDialogProps) {
  const theme = useThemeStore((s) => s.theme);
  const mode = useThemeStore((s) => s.mode);
  const setTheme = useThemeStore((s) => s.setTheme);
  const setMode = useThemeStore((s) => s.setMode);

  return (
    <Dialog title="🎨 主题切换" onClose={onClose} widthClassName="w-80">
      {/* 明暗模式 */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            className={cn(
              "py-2 rounded-full text-sm font-medium transition-all border-2",
              mode === m.id
                ? "border-accent-1 bg-accent-1/15 text-content-primary"
                : "border-transparent bg-surface-2/80 text-content-secondary hover:bg-surface-2"
            )}
          >
            {m.emoji} {m.name}
          </button>
        ))}
      </div>

      {/* 主题列表 */}
      <div className="space-y-3">
        {THEMES.map((t) => (
          <button
            key={t.id}
            onClick={() => setTheme(t.id)}
            className={cn(
              "w-full flex items-center gap-3 p-3 rounded-2xl transition-all",
              theme === t.id
                ? "ring-2 ring-accent-1 bg-accent-1/10"
                : "hover:bg-surface-2/70"
            )}
          >
            {/* 颜色预览（随当前模式切换） */}
            <div
              className="w-12 h-12 rounded-xl shadow-sm"
              style={{ background: t.preview[mode] }}
            />

            {/* 信息 */}
            <div className="flex-1 text-left">
              <div className="flex items-center gap-2">
                <span className="text-lg">{t.emoji}</span>
                <span className="font-medium">{t.name}</span>
              </div>
              <p className="text-xs text-content-muted">{t.description}</p>
            </div>

            {/* 选中标记 */}
            {theme === t.id && <span className="text-accent-1 text-lg">✓</span>}
          </button>
        ))}
      </div>

      {/* 提示 */}
      <p className="text-xs text-content-muted text-center mt-4">
        主题设置会自动保存 ✨
      </p>
    </Dialog>
  );
}
