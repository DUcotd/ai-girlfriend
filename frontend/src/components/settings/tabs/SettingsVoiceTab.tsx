"use client";

import { motion } from "framer-motion";
import Field from "@/components/ui/Field";
import Input from "@/components/ui/Input";
import Note from "@/components/ui/Note";
import SegmentedControl from "@/components/ui/SegmentedControl";
import type { TtsEngine } from "@/types";

interface SettingsVoiceTabProps {
    ttsEngine: TtsEngine;
    ttsApiKey: string;
    onTtsEngineChange: (value: TtsEngine) => void;
    onTtsApiKeyChange: (value: string) => void;
}

/**
 * 设置 → 语音：TTS 引擎选择与云端 Key。
 *
 * 云端语音与主 API Key 完全独立：只认这里的专属 TTS Key，
 * 未配置时云端引擎不启用，朗读/录音转写自动回退浏览器本地语音。
 */
export default function SettingsVoiceTab({
    ttsEngine,
    ttsApiKey,
    onTtsEngineChange,
    onTtsApiKeyChange,
}: SettingsVoiceTabProps) {
    const cloudUnconfigured = ttsEngine === "openai" && !ttsApiKey.trim();

    return (
        <>
            <div className="space-y-2">
                <label className="block pl-1 text-[10px] font-bold uppercase tracking-widest text-content-muted">
                    语音引擎
                </label>
                <SegmentedControl
                    options={[
                        { value: "openai", label: "OpenAI (云端)" },
                        { value: "local", label: "浏览器 (本地)" },
                    ]}
                    value={ttsEngine}
                    onChange={onTtsEngineChange}
                />
            </div>

            {ttsEngine === "openai" && (
                <motion.div initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
                    <Field
                        label={
                            <>
                                TTS API 密钥{" "}
                                <span className="normal-case text-accent-1/70">(仅支持 OpenAI 官方 Key)</span>
                            </>
                        }
                    >
                        <Input
                            type="password"
                            value={ttsApiKey}
                            onChange={(e) => onTtsApiKeyChange(e.target.value)}
                            placeholder="sk-... (未配置时云端语音不可用)"
                        />
                    </Field>

                    {cloudUnconfigured && (
                        <Note tone="warning">
                            ⚠️ 尚未配置 TTS 密钥：云端语音不会启用，朗读将自动使用浏览器本地语音。
                        </Note>
                    )}
                </motion.div>
            )}

            <Note tone="info">
                💡 提示：本地引擎完全免费且零延迟，但音色取决于你的系统配置；云端引擎音色更自然但需要消耗额度。
                云端语音使用独立的 TTS 密钥，不与聊天主 Key 共用。
            </Note>
        </>
    );
}
