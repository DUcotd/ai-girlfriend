"use client";

import { Volume2 } from "lucide-react";
import IconButton from "@/components/ui/IconButton";
import { cn } from "@/lib/cn";
import { useUiStore } from "@/stores/uiStore";

/** 语音模式开关 + 语音转写后「自动/手动发送」切换（状态在 uiStore）。 */
export default function VoiceModeControls() {
    const voiceMode = useUiStore((s) => s.voiceMode);
    const autoSendVoice = useUiStore((s) => s.autoSendVoice);
    const toggleVoiceMode = useUiStore((s) => s.toggleVoiceMode);
    const toggleAutoSendVoice = useUiStore((s) => s.toggleAutoSendVoice);

    return (
        <>
            <IconButton active={voiceMode} onClick={toggleVoiceMode} title="语音模式">
                <Volume2 size={20} />
            </IconButton>

            <button
                type="button"
                className={cn(
                    "whitespace-nowrap rounded-xl p-2 text-xs transition-all",
                    autoSendVoice
                        ? "bg-status-success/15 text-status-success"
                        : "text-content-muted hover:bg-surface-2"
                )}
                onClick={toggleAutoSendVoice}
                title="自动发送语音"
            >
                {autoSendVoice ? "自动" : "手动"}
            </button>
        </>
    );
}
