"use client";

import { Heart } from "lucide-react";
import { motion } from "framer-motion";

/** 「对方正在输入」提示 */
export function TypingIndicator() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex justify-start w-full"
    >
      <div className="bg-white/80 p-4 rounded-2xl rounded-tl-none border border-pink-100 shadow-sm flex items-center gap-2">
        <span className="w-2 h-2 bg-pink-400 rounded-full animate-bounce" />
        <span className="w-2 h-2 bg-pink-400 rounded-full animate-bounce delay-75" />
        <span className="w-2 h-2 bg-pink-400 rounded-full animate-bounce delay-150" />
      </div>
    </motion.div>
  );
}

/** 主动消息到达前的「小爱正在思考」提示 */
export function ProactiveTypingIndicator() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex justify-start w-full"
    >
      <div className="bg-gradient-to-r from-pink-50 to-purple-50 p-4 rounded-2xl rounded-tl-none border border-pink-200 shadow-sm flex items-center gap-3">
        <Heart className="w-4 h-4 text-pink-400 animate-pulse" />
        <span className="text-pink-500 text-sm">小爱正在思考...</span>
        <span className="w-2 h-2 bg-pink-400 rounded-full animate-bounce" />
        <span className="w-2 h-2 bg-pink-400 rounded-full animate-bounce delay-75" />
        <span className="w-2 h-2 bg-pink-400 rounded-full animate-bounce delay-150" />
      </div>
    </motion.div>
  );
}
