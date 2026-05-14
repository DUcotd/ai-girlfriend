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
  const [showSettings, setShowSettings] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const [affinity, setAffinity] = useState(35);
  const [emotion, setEmotion] = useState<string>("\u5e73\u9759");
  const [emotionalState, setEmotionalState] = useState<any>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showThemeSwitcher, setShowThemeSwitcher] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showMemoryDialog, setShowMemoryDialog] = useState(false);
  const [showTaskDialog, setShowTaskDialog] = useState(false);
  const [ttsEngine, setTtsEngine] = useState<"openai" | "local">("openai");
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [currentActivity, setCurrentActivity] = useState<{ activity: string; emoji: string } | null>(null);
  const [isFirstRun, setIsFirstRun] = useState<boolean | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [autoSendVoice, setAutoSendVoice] = useState(true);
  const [recordingTime, setRecordingTime] = useState(0);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);

  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [modelName, setModelName] = useState("gpt-3.5-turbo");
  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

  useEffect(() => {
    const savedApiKey = localStorage.getItem("apiKey");
    const hasCompletedSetup = localStorage.getItem("hasCompletedSetup");
    if (!savedApiKey || !hasCompletedSetup) setIsFirstRun(true);
    else setIsFirstRun(false);
  }, []);

  useEffect(() => {
    if ("Notification" in window) Notification.requestPermission();
    const createPetal = () => {
      const petal = document.createElement("div");
      petal.classList.add("sakura-petal");
      petal.style.left = Math.random() * 100 + "vw";
      petal.style.animationDuration = Math.random() * 3 + 4 + "s";
      petal.style.opacity = (Math.random() * 0.5 + 0.3).toString();
      document.body.appendChild(petal);
      setTimeout(() => { if (petal.parentNode) petal.remove(); }, 7000);
    };
    const interval = setInterval(createPetal, 1000);
    return () => {
      clearInterval(interval);
      document.querySelectorAll(".sakura-petal").forEach(p => p.remove());
    };
  }, []);

  useEffect(() => {
    const savedKey = localStorage.getItem("apiKey");
    if (savedKey) setApiKey(savedKey);
    const savedBase = localStorage.getItem("baseUrl");
    if (savedBase) setBaseUrl(savedBase);
    const savedModel = localStorage.getItem("modelName");
    if (savedModel) setModelName(savedModel);
    const savedEngine = localStorage.getItem("ttsEngine");
    if (savedEngine) setTtsEngine(savedEngine as "openai" | "local");

    const savedAffinity = localStorage.getItem("affinity");
    if (savedAffinity) setAffinity(parseInt(savedAffinity, 10));

    fetch(`${backendUrl}/state`)
      .then(res => res.json())
      .then(data => {
        if (typeof data.affinity === 'number') {
          setAffinity(data.affinity);
          localStorage.setItem("affinity", data.affinity.toString());
        }
      })
      .catch(() => {});

    const savedTheme = localStorage.getItem("theme");
    if (savedTheme) document.documentElement.setAttribute("data-theme", savedTheme);

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
      }).catch(() => {});
    }

    fetchHistory();
  }, []);

  useEffect(() => {
    localStorage.setItem("affinity", affinity.toString());
  }, [affinity]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    const fetchActivity = async () => {
      try {
        const res = await fetch(`${backendUrl}/life/current`);
        if (res.ok) {
          const data = await res.json();
          setCurrentActivity({ activity: data.activity, emoji: data.emoji || "\ud83c\udf38" });
        }
      } catch (e) {}
    };
    fetchActivity();
    const interval = setInterval(fetchActivity, 120000);
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
      const res = await fetch(`${backendUrl}/history`, { method: "DELETE" });
      if (res.ok) setMessages([]);
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
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);
      const res = await fetch(`${backendUrl}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) throw new Error("API Error");
      const data = await res.json();

      if (data.special_action === "ghosting") {
        if (data.affinity) setAffinity(data.affinity);
        if (data.emotionalState) setEmotionalState(data.emotionalState);
        const ghostingMsg = { role: "system" as const, content: "\ud83d\udc94 Message read, no response..." };
        setMessages((prev) => [...prev, ghostingMsg]);
        return;
      }

      const aiMsg = { role: "assistant" as const, content: data.reply };
      setMessages((prev) => [...prev, aiMsg]);

      if (data.emotion) setEmotion(data.emotion);
      if (typeof data.affinity === 'number') {
        setAffinity(data.affinity);
        localStorage.setItem("affinity", data.affinity.toString());
      }
      if (data.emotionalState) setEmotionalState(data.emotionalState);
      if (voiceMode) speakText(data.reply);
    } catch (error: any) {
      if (error.name === "AbortError") {
        setMessages((prev) => [...prev, { role: "assistant", content: "\u23f0 Taking longer than expected... please try again." }]);
      } else {
        setMessages((prev) => [...prev, { role: "assistant", content: "\u26a0\ufe0f Sorry, connection lost..." }]);
      }
    } finally {
      setIsLoading(false);
    }
  }, [backendUrl, input, voiceMode]);

  const speakTextLocal = useCallback((text: string) => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = 1.1;
    utterance.pitch = 1.2;
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

  const lastUserActivityRef = useRef(Date.now());
  const [isTypingProactive, setIsTypingProactive] = useState(false);

  useEffect(() => {
    const updateActivity = () => { lastUserActivityRef.current = Date.now(); };
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
    let isPageVisible = true;
    const getPollInterval = () => {
      const idleTime = Date.now() - lastUserActivityRef.current;
      return idleTime > 5 * 60 * 1000 ? 60000 : 15000;
    };

    const fetchProactive = async () => {
      if (!isPageVisible) return;
      try {
        const res = await fetch(`${backendUrl}/chat/proactive`);
        if (res.status === 200) {
          const data = await res.json();
          setIsTypingProactive(true);
          const typingDelay = Math.min(2000, Math.max(800, data.content.length * 30));
          await new Promise(r => setTimeout(r, typingDelay));
          setIsTypingProactive(false);
          const aiMsg = { role: "assistant" as const, content: data.content };
          setMessages(prev => [...prev, aiMsg]);
          if (data.emotion) setEmotion(data.emotion);
          if (voiceMode) speakText(data.content);
          if (document.hidden && Notification.permission === "granted") {
            const reasonMap: Record<string, string> = {
              morning_greeting: "\ud83c\udf05",
              night_greeting: "\ud83c\udf19",
              miss_you: "\ud83d\udc95",
              mood_check: "\ud83d\udc9d",
              task_reminder: "\ud83d\udcdd",
              random_chat: "\u2728",
              memory_share: "\ud83d\udcad"
            };
            new Notification(reasonMap[data.reason] || "Xiao Ai", {
              body: data.content,
              icon: "/favicon.ico",
              tag: "proactive-message",
            });
          }
          try { const audio = new Audio('/notification.mp3'); audio.volume = 0.3; audio.play().catch(() => {}); } catch {}
        }
      } catch (e) {}
    };

    const handleVisibilityChange = () => {
      isPageVisible = !document.hidden;
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    let interval: NodeJS.Timeout | null = null;
    const startPolling = () => {
      if (interval) clearInterval(interval);
      interval = setInterval(() => {
        fetchProactive();
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
        alert("Microphone access denied");
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

  const handleFirstRunComplete = () => {
    localStorage.setItem("hasCompletedSetup", "true");
    setIsFirstRun(false);
    const savedKey = localStorage.getItem("apiKey");
    if (savedKey) setApiKey(savedKey);
    const savedBase = localStorage.getItem("baseUrl");
    if (savedBase) setBaseUrl(savedBase);
    const savedModel = localStorage.getItem("modelName");
    if (savedModel) setModelName(savedModel);
    if (savedKey) {
      fetch(`${backendUrl}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: savedKey,
          base_url: savedBase || "https://api.openai.com/v1",
          model_name: savedModel || "gpt-3.5-turbo",
        }),
      }).catch(() => {});
    }
  };

  if (isFirstRun === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-gradient-to-br from-pink-100 via-purple-50 to-blue-100">
        <div className="text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-gradient-to-br from-pink-400 to-purple-500 flex items-center justify-center animate-pulse">
            <Heart className="w-8 h-8 text-white" />
          </div>
          <p className="text-gray-500">Loading...</p>
        </div>
      </div>
    );
  }

  if (isFirstRun) {
    return (
      <FirstRunWizard backendUrl={backendUrl} onComplete={handleFirstRunComplete} />
    );
  }

  return (
    <main className="flex h-screen overflow-hidden relative">
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

      <div className={`fixed md:static inset-y-0 left-0 z-40 w-full md:w-[400px] bg-white/80 md:bg-transparent backdrop-blur-xl md:backdrop-blur-none transition-transform duration-300 transform ${isSidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"} p-4 md:p-6 flex flex-col`}>
        <CharacterPanel emotion={emotion} affinity={affinity} currentActivity={currentActivity} emotionalState={emotionalState} />
        {isSidebarOpen && (
          <button className="absolute top-4 right-4 p-2 text-gray-500 md:hidden" onClick={() => setIsSidebarOpen(false)}>
            <X size={20} />
          </button>
        )}
      </div>

      <div className="flex-1 flex flex-col h-full relative z-10 max-w-5xl mx-auto w-full">
        <header className="h-16 flex items-center justify-between px-6 border-b border-white/20 backdrop-blur-sm">
          <div />
          <div className="flex gap-2">
            <button onClick={clearChat} className="p-2 rounded-full hover:bg-white/50 text-gray-600 transition-colors" title="New Chat">
              <MessageSquarePlus size={20} />
            </button>
            <button onClick={() => setShowMemoryDialog(true)} className="p-2 rounded-full hover:bg-white/50 text-gray-600 transition-colors" title="Memories">
              <Brain size={20} />
            </button>
            <button onClick={() => setShowThemeSwitcher(true)} className="p-2 rounded-full hover:bg-white/50 text-gray-600 transition-colors" title="Theme">
              <Palette size={20} />
            </button>
            <button onClick={() => setShowTaskDialog(true)} className="p-2 rounded-full hover:bg-white/50 text-gray-600 transition-colors" title="Tasks">
              <ClipboardList size={20} />
            </button>
            <button onClick={() => setShowExportDialog(true)} className="p-2 rounded-full hover:bg-white/50 text-gray-600 transition-colors" title="Export">
              <Download size={20} />
            </button>
            <button onClick={() => setShowSettings(!showSettings)} className="p-2 rounded-full hover:bg-white/50 text-gray-600 transition-colors" title="Settings">
              <Settings size={20} />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
          {messages.length === 0 && !isLoading && (
            <WelcomeMessage onQuickStart={sendMessage} />
          )}
          <AnimatePresence>
            {messages.map((msg, idx) => (
              <motion.div key={idx} initial={{ opacity: 0, y: 10, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }}
                className={`flex w-full ${msg.role === "user" ? "justify-end" : msg.role === "system" ? "justify-center" : "justify-start"}`}
              >
                {msg.role === "system" ? (
                  <div className="text-xs text-gray-400 bg-gray-100/50 px-3 py-1 rounded-full my-2">{msg.content}</div>
                ) : (
                  <div className={`max-w-[70%] p-4 text-sm md:text-base leading-relaxed break-words message-bubble relative ${msg.role === "user" ? "chat-bubble-user" : "chat-bubble-ai"}`}>
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
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex justify-start w-full">
                <div className="bg-gradient-to-r from-pink-50 to-purple-50 p-4 rounded-2xl rounded-tl-none border border-pink-200 shadow-sm flex items-center gap-3">
                  <Heart className="w-4 h-4 text-pink-400 animate-pulse" />
                  <span className="text-pink-500 text-sm">Xiao Ai is thinking...</span>
                  <span className="w-2 h-2 bg-pink-400 rounded-full animate-bounce" />
                  <span className="w-2 h-2 bg-pink-400 rounded-full animate-bounce delay-75" />
                  <span className="w-2 h-2 bg-pink-400 rounded-full animate-bounce delay-150" />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <div ref={messagesEndRef} />
        </div>

        <div className="p-4 md:p-6 pb-6">
          <div className="max-w-4xl mx-auto card-cute p-2">
            <QuickReplies onSend={sendMessage} disabled={isLoading} />
            <div className="flex items-center gap-2 px-2 pb-2">
              <button className={`p-3 rounded-xl transition-all ${voiceMode ? "bg-pink-100 text-pink-500" : "text-gray-400 hover:bg-gray-100"}`}
                onClick={() => setVoiceMode(!voiceMode)} title="Voice mode">
                <Volume2 size={20} />
              </button>
              <button className={`p-2 rounded-xl transition-all text-xs whitespace-nowrap ${autoSendVoice ? "bg-green-100 text-green-600" : "text-gray-400 hover:bg-gray-100"}`}
                onClick={() => setAutoSendVoice(!autoSendVoice)} title="Auto send voice">
                {autoSendVoice ? "Auto" : "Manual"}
              </button>
              <div className="relative">
                <button className={`p-3 rounded-xl transition-all ${showEmojiPicker ? "bg-pink-100 text-pink-500" : "text-gray-400 hover:bg-gray-100"}`}
                  onClick={() => setShowEmojiPicker(!showEmojiPicker)}>
                  <Smile size={20} />
                </button>
                <AnimatePresence>
                  {showEmojiPicker && (
                    <EmojiPicker onSelect={(emoji: string) => setInput(prev => prev + emoji)} onClose={() => setShowEmojiPicker(false)} />
                  )}
                </AnimatePresence>
              </div>
              <input type="text" value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
                placeholder="Say something..."
                className="flex-1 input-cute bg-transparent border-transparent focus:bg-white focus:border-pink-200"
                disabled={isLoading} />
              <button className={`p-3 rounded-xl transition-all relative flex items-center gap-1 ${isRecording ? "text-red-500 bg-red-50" : "text-gray-400 hover:bg-gray-100"}`}
                onClick={handleVoiceRecording}
                title={isRecording ? "Stop" : "Record"}>
                {isRecording && <span className="absolute inset-0 rounded-xl border border-red-500 pulse-ring" />}
                {isRecording ? <StopCircle size={20} /> : <Mic size={20} />}
                {isRecording && (
                  <span className="text-xs font-mono min-w-[2.5rem]">
                    {Math.floor(recordingTime / 60).toString().padStart(2, "0")}:{(recordingTime % 60).toString().padStart(2, "0")}
                  </span>
                )}
              </button>
              {isRecording && <AudioVisualizer stream={mediaStream} isRecording={isRecording} />}
              <button className="p-3 rounded-xl text-gray-400 hover:bg-gray-100 transition-all">
                <ImageIcon size={20} />
              </button>
              <button onClick={() => sendMessage()} disabled={!input.trim() || isLoading}
                className="p-3 rounded-xl btn-cute disabled:opacity-50 disabled:shadow-none">
                <Send size={20} />
              </button>
            </div>
          </div>
        </div>
      </div>

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
                onConfigChange={(config) => { setTtsEngine(config.ttsEngine); }}
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
                onStateChange={(state: any) => {
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
              <TaskDialog onClose={() => setShowTaskDialog(false)} backendUrl={backendUrl} />
            </div>
          </div>
        )}
      </AnimatePresence>
    </main>
  );
}
