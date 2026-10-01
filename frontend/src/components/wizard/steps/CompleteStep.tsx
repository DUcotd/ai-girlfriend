"use client";

import { motion } from "framer-motion";
import { Check, Heart } from "lucide-react";
import Button from "@/components/ui/Button";

interface CompleteStepProps {
    onComplete: () => void;
}

/** 首启向导 · 第 2 步：配置完成。 */
export default function CompleteStep({ onComplete }: CompleteStepProps) {
    return (
        <motion.div
            key="complete"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className="relative mx-4 my-auto max-w-lg rounded-3xl border border-accent-1/20 bg-surface-1/85 p-10 text-center shadow-modal backdrop-blur-xl"
        >
            <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", delay: 0.2 }}
                className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-status-success to-status-success/70 shadow-lg"
            >
                <Check className="h-10 w-10 text-white" />
            </motion.div>

            <motion.h2
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 }}
                className="mb-2 text-2xl font-bold text-content-primary"
            >
                配置完成！
            </motion.h2>

            <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.4 }}
                className="mb-8 text-content-secondary"
            >
                小爱已经准备好啦，快去和她聊天吧～ 💕
            </motion.p>

            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.5 }}
            >
                <Button
                    onClick={onComplete}
                    className="flex w-full items-center justify-center gap-2 rounded-2xl py-3 px-6 font-bold"
                >
                    <Heart className="h-5 w-5" /> 开始聊天
                </Button>
            </motion.div>
        </motion.div>
    );
}
