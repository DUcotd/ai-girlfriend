"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  MessageCircle,
  Send,
  Settings,
  Image as ImageIcon,
  Mic,
  Palette,
  Trash2,
  Download,
  Menu,
  X,
  Clock,
  Sparkles,
  Cpu,
  Heart,
  Smile,
  Volume2,
  VolumeX,
  History,
  ClipboardList,
  Brain,
  StopCircle,
  MessageSquarePlus
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import VoiceButton from "./components/VoiceButton";
import AudioVisualizer from "./components/AudioVisualizer";
import CharacterPanel from "./components/CharacterPanel";
import QuickReplies from "./components/QuickReplies";
import EmojiPicker from "./components/EmojiPicker";
import ThemeSwitcher from "./components/ThemeSwitcher";
import ExportDialog from "./components/ExportDialog";
import SettingsDialog from "./components/SettingsDialog";
import MemoryDialog from "./components/MemoryDialog";
import TaskDialog from "./components/TaskDialog";
import WelcomeMessage from "./components/WelcomeMessage";
import FirstRunWizard from "./components/FirstRunWizard";

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false); // Settings now just a placeholder or could be real settings
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // New State
  const [affinity, setAffinity] = useState(35); // Initial affinity
  const [emotion, setEmotion] = useState<"default" | "happy" | "shy" | "thinking" | "sleepy" | "sad" | "angry">("default");
  const [emotionalState, setEmotionalState] = useState<any>(null); // 新增：PAD情感状态
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showThemeSwitcher, setShowThemeSwitcher] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showMemoryDialog, setShowMemoryDialog] = useState(false);
  const [showTaskDialog, setShowTaskDialog] = useState(false);
  const [ttsEngine, setTtsEngine] = useState<"openai" | "local">("openai");
  const [isSidebarOpen, setIsSidebarOpen] = useState(false); // For mobile
  const [currentActivity, setCurrentActivity] = useState<{ activity: string; emoji: string } | null>(null); // 生活状态
  const [isFirstRun, setIsFirstRun] = useState<boolean | null>(null); // 首次运行检测，null表示正在检测

  // Voice State
  const [isRecording, setIsRecording] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [autoSendVoice, setAutoSendVoice] = useState(true);
  const [recordingTime, setRecordingTime] = useState(0);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Config State
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [modelName, setModelName] = useState("gpt-3.5-turbo");
  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

  // Effects
  // 首次运行检测
  useEffect(() => {
    const savedApiKey = localStorage.getItem("apiKey");
    const hasCompletedSetup = localStorage.getItem("hasCompletedSetup");

    // 如果没有 API Key 或没有完成过初始化，则认为是首次运行
    if (!savedApiKey || !hasCompletedSetup) {
      setIsFirstRun(true);
    } else {
      setIsFirstRun(false);
    }
  }, []);

  useEffect(() => {
    // 请求通知权限
    if ("Notification" in window) {
      Notification.requestPermission();
    }

    // Sakura animation logic (creating petals)
    const createPetal = () => {
      const petal = document.createElement("div");
      petal.classList.add("sakura-petal");
      petal.style.left = Math.random() * 100 + "vw";
      petal.style.animationDuration = Math.random() * 3 + 4 + "s";
      petal.style.opacity = (Math.random() * 0.5 + 0.3).toString();
      document.body.appendChild(petal);

      setTimeout(() => {
        if (petal.parentNode) petal.remove();
      }, 7000);
    };

    const interval = setInterval(createPetal, 1000);
    return () => {
      clearInterval(interval);
      // 清理残留的瓣片，防止内存泄露
      const petals = document.querySelectorAll(".sakura-petal");
      petals.forEach(p => p.remove());
    };
  }, []);

  useEffect(() => {
    // Load config
    const savedKey = localStorage.getItem("apiKey");
    if (savedKey) setApiKey(savedKey);
    const savedBase = localStorage.getItem("baseUrl");
    if (savedBase) setBaseUrl(savedBase);
    const savedModel = localStorage.getItem("modelName");
    if (savedModel) setModelName(savedModel);
    const savedEngine = localStorage.getItem("ttsEngine");
    if (savedEngine) setTtsEngine(savedEngine as "openai" | "local");

    // Load affinity from localStorage
    const savedAffinity = localStorage.getItem("affinity");
    if (savedAffinity) setAffinity(parseInt(savedAffinity, 10));

    // 加载保存的主题
    const savedTheme = localStorage.getItem("theme");
    if (savedTheme) {
      document.documentElement.setAttribute("data-theme", savedTheme);
    }

    // 自动配置后端（如果有保存的 API Key）
    if (savedKey) {
      const savedTtsKey = localStorage.getItem("ttsApiKey");
      const savedEmbKey = localStorage.getItem("embApiKey");
      const savedEmbBase = localStorage.getItem("embBaseUrl");
      const savedEmbModel = localStorage.getItem("embModelName");

      fetch(`${backendUrl}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: savedKey,
          base_url: savedBase || "https://api.openai.com/v1",
          model_name: savedModel || "gpt-3.5-turbo",
          tts_api_key: savedTtsKey || undefined,
          embedding_api_key: savedEmbKey || undefined,
          embedding_base_url: savedEmbBase || undefined,
          embedding_model_name: savedEmbModel || undefined,
        }),
      }).catch((err) => console.error("Auto config failed:", err));
    }

    fetchHistory();
  }, []);

  // Save affinity when it changes
  useEffect(() => {
    localStorage.setItem("affinity", affinity.toString());
  }, [affinity]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // 定时获取当前活动状态
  useEffect(() => {
    const fetchActivity = async () => {
      try {
        const res = await fetch(`${backendUrl}/life/current`);
        if (res.ok) {
          const data = await res.json();
          setCurrentActivity({ activity: data.activity, emoji: data.emoji || '🌸' });
        }
      } catch (e) {
        // 静默处理错误
      }
    };
    fetchActivity();
    const interval = setInterval(fetchActivity, 120000); // 每2分钟更新
    return () => clearInterval(interval);
  }, [backendUrl]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch(`${backendUrl}/history`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data);
      }
    } catch (error) {
      console.error("Failed to fetch history");
    }
  }, [backendUrl]);

  const clearChat = useCallback(async () => {
    try {
      const res = await fetch(`${backendUrl}/history`, {
        method: "DELETE",
      });
      if (res.ok) {
        setMessages([]);
      }
    } catch (error) {
      console.error("Failed to clear chat");
    }
  }, [backendUrl]);

  const sendMessage = useCallback(async (text: string = input) => {
    if (!text.trim()) return;

    const userMsg = { role: "user" as const, content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);
    setShowEmojiPicker(false);

    try {
      const res = await fetch(`${backendUrl}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      if (!res.ok) throw new Error("API Error");

      const data = await res.json();

      // Handle Ghosting (已读不回)
      if (data.special_action === "ghosting") {
        // 模拟短暂的 "对方正在输入..."
        setTimeout(() => {
          // 显示系统提示或短暂的状态
        }, 2000);

        // 不添加任何消息，只更新状态
        if (data.affinity) setAffinity(data.affinity);
        if (data.emotionalState) {
          setEmotionalState(data.emotionalState); // Update emotional state
        }

        // 显示一个短暂的 Toast 或状态指示
        const ghostingMsg = { role: "system" as const, content: "💔 对方已读，但似乎不想理你..." };
        setMessages((prev) => [...prev, ghostingMsg]);
        return;
      }

      const aiMsg = { role: "assistant" as const, content: data.reply };
      setMessages((prev) => [...prev, aiMsg]);

      // 使用 AI 返回的情绪和好感度
      if (data.emotion) {
        setEmotion(data.emotion);
      }
      if (typeof data.affinity === 'number') {
        setAffinity(data.affinity);
        localStorage.setItem("affinity", data.affinity.toString());
      }
      // Update emotional state if provided
      if (data.emotionalState) {
        setEmotionalState(data.emotionalState);
      }

      if (voiceMode) {
        speakText(data.reply);
      }
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "⚠️ 抱歉，我好像断线了..." },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [backendUrl, input, voiceMode]);

  const speakTextLocal = useCallback((text: string) => {
    if (!("speechSynthesis" in window)) {
      console.error("Browser does not support TTS");
      return;
    }

    // 取消之前的播放
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = 1.1; // 稍微快一点点更自然
    utterance.pitch = 1.2; // 稍微调高一点点，更像少女

    // 尝试寻找中文女声
    const voices = window.speechSynthesis.getVoices();
    const femaleVoice = voices.find(v =>
      (v.name.includes("Xiaoxiao") || v.name.includes("Huihui") || v.name.includes("Ting-Ting") || v.name.includes("female")) && v.lang.includes("zh")
    );
    if (femaleVoice) utterance.voice = femaleVoice;

    window.speechSynthesis.speak(utterance);
  }, []);

  const speakText = useCallback(async (text: string) => {
    if (ttsEngine === "local") {
      speakTextLocal(text);
      return;
    }

    // OpenAI TTS Logic (Existing)
    try {
      const res = await fetch(`${backendUrl}/audio/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.audio_url) {
          const audio = new Audio(`${backendUrl}${data.audio_url}`);
          audio.play();
        }
      }
    } catch (error) {
      console.error("TTS Error:", error);
    }
  }, [backendUrl, ttsEngine, speakTextLocal]);

  // 轮询主动消息 - 优化版
  const lastUserActivityRef = useRef(Date.now());
  const [isTypingProactive, setIsTypingProactive] = useState(false);

  // 追踪用户活跃
  useEffect(() => {
    const updateActivity = () => {
      lastUserActivityRef.current = Date.now();
    };

    window.addEventListener('mousemove', updateActivity);
    window.addEventListener('keydown', updateActivity);
    window.addEventListener('click', updateActivity);
    window.addEventListener('scroll', updateActivity);

    return () => {
      window.removeEventListener('mousemove', updateActivity);
      window.removeEventListener('keydown', updateActivity);
      window.removeEventListener('click', updateActivity);
      window.removeEventListener('scroll', updateActivity);
    };
  }, []);

  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    let isPageVisible = true;

    const getPollInterval = () => {
      const idleTime = Date.now() - lastUserActivityRef.current;
      // 活跃时15秒检查，5分钟未活跃后60秒检查
      return idleTime > 5 * 60 * 1000 ? 60000 : 15000;
    };

    const fetchProactive = async () => {
      // 页面不可见时跳过
      if (!isPageVisible) return;

      try {
        const res = await fetch(`${backendUrl}/chat/proactive`);
        if (res.status === 200) {
          const data = await res.json();

          // 1. 显示打字效果
          setIsTypingProactive(true);

          // 2. 模拟打字延迟（根据消息长度）
          const typingDelay = Math.min(2000, Math.max(800, data.content.length * 30));
          await new Promise(r => setTimeout(r, typingDelay));

          setIsTypingProactive(false);

          // 3. 添加到消息列表
          const aiMsg = { role: "assistant" as const, content: data.content };
          setMessages(prev => [...prev, aiMsg]);

          // 4. 更新情绪
          if (data.emotion) setEmotion(data.emotion);

          // 5. 语音播报
          if (voiceMode) {
            speakText(data.content);
          }

          // 6. 系统通知（页面不在前台时）
          if (document.hidden && Notification.permission === "granted") {
            const reasonMap: Record<string, string> = {
              morning_greeting: "☀️ 早安问候",
              night_greeting: "🌙 晚安祝福",
              miss_you: "💕 想念你了",
              mood_check: "💝 关心问候",
              task_reminder: "📝 任务提醒",
              random_chat: "✨ 小爱的消息",
              memory_share: "💭 回忆分享"
            };
            new Notification(reasonMap[data.reason] || "小爱的悄悄话 ✨", {
              body: data.content,
              icon: "/favicon.ico",
              tag: "proactive-message", // 避免重复通知
            });
          }

          // 7. 播放提示音（可选）
          try {
            const audio = new Audio('/notification.mp3');
            audio.volume = 0.3;
            audio.play().catch(() => { }); // 静默失败
          } catch { }
        }
      } catch (e) {
        // 静默处理错误
      }
    };

    // 页面可见性变化处理
    const handleVisibilityChange = () => {
      isPageVisible = !document.hidden;
      if (isPageVisible && !interval) {
        // 页面变为可见时重新开始轮询
        interval = setInterval(fetchProactive, getPollInterval());
        fetchProactive(); // 立即检查一次
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // 智能轮询：根据活跃度调整间隔
    const startPolling = () => {
      if (interval) clearInterval(interval);
      interval = setInterval(() => {
        fetchProactive();
        // 动态调整下次间隔
        if (interval) {
          clearInterval(interval);
          interval = setInterval(fetchProactive, getPollInterval());
        }
      }, getPollInterval());
    };

    startPolling();

    return () => {
      if (interval) clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [backendUrl, voiceMode, speakText]);

  const handleVoiceRecording = async () => {
    if (isRecording) {
      mediaRecorderRef.current?.stop();
      setIsRecording(false);
      setRecordingTime(0);
      setMediaStream(null);
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        setMediaStream(stream);
        const mediaRecorder = new MediaRecorder(stream);
        mediaRecorderRef.current = mediaRecorder;
        audioChunksRef.current = [];
        setRecordingTime(0);

        // Start timer
        recordingTimerRef.current = setInterval(() => {
          setRecordingTime(prev => prev + 1);
        }, 1000);

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) audioChunksRef.current.push(event.data);
        };

        mediaRecorder.onstop = async () => {
          setMediaStream(null);
          const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
          await transcribeAudio(audioBlob);
          stream.getTracks().forEach(track => track.stop());
          if (recordingTimerRef.current) {
            clearInterval(recordingTimerRef.current);
            recordingTimerRef.current = null;
          }
        };

        mediaRecorder.start();
        setIsRecording(true);
      } catch (e) {
        alert("麦克风访问被拒绝！");
      }
    }
  };

  const transcribeAudio = async (audioBlob: Blob) => {
    setIsLoading(true);
    const formData = new FormData();
    formData.append("file", audioBlob, "recording.webm");

    try {
      const res = await fetch(`${backendUrl}/audio/transcribe`, {
        method: "POST",
        body: formData,
      });
      if (res.ok) {
        const data = await res.json();
        if (data.text) {
          if (autoSendVoice) {
            // Auto-send the transcribed text
            setIsLoading(false);
            await sendMessage(data.text);
          } else {
            setInput(data.text);
            setIsLoading(false);
          }
        } else {
          setIsLoading(false);
        }
      } else {
        setIsLoading(false);
      }
    } catch (e) {
      console.error("Transcription failed", e);
      setIsLoading(false);
    }
  };

  // 首次运行向导完成后的回调
  const handleFirstRunComplete = () => {
    localStorage.setItem("hasCompletedSetup", "true");
    setIsFirstRun(false);
    // 重新加载配置
    const savedKey = localStorage.getItem("apiKey");
    if (savedKey) setApiKey(savedKey);
    const savedBase = localStorage.getItem("baseUrl");
    if (savedBase) setBaseUrl(savedBase);
    const savedModel = localStorage.getItem("modelName");
    if (savedModel) setModelName(savedModel);
    // 同步到后端
    if (savedKey) {
      fetch(`${backendUrl}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: savedKey,
          base_url: savedBase || "https://api.openai.com/v1",
          model_name: savedModel || "gpt-3.5-turbo",
        }),
      }).catch((err) => console.error("Config sync failed:", err));
    }
  };

  // 加载中状态（正在检测是否首次运行）
  if (isFirstRun === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-gradient-to-br from-pink-100 via-purple-50 to-blue-100">
        <div className="text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-gradient-to-br from-pink-400 to-purple-500 flex items-center justify-center animate-pulse">
            <Heart className="w-8 h-8 text-white" />
          </div>
          <p className="text-gray-500">加载中...</p>
        </div>
      </div>
    );
  }

  // 首次运行显示向导
  if (isFirstRun) {
    return (
      <FirstRunWizard
        backendUrl={backendUrl}
        onComplete={handleFirstRunComplete}
      />
    );
  }

  return (
    <main className="flex h-screen overflow-hidden relative">
      {/* 🌸 Background Elements */}
      <div className="fixed inset-0 pointer-events-none z-0">
        <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-gradient-to-bl from-pink-200/40 to-transparent rounded-full blur-3xl" />
        <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-gradient-to-tr from-blue-200/40 to-transparent rounded-full blur-3xl" />
      </div>

      {/* 📱 Mobile Sidebar Toggle */}
      <button
        className="md:hidden fixed top-4 left-4 z-50 p-2 bg-white/80 rounded-full shadow-lg"
        onClick={() => setIsSidebarOpen(!isSidebarOpen)}
      >
        <Menu size={24} />
      </button>

      {/* 🎨 Character Panel (Sidebar) */}
      <div className={`
        fixed md:static inset-y-0 left-0 z-40 w-full md:w-[400px] bg-white/80 md:bg-transparent backdrop-blur-xl md:backdrop-blur-none
        transition-transform duration-300 transform 
        ${isSidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}
        p-4 md:p-6 flex flex-col
      `}>
        <CharacterPanel emotion={emotion} affinity={affinity} currentActivity={currentActivity} emotionalState={emotionalState} />

        {/* Mobile Close Button */}
        {isSidebarOpen && (
          <button
            className="absolute top-4 right-4 p-2 text-gray-500 md:hidden"
            onClick={() => setIsSidebarOpen(false)}
          >
            ✕
          </button>
        )}
      </div>

      {/* 💬 Chat Area */}
      <div className="flex-1 flex flex-col h-full relative z-10 max-w-5xl mx-auto w-full">
        {/* Header */}
        <header className="h-16 flex items-center justify-between px-6 border-b border-white/20 backdrop-blur-sm">
          <div /> {/* Spacer */}
          <div className="flex gap-2">
            <button
              onClick={clearChat}
              className="p-2 rounded-full hover:bg-white/50 text-gray-600 transition-colors"
              title="新开对话"
            >
              <MessageSquarePlus size={20} />
            </button>
            <button
              onClick={() => setShowMemoryDialog(true)}
              className="p-2 rounded-full hover:bg-white/50 text-gray-600 transition-colors"
              title="记忆管理"
            >
              <Brain size={20} />
            </button>
            <button
              onClick={() => setShowThemeSwitcher(true)}
              className="p-2 rounded-full hover:bg-white/50 text-gray-600 transition-colors"
              title="切换主题"
            >
              <Palette size={20} />
            </button>
            <button
              onClick={() => setShowTaskDialog(true)}
              className="p-2 rounded-full hover:bg-white/50 text-gray-600 transition-colors"
              title="任务清单"
            >
              <ClipboardList size={20} />
            </button>
            <button
              onClick={() => setShowExportDialog(true)}
              className="p-2 rounded-full hover:bg-white/50 text-gray-600 transition-colors"
              title="导出对话"
            >
              <Download size={20} />
            </button>
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="p-2 rounded-full hover:bg-white/50 text-gray-600 transition-colors"
              title="设置"
            >
              <Settings size={20} />
            </button>
          </div>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
          {/* 欢迎消息 - 仅在没有聊天记录时显示 */}
          {messages.length === 0 && !isLoading && (
            <WelcomeMessage onQuickStart={sendMessage} />
          )}

          <AnimatePresence>
            {messages.map((msg, idx) => (
              <motion.div
                key={idx}
                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                className={`flex w-full ${msg.role === "user" ? "justify-end" : msg.role === "system" ? "justify-center" : "justify-start"}`}
              >
                {msg.role === "system" ? (
                  <div className="text-xs text-gray-400 bg-gray-100/50 px-3 py-1 rounded-full my-2">
                    {msg.content}
                  </div>
                ) : (
                  <div className={`max-w-[70%] p-4 text-sm md:text-base leading-relaxed break-words message-bubble relative
                    ${msg.role === "user" ? "chat-bubble-user" : "chat-bubble-ai"}
                  `}>
                    <div className="flex items-start gap-2">
                      <span className="flex-1">{msg.content}</span>
                      {msg.role === "assistant" && (
                        <VoiceButton text={msg.content} backendUrl={backendUrl} size={16} engine={ttsEngine} />
                      )}
                    </div>
                  </div>
                )}
              </motion.div>
            ))}
            {isLoading && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex justify-start w-full">
                <div className="bg-white/80 p-4 rounded-2xl rounded-tl-none border border-pink-100 shadow-sm flex items-center gap-2">
                  <span className="w-2 h-2 bg-pink-400 rounded-full animate-bounce" />
                  <span className="w-2 h-2 bg-pink-400 rounded-full animate-bounce delay-75" />
                  <span className="w-2 h-2 bg-pink-400 rounded-full animate-bounce delay-150" />
                </div>
              </motion.div>
            )}
            {isTypingProactive && !isLoading && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex justify-start w-full"
              >
                <div className="bg-gradient-to-r from-pink-50 to-purple-50 p-4 rounded-2xl rounded-tl-none border border-pink-200 shadow-sm flex items-center gap-3">
                  <Heart className="w-4 h-4 text-pink-400 animate-pulse" />
                  <span className="text-pink-500 text-sm">小爱正在想对你说的话...</span>
                  <span className="w-2 h-2 bg-pink-400 rounded-full animate-bounce" />
                  <span className="w-2 h-2 bg-pink-400 rounded-full animate-bounce delay-75" />
                  <span className="w-2 h-2 bg-pink-400 rounded-full animate-bounce delay-150" />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="p-4 md:p-6 pb-6">
          <div className="max-w-4xl mx-auto card-cute p-2">

            {/* Quick Replies */}
            <QuickReplies onSend={sendMessage} disabled={isLoading} />

            <div className="flex items-center gap-2 px-2 pb-2">
              {/* Voice Mode Toggle */}
              <button
                className={`p-3 rounded-xl transition-all ${voiceMode ? "bg-pink-100 text-pink-500" : "text-gray-400 hover:bg-gray-100"}`}
                onClick={() => setVoiceMode(!voiceMode)}
                title="开启语音朗读"
              >
                <Volume2 size={20} />
              </button>

              {/* Auto Send Voice Toggle */}
              <button
                className={`p-2 rounded-xl transition-all text-xs whitespace-nowrap ${autoSendVoice ? "bg-green-100 text-green-600" : "text-gray-400 hover:bg-gray-100"}`}
                onClick={() => setAutoSendVoice(!autoSendVoice)}
                title={autoSendVoice ? "语音转文字后自动发送" : "语音转文字后手动发送"}
              >
                {autoSendVoice ? "自动发送" : "手动发送"}
              </button>

              {/* Emoji Picker Toggle */}
              <div className="relative">
                <button
                  className={`p-3 rounded-xl transition-all ${showEmojiPicker ? "bg-pink-100 text-pink-500" : "text-gray-400 hover:bg-gray-100"}`}
                  onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                >
                  <Smile size={20} />
                </button>
                <AnimatePresence>
                  {showEmojiPicker && (
                    <EmojiPicker
                      onSelect={(emoji) => setInput(prev => prev + emoji)}
                      onClose={() => setShowEmojiPicker(false)}
                    />
                  )}
                </AnimatePresence>
              </div>

              {/* Text Input */}
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
                placeholder="和小爱说点什么吧..."
                className="flex-1 input-cute bg-transparent border-transparent focus:bg-white focus:border-pink-200"
                disabled={isLoading}
              />

              {/* Mic Button */}
              <button
                className={`p-3 rounded-xl transition-all relative flex items-center gap-1 ${isRecording ? "text-red-500 bg-red-50" : "text-gray-400 hover:bg-gray-100"}`}
                onClick={handleVoiceRecording}
                title={isRecording ? "停止录音" : "开始录音"}
              >
                {isRecording && <span className="absolute inset-0 rounded-xl border border-red-500 pulse-ring" />}
                {isRecording ? <StopCircle size={20} /> : <Mic size={20} />}
                {isRecording && (
                  <span className="text-xs font-mono min-w-[2.5rem]">
                    {Math.floor(recordingTime / 60).toString().padStart(2, "0")}:{(recordingTime % 60).toString().padStart(2, "0")}
                  </span>
                )}
              </button>

              {/* Audio Visualizer */}
              {isRecording && (
                <AudioVisualizer stream={mediaStream} isRecording={isRecording} />
              )}

              {/* Image Button */}
              <button className="p-3 rounded-xl text-gray-400 hover:bg-gray-100 transition-all">
                <ImageIcon size={20} />
              </button>

              {/* Send Button */}
              <button
                onClick={() => sendMessage()}
                disabled={!input.trim() || isLoading}
                className="p-3 rounded-xl btn-cute disabled:opacity-50 disabled:shadow-none"
              >
                <Send size={20} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Modals */}
      <AnimatePresence>
        {showThemeSwitcher && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm" onClick={() => setShowThemeSwitcher(false)}>
            <div onClick={(e) => e.stopPropagation()}>
              <ThemeSwitcher onClose={() => setShowThemeSwitcher(false)} />
            </div>
          </div>
        )}
        {showExportDialog && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm" onClick={() => setShowExportDialog(false)}>
            <div onClick={(e) => e.stopPropagation()}>
              <ExportDialog messages={messages} onClose={() => setShowExportDialog(false)} />
            </div>
          </div>
        )}
        {showSettings && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm" onClick={() => setShowSettings(false)}>
            <div onClick={(e) => e.stopPropagation()}>
              <SettingsDialog
                onClose={() => setShowSettings(false)}
                backendUrl={backendUrl}
                onConfigChange={(config) => {
                  setTtsEngine(config.ttsEngine);
                }}
              />
            </div>
          </div>
        )}
        {showMemoryDialog && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm" onClick={() => setShowMemoryDialog(false)}>
            <div onClick={(e) => e.stopPropagation()}>
              <MemoryDialog
                onClose={() => setShowMemoryDialog(false)}
                backendUrl={backendUrl}
                onStateChange={(state) => {
                  setAffinity(state.affinity);
                  localStorage.setItem("affinity", state.affinity.toString());
                }}
              />
            </div>
          </div>
        )}

        {showTaskDialog && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm" onClick={() => setShowTaskDialog(false)}>
            <div onClick={(e) => e.stopPropagation()}>
              <TaskDialog
                onClose={() => setShowTaskDialog(false)}
                backendUrl={backendUrl}
              />
            </div>
          </div>
        )}
      </AnimatePresence>
    </main>
  );
}
