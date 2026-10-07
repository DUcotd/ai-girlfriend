"use client";

import { useState } from "react";
import { AnimatePresence } from "framer-motion";
import { useToast } from "../ui/Toast";
import { api } from "@/lib/api";
import { toApiError } from "@/lib/apiError";
import { set } from "@/lib/storage";
import { DEFAULT_PROVIDER } from "@/lib/providers";
import ApiConfigStep from "./steps/ApiConfigStep";
import CompleteStep from "./steps/CompleteStep";
import WelcomeStep from "./steps/WelcomeStep";

interface FirstRunWizardProps {
    onComplete: () => void;
}

/** 首次运行引导：欢迎 → API 配置 → 完成。步骤展示拆分在 ./steps/ 下。 */
export default function FirstRunWizard({ onComplete }: FirstRunWizardProps) {
    const [step, setStep] = useState(0); // 0: Welcome, 1: API Config, 2: Complete
    const [apiKey, setApiKey] = useState("");
    const [baseUrl, setBaseUrl] = useState(DEFAULT_PROVIDER.baseUrl);
    const [modelName, setModelName] = useState(DEFAULT_PROVIDER.modelName);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState("");
    const showToast = useToast();

    const handleSaveConfig = async () => {
        if (!apiKey.trim()) {
            setError("请填写 API 密钥");
            return;
        }

        setIsLoading(true);
        setError("");

        try {
            // 保存到 localStorage
            set("apiKey", apiKey);
            set("baseUrl", baseUrl);
            set("modelName", modelName);

            // 同步到后端（camelCase → snake_case 由 syncConfig 统一处理）
            const result = await api.syncConfig({ apiKey, baseUrl, modelName });

            // ⚠️ hasCompletedSetup 必须在后端**真的收下配置之后**才写（FE-09）。
            // 旧写法先写完成标记再 fire-and-forget 同步：后端没起来时向导照样宣告完成、
            // 再也不出现，用户接下来发的第一条消息必然报错，而向导已经被关闭了。
            set("hasCompletedSetup", "true");

            const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
            showToast(warnings.length ? `配置已保存，但有 ${warnings.length} 条提醒` : "配置保存成功！", warnings.length ? "info" : "success");
            if (warnings.length) setError(warnings.join("\n"));
            setStep(2);
        } catch (e) {
            // 失败原因照抄后端 detail（没配 Key / 地址被拒 / 后端离线是三件事，
            // 一律写成「检查后端是否已启动」会把用户支去查网络）
            setError(`配置没能同步到后端：${toApiError(e).userMessage}`);
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-gradient-to-br from-[hsl(var(--bg-start))] to-[hsl(var(--bg-end))]">
            {/* 背景装饰 */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
                <div className="absolute left-10 top-10 h-32 w-32 animate-pulse rounded-full bg-accent-1/30 blur-3xl" />
                <div className="absolute bottom-20 right-20 h-40 w-40 animate-pulse rounded-full bg-accent-2/30 blur-3xl delay-700" />
                <div className="absolute left-1/4 top-1/2 h-24 w-24 animate-pulse rounded-full bg-accent-pop/20 blur-2xl delay-300" />
            </div>

            <AnimatePresence mode="wait">
                {step === 0 && <WelcomeStep key="welcome" onNext={() => setStep(1)} />}
                {step === 1 && (
                    <ApiConfigStep
                        key="config"
                        apiKey={apiKey}
                        baseUrl={baseUrl}
                        modelName={modelName}
                        onApiKeyChange={setApiKey}
                        onBaseUrlChange={setBaseUrl}
                        onModelNameChange={setModelName}
                        error={error}
                        isLoading={isLoading}
                        onBack={() => setStep(0)}
                        onSubmit={handleSaveConfig}
                    />
                )}
                {step === 2 && <CompleteStep key="complete" onComplete={onComplete} />}
            </AnimatePresence>
        </div>
    );
}
