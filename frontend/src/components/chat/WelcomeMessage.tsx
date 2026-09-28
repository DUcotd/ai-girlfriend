"use client";

import { motion } from "framer-motion";
import { Heart, MessageCircle } from "lucide-react";

interface WelcomeMessageProps {
    onQuickStart: (message: string) => void;
}

const quickStarters = [
    { emoji: "👋", text: "你好，我们认识一下吧！", label: "打个招呼" },
    { emoji: "💬", text: "今天过得怎么样？", label: "日常关心" },
    { emoji: "😊", text: "聊聊你的爱好吧", label: "了解喜好" },
    { emoji: "💕", text: "你觉得我怎么样？", label: "撒个娇" },
];

export default function WelcomeMessage({ onQuickStart }: WelcomeMessageProps) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center h-full px-6 py-12 text-center"
        >
            {/* 欢迎图标 */}
            <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", delay: 0.2 }}
                className="relative mb-6"
            >
                <div className="w-24 h-24 rounded-full bg-gradient-to-br from-pink-100 to-purple-100 flex items-center justify-center shadow-lg">
                    <Heart className="w-12 h-12 text-pink-400" />
                </div>
                <motion.span
                    animate={{ rotate: [0, 15, -15, 0] }}
                    transition={{ repeat: Infinity, duration: 2 }}
                    className="absolute -top-2 -right-2 text-2xl"
                >
                    ✨
                </motion.span>
            </motion.div>

            {/* 欢迎文字 */}
            <motion.h2
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 }}
                className="text-2xl font-bold gradient-text mb-2"
            >
                欢迎回来！
            </motion.h2>

            <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.4 }}
                className="text-gray-500 mb-8 max-w-md"
            >
                我是小爱，你的 AI 女友 💕<br />
                随时可以和我聊天哦～
            </motion.p>

            {/* 快速开始按钮 */}
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5 }}
                className="grid grid-cols-2 gap-3 w-full max-w-sm"
            >
                {quickStarters.map((item, idx) => (
                    <motion.button
                        key={idx}
                        whileHover={{ scale: 1.03 }}
                        whileTap={{ scale: 0.97 }}
                        onClick={() => onQuickStart(item.text)}
                        className="flex flex-col items-center gap-2 p-4 rounded-2xl bg-white/80 border border-pink-100 shadow-sm hover:shadow-md hover:border-pink-200 transition-all"
                    >
                        <span className="text-2xl">{item.emoji}</span>
                        <span className="text-sm text-gray-600">{item.label}</span>
                    </motion.button>
                ))}
            </motion.div>

            {/* 提示 */}
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.7 }}
                className="mt-8 flex items-center gap-2 text-xs text-gray-400"
            >
                <MessageCircle size={14} />
                <span>点击上方按钮或直接输入消息开始聊天</span>
            </motion.div>
        </motion.div>
    );
}
