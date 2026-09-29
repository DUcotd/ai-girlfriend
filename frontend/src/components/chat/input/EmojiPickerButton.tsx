"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { Smile } from "lucide-react";
import EmojiPicker from "../EmojiPicker";
import IconButton from "@/components/ui/IconButton";

interface EmojiPickerButtonProps {
    onSelect: (emoji: string) => void;
}

/**
 * 表情按钮 + 弹出面板（面板开关为组件局部态）。
 * 收起途径有三：再点按钮、点面板/按钮之外的任意处、Esc（Esc 在面板内部处理）。
 */
export default function EmojiPickerButton({ onSelect }: EmojiPickerButtonProps) {
    const [isOpen, setIsOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    // 点击外部收起：用 mousedown 而非 click，避开「面板内点击后 click 冒泡到
    // document 又把刚关掉的面板重新判定」的时序问题。
    useEffect(() => {
        if (!isOpen) return;
        const onPointerDown = (e: MouseEvent) => {
            if (!rootRef.current?.contains(e.target as Node)) setIsOpen(false);
        };
        document.addEventListener("mousedown", onPointerDown);
        return () => document.removeEventListener("mousedown", onPointerDown);
    }, [isOpen]);

    return (
        <div ref={rootRef} className="relative">
            <IconButton
                active={isOpen}
                onClick={() => setIsOpen(!isOpen)}
                title="选择表情"
                aria-haspopup="dialog"
                aria-expanded={isOpen}
            >
                <Smile size={20} />
            </IconButton>
            <AnimatePresence>
                {isOpen && (
                    <EmojiPicker
                        key="emoji-picker"
                        onSelect={onSelect}
                        onClose={() => setIsOpen(false)}
                    />
                )}
            </AnimatePresence>
        </div>
    );
}
