"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
    DEFAULT_EMOJI_CATEGORY_ID,
    EMOJI_CATEGORIES,
} from "@/lib/emojiData";
import { placePopoverBesideTrigger } from "@/lib/emojiPickerPosition";
import type { BoxRect } from "@/lib/emojiPickerPosition";

interface EmojiPickerProps {
    onSelect: (emoji: string) => void;
    onClose: () => void;
    /** 触发按钮在视口中的矩形（由 EmojiPickerButton 量好后传入） */
    anchor: BoxRect;
    /** 面板节点引用：调用方要靠它判断「点击是否发生在面板内」（面板已 portal 到 body） */
    panelRef: RefObject<HTMLElement | null>;
}

/**
 * 表情选择面板 —— 浮在输入框上方。
 *
 * 定位：portal 到 body + position: fixed，坐标由 placePopoverBesideTrigger 依
 * 「触发元素矩形 + 面板实际尺寸 + 视口」算出来。三个原因：
 * ① 输入区父链上有 backdrop-filter（玻璃 dock），它会给 fixed 造新的包含块，
 *    就地 fixed 会贴在 dock 上而不是视口上；
 * ② 外层 main 是 overflow-hidden，写死 `bottom-full left-0` 的面板一旦超出
 *    视口（375px 窄屏 / 软键盘顶起可视区）就被裁掉；
 * ③ 面板高度随分类变化，只有实测才知道贴不贴得下，放不下时它会自动翻到下方。
 *
 * 三段式结构：标题栏 / 分类标签 / 固定高度滚动网格。
 * 滚动区高度写死（h-[180px]）而非按内容自适应：各分类条数与格子高度都不同，
 * 内容撑高会让面板在切分类时整体上下跳（见 UI 稳定性约定②）。
 * 网格用 min-h-full + content-center：内容不满时垂直居中，超出时正常滚动
 * （若直接给 overflow 容器加 content-center，溢出后首行会被推出可视区、滚不回去）。
 */
export default function EmojiPicker({ onSelect, onClose, anchor, panelRef }: EmojiPickerProps) {
    const [activeId, setActiveId] = useState(DEFAULT_EMOJI_CATEGORY_ID);
    const activeCategory =
        EMOJI_CATEGORIES.find((cat) => cat.id === activeId) ?? EMOJI_CATEGORIES[0];
    const selfRef = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState<{ left: number; top: number; below: boolean } | null>(
        null
    );

    // Esc 关闭（桌面端预期行为，与 Modal 一致）
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [onClose]);

    /** 量一次面板实际尺寸再算位置；useLayoutEffect 保证这次测量在浏览器绘制之前完成 */
    useLayoutEffect(() => {
        const node = selfRef.current;
        if (!node) return;
        const placed = placePopoverBesideTrigger({
            trigger: anchor,
            panel: { width: node.offsetWidth, height: node.offsetHeight },
            viewport: { width: window.innerWidth, height: window.innerHeight },
        });
        setPosition({ left: placed.left, top: placed.top, below: placed.placement === "below" });
        // activeId 也在依赖里：切分类会改面板高度，高度变了位置就得重算
    }, [anchor, activeId]);

    const isGrid = activeCategory.layout === "grid";

    return createPortal(
        <motion.div
            ref={(node) => {
                selfRef.current = node;
                // 外部引用同一个节点：点外面收起的判定要能认得面板
                panelRef.current = node;
            }}
            role="dialog"
            aria-label="选择表情"
            initial={{ opacity: 0, scale: 0.94, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: 8 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            // 位置还没量到时先藏起来（同一帧里就会被填上，肉眼看不到这一帧）
            style={{
                position: "fixed",
                left: position?.left ?? 0,
                top: position?.top ?? 0,
                visibility: position ? "visible" : "hidden",
                // 缩放动画的支点跟着翻转方向一起换：上方展开时以下边为支点，反之以上边为支点
                transformOrigin: position?.below ? "top left" : "bottom left",
            }}
            className="z-[60] w-[344px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-3xl border border-accent-1/20 bg-surface-1/95 text-content-primary shadow-modal backdrop-blur-[30px]"
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
                    className="flex h-7 w-7 items-center justify-center rounded-full text-content-muted transition-colors duration-fast hover:bg-surface-2 hover:text-content-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-1/60"
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
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-1/60",
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
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-1/60",
                                isGrid ? "text-xl" : "whitespace-nowrap px-2 text-[13px]"
                            )}
                        >
                            {/* 放大反馈以前只有 group-hover —— 键盘 Tab 进来时看不出现任在哪一格，
                                补 group-focus-visible 让两种操作方式看到同一个提示 */}
                            <span className="transition-transform duration-fast group-hover:scale-110 group-focus-visible:scale-110">
                                {emoji}
                            </span>
                        </button>
                    ))}
                </motion.div>
            </div>
        </motion.div>,
        document.body
    );
}
