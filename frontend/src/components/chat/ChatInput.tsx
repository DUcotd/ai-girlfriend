"use client";

import { Send } from "lucide-react";
import AudioVisualizer from "../voice/AudioVisualizer";
import QuickReplies from "./QuickReplies";
import Button from "../ui/Button";
import EmojiPickerButton from "./input/EmojiPickerButton";
import RecordButton from "./input/RecordButton";
import VoiceModeControls from "./input/VoiceModeControls";
import type { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { useChatStore } from "@/stores/chatStore";

interface ChatInputProps {
    input: string;
    onInputChange: (value: string) => void;
    /** 发送输入框内容 */
    onSend: () => void;
    /** 发送快捷回复/欢迎语等预设文本 */
    onQuickSend: (text: string) => void;
    /** useVoiceRecorder 的整个返回值（录音状态 + 开关） */
    recorder: ReturnType<typeof useVoiceRecorder>;
}

/**
 * 输入区：浮动胶囊 dock —— 快捷回复浮在 dock 上方独立成行；
 * dock 本体是单行玻璃胶囊（语音/表情/输入/录音/发送），
 * 聚焦时外壳描边与光晕同步高亮（focus-within）。
 * isLoading 直接从 chatStore 订阅；voiceMode/autoSendVoice 由 VoiceModeControls 自管。
 */
export default function ChatInput({
    input,
    onInputChange,
    onSend,
    onQuickSend,
    recorder,
}: ChatInputProps) {
    const isLoading = useChatStore((s) => s.isLoading);
    const { isRecording, recordingTime, mediaStream, toggleRecording } = recorder;

    return (
        <div className="mx-auto w-full max-w-3xl">
            <QuickReplies onSend={onQuickSend} disabled={isLoading} />

            <div className="relative flex items-center gap-1.5 rounded-full border border-accent-1/15 bg-surface-1/85 p-2 pl-3 shadow-modal backdrop-blur-xl transition-[border-color,box-shadow] duration-normal focus-within:border-accent-1/40 focus-within:shadow-accent">
                {/* 录音波形：浮在 dock 上方，不挤占胶囊布局 */}
                {isRecording && (
                    <div className="absolute bottom-full left-1/2 mb-3 -translate-x-1/2 rounded-full border border-accent-1/15 bg-surface-1/90 p-1.5 shadow-card backdrop-blur-xl">
                        <AudioVisualizer stream={mediaStream} isRecording={isRecording} />
                    </div>
                )}

                <VoiceModeControls />

                <EmojiPickerButton onSelect={(emoji) => onInputChange(input + emoji)} />

                <input
                    type="text"
                    value={input}
                    onChange={(e) => onInputChange(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && onSend()}
                    placeholder="说点什么..."
                    className="min-w-0 flex-1 bg-transparent px-2 py-2 text-content-primary transition-colors duration-fast placeholder:text-content-muted focus:outline-none disabled:opacity-60"
                    disabled={isLoading}
                />

                <RecordButton
                    isRecording={isRecording}
                    recordingTime={recordingTime}
                    disabled={isLoading}
                    onToggle={toggleRecording}
                />

                <Button
                    onClick={onSend}
                    disabled={!input.trim() || isLoading}
                    className="rounded-full p-3"
                    title="发送"
                >
                    <Send size={20} />
                </Button>
            </div>
        </div>
    );
}
