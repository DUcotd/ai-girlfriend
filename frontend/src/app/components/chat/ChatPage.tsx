"use client";

import { useCallback, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { Menu, X } from "lucide-react";

import ChatInput from "./ChatInput";
import ChatMessage from "./ChatMessage";
import ChatToolbar from "./ChatToolbar";
import { ProactiveTypingIndicator, TypingIndicator } from "./TypingIndicator";
import CharacterPanel from "../CharacterPanel";
import DialogLayer from "../DialogLayer";
import FirstRunWizard from "../FirstRunWizard";
import WelcomeMessage from "../WelcomeMessage";

import { useActivityPolling } from "@/hooks/useActivityPolling";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useBootstrap } from "@/hooks/useBootstrap";
import { useProactivePolling } from "@/hooks/useProactivePolling";
import { useSakuraEffect } from "@/hooks/useSakuraEffect";
import { useSpeech } from "@/hooks/useSpeech";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { api } from "@/lib/api";
import { getChatConfig } from "@/lib/storage";
import { useChatStore } from "@/stores/chatStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useUiStore } from "@/stores/uiStore";

/**
 * 聊天主界面编排。状态真源：chatStore（会话）/ settingsStore（配置）/
 * uiStore（界面）/ themeStore（主题）；本组件只保留输入草稿等纯局部态。
 */
export default function ChatPage() {
  const [input, setInput] = useState("");

  const messages = useChatStore((s) => s.messages);
  const isLoading = useChatStore((s) => s.isLoading);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const appendProactiveMessage = useChatStore((s) => s.appendProactiveMessage);
  const ttsEngine = useSettingsStore((s) => s.ttsEngine);
  const isSidebarOpen = useUiStore((s) => s.isSidebarOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const isTypingProactive = useUiStore((s) => s.isTypingProactive);

  const { isFirstRun, completeFirstRun } = useBootstrap();
  const currentActivity = useActivityPolling();
  const { listRef, stickToBottom } = useAutoScroll();
  useSpeech(); // 注册 speakBus 全局朗读者
  useSakuraEffect();
  useProactivePolling({ onMessage: appendProactiveMessage });

  // 录音转写结果：自动发送或填入输入框
  const handleTranscribed = useCallback((text: string) => {
    if (useUiStore.getState().autoSendVoice) {
      void useChatStore.getState().sendMessage(text);
    } else {
      setInput(text);
    }
  }, []);
  const { isRecording, recordingTime, mediaStream, toggleRecording } =
    useVoiceRecorder(handleTranscribed);

  const handleFirstRunComplete = () => {
    completeFirstRun();
    const config = getChatConfig();
    if (config.apiKey) api.updateConfig(config).catch(() => {});
  };

  const handleSend = () => {
    if (!input.trim()) return;
    stickToBottom(); // 主动发言时总是跟到底部
    void sendMessage(input);
    setInput("");
  };

  /** 流式正文是否已经开始可见（最后一条 assistant 有实际内容） */
  const isStreamingVisible = (() => {
    if (!isLoading) return false;
    const last = messages[messages.length - 1];
    return last?.role === "assistant" && !!last.content.trim();
  })();

  // 首屏不再渲染整页「加载中」白屏：主界面直接铺出来（背景与布局骨架先到位），
  // 首次运行时引导层自带全屏遮罩叠在上面，等 localStorage 读完再决定要不要显示。
  return (
    <main className="flex h-screen overflow-hidden relative">
      {/* 背景光晕 */}
      <div className="fixed inset-0 pointer-events-none z-0">
        <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-gradient-to-bl from-pink-200/40 to-transparent rounded-full blur-3xl" />
        <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-gradient-to-tr from-blue-200/40 to-transparent rounded-full blur-3xl" />
      </div>

      <button
        className="md:hidden fixed top-4 left-4 z-50 p-2 bg-white/80 rounded-full shadow-lg"
        onClick={() => setSidebarOpen(!isSidebarOpen)}
      >
        <Menu size={24} />
      </button>

      {/* 侧边栏：角色面板 */}
      <div
        className={`fixed md:static inset-y-0 left-0 z-40 w-full md:w-[400px] bg-white/80 md:bg-transparent backdrop-blur-xl md:backdrop-blur-none transition-transform duration-300 transform ${
          isSidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        } p-4 md:p-6 flex flex-col`}
      >
        <CharacterPanel currentActivity={currentActivity} />
        {isSidebarOpen && (
          <button
            className="absolute top-4 right-4 p-2 text-gray-500 md:hidden"
            onClick={() => setSidebarOpen(false)}
          >
            <X size={20} />
          </button>
        )}
      </div>

      <div className="flex-1 flex flex-col h-full relative z-10 max-w-5xl mx-auto w-full">
        <ChatToolbar />

        <div ref={listRef} className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
          {messages.length === 0 && !isLoading && (
            <WelcomeMessage onQuickStart={sendMessage} />
          )}

          <AnimatePresence>
            {messages.map((msg) =>
              // 流式占位的空气泡不渲染：等待期由下方打字指示器单独代表「在输入」，
              // 否则会出现「🔊 空气泡 + ··· 」两个气泡并存的怪相
              msg.role === "assistant" && !msg.content.trim() ? null : (
                <ChatMessage key={msg.id} message={msg} ttsEngine={ttsEngine} />
              )
            )}
            {/* 正文开始流出后由气泡接管，打字指示器退场 */}
            {isLoading && !isStreamingVisible && <TypingIndicator />}
            {isTypingProactive && !isLoading && <ProactiveTypingIndicator />}
          </AnimatePresence>
        </div>

        <div className="p-4 md:p-6 pb-6">
          <ChatInput
            input={input}
            onInputChange={setInput}
            onSend={handleSend}
            onQuickSend={sendMessage}
            isLoading={isLoading}
            isRecording={isRecording}
            recordingTime={recordingTime}
            mediaStream={mediaStream}
            onToggleRecording={toggleRecording}
          />
        </div>
      </div>

      {/* 弹窗：按名称集中渲染（开关状态在 uiStore） */}
      <DialogLayer />

      {/* 首次运行引导：自带全屏遮罩，叠在主界面之上 */}
      {isFirstRun && <FirstRunWizard onComplete={handleFirstRunComplete} />}
    </main>
  );
}
