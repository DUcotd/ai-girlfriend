"use client";

import { useState, useEffect } from "react";
import { Settings, MessageSquare, Mic, Brain, ShieldAlert, Bell } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useToast } from "./Toast";
import ConfirmDialog from "./ConfirmDialog";
import { api } from "@/lib/api";
import { get, remove, set } from "@/lib/storage";
import type { ProactiveTypeInfo, TtsEngine } from "@/types";
import SettingsProactiveTab from "./settings/SettingsProactiveTab";

interface SettingsDialogProps {
    onClose: () => void;
    onConfigChange?: (config: { ttsEngine: TtsEngine }) => void;
}

type SettingsTab = "general" | "voice" | "memory" | "proactive" | "advanced";

export default function SettingsDialog({ onClose, onConfigChange }: SettingsDialogProps) {
    // 初始值直接从 localStorage 惰性读取（storage 层已做 SSR 保护）
    const [apiKey, setApiKey] = useState(() => get("apiKey") || "");
    const [baseUrl, setBaseUrl] = useState(() => get("baseUrl") || "https://api.openai.com/v1");
    const [modelName, setModelName] = useState(() => get("modelName") || "gpt-3.5-turbo");
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

    const { showToast, ToastContainer } = useToast();

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

            if (onConfigChange) {
                onConfigChange({ ttsEngine });
            }

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

    const tabs: { id: SettingsTab; label: string; icon: LucideIcon }[] = [
        { id: "general", label: "通用", icon: MessageSquare },
        { id: "voice", label: "语音", icon: Mic },
        { id: "memory", label: "记忆", icon: Brain },
        { id: "proactive", label: "主动", icon: Bell },
        { id: "advanced", label: "系统", icon: ShieldAlert },
    ];

    return (
        <>
            <div className="modal-glass p-0 overflow-hidden w-[520px] max-h-[90vh] flex flex-col shadow-2xl">
                {/* Header */}
                <div className="px-6 py-4 border-b border-pink-100/50 flex justify-between items-center bg-white/40">
                    <h3 className="font-bold text-lg flex items-center gap-2 text-pink-600">
                        <Settings size={22} className="animate-spin-slow" /> 系统设置
                    </h3>
                    <button
                        onClick={onClose}
                        className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-pink-100/50 text-gray-400 hover:text-pink-500 transition-all"
                    >
                        ✕
                    </button>
                </div>

                <div className="flex flex-1 overflow-hidden">
                    {/* Sidebar Tabs */}
                    <div className="w-32 bg-pink-50/30 border-r border-pink-100/50 p-3 flex flex-col gap-2">
                        {tabs.map((tab) => (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className={`flex flex-col items-center justify-center py-3 rounded-2xl transition-all gap-1.5 ${activeTab === tab.id
                                    ? "bg-white text-pink-600 shadow-sm border border-pink-100"
                                    : "text-gray-400 hover:bg-white/50 hover:text-pink-400"
                                    }`}
                            >
                                <tab.icon size={20} />
                                <span className="text-[10px] font-bold uppercase tracking-wider">{tab.label}</span>
                            </button>
                        ))}
                    </div>

                    {/* Content Area */}
                    <div className="flex-1 overflow-y-auto p-6 bg-white/20 custom-scrollbar h-[420px]">
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
                                    <>
                                        <div className="space-y-1">
                                            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest pl-1">API 密钥</label>
                                            <input
                                                type="password"
                                                value={apiKey}
                                                onChange={(e) => setApiKey(e.target.value)}
                                                className="input-cute py-2.5 text-sm bg-white/80"
                                                placeholder="sk-..."
                                            />
                                        </div>
                                        <div className="space-y-1">
                                            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest pl-1">基础 URL</label>
                                            <input
                                                type="text"
                                                value={baseUrl}
                                                onChange={(e) => setBaseUrl(e.target.value)}
                                                className="input-cute py-2.5 text-sm bg-white/80"
                                                placeholder="https://api.openai.com/v1"
                                            />
                                        </div>
                                        <div className="space-y-1">
                                            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest pl-1">模型名称</label>
                                            <input
                                                type="text"
                                                value={modelName}
                                                onChange={(e) => setModelName(e.target.value)}
                                                className="input-cute py-2.5 text-sm bg-white/80"
                                                placeholder="gpt-3.5-turbo"
                                            />
                                        </div>
                                    </>
                                )}

                                {activeTab === "voice" && (
                                    <>
                                        <div className="space-y-2">
                                            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest pl-1">语音引擎</label>
                                            <div className="flex gap-2 p-1 bg-gray-100/50 rounded-2xl border border-gray-100">
                                                <button
                                                    onClick={() => setTtsEngine("openai")}
                                                    className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${ttsEngine === "openai" ? "bg-white text-pink-600 shadow-sm" : "text-gray-400 hover:text-gray-500"
                                                        }`}
                                                >
                                                    OpenAI (云端)
                                                </button>
                                                <button
                                                    onClick={() => setTtsEngine("local")}
                                                    className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${ttsEngine === "local" ? "bg-white text-pink-600 shadow-sm" : "text-gray-400 hover:text-gray-500"
                                                        }`}
                                                >
                                                    浏览器 (本地)
                                                </button>
                                            </div>
                                        </div>
                                        {ttsEngine === "openai" && (
                                            <motion.div
                                                initial={{ opacity: 0, y: 5 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                className="space-y-1"
                                            >
                                                <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest pl-1">
                                                    TTS API 密钥 <span className="text-pink-300 normal-case">(仅支持 OpenAI 官方 Key)</span>
                                                </label>
                                                <input
                                                    type="password"
                                                    value={ttsApiKey}
                                                    onChange={(e) => setTtsApiKey(e.target.value)}
                                                    className="input-cute py-2.5 text-sm bg-white/80"
                                                    placeholder="sk-... (不填则尝试主 Key)"
                                                />
                                            </motion.div>
                                        )}
                                        <div className="p-4 bg-blue-50/50 rounded-2xl border border-blue-100 text-[11px] text-blue-500 leading-relaxed">
                                            💡 提示：本地引擎完全免费且零延迟，但音色取决于你的系统配置；云端引擎音色更自然但需要消耗额度。
                                        </div>
                                    </>
                                )}

                                {activeTab === "memory" && (
                                    <>
                                        <div className="space-y-1">
                                            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest pl-1">嵌入 API 密钥</label>
                                            <input
                                                type="password"
                                                value={embApiKey}
                                                onChange={(e) => setEmbApiKey(e.target.value)}
                                                className="input-cute py-2.5 text-sm bg-white/80"
                                                placeholder="sk-... (留空则使用主 Key)"
                                            />
                                        </div>
                                        <div className="space-y-1">
                                            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest pl-1">嵌入基础 URL</label>
                                            <input
                                                type="text"
                                                value={embBaseUrl}
                                                onChange={(e) => setEmbBaseUrl(e.target.value)}
                                                className="input-cute py-2.5 text-sm bg-white/80"
                                                placeholder="https://api.siliconflow.cn/v1"
                                            />
                                        </div>
                                        <div className="space-y-1">
                                            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest pl-1">嵌入模型名称</label>
                                            <input
                                                type="text"
                                                value={embModelName}
                                                onChange={(e) => setEmbModelName(e.target.value)}
                                                className="input-cute py-2.5 text-sm bg-white/80"
                                            />
                                        </div>
                                        <div className="p-4 bg-pink-50/50 rounded-2xl border border-pink-100 text-[11px] text-pink-500 leading-relaxed">
                                            🧠 记忆引擎让小爱具备语义搜索能力。推荐使用硅基流动等服务，能让小爱更精准地回忆起之前的谈话。
                                        </div>
                                    </>
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
                                    <div className="space-y-6">
                                        <div className="p-4 bg-red-50/30 rounded-2xl border border-red-100 space-y-3">
                                            <h4 className="text-xs font-bold text-red-500 flex items-center gap-1">
                                                <ShieldAlert size={14} /> 危险操作
                                            </h4>
                                            <button
                                                onClick={() => setShowResetConfirm(true)}
                                                className="w-full py-2.5 rounded-xl border border-red-200 text-red-500 text-xs font-bold hover:bg-red-500 hover:text-white transition-all shadow-sm"
                                            >
                                                🔄 完全重置小爱 (不可逆)
                                            </button>
                                            <p className="text-[10px] text-red-400 text-center">
                                                这将清空所有对话历史、向量化存储和角色好感度。
                                            </p>
                                        </div>

                                        <div className="p-4 bg-gray-50/50 rounded-2xl border border-gray-100 space-y-2 text-[11px] text-gray-500 italic">
                                            <p>后端 API 版本: v1.2.0</p>
                                            <p>前端版本: Next.js 15</p>
                                        </div>
                                    </div>
                                )}
                            </motion.div>
                        </AnimatePresence>
                    </div>
                </div>

                {/* Footer */}
                <div className="px-6 py-4 border-t border-pink-100/30 bg-white/40 flex justify-end">
                    <button
                        onClick={handleSave}
                        disabled={isLoading}
                        className="btn-cute px-8 py-2.5 text-sm shadow-pink-200 min-w-[120px]"
                    >
                        {isLoading ? "保存中..." : "保存全部配置"}
                    </button>
                </div>
            </div>

            {/* Toast 通知 */}
            {ToastContainer}

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
