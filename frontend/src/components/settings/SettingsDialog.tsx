"use client";

import { useState, useEffect } from "react";
import { Settings, MessageSquare, Mic, Brain, Palette, ShieldAlert, Bell } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import Button from "../ui/Button";
import ConfirmDialog from "../ui/ConfirmDialog";
import Dialog from "../ui/Dialog";
import { useToast } from "../ui/Toast";
import { api } from "@/lib/api";
import { get, getAdvancedChatConfig, remove, set, setAdvancedChatConfig } from "@/lib/storage";
import { DEFAULT_PROVIDER } from "@/lib/providers";
import { getMemoryConfig } from "@/lib/storage";
import { normalizeAdvancedConfig } from "@/lib/chatParams";
import type { AdvancedChatConfig } from "@/lib/chatParams";
import { useSettingsStore } from "@/stores/settingsStore";
import { usePersonality } from "@/hooks/usePersonality";
import { cn } from "@/lib/cn";
import type { ProactiveGroupInfo, ProactiveTypeInfo, TtsEngine } from "@/types";
import type { MemoryRetrievalMode } from "./tabs/SettingsMemoryTab";
import SettingsAdvancedTab from "./tabs/SettingsAdvancedTab";
import SettingsGeneralTab from "./tabs/SettingsGeneralTab";
import SettingsMemoryTab from "./tabs/SettingsMemoryTab";
import SettingsPersonalityTab from "./tabs/SettingsPersonalityTab";
import SettingsProactiveTab from "./tabs/SettingsProactiveTab";
import SettingsVoiceTab from "./tabs/SettingsVoiceTab";

interface SettingsDialogProps {
    onClose: () => void;
}

type SettingsTab = "general" | "voice" | "memory" | "personality" | "proactive" | "advanced";

const tabs: { id: SettingsTab; label: string; icon: LucideIcon }[] = [
    { id: "general", label: "通用", icon: MessageSquare },
    { id: "voice", label: "语音", icon: Mic },
    { id: "memory", label: "记忆", icon: Brain },
    { id: "personality", label: "性格", icon: Palette },
    { id: "proactive", label: "主动", icon: Bell },
    { id: "advanced", label: "系统", icon: ShieldAlert },
];

/**
 * 设置弹窗外壳：持有全部配置状态与保存/重置逻辑，
 * 六个页签的展示拆分在 ./tabs/ 下。
 */
export default function SettingsDialog({ onClose }: SettingsDialogProps) {
    // 初始值直接从 localStorage 惰性读取（storage 层已做 SSR 保护）
    const [apiKey, setApiKey] = useState(() => get("apiKey") || "");
    const [baseUrl, setBaseUrl] = useState(() => get("baseUrl") || DEFAULT_PROVIDER.baseUrl);
    const [modelName, setModelName] = useState(() => get("modelName") || DEFAULT_PROVIDER.modelName);
    // 语音配置独立于主 Key：引擎默认「浏览器本地」，云端只在用户显式选择并配置了
    // 专属 TTS Key 后才启用（未配置时云端语音不可用，运行时自动回退本地）
    const [ttsApiKey, setTtsApiKey] = useState(() => get("ttsApiKey") || "");
    const [ttsEngine, setTtsEngine] = useState<TtsEngine>(() => (get("ttsEngine") as TtsEngine) || "local");
    // 嵌入配置不预填任何默认值：只在用户真的要用语义检索时才展开填写（留空 = 用主 Key/默认模型）
    const [embApiKey, setEmbApiKey] = useState(() => get("embApiKey") || "");
    const [embBaseUrl, setEmbBaseUrl] = useState(() => get("embBaseUrl") || "");
    const [embModelName, setEmbModelName] = useState(() => get("embModelName") || "");
    // 记忆设置：事实提取开关 + 检索模式（storage 读取已归一化，这里拿到的就是合法值）
    const [memoryFactsEnabled, setMemoryFactsEnabled] = useState(() => getMemoryConfig().memoryFactsEnabled);
    const [memoryRetrievalMode, setMemoryRetrievalMode] = useState<MemoryRetrievalMode>(
        () => getMemoryConfig().memoryRetrievalMode
    );
    // 高级选项四项（storage 读取时已钳制/补默认，这里拿到的就是合法值）
    const [advanced, setAdvanced] = useState<AdvancedChatConfig>(getAdvancedChatConfig);
    const [activeTab, setActiveTab] = useState<SettingsTab>("general");
    const [isLoading, setIsLoading] = useState(false);
    const [showResetConfirm, setShowResetConfirm] = useState(false);
    const [showPersonalityResetConfirm, setShowPersonalityResetConfirm] = useState(false);

    // 性格状态与提交（即时提交，不走「保存全部配置」）；
    // 挂在弹窗层级，性格页签只做展示，「恢复默认预设」确认框才能渲染为 Dialog 的兄弟节点。
    const personality = usePersonality();

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
        if (saved) {
            // 脏值/跨版本残留会让裸 JSON.parse 抛异常、整个设置弹窗渲染崩溃；
            // 解析结果还必须是字符串数组才算合法
            try {
                const parsed: unknown = JSON.parse(saved);
                if (Array.isArray(parsed) && parsed.every((t) => typeof t === "string")) {
                    return parsed as string[];
                }
            } catch {
                // fall through to default
            }
        }
        // 与 backend/src/core/proactiveTypes.js 的 defaultEnabled 保持镜像；
        // 挂载后会被服务端下发的列表覆盖，这里只是后端不可用时的兜底。
        return ['morning_greeting', 'night_greeting', 'task_reminder',
                'random_chat', 'miss_you', 'mood_check', 'memory_share', 'life_update'];
    });
    const [availableTypes, setAvailableTypes] = useState<ProactiveTypeInfo[]>([]);
    const [availableGroups, setAvailableGroups] = useState<ProactiveGroupInfo[]>([]);

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
                if (data.groups) {
                    setAvailableGroups(data.groups);
                }
            })
            .catch((e) => {
                if (!cancelled) console.error("Failed to fetch proactive config:", e);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    /** 高级选项增量变更（页签只上报改动的字段） */
    const patchAdvanced = (patch: Partial<AdvancedChatConfig>) => {
        setAdvanced((prev) => ({ ...prev, ...patch }));
    };

    const handleSave = async () => {
        setIsLoading(true);
        // 保存前再钳一次：输入框失焦已钳过，这里是防「改完直接点保存」的漏网值
        const safeAdvanced = normalizeAdvancedConfig(advanced);

        // 保存到本地
        setAdvancedChatConfig(safeAdvanced);
        set("apiKey", apiKey);
        set("baseUrl", baseUrl);
        set("modelName", modelName);
        set("ttsApiKey", ttsApiKey);
        set("ttsEngine", ttsEngine);
        set("embApiKey", embApiKey);
        set("embBaseUrl", embBaseUrl);
        set("embModelName", embModelName);

        // 保存记忆设置到本地
        set("memoryFactsEnabled", memoryFactsEnabled.toString());
        set("memoryRetrievalMode", memoryRetrievalMode);

        // 保存主动消息配置到本地
        set("proactiveEnabled", proactiveEnabled.toString());
        set("frequencyLevel", frequencyLevel);
        set("customDailyLimit", customDailyLimit === null ? 'null' : customDailyLimit.toString());
        set("enabledTypes", JSON.stringify(enabledTypes));

        try {
            // 同步到后端（camelCase → snake_case 由 syncConfig 统一处理）
            await api.syncConfig({
                apiKey,
                baseUrl,
                modelName,
                ttsApiKey,
                embApiKey,
                embBaseUrl,
                embModelName,
                memoryFactsEnabled,
                memoryRetrievalMode,
                ...safeAdvanced,
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

    /** 性格「恢复默认预设」确认后的执行体（清账本 + 恢复 gentle，不动好感度/记忆/对话） */
    const handlePersonalityReset = async () => {
        const ok = await personality.reset();
        setShowPersonalityResetConfirm(false);
        if (ok) showToast("已恢复默认预设 🌸", "success");
    };

    const handleResetAll = async () => {
        try {
            // 走 /reset（完全重置语义）：清对话 + 记忆 + 好感度 + 性格 + 情绪 + 任务。
            // 注意不要用 clearHistory——那只是「新对话」，不会动记忆与好感度。
            const result = await api.resetAll();
            remove("affinity");
            if (result.status === "partial") {
                // 后端有引擎重置失败：如实列出是哪几项，但仍刷新以反映已重置的部分
                const names = result.failed.map((f) => f.step).join("、");
                showToast(`已重置 ${result.reset.length} 项，但 ${names} 未成功，请重试`, "error");
            } else {
                showToast("小爱已完全重置！", "success");
            }
            setShowResetConfirm(false);
            // 无论成功/部分成功都整页刷新，避免 Zustand 内存态残留
            setTimeout(() => window.location.reload(), 1000);
        } catch {
            // 请求本身失败（后端未启动/超时）：保持确认框可重试，不刷新
            showToast("重置失败，请检查后端连接后重试", "error");
        }
    };

    return (
        <>
            <Dialog
                title="系统设置"
                icon={<Settings size={22} className="animate-spin-slow" />}
                onClose={onClose}
                widthClassName="w-[520px]"
                className="overflow-hidden"
                bodyClassName="flex flex-col p-0 md:flex-row"
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
                {/* 6 个竖排按钮必须装进 h-[420px]：py-2 + gap-1.5（原 5 Tab 用的 py-3 + gap-2
                    会溢出约 28px，最后一个按钮被裁切） */}
                {/* 窄屏（<md）改为顶部横排、可横向滑动；md 起恢复左侧纵排 */}
                <div className="flex w-full shrink-0 flex-row gap-1.5 overflow-x-auto border-b border-line-subtle bg-surface-2/30 p-3 md:w-32 md:flex-col md:border-b-0 md:border-r">
                    {tabs.map((tab) => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={cn(
                                // border 常驻（未激活用 transparent），避免激活态增删边框改变高度，
                                // 点击切换时下方按钮会整体位移（UI 抽动）
                                "flex flex-row items-center gap-2 rounded-2xl border px-3 py-2 md:flex-col md:justify-center md:gap-1.5 md:px-0",
                                "transition-colors duration-fast ease-out-expo",
                                activeTab === tab.id
                                    ? "border-line-subtle bg-surface-1 text-accent-strong shadow-sm dark:text-accent-1"
                                    : "border-transparent text-content-muted hover:bg-surface-1/50 hover:text-accent-1"
                            )}
                        >
                            <tab.icon size={20} />
                            <span className="whitespace-nowrap text-[10px] font-bold uppercase tracking-wider">{tab.label}</span>
                        </button>
                    ))}
                </div>

                {/* Content Area */}
                {/* scrollbar-gutter: stable 让滚动条槽位常驻：各页签内容高度不同，
                    否则滚动条来回出现/消失会让内容区宽度跳变 8px */}
                {/* overflow-x-hidden 兜住页签切换动画的 x 位移，避免水平滚动条闪现 */}
                {/* 窄屏用 60vh：标签行占掉一行后，420px 固定高会顶着 max-h-90vh 让 body 出现整卷滚动 */}
                <div className="h-[60vh] flex-1 overflow-y-auto overflow-x-hidden p-6 [scrollbar-gutter:stable] md:h-[420px]">
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
                                    advanced={advanced}
                                    onAdvancedChange={patchAdvanced}
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
                                    memoryFactsEnabled={memoryFactsEnabled}
                                    onMemoryFactsEnabledChange={setMemoryFactsEnabled}
                                    memoryRetrievalMode={memoryRetrievalMode}
                                    onMemoryRetrievalModeChange={setMemoryRetrievalMode}
                                />
                            )}

                            {activeTab === "personality" && (
                                <SettingsPersonalityTab
                                    personality={personality}
                                    onRequestReset={() => setShowPersonalityResetConfirm(true)}
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
                                    availableGroups={availableGroups}
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
                message={
                    "确定要完全重置小爱吗？这将清空：\n" +
                    "· 好感度（回到初始档位）\n" +
                    "· 性格（回到「温柔」默认档）\n" +
                    "· 情绪状态（回到初始心情）\n" +
                    "· 全部任务与提醒\n" +
                    "· 全部长期记忆\n" +
                    "· 全部对话记录\n\n" +
                    "此操作不可恢复！\n" +
                    "（若只想清掉对话画面、保留好感度与记忆，请用顶部工具栏的「新对话」。）"
                }
                confirmText="确认重置"
                cancelText="取消"
                type="danger"
                onConfirm={handleResetAll}
                onCancel={() => setShowResetConfirm(false)}
            />

            {/* 性格「恢复默认预设」确认框：必须渲染为 Dialog 的兄弟节点——
                Modal 的 transform 会让子级 fixed 相对弹窗定位，嵌套会错位 */}
            <ConfirmDialog
                isOpen={showPersonalityResetConfirm}
                title="恢复默认预设"
                message={
                    "将把小爱的性格恢复为「温柔」默认档，并清空全部性格变化记录。\n" +
                    "好感度、记忆与对话记录不受影响。"
                }
                confirmText="确认恢复"
                cancelText="取消"
                type="danger"
                onConfirm={handlePersonalityReset}
                onCancel={() => setShowPersonalityResetConfirm(false)}
            />
        </>
    );
}
