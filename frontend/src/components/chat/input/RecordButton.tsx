"use client";

import { Mic, StopCircle } from "lucide-react";
import IconButton from "@/components/ui/IconButton";

interface RecordButtonProps {
    isRecording: boolean;
    /** 已录秒数 */
    recordingTime: number;
    /** AI 回复进行中禁用：自动发送路径无并发闸的另一道防线 */
    disabled?: boolean;
    onToggle: () => void;
}

/** 录音按钮：录制中显示脉冲圈与 mm:ss 计时。 */
export default function RecordButton({ isRecording, recordingTime, disabled = false, onToggle }: RecordButtonProps) {
    return (
        <IconButton
            active={isRecording}
            tone="danger"
            className="relative flex items-center gap-1"
            onClick={onToggle}
            disabled={disabled}
            title={isRecording ? "停止" : "录音"}
        >
            {isRecording && (
                <span className="pulse-ring absolute inset-0 rounded-xl border border-status-danger" />
            )}
            {isRecording ? <StopCircle size={20} /> : <Mic size={20} />}
            {isRecording && (
                <span className="min-w-[2.5rem] font-mono text-xs">
                    {Math.floor(recordingTime / 60)
                        .toString()
                        .padStart(2, "0")}
                    :{(recordingTime % 60).toString().padStart(2, "0")}
                </span>
            )}
        </IconButton>
    );
}
