"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
    DEFAULT_EMOJI_CATEGORY_ID,
    EMOJI_CATEGORIES,
} from "@/lib/emojiData";

interface EmojiPickerProps {
    onSelect: (emoji: string) => void;
    onClose: () => void;
}

/**
 * 表情选择面板 —— 浮在输入框上方（由 EmojiPickerButton 的 AnimatePresence 提供出入场动画）。
 *
 * 三段式结构：标题栏 / 分类标签 / 固定高度滚动网格。
 * 滚动区高度写死（h-[180px]）而非按内容自适应：各分类条数与格子高度都不同，
 * 内容撑高会让面板在切分类时整体上下跳（见 UI 稳定性约定②）。
 * 网格用 min-h-full + content-center：内容不满时垂直居中，超出时正常滚动
 * （若直接给 overflow 容器加 content-center，溢出后首行会被推出可视区、滚不回去）。
 */
export default function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
    const [activeId, setActiveId] = useState(DEFAULT_EMOJI_CATEGORY_ID);
    const activeCategory =
        EMOJI_CATEGORIES.find((cat) => cat.id === activeId) ?? EMOJI_CATEGORIES[0];

    // Esc 关闭（桌面端预期行为，与 Modal 一致）
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [onClose]);

    const isGrid = activeCategory.layout === "grid";

    return (
        <motion.div
            role="dialog"
            aria-label="选择表情"
            initial={{ opacity: 0, scale: 0.94, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: 8 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="absolute bottom-full left-0 z-30 mb-3 w-[344px] max-w-[calc(100vw-2rem)] origin-bottom-left overflow-hidden rounded-3xl border border-accent-1/20 bg-surface-1/95 text-content-primary shadow-modal backdrop-blur-[30px]"
        >
            {/* 标题栏 */}
            <div className="flex items-center justify-between px-4 pb-2 pt-3.5">
                <h3 className="text-sm font-bold">
                    选择表情 <span className="text-accent-1">✨</span>
                </h3>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="关闭"
                    className="flex h-7 w-7 items-center justify-center rounded-full text-content-muted transition-colors duration-fast hover:bg-surface-2 hover:text-content-secondary"
                >
                    <X size={15} />
                </button>
            </div>

            {/* 分类标签：横向可滚，隐藏滚动条避免 5 个标签在窄屏挤出滚动槽 */}
            <div
                role="tablist"
                aria-label="表情分类"
                className="flex gap-1 overflow-x-auto px-4 pb-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
                {EMOJI_CATEGORIES.map((cat) => {
                    const active = cat.id === activeCategory.id;
                    return (
                        <button
                            key={cat.id}
                            type="button"
                            role="tab"
                            aria-selected={active}
                            onClick={() => setActiveId(cat.id)}
                            className={cn(
                                // 边框常驻（未激活用 border-transparent）：
                                // height 为 auto 时 border-box 不吸收边框，激活才加 border 会让
                                // 该标签高 2px 并把整行控件推挤错位（见 UI 稳定性约定①）
                                "whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-normal",
                                active
                                    ? "border-accent-1/30 bg-accent-1/15 text-accent-strong dark:text-accent-1"
                                    : "border-transparent text-content-secondary hover:bg-surface-2 hover:text-content-primary"
                            )}
                        >
                            {cat.label}
                        </button>
                    );
                })}
            </div>

            {/* 表情网格：固定高度滚动区 */}
            <div className="h-[180px] overflow-y-auto overflow-x-hidden border-t border-line-subtle px-4 py-3 [scrollbar-gutter:stable]">
                <motion.div
                    // key 随分类变化 → 重建并淡入，避免内容突变
                    key={activeCategory.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.15 }}
                    className={cn(
                        "grid min-h-full gap-1 content-center",
                        // 颜文字必须单列：最长的 "(⁄ ⁄•⁄ω⁄•⁄ ⁄)" 在两列宽格（约 137px 可用宽）里
                        // 会被 overflow-x-hidden 裁掉尾巴，实测 149px 格宽装不下
                        isGrid ? "auto-rows-[50px] grid-cols-6" : "auto-rows-[34px] grid-cols-1"
                    )}
                >
                    {activeCategory.emojis.map((emoji) => (
                        <button
                            key={`${activeCategory.id}-${emoji}`}
                            type="button"
                            onClick={() => {
                                onSelect(emoji);
                                onClose();
                            }}
                            aria-label={emoji}
                            title={emoji}
                            className={cn(
                                "group flex items-center justify-center rounded-xl transition-colors duration-fast",
                                "hover:bg-accent-1/15 active:bg-accent-1/25",
                                isGrid ? "text-xl" : "whitespace-nowrap px-2 text-[13px]"
                            )}
                        >
                            <span className="transition-transform duration-fast group-hover:scale-110">
                                {emoji}
                            </span>
                        </button>
                    ))}
                </motion.div>
            </div>
        </motion.div>
    );
}
