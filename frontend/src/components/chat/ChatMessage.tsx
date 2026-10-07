"use client";

import { memo } from "react";
import { motion } from "framer-motion";
import { Brain } from "lucide-react";
import VoiceButton from "../voice/VoiceButton";
import { cn } from "@/lib/cn";
import type { Message, TtsEngine } from "@/types";

interface ChatMessageProps {
  message: Message;
  ttsEngine: TtsEngine;
}

/** 原 .chat-bubble-user：accent 渐变圆角气泡 */
const userBubbleClasses =
  "rounded-[20px] rounded-br-lg bg-gradient-to-br from-accent-1 to-accent-strong text-white shadow-[0_4px_15px_-3px_hsl(var(--accent-1)/0.3)]";

/** 原 .chat-bubble-ai：surface 底 + accent 描边 */
const aiBubbleClasses =
  "rounded-[20px] rounded-bl-lg border-2 border-accent-1/20 bg-surface-1/95 text-content-primary shadow-[0_4px_15px_-3px_hsl(0_0%_0%/0.08)]";

/**
 * 内心独白入口：默认只是一个小图标，hover / 聚焦才展开小爱的心声。
 * 注意这里展示的是 <monologue> 人设独白，模型自己的 CoT 不会下发到前端。
 */
function ThoughtIcon({ text }: { text: string }) {
  return (
    <div className="group relative flex self-start">
      {/* 用 button 而不是 tabIndex 的 span：触屏上非交互元素点一下不会获得焦点，
          「心声」就只有 hover 一条路 —— 手机用户永远打不开它（FE-10） */}
      <button
        type="button"
        tabIndex={0}
        aria-label="查看小爱的内心独白"
        className="mt-1 flex h-6 w-6 cursor-help items-center justify-center rounded-full bg-surface-1/90 text-accent-1 shadow-sm ring-1 ring-accent-1/30 transition hover:bg-accent-1/10 focus:outline-none focus:ring-2 focus:ring-accent-1/50 focus-visible:ring-accent-1"
      >
        <Brain size={14} />
      </button>
      <div className="pointer-events-none absolute left-1/2 top-8 z-20 hidden w-60 -translate-x-1/2 rounded-xl bg-surface-1 p-3 text-xs leading-relaxed text-content-secondary shadow-lg ring-1 ring-line-subtle group-hover:block group-focus-within:block">
        <div className="mb-1 text-[11px] font-medium text-accent-1">小爱的心声</div>
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
        <div className="my-2 rounded-full bg-surface-2/60 px-3 py-1 text-xs text-content-muted">
          {message.content}
        </div>
      ) : (
        <>
          <div
            className={cn(
              "message-bubble relative max-w-[70%] break-words p-4 text-sm leading-relaxed md:text-base",
              message.role === "user" ? userBubbleClasses : aiBubbleClasses
            )}
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
