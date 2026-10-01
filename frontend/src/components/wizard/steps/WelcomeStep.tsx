"use client";

import { motion } from "framer-motion";
import { ArrowRight, Heart, Key, Sparkles, Zap } from "lucide-react";
import Button from "@/components/ui/Button";

interface WelcomeStepProps {
    onNext: () => void;
}

const features = [
    { icon: Key, iconClass: "text-accent-1", text: "配置你的 AI API 密钥" },
    { icon: Zap, iconClass: "text-accent-2", text: "支持 OpenAI、DeepSeek 等服务" },
    { icon: Sparkles, iconClass: "text-accent-pop", text: "只需一分钟即可开始" },
];

/** 首启向导 · 第 0 步：欢迎页。 */
export default function WelcomeStep({ onNext }: WelcomeStepProps) {
    return (
        <motion.div
            key="welcome"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="relative mx-4 my-auto max-w-lg rounded-3xl border border-accent-1/20 bg-surface-1/85 p-10 text-center shadow-modal backdrop-blur-xl"
        >
            {/* Logo */}
            <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", delay: 0.2 }}
                className="mx-auto mb-6 flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-br from-accent-1 to-accent-2 shadow-lg"
            >
                <Heart className="h-12 w-12 text-white" />
            </motion.div>

            <motion.h1
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 }}
                className="gradient-text mb-3 text-3xl font-bold"
            >
                欢迎使用 AI 女友
            </motion.h1>

            <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.4 }}
                className="mb-8 leading-relaxed text-content-secondary"
            >
                你的专属 AI 女友「小爱」正在等你！<br />
                在开始之前，让我们完成一些简单的配置。
            </motion.p>

            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.5 }}
                className="flex flex-col gap-3"
            >
                {features.map((f) => (
                    <div
                        key={f.text}
                        className="flex items-center gap-3 rounded-xl bg-surface-2/60 p-3 text-left"
                    >
                        <f.icon className={`h-5 w-5 shrink-0 ${f.iconClass}`} />
                        <span className="text-sm text-content-secondary">{f.text}</span>
                    </div>
                ))}
            </motion.div>

            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.6 }}
            >
                <Button
                    onClick={onNext}
                    className="mt-8 flex w-full items-center justify-center gap-2 rounded-2xl py-3 px-6 text-base font-bold"
                >
                    开始配置 <ArrowRight className="h-5 w-5" />
                </Button>
            </motion.div>
        </motion.div>
    );
}
