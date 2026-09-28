"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { Brain, ClipboardList, Download, Menu, MessageSquarePlus, Palette, Settings, X } from "lucide-react";

import ChatInput from "./components/chat/ChatInput";
import ChatMessage from "./components/chat/ChatMessage";
import { ProactiveTypingIndicator, TypingIndicator } from "./components/chat/TypingIndicator";
import CharacterPanel from "./components/CharacterPanel";
import ExportDialog from "./components/ExportDialog";
import FirstRunWizard from "./components/FirstRunWizard";
import MemoryDialog from "./components/MemoryDialog";
import SettingsDialog from "./components/SettingsDialog";
import TaskDialog from "./components/TaskDialog";
import ThemeSwitcher from "./components/ThemeSwitcher";
import WelcomeMessage from "./components/WelcomeMessage";
import Modal from "./components/ui/Modal";

import { useChat } from "@/hooks/useChat";
import { useProactivePolling } from "@/hooks/useProactivePolling";
import { useSakuraEffect } from "@/hooks/useSakuraEffect";
import { useSpeech } from "@/hooks/useSpeech";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { api } from "@/lib/api";
import { applyTheme, get, getChatConfig, getStoredTheme, isSetupComplete } from "@/lib/storage";
import type { CurrentActivity, ProactiveMessage, TtsEngine } from "@/types";

type DialogName = "settings" | "memory" | "task" | "export" | "theme";

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

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { speak } = useSpeech(ttsEngine);
  const chat = useChat({ voiceMode, speak });

  useSakuraEffect();

  // ---------- 主动消息：先显示「思考中」，再逐字延迟出场 ----------
  const handleProactiveMessage = useCallback((message: ProactiveMessage) => {
    setIsTypingProactive(true);
    const typingDelay = Math.min(2000, Math.max(800, message.content.length * 30));
    setTimeout(() => {
      setIsTypingProactive(false);
      chat.setMessages((prev) => [
        ...prev,
        { role: "assistant", content: message.content },
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

    if ("Notification" in window) Notification.requestPermission();

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

  // 滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat.messages]);

  const handleFirstRunComplete = () => {
    setIsFirstRun(false);
    const config = getChatConfig();
    if (config.apiKey) api.updateConfig(config).catch(() => {});
  };

  const handleSend = () => {
    if (!input.trim()) return;
    chat.sendMessage(input);
    setInput("");
    setShowEmojiPicker(false);
  };

  // ---------- 首屏 ----------
  if (isFirstRun === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-gradient-to-br from-pink-100 via-purple-50 to-blue-100">
        <div className="text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-gradient-to-br from-pink-400 to-purple-500 flex items-center justify-center animate-pulse" />
          <p className="text-gray-500">加载中...</p>
        </div>
      </div>
    );
  }

  if (isFirstRun) {
    return (
      <FirstRunWizard onComplete={handleFirstRunComplete} />
    );
  }

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
        <header className="h-16 flex items-center justify-between px-6 border-b border-white/20 backdrop-blur-sm">
          <div />
          <div className="flex gap-2">
            <button onClick={chat.clearChat} className="p-2 rounded-full hover:bg-white/50 text-gray-600 transition-colors" title="新对话">
              <MessageSquarePlus size={20} />
            </button>
            <button onClick={() => setDialog("memory")} className="p-2 rounded-full hover:bg-white/50 text-gray-600 transition-colors" title="记忆">
              <Brain size={20} />
            </button>
            <button onClick={() => setDialog("theme")} className="p-2 rounded-full hover:bg-white/50 text-gray-600 transition-colors" title="主题">
              <Palette size={20} />
            </button>
            <button onClick={() => setDialog("task")} className="p-2 rounded-full hover:bg-white/50 text-gray-600 transition-colors" title="任务">
              <ClipboardList size={20} />
            </button>
            <button onClick={() => setDialog("export")} className="p-2 rounded-full hover:bg-white/50 text-gray-600 transition-colors" title="导出">
              <Download size={20} />
            </button>
            <button onClick={() => setDialog("settings")} className="p-2 rounded-full hover:bg-white/50 text-gray-600 transition-colors" title="设置">
              <Settings size={20} />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
          {chat.messages.length === 0 && !chat.isLoading && (
            <WelcomeMessage onQuickStart={chat.sendMessage} />
          )}

          <AnimatePresence>
            {chat.messages.map((msg, idx) => (
              <ChatMessage key={idx} message={msg} ttsEngine={ttsEngine} />
            ))}
            {chat.isLoading && <TypingIndicator />}
            {isTypingProactive && !chat.isLoading && <ProactiveTypingIndicator />}
          </AnimatePresence>

          <div ref={messagesEndRef} />
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

      {/* 弹窗 */}
      <Modal isOpen={dialog === "theme"} onClose={() => setDialog(null)}>
        <ThemeSwitcher onClose={() => setDialog(null)} />
      </Modal>
      <Modal isOpen={dialog === "export"} onClose={() => setDialog(null)}>
        <ExportDialog messages={chat.messages} onClose={() => setDialog(null)} />
      </Modal>
      <Modal isOpen={dialog === "settings"} onClose={() => setDialog(null)}>
        <SettingsDialog onClose={() => setDialog(null)} onConfigChange={(c) => setTtsEngine(c.ttsEngine)} />
      </Modal>
      <Modal isOpen={dialog === "memory"} onClose={() => setDialog(null)}>
        <MemoryDialog
          onClose={() => setDialog(null)}
          onStateChange={(state) => chat.setAffinity(state.affinity)}
        />
      </Modal>
      <Modal isOpen={dialog === "task"} onClose={() => setDialog(null)}>
        <TaskDialog onClose={() => setDialog(null)} />
      </Modal>
    </main>
  );
}
