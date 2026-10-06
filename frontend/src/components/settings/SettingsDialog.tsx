"use client";

import { useState, useEffect, useCallback } from "react";
import { Settings, MessageSquare, Mic, Brain, Palette, ShieldAlert, Bell } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import Button from "../ui/Button";
import ConfirmDialog from "../ui/ConfirmDialog";
import Dialog from "../ui/Dialog";
import { useToast } from "../ui/Toast";
import { api } from "@/lib/api";
import { get, getAdvancedChatConfig, getCompanionConfig, remove, set, setAdvancedChatConfig, DEFAULT_ENABLED_PROACTIVE_TYPES } from "@/lib/storage";
import type { CompanionConfig } from "@/lib/storage";
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
import type { LiveConfig } from "@/components/ui/ApiConfigForm";

interface SettingsDialogProps {
    onClose: () => void;
}

type SettingsTab = "general" | "voice" | "memory" | "personality" | "proactive" | "advanced";

/**
 * 把保存失败的原因说清楚。
 *
 * 后端业务 4xx 的 `detail` 已经被 `request()` 放进 Error.message（地址不合规、
 * 未知主动消息类型……），而后端离线时 fetch 抛的是 "Failed to fetch"。
 * 两者必须分开提示 —— 一律写成「请检查后端连接」会指挥用户去查网络，
 * 而真正的问题是他们刚填的那个地址。
 */
function saveFailureMessage(error: unknown): string {
    const raw = error instanceof Error ? error.message.trim() : "";
    if (!raw || /failed to fetch|networkerror|network request failed|load failed/i.test(raw)) {
        return "保存失败：连不上后端（默认 8000 端口），请确认后端已启动后重试";
    }
    return `保存失败：${raw}`;
}

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
    // 陪伴感三子系统开关：本地值先兜底，挂载后用后端真值覆盖（后端现在会持久化它们）
    const [companion, setCompanion] = useState<CompanionConfig>(getCompanionConfig);
    const [activeTab, setActiveTab] = useState<SettingsTab>("general");
    const [isLoading, setIsLoading] = useState(false);
    const [showResetConfirm, setShowResetConfirm] = useState(false);
    const [showPersonalityResetConfirm, setShowPersonalityResetConfirm] = useState(false);
    /**
     * 后端**当前真正生效**的连接配置（`GET /config/status`，只有非敏感字段）。
     * 「表单值」和「生效值」是两回事：后端重启后 Key 没回灌时，界面照样显示上次保存的
     * 地址与模型，聊天却一路报错 —— 这一行就是用来戳破这种自欺的。
     */
    const [liveConfig, setLiveConfig] = useState<LiveConfig | null>(null);
    /** `POST /config` 成功但带回 warnings（未知字段、本机/局域网地址）时留在这里供读完 */
    const [saveWarnings, setSaveWarnings] = useState<string[]>([]);

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
        // 与 backend-node/src/core/proactiveTypes.js 的 defaultEnabled 保持镜像
        // （同一份常量，跨端一致性由 proactiveDefaults.test.ts 钉住）；
        // 挂载后会被服务端下发的列表覆盖，这里只是后端不可用时的兜底。
        return [...DEFAULT_ENABLED_PROACTIVE_TYPES];
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

    /**
     * 把 `GET /config/status` 写进界面状态：陪伴感开关 + 后端当前生效的连接配置。
     * 只读非敏感字段（后端不会回传任何 Key）。
     */
    const applyConfigStatus = useCallback(
        (data: Awaited<ReturnType<typeof api.getConfigStatus>>) => {
            setLiveConfig({
                configured: !!data.isConfigured,
                baseUrl: data.baseUrl ?? null,
                currentModel: data.currentModel ?? null,
            });
            if (data.companion) {
                setCompanion({
                    userEmotionEnabled: !!data.companion.userEmotionEnabled,
                    narrativeEnabled: !!data.companion.narrativeEnabled,
                    triggerEnabled: !!data.companion.triggerEnabled,
                });
            }
        },
        []
    );

    // 陪伴感开关以**后端真值**为准：后端现在会把它们持久化，本地镜像只作离线兜底，
    // 否则会出现「界面显示开着、后端其实早就回弹了」的假象（审计 HTTP-10）。
    useEffect(() => {
        let cancelled = false;
        api.getConfigStatus()
            .then((data) => {
                if (!cancelled) applyConfigStatus(data);
            })
            .catch((e) => {
                if (!cancelled) console.error("Failed to fetch config status:", e);
            });
        return () => {
            cancelled = true;
        };
    }, [applyConfigStatus]);

    /** 高级选项增量变更（页签只上报改动的字段） */
    const patchAdvanced = (patch: Partial<AdvancedChatConfig>) => {
        setAdvanced((prev) => ({ ...prev, ...patch }));
    };

    /** 陪伴感开关增量变更 */
    const patchCompanion = (patch: Partial<CompanionConfig>) => {
        setCompanion((prev) => ({ ...prev, ...patch }));
    };

    const handleSave = async () => {
        setIsLoading(true);
        // 每次保存重新开始收集提醒，否则上一次的警告会一直挂着
        setSaveWarnings([]);
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

        // 陪伴感三开关写本地镜像（真值以后端为准，这里只是离线兜底与下次预填）
        set("userEmotionEnabled", companion.userEmotionEnabled.toString());
        set("narrativeEnabled", companion.narrativeEnabled.toString());
        set("triggerEnabled", companion.triggerEnabled.toString());

        // 保存主动消息配置到本地
        set("proactiveEnabled", proactiveEnabled.toString());
        set("frequencyLevel", frequencyLevel);
        set("customDailyLimit", customDailyLimit === null ? 'null' : customDailyLimit.toString());
        set("enabledTypes", JSON.stringify(enabledTypes));

        try {
            // 同步到后端（camelCase → snake_case 由 syncConfig 统一处理）
            const result = await api.syncConfig({
                apiKey,
                baseUrl,
                modelName,
                ttsApiKey,
                embApiKey,
                embBaseUrl,
                embModelName,
                memoryFactsEnabled,
                memoryRetrievalMode,
                ...companion,
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

            // 保存后立刻用后端真值刷新「当前生效」，让界面说的就是进程里的事实
            try {
                applyConfigStatus(await api.getConfigStatus());
            } catch {
                // 后端在保存之后掉线不该把成功的保存报成失败，保留上次快照即可
            }

            const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
            setSaveWarnings(warnings);
            if (warnings.length) {
                // 「存下了，但没按你以为的方式生效」——弹窗不关，警告留在表单里读完
                showToast(`设置已保存，但有 ${warnings.length} 条提醒需要你确认`, "info");
                return;
            }
            showToast("设置已保存并同步! ✨", "success");
            onClose();
        } catch (error) {
            showToast(saveFailureMessage(error), "error");
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
                                    live={liveConfig}
                                    saveWarnings={saveWarnings}
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
                                <SettingsAdvancedTab
                                    onReset={() => setShowResetConfirm(true)}
                                    companion={companion}
                                    onCompanionChange={patchCompanion}
                                />
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
