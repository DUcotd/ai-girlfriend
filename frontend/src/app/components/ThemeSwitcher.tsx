"use client";

import { useState } from "react";
import { applyTheme, getStoredTheme } from "@/lib/storage";

interface ThemeSwitcherProps {
    onClose: () => void;
}

const themes = [
    {
        id: "sakura",
        name: "樱花粉",
        emoji: "🌸",
        description: "柔和粉色系",
        preview: "linear-gradient(135deg, #fff0f3, #ffe6f0)",
    },
    {
        id: "starry",
        name: "星空紫",
        emoji: "🌙",
        description: "神秘夜空色",
        preview: "linear-gradient(135deg, #2d1f4f, #1a1230)",
    },
    {
        id: "ocean",
        name: "海洋蓝",
        emoji: "🌊",
        description: "清新海洋色",
        preview: "linear-gradient(135deg, #e6f4f8, #d4eef5)",
    },
    {
        id: "forest",
        name: "森林绿",
        emoji: "🌿",
        description: "自然清新色",
        preview: "linear-gradient(135deg, #e8f5e9, #dcedc8)",
    },
];

export default function ThemeSwitcher({ onClose }: ThemeSwitcherProps) {
    // 懒初始化：直接从 localStorage 读取，避免闪烁
    const [currentTheme, setCurrentTheme] = useState(
        () => getStoredTheme() || "sakura"
    );

    const selectTheme = (themeId: string) => {
        setCurrentTheme(themeId);
        applyTheme(themeId);
    };

    return (
        <div className="modal-glass p-6 w-80">
            {/* 标题 */}
            <div className="flex justify-between items-center mb-4">
                <h3 className="font-bold text-lg">🎨 主题切换</h3>
                <button
                    onClick={onClose}
                    className="text-gray-400 hover:text-gray-600 transition-colors"
                >
                    ✕
                </button>
            </div>

            {/* 主题列表 */}
            <div className="space-y-3">
                {themes.map((theme) => (
                    <button
                        key={theme.id}
                        onClick={() => selectTheme(theme.id)}
                        className={`w-full flex items-center gap-3 p-3 rounded-2xl transition-all ${currentTheme === theme.id
                            ? "ring-2 ring-pink-400 bg-pink-50"
                            : "hover:bg-gray-50"
                            }`}
                    >
                        {/* 颜色预览 */}
                        <div
                            className="w-12 h-12 rounded-xl shadow-sm"
                            style={{ background: theme.preview }}
                        />

                        {/* 信息 */}
                        <div className="flex-1 text-left">
                            <div className="flex items-center gap-2">
                                <span className="text-lg">{theme.emoji}</span>
                                <span className="font-medium">{theme.name}</span>
                            </div>
                            <p className="text-xs text-gray-500">{theme.description}</p>
                        </div>

                        {/* 选中标记 */}
                        {currentTheme === theme.id && (
                            <span className="text-pink-500 text-lg">✓</span>
                        )}
                    </button>
                ))}
            </div>

            {/* 提示 */}
            <p className="text-xs text-gray-400 text-center mt-4">
                主题设置会自动保存 ✨
            </p>
        </div>
    );
}
