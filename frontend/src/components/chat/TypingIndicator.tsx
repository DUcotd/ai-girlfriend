"use client";

import { Heart } from "lucide-react";
import { motion } from "framer-motion";

const dotClasses = "h-2 w-2 animate-bounce rounded-full bg-accent-1";

/** 「对方正在输入」提示 */
export function TypingIndicator() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex w-full justify-start"
    >
      <div className="flex items-center gap-2 rounded-2xl rounded-tl-none border border-line-subtle bg-surface-1/80 p-4 shadow-sm">
        <span className={dotClasses} />
        <span className={`${dotClasses} delay-75`} />
        <span className={`${dotClasses} delay-150`} />
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
      className="flex w-full justify-start"
    >
      <div className="flex items-center gap-3 rounded-2xl rounded-tl-none border border-accent-1/30 bg-gradient-to-r from-accent-1/10 to-accent-2/10 p-4 shadow-sm">
        <Heart className="h-4 w-4 animate-pulse text-accent-1" />
        <span className="text-sm text-accent-strong dark:text-accent-1">小爱正在思考...</span>
        <span className={dotClasses} />
        <span className={`${dotClasses} delay-75`} />
        <span className={`${dotClasses} delay-150`} />
      </div>
    </motion.div>
  );
}
