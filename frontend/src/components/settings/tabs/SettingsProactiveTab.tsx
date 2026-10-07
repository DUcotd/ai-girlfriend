"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import Note from "@/components/ui/Note";
import SegmentedControl from "@/components/ui/SegmentedControl";
import Switch from "@/components/ui/Switch";
import ProactiveStatusStrip from "@/components/settings/proactive/ProactiveStatusStrip";
import TypeToggleCard from "@/components/settings/proactive/TypeToggleCard";
import { cn } from "@/lib/cn";
import type { NotifyPrivacy } from "@/lib/notifyPrivacy";
import type { ProactiveGroupInfo, ProactiveTypeInfo } from "@/types";

interface SettingsProactiveTabProps {
    enabled: boolean;
    onToggleEnabled: (value: boolean) => void;
    frequencyLevel: "low" | "medium" | "high";
    onFrequencyChange: (level: "low" | "medium" | "high") => void;
    customDailyLimit: number | null;
    onCustomDailyLimitChange: (value: number | null) => void;
    enabledTypes: string[];
    onEnabledTypesChange: (types: string[]) => void;
    availableTypes: ProactiveTypeInfo[];
    /** 后端下发的分组定义（缺失时退化成单组） */
    availableGroups?: ProactiveGroupInfo[];
    /** 桌面通知是否显示正文（FE-15，纯浏览器偏好，改动即时生效、不进「保存全部配置」） */
    notifyPrivacy: NotifyPrivacy;
    onNotifyPrivacyChange: (value: NotifyPrivacy) => void;
    /** 主动消息是否朗读（可与打字回复的朗读分开关） */
    speakProactive: boolean;
    onSpeakProactiveChange: (value: boolean) => void;
}

/** 频率档位的「量化」说明：把冷却与上限的倍率直接摆出来，别只给形容词 */
const FREQUENCY_INFO = {
    low: {
        label: "🐢 低频",
        name: "安静模式",
        desc: "冷却时间 ×2、每日上限 ×0.5 —— 只在真的很想你的时候才出现",
    },
    medium: {
        label: "🐰 中频",
        name: "平衡模式",
        desc: "冷却时间 ×1、每日上限 ×1 —— 适度互动（默认推荐）",
    },
    high: {
        label: "🚀 高频",
        name: "活跃模式",
        desc: "冷却时间 ×0.7、每日上限 ×1.5 —— 适合想要陪伴的时刻",
    },
} as const;

const CUSTOM_LIMIT_DEFAULT = 8;

/**
 * 设置 → 主动消息页签。
 *
 * 结构：总开关 → 运行状态（实时）→ [频率 · 每日上限 · 消息类型] → 说明。
 * 展示状态由 SettingsDialog 持有，页签本身无状态（除了子组件的自取状态）。
 */
export default function SettingsProactiveTab({
    enabled,
    onToggleEnabled,
    frequencyLevel,
    onFrequencyChange,
    customDailyLimit,
    onCustomDailyLimitChange,
    enabledTypes,
    onEnabledTypesChange,
    availableTypes,
    availableGroups = [],
    notifyPrivacy,
    onNotifyPrivacyChange,
    speakProactive,
    onSpeakProactiveChange,
}: SettingsProactiveTabProps) {
    /** 按分组归拢类型（分组顺序以后端下发为准，未知分组排在最后） */
    const groupedTypes = useMemo(() => {
        const groupOrder = availableGroups.map((g) => g.id);
        const buckets = new Map<string, ProactiveTypeInfo[]>();
        for (const type of availableTypes) {
            const key = type.group || "other";
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key)!.push(type);
        }
        const infoOf = (id: string) =>
            availableGroups.find((g) => g.id === id) ?? { id, label: "其他", description: "" };
        return [...buckets.entries()]
            .map(([id, types]) => ({ ...infoOf(id), types }))
            .sort((a, b) => {
                const ai = groupOrder.indexOf(a.id);
                const bi = groupOrder.indexOf(b.id);
                return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi);
            });
    }, [availableTypes, availableGroups]);

    const toggleType = (id: string, checked: boolean) => {
        onEnabledTypesChange(
            checked ? [...new Set([...enabledTypes, id])] : enabledTypes.filter((t) => t !== id)
        );
    };

    /** 分组批量勾选/取消 */
    const setGroupTypes = (ids: string[], checked: boolean) => {
        const next = new Set(enabledTypes);
        ids.forEach((id) => (checked ? next.add(id) : next.delete(id)));
        onEnabledTypesChange([...next]);
    };

    return (
        <>
            {/* 总开关 */}
            <div className="flex items-center justify-between rounded-2xl border border-line-subtle bg-surface-1/50 p-4">
                <div>
                    <h4 className="text-sm font-bold text-content-primary">启用主动消息</h4>
                    <p className="mt-0.5 text-[10px] text-content-muted">
                        小爱会根据时间和场景主动找你聊天
                    </p>
                </div>
                <Switch checked={enabled} onChange={onToggleEnabled} label="启用主动消息" />
            </div>

            {/* 运行状态：总开关关掉也保留，用户能看到「已暂停」而不是整块消失 */}
            <ProactiveStatusStrip enabled={enabled} />

            {enabled && (
                <motion.div
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="space-y-5"
                >
                    {/* 频率 */}
                    <div className="space-y-2">
                        <label className="block pl-1 text-[10px] font-bold uppercase tracking-widest text-content-muted">
                            消息频率
                        </label>
                        <SegmentedControl
                            options={[
                                { value: "low", label: FREQUENCY_INFO.low.label },
                                { value: "medium", label: FREQUENCY_INFO.medium.label },
                                { value: "high", label: FREQUENCY_INFO.high.label },
                            ]}
                            value={frequencyLevel}
                            onChange={onFrequencyChange}
                        />
                        {/* 说明固定占位：切档位时文字长短不一，不留高度会让下方字段上下跳 */}
                        <p className="min-h-[30px] pl-1 text-[10px] leading-relaxed text-content-muted">
                            <span className="font-bold text-content-secondary">
                                {FREQUENCY_INFO[frequencyLevel].name}
                            </span>
                            ：{FREQUENCY_INFO[frequencyLevel].desc}
                        </p>
                    </div>

                    {/* 每日上限 */}
                    <div className="space-y-2">
                        <label className="block pl-1 text-[10px] font-bold uppercase tracking-widest text-content-muted">
                            每日消息上限
                        </label>
                        <SegmentedControl<"auto" | "custom">
                            options={[
                                { value: "auto", label: "自动（按好感度）" },
                                { value: "custom", label: "自定义" },
                            ]}
                            value={customDailyLimit === null ? "auto" : "custom"}
                            onChange={(next) =>
                                onCustomDailyLimitChange(
                                    next === "auto" ? null : (customDailyLimit ?? CUSTOM_LIMIT_DEFAULT)
                                )
                            }
                        />
                        {/* 两种模式都渲染在同样高度的容器里：条件渲染会让下方整块位移 */}
                        <div className="flex min-h-[36px] items-center">
                            {customDailyLimit === null ? (
                                <p className="text-[10px] leading-5 text-content-muted">
                                    按好感度阶段与频率档位自动计算，实时数值见上方「运行状态」
                                </p>
                            ) : (
                                <div className="flex w-full items-center gap-3">
                                    <input
                                        type="range"
                                        min="1"
                                        max="20"
                                        value={customDailyLimit}
                                        onChange={(e) =>
                                            onCustomDailyLimitChange(parseInt(e.target.value, 10))
                                        }
                                        className="h-1 flex-1 accent-accent-1"
                                        aria-label="每日消息上限"
                                    />
                                    <span className="min-w-[4.5rem] text-right text-sm font-bold text-accent-strong dark:text-accent-1">
                                        {customDailyLimit} 条/天
                                    </span>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* 消息类型 */}
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <label className="pl-1 text-[10px] font-bold uppercase tracking-widest text-content-muted">
                                消息类型
                            </label>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => setGroupTypes(availableTypes.map((t) => t.id), true)}
                                    className="rounded-lg bg-surface-2 px-2 py-1 text-[10px] text-content-muted transition-colors duration-fast hover:text-content-secondary"
                                >
                                    全选
                                </button>
                                <button
                                    type="button"
                                    onClick={() => onEnabledTypesChange([])}
                                    className="rounded-lg bg-surface-2 px-2 py-1 text-[10px] text-content-muted transition-colors duration-fast hover:text-content-secondary"
                                >
                                    清空
                                </button>
                            </div>
                        </div>

                        {availableTypes.length === 0 ? (
                            <div className="rounded-xl border border-dashed border-line-subtle p-4 text-center text-[11px] text-content-muted">
                                正在读取消息类型…若长时间无响应，请确认后端已启动
                            </div>
                        ) : (
                            <div className="space-y-4">
                                {groupedTypes.map((group) => {
                                    const ids = group.types.map((t) => t.id);
                                    const allOn = ids.every((id) => enabledTypes.includes(id));
                                    return (
                                        <div key={group.id} className="space-y-2">
                                            <div className="flex items-baseline justify-between pl-1">
                                                <span className="text-[11px] font-bold text-content-secondary">
                                                    {group.label}
                                                </span>
                                                <button
                                                    type="button"
                                                    onClick={() => setGroupTypes(ids, !allOn)}
                                                    className="text-[10px] text-content-muted transition-colors duration-fast hover:text-accent-1"
                                                >
                                                    {allOn ? "取消本组" : "选择本组"}
                                                </button>
                                            </div>
                                            <div className="grid grid-cols-1 gap-2">
                                                {group.types.map((type) => (
                                                    <TypeToggleCard
                                                        key={type.id}
                                                        type={type}
                                                        checked={enabledTypes.includes(type.id)}
                                                        onToggle={toggleType}
                                                    />
                                                ))}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {/* 常驻占位，避免勾掉最后一个类型时整块内容上下跳 */}
                        <p
                            className={cn(
                                "min-h-[14px] pl-1 text-[10px] transition-opacity duration-normal",
                                enabledTypes.length === 0 ? "text-status-warning opacity-100" : "opacity-0"
                            )}
                        >
                            一个类型都没选，小爱不会主动找你哦
                        </p>
                    </div>
                </motion.div>
            )}

            {/* 隐私与朗读（FE-15）：这两个是浏览器偏好，改了立刻生效，不需要点「保存全部配置」 */}
            <div className="space-y-2 rounded-2xl border border-line-subtle bg-surface-1/50 p-4">
                <h4 className="text-sm font-bold text-content-primary">通知与朗读隐私</h4>
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <p className="text-xs font-bold text-content-secondary">锁屏通知显示正文</p>
                        <p className="mt-0.5 text-[10px] leading-relaxed text-content-muted">
                            关闭时通知只写「小爱给你发来一条消息」，正文要打开页面才看得到；
                            打开后她说的原话会出现在锁屏、通知中心和其他人的预览里。
                        </p>
                    </div>
                    <Switch
                        checked={notifyPrivacy === "preview"}
                        onChange={(checked) => onNotifyPrivacyChange(checked ? "preview" : "hidden")}
                        label="锁屏通知显示正文"
                    />
                </div>
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <p className="text-xs font-bold text-content-secondary">她主动发消息时朗读出来</p>
                        <p className="mt-0.5 text-[10px] leading-relaxed text-content-muted">
                            只影响**主动消息**的语音；打字回复的朗读跟着顶部语音开关走。
                        </p>
                    </div>
                    <Switch
                        checked={speakProactive}
                        onChange={onSpeakProactiveChange}
                        label="主动消息朗读"
                    />
                </div>
            </div>

            <Note tone="accent">
                💝 主动消息让小爱更加主动关心你！她会在合适的时间发送问候、想念消息和情绪关怀。
                深夜 23:30 – 07:00 是免打扰时段，只有定时问候与任务提醒会发出。
            </Note>
        </>
    );
}
