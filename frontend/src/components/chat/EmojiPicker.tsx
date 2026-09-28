"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

interface EmojiPickerProps {
    onSelect: (emoji: string) => void;
    onClose: () => void;
}

const emojiCategories = [
    {
        name: "爱心",
        emojis: ["❤️", "💕", "💖", "💗", "💓", "💞", "💝", "💘", "🥰", "😍", "😘", "😚"],
    },
    {
        name: "表情",
        emojis: ["😊", "😄", "😆", "🤭", "😳", "🥹", "😢", "😭", "😤", "😡", "🤗", "🤔"],
    },
    {
        name: "动作",
        emojis: ["👋", "👏", "🙌", "🤝", "👍", "👎", "✌️", "🤞", "🫶", "💪", "🙏", "🫡"],
    },
    {
        name: "颜文字",
        emojis: ["(๑•̀ㅂ•́)و✧", "(｡♥‿♥｡)", "(✿◠‿◠)", "(≧◡≦)", "(´・ω・`)", "╰(*°▽°*)╯",
            "(｡◕‿◕｡)", "(◕‿◕✿)", "(⁄ ⁄•⁄ω⁄•⁄ ⁄)", "( ´ ▽ ` )ﾉ", "(✧ω✧)", "٩(◕‿◕｡)۶"],
    },
    {
        name: "其他",
        emojis: ["✨", "💫", "⭐", "🌟", "🌸", "🌺", "🎀", "🎵", "🎶", "💭", "💬", "🎁"],
    },
];

export default function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
    const [activeCategory, setActiveCategory] = useState(0);

    return (
        <div className="absolute bottom-full left-0 mb-2 w-80 rounded-[28px] border border-accent-1/20 bg-surface-1/95 p-4 text-content-primary shadow-modal backdrop-blur-[30px]">
            {/* 标题栏 */}
            <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-bold">选择表情 ✨</h3>
                <button
                    onClick={onClose}
                    className="text-content-muted transition-colors hover:text-content-secondary"
                >
                    ✕
                </button>
            </div>

            {/* 分类标签 */}
            <div className="mb-3 flex gap-1 overflow-x-auto border-b border-line-subtle pb-2">
                {emojiCategories.map((cat, idx) => (
                    <button
                        key={idx}
                        onClick={() => setActiveCategory(idx)}
                        className={cn(
                            "whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium transition-all",
                            activeCategory === idx
                                ? "bg-accent-1/15 text-accent-strong dark:text-accent-1"
                                : "text-content-secondary hover:bg-surface-2"
                        )}
                    >
                        {cat.name}
                    </button>
                ))}
            </div>

            {/* 表情网格 */}
            <div className="grid max-h-40 grid-cols-6 gap-2 overflow-y-auto">
                {emojiCategories[activeCategory].emojis.map((emoji, idx) => (
                    <button
                        key={idx}
                        onClick={() => {
                            onSelect(emoji);
                            onClose();
                        }}
                        className="rounded-lg p-2 text-center text-lg transition-all hover:scale-110 hover:bg-accent-1/10 active:scale-95"
                        title={emoji}
                    >
                        {emoji}
                    </button>
                ))}
            </div>
        </div>
    );
}
