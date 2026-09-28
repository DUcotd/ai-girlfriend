"use client";

import { useState } from "react";
import { AnimatePresence } from "framer-motion";
import { Smile } from "lucide-react";
import EmojiPicker from "../EmojiPicker";
import IconButton from "@/components/ui/IconButton";

interface EmojiPickerButtonProps {
    onSelect: (emoji: string) => void;
}

/** 表情按钮 + 弹出面板（面板开关为组件局部态）。 */
export default function EmojiPickerButton({ onSelect }: EmojiPickerButtonProps) {
    const [isOpen, setIsOpen] = useState(false);

    return (
        <div className="relative">
            <IconButton
                active={isOpen}
                onClick={() => setIsOpen(!isOpen)}
                title="选择表情"
            >
                <Smile size={20} />
            </IconButton>
            <AnimatePresence>
                {isOpen && (
                    <EmojiPicker
                        onSelect={onSelect}
                        onClose={() => setIsOpen(false)}
                    />
                )}
            </AnimatePresence>
        </div>
    );
}
