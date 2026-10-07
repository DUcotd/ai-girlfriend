"use client";

import { useState } from "react";
import { Brain, ClipboardList, Download, Palette, MessageSquarePlus, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { DialogName } from "@/app/dialogs";
import { cn } from "@/lib/cn";
import ConfirmDialog from "../ui/ConfirmDialog";
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
  const newConversation = useChatStore((s) => s.newConversation);
  // 「新对话」会清空对话记录，先弹确认——它只是清画面，不动记忆与好感度
  const [showNewConfirm, setShowNewConfirm] = useState(false);

  const handleNewConversation = () => {
    setShowNewConfirm(false);
    void newConversation();
  };

  return (
    <>
      <header className="flex h-16 items-center justify-between border-b border-line-subtle/50 px-6 backdrop-blur-sm">
        <div />
        <div className="flex gap-1">
          {ACTIONS.map(({ dialog, icon: Icon, label }) => (
            <button
              key={label}
              type="button"
              aria-label={label}
              title={label}
              onClick={() => (dialog ? openDialog(dialog) : setShowNewConfirm(true))}
              className={cn(
                "rounded-full p-2 text-content-secondary transition-all hover:bg-surface-1/70 hover:text-accent-strong active:scale-95 dark:hover:text-accent-1",
                // 图标 20px + p-2 = 36px，低于触屏最小触达尺寸 44×44（WCAG 2.5.5）。
                // 用 min-h/min-w 把可点区撑到 44 而不是加 padding：图标与视觉间距都不变，
                // 只是手指按得更准（header 高 64px，装得下）。
                "inline-flex min-h-11 min-w-11 items-center justify-center",
                // 键盘焦点：这一排按钮 hover 才有底色，没有焦点环就看不出选中了谁
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-1/60"
              )}
            >
              <Icon size={20} />
            </button>
          ))}
        </div>
      </header>

      {/* 确认弹窗渲染为 header 的兄弟节点：父级若带 transform，会把子级 fixed
          相对弹窗定位而非 viewport（本项目踩过），故与 header 平级而非嵌套其中。 */}
      <ConfirmDialog
        isOpen={showNewConfirm}
        title="开始新对话？"
        message={"只会清空当前的对话记录。\n小爱的记忆与好感度都会保留。"}
        confirmText="开始新对话"
        cancelText="取消"
        type="normal"
        onConfirm={handleNewConversation}
        onCancel={() => setShowNewConfirm(false)}
      />
    </>
  );
}
