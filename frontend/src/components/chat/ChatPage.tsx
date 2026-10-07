"use client";

import { useCallback, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { Menu, X } from "lucide-react";

import ChatInput from "./ChatInput";
import ChatMessage from "./ChatMessage";
import ChatToolbar from "./ChatToolbar";
import BackendOfflineBanner from "./BackendOfflineBanner";
import { ProactiveTypingIndicator, TypingIndicator } from "./TypingIndicator";
import CharacterPanel from "../character/CharacterPanel";
import DialogLayer from "../dialogs/DialogLayer";
import FirstRunWizard from "../wizard/FirstRunWizard";
import WelcomeMessage from "./WelcomeMessage";

import { useActivityPolling } from "@/hooks/useActivityPolling";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useBackendWatcher } from "@/hooks/useBackendWatcher";
import { useBootstrap } from "@/hooks/useBootstrap";
import { useProactivePolling } from "@/hooks/useProactivePolling";
import { useSpeech } from "@/hooks/useSpeech";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { api } from "@/lib/api";
import { toApiError } from "@/lib/apiError";
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
  // 后端可达性：离线时挂横幅并每 30 秒自动重试，恢复后自己重拉历史 + 回灌 Key
  useBackendWatcher();
  const currentActivity = useActivityPolling();
  const { listRef, stickToBottom } = useAutoScroll();
  useSpeech(); // 注册 speakBus 全局朗读者
  useProactivePolling({ onMessage: appendProactiveMessage });

  // 录音转写结果：自动发送或填入输入框
  const handleTranscribed = useCallback((text: string) => {
    if (useUiStore.getState().autoSendVoice && !useChatStore.getState().isLoading) {
      void useChatStore.getState().sendMessage(text);
    } else {
      // 自动发送撞上 AI 回复进行中时退化为填入输入框，转写结果不丢
      setInput(text);
    }
  }, []);
  const recorder = useVoiceRecorder(handleTranscribed);

  const handleFirstRunComplete = async () => {
    const config = getChatConfig();
    if (!config.apiKey && !config.ttsApiKey) {
      completeFirstRun();
      return;
    }
    try {
      // FE-09：向导的「完成」以后端真的收下配置为准。
      // 旧写法先 set("hasCompletedSetup") 再 fire-and-forget syncConfig ——
      // 后端没起来时向导照样宣告完成、再也不出现，而第一条消息必然报错。
      await api.syncConfig(config);
      completeFirstRun();
    } catch (e) {
      console.warn("[FirstRun] syncConfig failed:", e);
      useUiStore.getState().pushToast(
        `配置还没同步到后端：${toApiError(e).userMessage}。向导先留着，后端起来后点一次「完成配置」即可`,
        "error"
      );
    }
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
    // 高度用 100dvh（移动端地址栏收起/展开时 dvh 才等于真实可视高度；
    // 旧版 h-screen=100vh 在 iOS 上会把输入 dock 顶到地址栏后面）。
    // supports- 前缀保证老浏览器仍走 100vh，不会拿不到高度。
    <main className="relative flex h-screen overflow-hidden supports-[height:100dvh]:h-[100dvh]">
      {/* 背景光晕 */}
      <div className="fixed inset-0 pointer-events-none z-0">
        <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-gradient-to-bl from-accent-1/40 to-transparent rounded-full blur-3xl" />
        <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-gradient-to-tr from-accent-2/40 to-transparent rounded-full blur-3xl" />
      </div>

      <button
        className="md:hidden fixed top-4 left-4 z-50 p-2 bg-surface-1/80 text-content-primary rounded-full shadow-lg"
        onClick={() => setSidebarOpen(!isSidebarOpen)}
        aria-label={isSidebarOpen ? "关闭角色面板" : "打开角色面板"}
        aria-expanded={isSidebarOpen}
      >
        <Menu size={24} />
      </button>

      {/* 侧边栏：角色面板（玻璃卡片悬浮，桌面 360px） */}
      <div
        role="dialog"
        aria-modal={isSidebarOpen || undefined}
        aria-label="小爱的状态"
        className={`fixed md:static inset-y-0 left-0 z-40 w-full md:w-[360px] md:shrink-0 bg-surface-1/80 md:bg-transparent backdrop-blur-xl md:backdrop-blur-none transition-transform duration-300 transform ${
          isSidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        } p-4 pt-[calc(1rem+env(safe-area-inset-top))] md:p-6 md:pr-0 flex flex-col`}
      >
        <CharacterPanel currentActivity={currentActivity} />
        {isSidebarOpen && (
          <button
            className="absolute top-4 right-4 p-2 text-content-secondary md:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-label="关闭角色面板"
          >
            <X size={20} />
          </button>
        )}
      </div>

      {/* 主区：工具栏全宽；消息流与输入 dock 收窄 max-w-3xl 居中，视线聚焦 */}
      <div className="flex-1 flex flex-col h-full relative z-10 min-w-0">
        <ChatToolbar />
        <BackendOfflineBanner />

        <div
          ref={listRef}
          className="flex-1 overflow-y-auto p-4 md:p-6"
          // 流式正文对读屏是「会变的内容」：polite 让它在用户停下时才播报，
          // 不抢打断（aria-live 挂在容器上，逐条挂会每次新增都念一遍）
          aria-live="polite"
          aria-relevant="additions"
          aria-label="和小爱的对话"
        >
          <div className="mx-auto w-full max-w-3xl space-y-6">
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
        </div>

        {/* safe-area 兜底 iOS 全面屏底部横条（桌面/Android 无 env 值时回落 0） */}
        <div className="px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-2 md:px-6 md:pb-6">
          <ChatInput
            input={input}
            onInputChange={setInput}
            onSend={handleSend}
            onQuickSend={sendMessage}
            recorder={recorder}
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
