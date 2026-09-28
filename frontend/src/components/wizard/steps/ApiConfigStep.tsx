"use client";

import { motion } from "framer-motion";
import { Settings } from "lucide-react";
import ApiConfigForm from "@/components/ui/ApiConfigForm";
import Button from "@/components/ui/Button";
import Note from "@/components/ui/Note";

interface ApiConfigStepProps {
    apiKey: string;
    baseUrl: string;
    modelName: string;
    onApiKeyChange: (value: string) => void;
    onBaseUrlChange: (value: string) => void;
    onModelNameChange: (value: string) => void;
    error: string;
    isLoading: boolean;
    onBack: () => void;
    onSubmit: () => void;
}

/** 首启向导 · 第 1 步：API 配置（表单与设置页通用页签共用 ApiConfigForm）。 */
export default function ApiConfigStep({
    apiKey,
    baseUrl,
    modelName,
    onApiKeyChange,
    onBaseUrlChange,
    onModelNameChange,
    error,
    isLoading,
    onBack,
    onSubmit,
}: ApiConfigStepProps) {
    return (
        <motion.div
            key="config"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="relative mx-4 max-w-md rounded-3xl border border-accent-1/20 bg-surface-1/85 p-8 shadow-modal backdrop-blur-xl"
        >
            <div className="mb-6 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-accent-1 to-accent-2">
                    <Settings className="h-5 w-5 text-white" />
                </div>
                <div>
                    <h2 className="text-xl font-bold text-content-primary">API 配置</h2>
                    <p className="text-xs text-content-muted">配置 AI 服务才能和小爱聊天</p>
                </div>
            </div>

            <div className="space-y-4">
                <ApiConfigForm
                    apiKey={apiKey}
                    baseUrl={baseUrl}
                    modelName={modelName}
                    onApiKeyChange={onApiKeyChange}
                    onBaseUrlChange={onBaseUrlChange}
                    onModelNameChange={onModelNameChange}
                    showPresets
                    baseUrlHint="使用 DeepSeek? 填写 https://api.deepseek.com"
                    modelPlaceholder="gpt-3.5-turbo / deepseek-chat"
                />

                {error && (
                    <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
                        <Note tone="danger" className="p-3 text-sm">
                            {error}
                        </Note>
                    </motion.div>
                )}

                <Note tone="info" className="p-3">
                    💡 <strong>提示</strong>：API 密钥仅保存在本地浏览器中，不会上传到任何服务器。
                    你可以在设置中随时修改这些配置。
                </Note>
            </div>

            <div className="mt-6 flex gap-3">
                <Button
                    variant="secondary"
                    onClick={onBack}
                    className="flex-1 rounded-xl py-3 px-4"
                >
                    返回
                </Button>
                <Button
                    onClick={onSubmit}
                    disabled={isLoading}
                    className="flex flex-1 items-center justify-center gap-2 rounded-xl py-3 px-4 font-bold"
                >
                    {isLoading ? "保存中..." : "完成配置"}
                </Button>
            </div>
        </motion.div>
    );
}
