"use client";

import { memo } from "react";
import { motion } from "framer-motion";
import { Brain } from "lucide-react";
import VoiceButton from "../voice/VoiceButton";
import type { Message, TtsEngine } from "@/types";

interface ChatMessageProps {
  message: Message;
  ttsEngine: TtsEngine;
}

/**
 * 内心独白入口：默认只是一个小图标，hover / 聚焦才展开小爱的心声。
 * 注意这里展示的是 <monologue> 人设独白，模型自己的 CoT 不会下发到前端。
 */
function ThoughtIcon({ text }: { text: string }) {
  return (
    <div className="group relative flex self-start">
      <span
        tabIndex={0}
        aria-label="查看小爱的内心独白"
        className="mt-1 flex h-6 w-6 cursor-help items-center justify-center rounded-full bg-white/90 text-pink-500 ring-1 ring-pink-200 shadow-sm transition hover:bg-pink-50 focus:outline-none focus:ring-2 focus:ring-pink-300"
      >
        <Brain size={14} />
      </span>
      <div className="pointer-events-none absolute left-1/2 top-8 z-20 hidden w-60 -translate-x-1/2 rounded-xl bg-white p-3 text-xs leading-relaxed text-gray-700 shadow-lg ring-1 ring-black/5 group-hover:block group-focus-within:block">
        <div className="mb-1 text-[11px] font-medium text-pink-500">小爱的心声</div>
        {text}
      </div>
    </div>
  );
}

/**
 * 单条消息气泡：用户 / AI / 系统提示。
 *
 * 流式输出时每个增量都会生成新的 messages 数组，若不加 memo，
 * 整列表（含每条的 framer-motion 动画）都会跟着重渲染，长对话明显掉帧。
 * 配合稳定的 message.id 作为 key，未变化的消息不会重渲染。
 */
function ChatMessage({ message, ttsEngine }: ChatMessageProps) {
  const alignment =
    message.role === "user"
      ? "justify-end"
      : message.role === "system"
        ? "justify-center"
        : "justify-start";

  const showThought = message.role === "assistant" && !!message.thought;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      className={`flex w-full items-start gap-2 ${alignment}`}
    >
      {message.role === "system" ? (
        <div className="text-xs text-gray-400 bg-gray-100/50 px-3 py-1 rounded-full my-2">
          {message.content}
        </div>
      ) : (
        <>
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
          {showThought && <ThoughtIcon text={message.thought as string} />}
        </>
      )}
    </motion.div>
  );
}

export default memo(ChatMessage);
