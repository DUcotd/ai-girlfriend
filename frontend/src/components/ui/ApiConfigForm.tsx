"use client";

import type { ReactNode } from "react";
import { PROVIDER_PRESETS, matchPreset } from "@/lib/providers";
import Field from "./Field";
import Input from "./Input";
import SegmentedControl from "./SegmentedControl";

interface ApiConfigFormProps {
    apiKey: string;
    baseUrl: string;
    modelName: string;
    onApiKeyChange: (value: string) => void;
    onBaseUrlChange: (value: string) => void;
    onModelNameChange: (value: string) => void;
    /** 是否显示服务商预设行（设置页用；向导第一步也可以开） */
    showPresets?: boolean;
    /** 基础 URL 下方的补充说明（如向导里的 DeepSeek 提示） */
    baseUrlHint?: ReactNode;
    modelPlaceholder?: string;
}

/**
 * LLM 服务商配置表单：设置页「通用」页签与首启向导共用，
 * 消除两处重复（Key / Base URL / 模型名 + 预设一键填充）。
 */
export default function ApiConfigForm({
    apiKey,
    baseUrl,
    modelName,
    onApiKeyChange,
    onBaseUrlChange,
    onModelNameChange,
    showPresets = false,
    baseUrlHint,
    modelPlaceholder = "gpt-3.5-turbo",
}: ApiConfigFormProps) {
    // 从当前填写值反推命中的预设（值被手改过就自动落到「自定义」）
    const activePreset = matchPreset(baseUrl, modelName);
    const activePresetNote = PROVIDER_PRESETS.find((p) => p.id === activePreset)?.note;

    return (
        <>
            {showPresets && (
                <div className="space-y-2">
                    <label className="block pl-1 text-[10px] font-bold uppercase tracking-widest text-content-muted">
                        服务商
                    </label>
                    <SegmentedControl
                        options={[
                            ...PROVIDER_PRESETS.map((p) => ({ value: p.id, label: p.label })),
                            { value: "custom", label: "自定义", disabled: true },
                        ]}
                        value={activePreset}
                        onChange={(id) => {
                            const preset = PROVIDER_PRESETS.find((p) => p.id === id);
                            if (preset) {
                                onBaseUrlChange(preset.baseUrl);
                                onModelNameChange(preset.modelName);
                            }
                        }}
                    />
                    {activePresetNote && (
                        <p className="pl-1 text-[10px] leading-relaxed text-status-warning">
                            ⚠️ {activePresetNote}
                        </p>
                    )}
                </div>
            )}

            <Field label="API 密钥">
                <Input
                    type="password"
                    value={apiKey}
                    onChange={(e) => onApiKeyChange(e.target.value)}
                    placeholder="sk-..."
                />
            </Field>

            <Field label="基础 URL" hint={baseUrlHint}>
                <Input
                    type="text"
                    value={baseUrl}
                    onChange={(e) => onBaseUrlChange(e.target.value)}
                    placeholder="https://api.openai.com/v1"
                />
            </Field>

            <Field label="模型名称">
                <Input
                    type="text"
                    value={modelName}
                    onChange={(e) => onModelNameChange(e.target.value)}
                    placeholder={modelPlaceholder}
                />
            </Field>
        </>
    );
}
