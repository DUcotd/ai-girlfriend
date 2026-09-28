"use client";

import { useState } from "react";

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
        <div className="absolute bottom-full left-0 mb-2 w-80 modal-glass p-4 shadow-2xl">
            {/* 标题栏 */}
            <div className="flex justify-between items-center mb-3">
                <h3 className="font-bold text-sm">选择表情 ✨</h3>
                <button
                    onClick={onClose}
                    className="text-gray-400 hover:text-gray-600 transition-colors"
                >
                    ✕
                </button>
            </div>

            {/* 分类标签 */}
            <div className="flex gap-1 mb-3 pb-2 border-b border-gray-200 overflow-x-auto">
                {emojiCategories.map((cat, idx) => (
                    <button
                        key={idx}
                        onClick={() => setActiveCategory(idx)}
                        className={`px-3 py-1 rounded-full text-xs font-medium transition-all whitespace-nowrap ${activeCategory === idx
                                ? "bg-pink-100 text-pink-600"
                                : "text-gray-500 hover:bg-gray-100"
                            }`}
                    >
                        {cat.name}
                    </button>
                ))}
            </div>

            {/* 表情网格 */}
            <div className="grid grid-cols-6 gap-2 max-h-40 overflow-y-auto">
                {emojiCategories[activeCategory].emojis.map((emoji, idx) => (
                    <button
                        key={idx}
                        onClick={() => {
                            onSelect(emoji);
                            onClose();
                        }}
                        className="p-2 rounded-lg hover:bg-pink-50 transition-colors text-center text-lg hover:scale-110 active:scale-95"
                        title={emoji}
                    >
                        {emoji}
                    </button>
                ))}
            </div>
        </div>
    );
}
