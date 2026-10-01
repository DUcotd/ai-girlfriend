"use client";

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

interface DialogProps {
    title: ReactNode;
    /** 标题前的图标（自动染 accent 色） */
    icon?: ReactNode;
    onClose: () => void;
    children: ReactNode;
    /** 底部操作区（保存按钮等） */
    footer?: ReactNode;
    /** 宽度类，默认 w-[400px] */
    widthClassName?: string;
    className?: string;
    /** 内容区附加类（默认 p-6 + 纵向滚动） */
    bodyClassName?: string;
}

/**
 * 标准弹窗外壳：原 .modal-glass + 各弹窗复制了 5 份的 header/footer。
 * 仍需包在 <Modal>（遮罩 + 居中 + 动画）里使用。
 */
export default function Dialog({
    title,
    icon,
    onClose,
    children,
    footer,
    widthClassName = "w-[400px]",
    className,
    bodyClassName,
}: DialogProps) {
    return (
        <div
            className={cn(
                "flex max-h-[90vh] flex-col rounded-[28px] border border-accent-1/20",
                // max-w 兜底：手机竖屏(375-430px)下 w-[520px] 这类写死宽度会溢出被裁，
                // 钳到视口减 2rem（与 EmojiPicker 的既有做法一致），配合 Modal 的 p-4 不贴边
                "bg-surface-1/95 text-content-primary shadow-modal backdrop-blur-[30px]",
                "max-w-[calc(100vw-2rem)]",
                widthClassName,
                className
            )}
        >
            <div className="flex shrink-0 items-center justify-between border-b border-line-subtle px-6 py-4">
                <h3 className="flex items-center gap-2 text-lg font-bold">
                    {icon && <span className="text-accent-1">{icon}</span>}
                    {title}
                </h3>
                <button
                    onClick={onClose}
                    aria-label="关闭"
                    className="flex h-8 w-8 items-center justify-center rounded-full text-content-muted transition-all hover:bg-surface-2 hover:text-content-secondary"
                >
                    <X size={16} />
                </button>
            </div>
            <div className={cn("flex-1 overflow-y-auto p-6", bodyClassName)}>{children}</div>
            {footer && (
                <div className="shrink-0 border-t border-line-subtle px-6 py-4">{footer}</div>
            )}
        </div>
    );
}
