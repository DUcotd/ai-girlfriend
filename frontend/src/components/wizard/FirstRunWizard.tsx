"use client";

import { useState } from "react";
import { AnimatePresence } from "framer-motion";
import { useToast } from "../ui/Toast";
import { api } from "@/lib/api";
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
            set("hasCompletedSetup", "true");

            // 同步到后端（camelCase → snake_case 由 syncConfig 统一处理）
            await api.syncConfig({ apiKey, baseUrl, modelName });

            showToast("配置保存成功！", "success");
            setStep(2);
        } catch (e) {
            setError("配置保存失败，请检查后端是否已启动");
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
