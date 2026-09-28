"use client";

import { useState } from "react";
import { AnimatePresence } from "framer-motion";
import { Image as ImageIcon, Mic, Send, Smile, StopCircle, Volume2 } from "lucide-react";
import AudioVisualizer from "../AudioVisualizer";
import EmojiPicker from "../EmojiPicker";
import QuickReplies from "../QuickReplies";
import { useUiStore } from "@/stores/uiStore";

interface ChatInputProps {
  input: string;
  onInputChange: (value: string) => void;
  /** 发送输入框内容 */
  onSend: () => void;
  /** 发送快捷回复/欢迎语等预设文本 */
  onQuickSend: (text: string) => void;
  isLoading: boolean;
  isRecording: boolean;
  recordingTime: number;
  mediaStream: MediaStream | null;
  onToggleRecording: () => void;
}

/**
 * 输入区：快捷回复 + 语音/表情/录音/发送。
 * voiceMode/autoSendVoice 读 uiStore；表情面板开关为组件局部态。
 */
export default function ChatInput({
  input,
  onInputChange,
  onSend,
  onQuickSend,
  isLoading,
  isRecording,
  recordingTime,
  mediaStream,
  onToggleRecording,
}: ChatInputProps) {
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const voiceMode = useUiStore((s) => s.voiceMode);
  const autoSendVoice = useUiStore((s) => s.autoSendVoice);
  const toggleVoiceMode = useUiStore((s) => s.toggleVoiceMode);
  const toggleAutoSendVoice = useUiStore((s) => s.toggleAutoSendVoice);

  const handleSend = () => {
    setShowEmojiPicker(false);
    onSend();
  };

  return (
    <div className="max-w-4xl mx-auto card-cute p-2">
      <QuickReplies onSend={onQuickSend} disabled={isLoading} />

      <div className="flex items-center gap-2 px-2 pb-2">
        <button
          className={`p-3 rounded-xl transition-all ${voiceMode ? "bg-pink-100 text-pink-500" : "text-gray-400 hover:bg-gray-100"}`}
          onClick={toggleVoiceMode}
          title="语音模式"
        >
          <Volume2 size={20} />
        </button>

        <button
          className={`p-2 rounded-xl transition-all text-xs whitespace-nowrap ${autoSendVoice ? "bg-green-100 text-green-600" : "text-gray-400 hover:bg-gray-100"}`}
          onClick={toggleAutoSendVoice}
          title="自动发送语音"
        >
          {autoSendVoice ? "自动" : "手动"}
        </button>

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
                onSelect={(emoji) => onInputChange(input + emoji)}
                onClose={() => setShowEmojiPicker(false)}
              />
            )}
          </AnimatePresence>
        </div>

        <input
          type="text"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
          placeholder="说点什么..."
          className="flex-1 input-cute bg-transparent border-transparent focus:bg-white focus:border-pink-200"
          disabled={isLoading}
        />

        <button
          className={`p-3 rounded-xl transition-all relative flex items-center gap-1 ${isRecording ? "text-red-500 bg-red-50" : "text-gray-400 hover:bg-gray-100"}`}
          onClick={onToggleRecording}
          title={isRecording ? "停止" : "录音"}
        >
          {isRecording && <span className="absolute inset-0 rounded-xl border border-red-500 pulse-ring" />}
          {isRecording ? <StopCircle size={20} /> : <Mic size={20} />}
          {isRecording && (
            <span className="text-xs font-mono min-w-[2.5rem]">
              {Math.floor(recordingTime / 60)
                .toString()
                .padStart(2, "0")}
              :{(recordingTime % 60).toString().padStart(2, "0")}
            </span>
          )}
        </button>

        {isRecording && <AudioVisualizer stream={mediaStream} isRecording={isRecording} />}

        <button className="p-3 rounded-xl text-gray-400 hover:bg-gray-100 transition-all">
          <ImageIcon size={20} />
        </button>

        <button
          onClick={handleSend}
          disabled={!input.trim() || isLoading}
          className="p-3 rounded-xl btn-cute disabled:opacity-50 disabled:shadow-none"
        >
          <Send size={20} />
        </button>
      </div>
    </div>
  );
}
