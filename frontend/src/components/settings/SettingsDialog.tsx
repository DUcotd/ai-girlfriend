"use client";

import { useState, useEffect } from "react";
import { Settings, MessageSquare, Mic, Brain, ShieldAlert, Bell } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import Button from "../ui/Button";
import ConfirmDialog from "../ui/ConfirmDialog";
import Dialog from "../ui/Dialog";
import { useToast } from "../ui/Toast";
import { api } from "@/lib/api";
import { get, remove, set } from "@/lib/storage";
import { DEFAULT_PROVIDER } from "@/lib/providers";
import { useSettingsStore } from "@/stores/settingsStore";
import { cn } from "@/lib/cn";
import type { ProactiveTypeInfo, TtsEngine } from "@/types";
import SettingsAdvancedTab from "./tabs/SettingsAdvancedTab";
import SettingsGeneralTab from "./tabs/SettingsGeneralTab";
import SettingsMemoryTab from "./tabs/SettingsMemoryTab";
import SettingsProactiveTab from "./tabs/SettingsProactiveTab";
import SettingsVoiceTab from "./tabs/SettingsVoiceTab";

interface SettingsDialogProps {
    onClose: () => void;
}

type SettingsTab = "general" | "voice" | "memory" | "proactive" | "advanced";

const tabs: { id: SettingsTab; label: string; icon: LucideIcon }[] = [
    { id: "general", label: "通用", icon: MessageSquare },
    { id: "voice", label: "语音", icon: Mic },
    { id: "memory", label: "记忆", icon: Brain },
    { id: "proactive", label: "主动", icon: Bell },
    { id: "advanced", label: "系统", icon: ShieldAlert },
];

/**
 * 设置弹窗外壳：持有全部配置状态与保存/重置逻辑，
 * 五个页签的展示拆分在 ./tabs/ 下。
 */
export default function SettingsDialog({ onClose }: SettingsDialogProps) {
    // 初始值直接从 localStorage 惰性读取（storage 层已做 SSR 保护）
    const [apiKey, setApiKey] = useState(() => get("apiKey") || "");
    const [baseUrl, setBaseUrl] = useState(() => get("baseUrl") || DEFAULT_PROVIDER.baseUrl);
    const [modelName, setModelName] = useState(() => get("modelName") || DEFAULT_PROVIDER.modelName);
    const [ttsApiKey, setTtsApiKey] = useState(() => get("ttsApiKey") || "");
    const [ttsEngine, setTtsEngine] = useState<TtsEngine>(() => (get("ttsEngine") as TtsEngine) || "openai");
    const [embApiKey, setEmbApiKey] = useState(() => get("embApiKey") || "");
    const [embBaseUrl, setEmbBaseUrl] = useState(() => get("embBaseUrl") || "https://api.siliconflow.cn/v1");
    const [embModelName, setEmbModelName] = useState(() => get("embModelName") || "BAAI/bge-large-zh-v1.5");
    const [activeTab, setActiveTab] = useState<SettingsTab>("general");
    const [isLoading, setIsLoading] = useState(false);
    const [showResetConfirm, setShowResetConfirm] = useState(false);

    // 主动消息配置
    const [proactiveEnabled, setProactiveEnabled] = useState(
        () => get("proactiveEnabled") !== "false"
    );
    const [frequencyLevel, setFrequencyLevel] = useState<"low" | "medium" | "high">(
        () => (get("frequencyLevel") as "low" | "medium" | "high") || "medium"
    );
    const [customDailyLimit, setCustomDailyLimit] = useState<number | null>(() => {
        const saved = get("customDailyLimit");
        if (!saved || saved === "null") return null;
        return Number.parseInt(saved, 10);
    });
    const [enabledTypes, setEnabledTypes] = useState<string[]>(() => {
        const saved = get("enabledTypes");
        return saved
            ? JSON.parse(saved)
            : ['morning_greeting', 'night_greeting', 'task_reminder',
               'random_chat', 'miss_you', 'mood_check', 'memory_share'];
    });
    const [availableTypes, setAvailableTypes] = useState<ProactiveTypeInfo[]>([]);

    const showToast = useToast();

    // 挂载后用服务端配置覆盖本地值。
    // setState 放在异步回调里，避免 effect 同步体内 setState 造成级联渲染。
    useEffect(() => {
        let cancelled = false;
        api.getProactiveConfig()
            .then((data) => {
                if (cancelled) return;
                if (data.config) {
                    setProactiveEnabled(data.config.enabled);
                    setFrequencyLevel(data.config.frequencyLevel);
                    setCustomDailyLimit(data.config.customDailyLimit);
                    setEnabledTypes(data.config.enabledTypes || []);
                }
                if (data.availableTypes) {
                    setAvailableTypes(data.availableTypes);
                }
            })
            .catch((e) => {
                if (!cancelled) console.error("Failed to fetch proactive config:", e);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const handleSave = async () => {
        setIsLoading(true);
        // 保存到本地
        set("apiKey", apiKey);
        set("baseUrl", baseUrl);
        set("modelName", modelName);
        set("ttsApiKey", ttsApiKey);
        set("ttsEngine", ttsEngine);
        set("embApiKey", embApiKey);
        set("embBaseUrl", embBaseUrl);
        set("embModelName", embModelName);

        // 保存主动消息配置到本地
        set("proactiveEnabled", proactiveEnabled.toString());
        set("frequencyLevel", frequencyLevel);
        set("customDailyLimit", customDailyLimit === null ? 'null' : customDailyLimit.toString());
        set("enabledTypes", JSON.stringify(enabledTypes));

        try {
            // 同步到后端
            await api.updateConfig({
                api_key: apiKey,
                base_url: baseUrl,
                model_name: modelName,
                tts_api_key: ttsApiKey || undefined,
                embedding_api_key: embApiKey || undefined,
                embedding_base_url: embBaseUrl || undefined,
                embedding_model_name: embModelName || undefined,
            });

            await api.updateProactiveConfig({
                enabled: proactiveEnabled,
                frequencyLevel,
                customDailyLimit,
                enabledTypes,
            });

            // 通知运行时（useSpeech 等订阅方）引擎已切换
            useSettingsStore.getState().setTtsEngine(ttsEngine);

            showToast("设置已保存并同步! ✨", "success");
            onClose();
        } catch {
            showToast("保存失败，请检查后端连接", "error");
        } finally {
            setIsLoading(false);
        }
    };

    const handleResetAll = async () => {
        try {
            await api.clearHistory();
            remove("affinity");
            showToast("小爱已完全重置！", "success");
            setTimeout(() => window.location.reload(), 1000);
        } catch {
            showToast("重置失败", "error");
        }
        setShowResetConfirm(false);
    };

    return (
        <>
            <Dialog
                title="系统设置"
                icon={<Settings size={22} className="animate-spin-slow" />}
                onClose={onClose}
                widthClassName="w-[520px]"
                className="overflow-hidden"
                bodyClassName="flex p-0"
                footer={
                    <div className="flex justify-end">
                        <Button
                            onClick={handleSave}
                            disabled={isLoading}
                            className="min-w-[120px] px-8 py-2.5"
                        >
                            {isLoading ? "保存中..." : "保存全部配置"}
                        </Button>
                    </div>
                }
            >
                {/* Sidebar Tabs */}
                <div className="flex w-32 flex-col gap-2 border-r border-line-subtle bg-surface-2/30 p-3">
                    {tabs.map((tab) => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={cn(
                                "flex flex-col items-center justify-center gap-1.5 rounded-2xl py-3 transition-all",
                                activeTab === tab.id
                                    ? "border border-line-subtle bg-surface-1 text-accent-strong shadow-sm dark:text-accent-1"
                                    : "text-content-muted hover:bg-surface-1/50 hover:text-accent-1"
                            )}
                        >
                            <tab.icon size={20} />
                            <span className="text-[10px] font-bold uppercase tracking-wider">{tab.label}</span>
                        </button>
                    ))}
                </div>

                {/* Content Area */}
                <div className="h-[420px] flex-1 overflow-y-auto p-6">
                    <AnimatePresence mode="wait">
                        <motion.div
                            key={activeTab}
                            initial={{ opacity: 0, x: 10 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -10 }}
                            transition={{ duration: 0.2 }}
                            className="space-y-5"
                        >
                            {activeTab === "general" && (
                                <SettingsGeneralTab
                                    apiKey={apiKey}
                                    baseUrl={baseUrl}
                                    modelName={modelName}
                                    onApiKeyChange={setApiKey}
                                    onBaseUrlChange={setBaseUrl}
                                    onModelNameChange={setModelName}
                                />
                            )}

                            {activeTab === "voice" && (
                                <SettingsVoiceTab
                                    ttsEngine={ttsEngine}
                                    ttsApiKey={ttsApiKey}
                                    onTtsEngineChange={setTtsEngine}
                                    onTtsApiKeyChange={setTtsApiKey}
                                />
                            )}

                            {activeTab === "memory" && (
                                <SettingsMemoryTab
                                    embApiKey={embApiKey}
                                    embBaseUrl={embBaseUrl}
                                    embModelName={embModelName}
                                    onEmbApiKeyChange={setEmbApiKey}
                                    onEmbBaseUrlChange={setEmbBaseUrl}
                                    onEmbModelNameChange={setEmbModelName}
                                />
                            )}

                            {activeTab === "proactive" && (
                                <SettingsProactiveTab
                                    enabled={proactiveEnabled}
                                    onToggleEnabled={setProactiveEnabled}
                                    frequencyLevel={frequencyLevel}
                                    onFrequencyChange={setFrequencyLevel}
                                    customDailyLimit={customDailyLimit}
                                    onCustomDailyLimitChange={setCustomDailyLimit}
                                    enabledTypes={enabledTypes}
                                    onEnabledTypesChange={setEnabledTypes}
                                    availableTypes={availableTypes}
                                />
                            )}

                            {activeTab === "advanced" && (
                                <SettingsAdvancedTab onReset={() => setShowResetConfirm(true)} />
                            )}
                        </motion.div>
                    </AnimatePresence>
                </div>
            </Dialog>

            {/* 确认对话框 */}
            <ConfirmDialog
                isOpen={showResetConfirm}
                title="完全重置小爱"
                message="确定要完全重置小爱吗？\n这将清除所有聊天记录、记忆和好感度！\n此操作无法撤销！"
                confirmText="确认重置"
                cancelText="取消"
                type="danger"
                onConfirm={handleResetAll}
                onCancel={() => setShowResetConfirm(false)}
            />
        </>
    );
}
