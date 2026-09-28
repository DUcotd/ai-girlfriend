"use client";

import { Brain, ClipboardList, Download, Palette, MessageSquarePlus, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { DialogName } from "@/app/dialogs";

interface ChatToolbarProps {
  onOpen: (dialog: DialogName) => void;
  onNewChat: () => void;
}

/** 顶部操作栏：新对话 / 记忆 / 主题 / 任务 / 导出 / 设置 */
const ACTIONS: { dialog?: DialogName; icon: LucideIcon; label: string }[] = [
  { icon: MessageSquarePlus, label: "新对话" },
  { dialog: "memory", icon: Brain, label: "记忆" },
  { dialog: "theme", icon: Palette, label: "主题" },
  { dialog: "task", icon: ClipboardList, label: "任务" },
  { dialog: "export", icon: Download, label: "导出" },
  { dialog: "settings", icon: Settings, label: "设置" },
];

export default function ChatToolbar({ onOpen, onNewChat }: ChatToolbarProps) {
  return (
    <header className="h-16 flex items-center justify-between px-6 border-b border-white/20 backdrop-blur-sm">
      <div />
      <div className="flex gap-1">
        {ACTIONS.map(({ dialog, icon: Icon, label }) => (
          <button
            key={label}
            type="button"
            aria-label={label}
            title={label}
            onClick={() => (dialog ? onOpen(dialog) : onNewChat())}
            className="p-2 rounded-full text-gray-500 hover:text-pink-600 hover:bg-white/70 active:scale-95 transition-all"
          >
            <Icon size={20} />
          </button>
        ))}
      </div>
    </header>
  );
}
