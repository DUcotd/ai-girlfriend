"use client";

import Field from "@/components/ui/Field";
import Input from "@/components/ui/Input";
import Note from "@/components/ui/Note";

interface SettingsMemoryTabProps {
    embApiKey: string;
    embBaseUrl: string;
    embModelName: string;
    onEmbApiKeyChange: (value: string) => void;
    onEmbBaseUrlChange: (value: string) => void;
    onEmbModelNameChange: (value: string) => void;
}

/** 设置 → 记忆：embedding 服务配置（语义检索）。 */
export default function SettingsMemoryTab({
    embApiKey,
    embBaseUrl,
    embModelName,
    onEmbApiKeyChange,
    onEmbBaseUrlChange,
    onEmbModelNameChange,
}: SettingsMemoryTabProps) {
    return (
        <>
            <Field label="嵌入 API 密钥">
                <Input
                    type="password"
                    value={embApiKey}
                    onChange={(e) => onEmbApiKeyChange(e.target.value)}
                    placeholder="sk-... (留空则使用主 Key)"
                />
            </Field>

            <Field label="嵌入基础 URL">
                <Input
                    type="text"
                    value={embBaseUrl}
                    onChange={(e) => onEmbBaseUrlChange(e.target.value)}
                    placeholder="https://api.siliconflow.cn/v1"
                />
            </Field>

            <Field label="嵌入模型名称">
                <Input
                    type="text"
                    value={embModelName}
                    onChange={(e) => onEmbModelNameChange(e.target.value)}
                />
            </Field>

            <Note tone="accent">
                🧠 记忆引擎让小爱具备语义搜索能力。推荐使用硅基流动等服务，能让小爱更精准地回忆起之前的谈话。
            </Note>
        </>
    );
}
