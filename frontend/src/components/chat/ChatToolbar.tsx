"use client";

import { Brain, ClipboardList, Download, Palette, MessageSquarePlus, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { DialogName } from "@/app/dialogs";
import { useChatStore } from "@/stores/chatStore";
import { useUiStore } from "@/stores/uiStore";

/** 顶部操作栏：新对话 / 记忆 / 主题 / 任务 / 导出 / 设置 */
const ACTIONS: { dialog?: DialogName; icon: LucideIcon; label: string }[] = [
  { icon: MessageSquarePlus, label: "新对话" },
  { dialog: "memory", icon: Brain, label: "记忆" },
  { dialog: "theme", icon: Palette, label: "主题" },
  { dialog: "task", icon: ClipboardList, label: "任务" },
  { dialog: "export", icon: Download, label: "导出" },
  { dialog: "settings", icon: Settings, label: "设置" },
];

export default function ChatToolbar() {
  const openDialog = useUiStore((s) => s.openDialog);
  const clearChat = useChatStore((s) => s.clearChat);

  return (
    <header className="flex h-16 items-center justify-between border-b border-line-subtle/50 px-6 backdrop-blur-sm">
      <div />
      <div className="flex gap-1">
        {ACTIONS.map(({ dialog, icon: Icon, label }) => (
          <button
            key={label}
            type="button"
            aria-label={label}
            title={label}
            onClick={() => (dialog ? openDialog(dialog) : void clearChat())}
            className="rounded-full p-2 text-content-secondary transition-all hover:bg-surface-1/70 hover:text-accent-strong active:scale-95 dark:hover:text-accent-1"
          >
            <Icon size={20} />
          </button>
        ))}
      </div>
    </header>
  );
}
