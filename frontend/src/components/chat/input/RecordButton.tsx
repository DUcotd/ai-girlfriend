"use client";

import { useEffect, useState } from "react";
import { Mic, StopCircle } from "lucide-react";
import IconButton from "@/components/ui/IconButton";
import { elapsedSeconds } from "@/hooks/useVoiceRecorder";

interface RecordButtonProps {
    isRecording: boolean;
    /** 本次录音开始时刻（ms）；null = 未在录 */
    startedAt: number | null;
    /** AI 回复进行中禁用：自动发送路径无并发闸的另一道防线 */
    disabled?: boolean;
    onToggle: () => void;
}

/**
 * 录音按钮：录制中显示脉冲圈与 mm:ss 计时。
 *
 * ⚠️ 秒数是本组件的局部 state，不再从 ChatPage 传下来（FE-12）：
 * 计时器挂在页面级会让整棵聊天树每秒重渲染一次，包括所有历史气泡。
 */
export default function RecordButton({ isRecording, startedAt, disabled = false, onToggle }: RecordButtonProps) {
    const [seconds, setSeconds] = useState(0);

    /* eslint-disable react-hooks/set-state-in-effect */
    // 计时器是外部世界的时间，只能在 effect 里读：startedAt 变化时归零并重启 interval。
    // 这里不存在「同步派生 state」的替代写法（render 期读 Date.now() 会让 SSR 与水合不一致）。
    useEffect(() => {
        if (startedAt === null) {
            setSeconds(0);
            return;
        }
        setSeconds(elapsedSeconds(startedAt, Date.now()));
        const id = setInterval(() => setSeconds(elapsedSeconds(startedAt, Date.now())), 1000);
        return () => clearInterval(id);
    }, [startedAt]);
    /* eslint-enable react-hooks/set-state-in-effect */

    return (
        <IconButton
            active={isRecording}
            tone="danger"
            className="relative flex items-center gap-1"
            onClick={onToggle}
            disabled={disabled}
            aria-label={isRecording ? "停止录音" : "开始录音"}
            title={isRecording ? "停止" : "录音"}
        >
            {isRecording && (
                <span className="pulse-ring absolute inset-0 rounded-xl border border-status-danger" />
            )}
            {isRecording ? <StopCircle size={20} /> : <Mic size={20} />}
            {isRecording && (
                <span className="min-w-[2.5rem] font-mono text-xs">
                    {Math.floor(seconds / 60)
                        .toString()
                        .padStart(2, "0")}
                    :{(seconds % 60).toString().padStart(2, "0")}
                </span>
            )}
        </IconButton>
    );
}
