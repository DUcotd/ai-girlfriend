"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { Menu, X } from "lucide-react";

import ChatInput from "./components/chat/ChatInput";
import ChatMessage from "./components/chat/ChatMessage";
import ChatToolbar from "./components/chat/ChatToolbar";
import { ProactiveTypingIndicator, TypingIndicator } from "./components/chat/TypingIndicator";
import CharacterPanel from "./components/CharacterPanel";
import DialogLayer from "./components/DialogLayer";
import FirstRunWizard from "./components/FirstRunWizard";
import WelcomeMessage from "./components/WelcomeMessage";

import type { DialogName } from "./dialogs";
import { useChat } from "@/hooks/useChat";
import { useProactivePolling } from "@/hooks/useProactivePolling";
import { useSakuraEffect } from "@/hooks/useSakuraEffect";
import { useSpeech } from "@/hooks/useSpeech";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { api } from "@/lib/api";
import { applyTheme, get, getChatConfig, getStoredTheme, isSetupComplete, set } from "@/lib/storage";
import type { CurrentActivity, ProactiveMessage, TtsEngine } from "@/types";

export default function Home() {
  const [isFirstRun, setIsFirstRun] = useState<boolean | null>(null);
  const [dialog, setDialog] = useState<DialogName | null>(null);
  const [input, setInput] = useState("");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [ttsEngine, setTtsEngine] = useState<TtsEngine>("openai");
  const [voiceMode, setVoiceMode] = useState(false);
  const [autoSendVoice, setAutoSendVoice] = useState(true);
  const [currentActivity, setCurrentActivity] = useState<CurrentActivity | null>(null);
  const [isTypingProactive, setIsTypingProactive] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  /** 用户是否贴着底部：只有贴底时才自动跟随新内容，避免打断用户翻历史 */
  const atBottomRef = useRef(true);

  const { speak } = useSpeech(ttsEngine);
  const chat = useChat({ voiceMode, speak });

  useSakuraEffect();

  // ---------- 主动消息：先显示「思考中」，再逐字延迟出场 ----------
  const proactiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleProactiveMessage = useCallback((message: ProactiveMessage) => {
    setIsTypingProactive(true);
    const typingDelay = Math.min(2000, Math.max(800, message.content.length * 30));
    // 存下来以便卸载时清理，避免组件已卸载还去 setState
    proactiveTimerRef.current = setTimeout(() => {
      proactiveTimerRef.current = null;
      setIsTypingProactive(false);
      chat.setMessages((prev) => [
        ...prev,
        { id: `proactive-${message.id}`, role: "assistant", content: message.content },
      ]);
    }, typingDelay);
  }, [chat]);

  useProactivePolling({
    onMessage: handleProactiveMessage,
    voiceMode,
    speak,
  });

  // ---------- 录音转写结果 ----------
  const handleTranscribed = useCallback(
    (text: string) => {
      if (autoSendVoice) chat.sendMessage(text);
      else setInput(text);
    },
    [autoSendVoice, chat]
  );

  const { isRecording, recordingTime, mediaStream, toggleRecording } =
    useVoiceRecorder(handleTranscribed);

  const { syncState, fetchHistory } = chat;

  // ---------- 初始化 ----------
  // localStorage 只能在客户端读取，为规避 SSR 首帧水合不一致，
  // 首帧统一渲染「加载中」，挂载后再一次性恢复本地配置并同步后端。
  // 这是一次性的客户端引导（非响应式状态同步），故豁免该条规则。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setIsFirstRun(!isSetupComplete());

    const savedEngine = get("ttsEngine");
    if (savedEngine) setTtsEngine(savedEngine as TtsEngine);

    const savedTheme = getStoredTheme();
    if (savedTheme) applyTheme(savedTheme);

    // 通知权限只问一次：问过就记下来，已授权/已拒绝也不再打扰
    if (
      "Notification" in window &&
      Notification.permission === "default" &&
      !get("notificationAsked")
    ) {
      set("notificationAsked", "true");
      void Notification.requestPermission();
    }

    void syncState();
    void fetchHistory();

    // 已有配置时同步给后端（后端配置仅存于内存，重启后需要重新下发）
    const config = getChatConfig();
    if (config.apiKey) {
      api.updateConfig(config).catch(() => {});
    }
  }, [syncState, fetchHistory]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ---------- 生活模拟：每 2 分钟刷新一次当前活动 ----------
  useEffect(() => {
    let cancelled = false;
    const fetchActivity = () => {
      api
        .getCurrentActivity()
        .then((activity) => {
          if (!cancelled) setCurrentActivity(activity);
        })
        .catch(() => {
          // 后端未启动，忽略
        });
    };
    fetchActivity();
    const interval = setInterval(fetchActivity, 120_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // 卸载时清理主动消息的延时器
  useEffect(() => () => {
    if (proactiveTimerRef.current) clearTimeout(proactiveTimerRef.current);
  }, []);

  // 监听滚动，判断用户是否还贴着底部
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // 自动跟随：贴底时才滚。流式输出中用 auto（逐字追加时 smooth 会互相打断、抖动）
  useEffect(() => {
    const el = listRef.current;
    if (!el || !atBottomRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: chat.isLoading ? "auto" : "smooth" });
  }, [chat.messages, chat.isLoading]);

  const handleFirstRunComplete = () => {
    setIsFirstRun(false);
    const config = getChatConfig();
    if (config.apiKey) api.updateConfig(config).catch(() => {});
  };

  const handleSend = () => {
    if (!input.trim()) return;
    atBottomRef.current = true; // 主动发言时总是跟到底部
    chat.sendMessage(input);
    setInput("");
    setShowEmojiPicker(false);
  };

  // ---------- 首屏 ----------
  // 不再渲染整页「加载中」白屏：主界面直接铺出来（背景与布局骨架先到位），
  // 首次运行时引导层自带全屏遮罩叠在上面，等 localStorage 读完再决定要不要显示。
  // 这样回访用户是「一帧到位」，首次用户也不会看到白屏切换。
  return (
    <main className="flex h-screen overflow-hidden relative">
      {/* 背景光晕 */}
      <div className="fixed inset-0 pointer-events-none z-0">
        <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-gradient-to-bl from-pink-200/40 to-transparent rounded-full blur-3xl" />
        <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-gradient-to-tr from-blue-200/40 to-transparent rounded-full blur-3xl" />
      </div>

      <button
        className="md:hidden fixed top-4 left-4 z-50 p-2 bg-white/80 rounded-full shadow-lg"
        onClick={() => setIsSidebarOpen(!isSidebarOpen)}
      >
        <Menu size={24} />
      </button>

      {/* 侧边栏：角色面板 */}
      <div
        className={`fixed md:static inset-y-0 left-0 z-40 w-full md:w-[400px] bg-white/80 md:bg-transparent backdrop-blur-xl md:backdrop-blur-none transition-transform duration-300 transform ${
          isSidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        } p-4 md:p-6 flex flex-col`}
      >
        <CharacterPanel
          emotion={chat.emotion}
          affinity={chat.affinity}
          currentActivity={currentActivity}
          emotionalState={chat.emotionalState}
        />
        {isSidebarOpen && (
          <button
            className="absolute top-4 right-4 p-2 text-gray-500 md:hidden"
            onClick={() => setIsSidebarOpen(false)}
          >
            <X size={20} />
          </button>
        )}
      </div>

      <div className="flex-1 flex flex-col h-full relative z-10 max-w-5xl mx-auto w-full">
        <ChatToolbar onOpen={setDialog} onNewChat={chat.clearChat} />

        <div ref={listRef} className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
          {chat.messages.length === 0 && !chat.isLoading && (
            <WelcomeMessage onQuickStart={chat.sendMessage} />
          )}

          <AnimatePresence>
            {chat.messages.map((msg) => (
              <ChatMessage key={msg.id} message={msg} ttsEngine={ttsEngine} />
            ))}
            {chat.isLoading && <TypingIndicator />}
            {isTypingProactive && !chat.isLoading && <ProactiveTypingIndicator />}
          </AnimatePresence>
        </div>

        <div className="p-4 md:p-6 pb-6">
          <ChatInput
            input={input}
            onInputChange={setInput}
            onSend={handleSend}
            onQuickSend={chat.sendMessage}
            isLoading={chat.isLoading}
            voiceMode={voiceMode}
            onToggleVoiceMode={() => setVoiceMode(!voiceMode)}
            autoSendVoice={autoSendVoice}
            onToggleAutoSend={() => setAutoSendVoice(!autoSendVoice)}
            showEmojiPicker={showEmojiPicker}
            onToggleEmojiPicker={setShowEmojiPicker}
            isRecording={isRecording}
            recordingTime={recordingTime}
            mediaStream={mediaStream}
            onToggleRecording={toggleRecording}
          />
        </div>
      </div>

      {/* 弹窗：按名称集中渲染 */}
      <DialogLayer
        dialog={dialog}
        onClose={() => setDialog(null)}
        messages={chat.messages}
        onAffinityChange={chat.setAffinity}
        onTtsEngineChange={setTtsEngine}
      />

      {/* 首次运行引导：自带全屏遮罩，叠在主界面之上 */}
      {isFirstRun && <FirstRunWizard onComplete={handleFirstRunComplete} />}
    </main>
  );
}
