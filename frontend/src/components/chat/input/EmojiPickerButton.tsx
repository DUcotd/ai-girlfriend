"use client";

import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { AnimatePresence } from "framer-motion";
import { Smile } from "lucide-react";
import EmojiPicker from "../EmojiPicker";
import IconButton from "@/components/ui/IconButton";
import type { BoxRect } from "@/lib/emojiPickerPosition";

interface EmojiPickerButtonProps {
    onSelect: (emoji: string) => void;
}

const toRect = (el: HTMLElement): BoxRect => {
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
};

/**
 * 表情按钮 + 弹出面板（面板开关为组件局部态）。
 * 收起途径有三：再点按钮、点面板/按钮之外的任意处、Esc（Esc 在面板内部处理）。
 *
 * 面板是 portal 到 body 的 fixed 浮层（原因见 EmojiPicker 头部注释），
 * 所以这里要负责两件事：
 * ① 把触发按钮的视口矩形交给面板算位置——点击时**同步**量一次，
 *    首帧就有正确坐标；窗口缩放/页面滚动时再重量，面板跟着走；
 * ② 「点外面」的判定得把面板节点也算成自己人，
 *    否则面板已经不在 rootRef 子树里，点任何表情都会被当成点到外面。
 */
export default function EmojiPickerButton({ onSelect }: EmojiPickerButtonProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [anchor, setAnchor] = useState<BoxRect | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLElement | null>(null);

    // 点击外部收起：用 mousedown 而非 click，避开「面板内点击后 click 冒泡到
    // document 又把刚关掉的面板重新判定」的时序问题。
    useEffect(() => {
        if (!isOpen) return;
        const onPointerDown = (e: MouseEvent) => {
            const target = e.target as Node;
            if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            setIsOpen(false);
        };
        document.addEventListener("mousedown", onPointerDown);
        return () => document.removeEventListener("mousedown", onPointerDown);
    }, [isOpen]);

    // 面板开着时跟随视口变化重新测量触发元素（聊天列表滚动也算）
    useEffect(() => {
        if (!isOpen) return;
        const measure = () => {
            if (rootRef.current) setAnchor(toRect(rootRef.current));
        };
        measure();
        window.addEventListener("resize", measure);
        // capture: true —— 滚动发生在内部的聊天列表容器上，不冒泡，只能在捕获阶段听到
        window.addEventListener("scroll", measure, true);
        return () => {
            window.removeEventListener("resize", measure);
            window.removeEventListener("scroll", measure, true);
        };
    }, [isOpen]);

    const toggle = (event: ReactMouseEvent<HTMLButtonElement>) => {
        if (!isOpen) {
            // 打开的这一刻就量好矩形：省掉「先渲染在 0,0 再跳过去」的那一帧
            const el = event.currentTarget;
            setAnchor(toRect(el));
        }
        setIsOpen((open) => !open);
    };

    return (
        <div ref={rootRef} className="relative">
            <IconButton
                active={isOpen}
                onClick={toggle}
                title="选择表情"
                aria-haspopup="dialog"
                aria-expanded={isOpen}
            >
                <Smile size={20} />
            </IconButton>
            <AnimatePresence>
                {isOpen && anchor && (
                    <EmojiPicker
                        key="emoji-picker"
                        anchor={anchor}
                        panelRef={panelRef}
                        onSelect={onSelect}
                        onClose={() => setIsOpen(false)}
                    />
                )}
            </AnimatePresence>
        </div>
    );
}
