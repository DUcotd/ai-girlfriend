"use client";

import { useMemo } from "react";
import Dialog from "../ui/Dialog";
import { cn } from "@/lib/cn";
import { useThemeStore } from "@/stores/themeStore";
import { useRadioGroup } from "@/hooks/useRadioGroup";
import { MODES, THEMES } from "./themeConfig";
import type { ThemeMode, ThemeName } from "@/types";

interface ThemeDialogProps {
  onClose: () => void;
}

/**
 * 主题切换：主题（色相）与明暗模式两个独立维度。
 * 状态读写全部走 themeStore（防 FOUC 脚本保证首帧一致）。
 *
 * 两组选项都是「单选」语义（radiogroup / radio / aria-checked）：
 * 选中状态必须由 aria 说出来——旧实现只有描边和 ✓ 的区别，
 * 读屏用户听完只知道「有个按钮」，不知道当前用的是哪个主题。
 * 键盘导航复用 lib/radioGroup 的规则（方向键换档即时生效）。
 */
export default function ThemeDialog({ onClose }: ThemeDialogProps) {
  const theme = useThemeStore((s) => s.theme);
  const mode = useThemeStore((s) => s.mode);
  const setTheme = useThemeStore((s) => s.setTheme);
  const setMode = useThemeStore((s) => s.setMode);

  // useRadioGroup 只认 { value, disabled? }，且需要稳定引用（否则每次渲染重建回调）
  const modeOptions = useMemo(
    () => MODES.map((m) => ({ value: m.id as ThemeMode })),
    []
  );
  const themeOptions = useMemo(
    () => THEMES.map((t) => ({ value: t.id as ThemeName })),
    []
  );
  const modeGroup = useRadioGroup({ options: modeOptions, value: mode, onChange: setMode });
  const themeGroup = useRadioGroup({ options: themeOptions, value: theme, onChange: setTheme });

  return (
    <Dialog title="🎨 主题切换" onClose={onClose} widthClassName="w-80">
      {/* 明暗模式 */}
      <div role="radiogroup" aria-label="显示模式" className="mb-4 grid grid-cols-2 gap-2">
        {MODES.map((m, index) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            tabIndex={modeGroup.tabIndexFor(index)}
            ref={(node) => {
              modeGroup.refs.current[index] = node;
            }}
            onClick={() => setMode(m.id)}
            onKeyDown={(e) => modeGroup.onKeyDown(e, index)}
            className={cn(
              "py-2 rounded-full text-sm font-medium transition-all border-2",
              // hover 才变底色 = 键盘用户看不出重点；补 focus-visible 环 + 选中态本身就有描边
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-1/60",
              mode === m.id
                ? "border-accent-1 bg-accent-1/15 text-content-primary"
                : "border-transparent bg-surface-2/80 text-content-secondary hover:bg-surface-2"
            )}
          >
            {/* emoji 是装饰，读屏念「太阳 浅色」没意义，交给 aria-label 的纯文字 */}
            <span aria-hidden="true">{m.emoji} </span>
            {m.name}
          </button>
        ))}
      </div>

      {/* 主题列表 */}
      <div role="radiogroup" aria-label="主题配色" className="space-y-3">
        {THEMES.map((t, index) => {
          const active = theme === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={themeGroup.tabIndexFor(index)}
              ref={(node) => {
                themeGroup.refs.current[index] = node;
              }}
              onClick={() => setTheme(t.id)}
              onKeyDown={(e) => themeGroup.onKeyDown(e, index)}
              className={cn(
                "w-full flex items-center gap-3 p-3 rounded-2xl transition-all",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-1/60",
                active ? "ring-2 ring-accent-1 bg-accent-1/10" : "hover:bg-surface-2/70"
              )}
            >
              {/* 颜色预览（随当前模式切换）；纯装饰，对读屏无信息量 */}
              <div
                aria-hidden="true"
                className="w-12 h-12 rounded-xl shadow-sm"
                style={{ background: t.preview[mode] }}
              />

              {/* 信息 */}
              <div className="flex-1 text-left">
                <div className="flex items-center gap-2">
                  <span aria-hidden="true" className="text-lg">
                    {t.emoji}
                  </span>
                  <span className="font-medium">{t.name}</span>
                </div>
                <p className="text-xs text-content-muted">{t.description}</p>
              </div>

              {/* 选中标记：视觉上是个 ✓，可访问性由 aria-checked 负责，
                  否则读屏会念成「对勾」并和「已选中」重复 */}
              {active && (
                <span aria-hidden="true" className="text-accent-1 text-lg">
                  ✓
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* 提示 */}
      <p className="text-xs text-content-muted text-center mt-4">
        主题设置会自动保存 ✨
      </p>
    </Dialog>
  );
}
