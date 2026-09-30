"use client";

import ApiConfigForm from "@/components/ui/ApiConfigForm";
import type { AdvancedChatConfig } from "@/lib/chatParams";

interface SettingsGeneralTabProps {
    apiKey: string;
    baseUrl: string;
    modelName: string;
    onApiKeyChange: (value: string) => void;
    onBaseUrlChange: (value: string) => void;
    onModelNameChange: (value: string) => void;
    /** 高级选项（上下文条数 / 温度 / 最大输出 / 思考强度）当前值 */
    advanced: AdvancedChatConfig;
    /** 高级选项增量变更；状态由 SettingsDialog 持有并统一保存 */
    onAdvancedChange: (patch: Partial<AdvancedChatConfig>) => void;
}

/**
 * 设置 → 通用：LLM 服务商配置（预设 + Key/URL/模型）+ 高级选项折叠区。
 *
 * 状态全部由 SettingsDialog 持有（与其余页签一致），这里只做透传，
 * 高级选项的渲染细节在 ApiConfigForm 内（向导复用同一份表单但不展开高级区）。
 */
export default function SettingsGeneralTab(props: SettingsGeneralTabProps) {
    return <ApiConfigForm {...props} showPresets showAdvanced />;
}
