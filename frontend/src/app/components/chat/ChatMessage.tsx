"use client";

import { motion } from "framer-motion";
import VoiceButton from "../VoiceButton";
import type { Message, TtsEngine } from "@/types";

interface ChatMessageProps {
  message: Message;
  ttsEngine: TtsEngine;
}

/** 单条消息气泡：用户 / AI / 系统提示 */
export default function ChatMessage({ message, ttsEngine }: ChatMessageProps) {
  const alignment =
    message.role === "user"
      ? "justify-end"
      : message.role === "system"
        ? "justify-center"
        : "justify-start";

  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      className={`flex w-full ${alignment}`}
    >
      {message.role === "system" ? (
        <div className="text-xs text-gray-400 bg-gray-100/50 px-3 py-1 rounded-full my-2">
          {message.content}
        </div>
      ) : (
        <div
          className={`max-w-[70%] p-4 text-sm md:text-base leading-relaxed break-words message-bubble relative ${
            message.role === "user" ? "chat-bubble-user" : "chat-bubble-ai"
          }`}
        >
          <div className="flex items-start gap-2">
            <span className="flex-1">{message.content}</span>
            {message.role === "assistant" && (
              <VoiceButton text={message.content} size={16} engine={ttsEngine} />
            )}
          </div>
        </div>
      )}
    </motion.div>
  );
}
