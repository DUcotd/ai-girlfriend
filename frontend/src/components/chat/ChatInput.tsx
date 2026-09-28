"use client";

import { Image as ImageIcon, Send } from "lucide-react";
import AudioVisualizer from "../voice/AudioVisualizer";
import QuickReplies from "./QuickReplies";
import Button from "../ui/Button";
import Card from "../ui/Card";
import IconButton from "../ui/IconButton";
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
 * 输入区：快捷回复 + 语音/表情/录音/发送。
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
        <Card className="mx-auto max-w-4xl p-2">
            <QuickReplies onSend={onQuickSend} disabled={isLoading} />

            <div className="flex items-center gap-2 px-2 pb-2">
                <VoiceModeControls />

                <EmojiPickerButton onSelect={(emoji) => onInputChange(input + emoji)} />

                <input
                    type="text"
                    value={input}
                    onChange={(e) => onInputChange(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && onSend()}
                    placeholder="说点什么..."
                    className="flex-1 rounded-2xl border-2 border-transparent bg-transparent px-4 py-3 text-content-primary transition-all placeholder:text-content-muted focus:border-accent-1/30 focus:bg-surface-1 focus:outline-none"
                    disabled={isLoading}
                />

                <RecordButton
                    isRecording={isRecording}
                    recordingTime={recordingTime}
                    onToggle={toggleRecording}
                />

                {isRecording && <AudioVisualizer stream={mediaStream} isRecording={isRecording} />}

                <IconButton title="发送图片">
                    <ImageIcon size={20} />
                </IconButton>

                <Button
                    onClick={onSend}
                    disabled={!input.trim() || isLoading}
                    className="rounded-xl p-3"
                    title="发送"
                >
                    <Send size={20} />
                </Button>
            </div>
        </Card>
    );
}
