"use client";

import ApiConfigForm from "@/components/ui/ApiConfigForm";

interface SettingsGeneralTabProps {
    apiKey: string;
    baseUrl: string;
    modelName: string;
    onApiKeyChange: (value: string) => void;
    onBaseUrlChange: (value: string) => void;
    onModelNameChange: (value: string) => void;
}

/** 设置 → 通用：LLM 服务商配置（预设 + Key/URL/模型）。 */
export default function SettingsGeneralTab(props: SettingsGeneralTabProps) {
    return <ApiConfigForm {...props} showPresets />;
}
