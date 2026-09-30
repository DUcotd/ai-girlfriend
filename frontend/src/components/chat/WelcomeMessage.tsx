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
            className="flex h-full flex-col items-center justify-center px-6 py-12 text-center"
        >
            {/* 欢迎图标 */}
            <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", delay: 0.2 }}
                className="relative mb-6"
            >
                <div className="flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-br from-accent-1/20 to-accent-2/20 shadow-lg">
                    <Heart className="h-12 w-12 text-accent-1" />
                </div>
                <motion.span
                    animate={{ rotate: [0, 15, -15, 0] }}
                    transition={{ repeat: Infinity, duration: 2 }}
                    className="absolute -right-2 -top-2 text-2xl"
                >
                    ✨
                </motion.span>
            </motion.div>

            {/* 欢迎文字 */}
            <motion.h2
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 }}
                className="gradient-text mb-2 text-2xl font-bold"
            >
                欢迎回来！
            </motion.h2>

            <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.4 }}
                className="mb-8 max-w-md text-content-secondary"
            >
                我是小爱，你的 AI 女友 💕<br />
                随时可以和我聊天哦～
            </motion.p>

            {/* 快速开始按钮 */}
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5 }}
                className="grid w-full max-w-md grid-cols-2 gap-4"
            >
                {quickStarters.map((item, idx) => (
                    <motion.button
                        key={idx}
                        whileHover={{ scale: 1.03 }}
                        whileTap={{ scale: 0.97 }}
                        onClick={() => onQuickStart(item.text)}
                        className="flex flex-col items-center gap-2 rounded-2xl border border-line-subtle bg-surface-1/80 p-4 shadow-sm transition-all hover:border-accent-1/40 hover:shadow-md"
                    >
                        <span className="text-2xl">{item.emoji}</span>
                        <span className="text-sm text-content-secondary">{item.label}</span>
                    </motion.button>
                ))}
            </motion.div>

            {/* 提示 */}
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.7 }}
                className="mt-6 flex items-center gap-2 text-xs text-content-muted"
            >
                <MessageCircle size={14} />
                <span>点击上方按钮或直接输入消息开始聊天</span>
            </motion.div>
        </motion.div>
    );
}
