"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { PROVIDER_PRESETS, matchPreset } from "@/lib/providers";
import { assessBaseUrl } from "@/lib/baseUrlGrade";
import type { BaseUrlGrade } from "@/lib/baseUrlGrade";
import {
    CHAT_NUMBER_LIMITS,
    DEFAULT_ADVANCED_CONFIG,
    REASONING_EFFORT_OPTIONS,
} from "@/lib/chatParams";
import type { AdvancedChatConfig } from "@/lib/chatParams";
import { cn } from "@/lib/cn";
import Field from "./Field";
import Input from "./Input";
import NumberField from "./NumberField";
import Select from "./Select";
import Switch from "./Switch";

/**
 * 服务商下拉选项：预设 + 自定义。
 * 模块级常量，避免每次渲染重建数组。
 *
 * 「自定义」必须可选（不再 disabled）：手改过 URL/模型名后 matchPreset 会返回 custom，
 * 之前它是个禁用按钮，用户点不动、以为是界面卡了（2026-10 修复）。
 */
const PROVIDER_OPTIONS: readonly { value: string; label: string }[] = [
    ...PROVIDER_PRESETS.map((p) => ({ value: p.id, label: p.label })),
    { value: "custom", label: "自定义" },
];

interface ApiConfigFormProps {
    apiKey: string;
    baseUrl: string;
    modelName: string;
    onApiKeyChange: (value: string) => void;
    onBaseUrlChange: (value: string) => void;
    onModelNameChange: (value: string) => void;
    /** 是否显示服务商预设行（设置页用；向导第一步也可以开） */
    showPresets?: boolean;
    /** 是否显示「高级选项」折叠区（设置页用；首启向导不开，避免吓到新用户） */
    showAdvanced?: boolean;
    /** 高级选项当前值；不传则用默认值渲染（只读展示场景） */
    advanced?: AdvancedChatConfig;
    /** 高级选项变更（增量 patch） */
    onAdvancedChange?: (patch: Partial<AdvancedChatConfig>) => void;
    /** 基础 URL 下方的补充说明（如向导里的 DeepSeek 提示） */
    baseUrlHint?: ReactNode;
    modelPlaceholder?: string;
    /**
     * 后端**当前真正生效**的配置（`GET /config/status`，不含任何 Key）。
     * 只有设置页会传；不传就不渲染「当前生效」那一行。
     */
    live?: LiveConfig | null;
    /**
     * 上一次保存成功后后端回传的 warnings（`POST /config` 响应字段）。
     * 「保存成功但有话要说」时不能只甩一句「已保存」—— 那正是静默失效的温床。
     */
    saveWarnings?: string[];
}

export interface LiveConfig {
    /** 后端进程里是否已经有 API Key（后端重启后未回灌时为 false） */
    configured: boolean;
    baseUrl: string | null;
    currentModel: string | null;
}

/**
 * baseUrl 分级的展示样式。分级规则在 `lib/baseUrlGrade.ts`，与后端
 * `configValidation.classifyBaseUrlHost()` 是同一把尺子（跨端测试逐样本比对）。
 * ok 不占版面：只在 warn / block 时给一行说明。
 */
const GRADE_STYLE: Record<
    Exclude<BaseUrlGrade, "ok">,
    { note: string; input: string; label: string }
> = {
    warn: {
        note: "text-status-warning",
        input: "border-status-warning/60 focus:border-status-warning focus:ring-status-warning/15",
        label: "⚠️",
    },
    block: {
        note: "text-status-danger",
        input: "border-status-danger/60 focus:border-status-danger focus:ring-status-danger/15",
        label: "⛔",
    },
};

/**
 * LLM 服务商配置表单：设置页「通用」页签与首启向导共用，
 * 消除两处重复（Key / Base URL / 模型名 + 预设一键填充）。
 */
export default function ApiConfigForm({
    apiKey,
    baseUrl,
    modelName,
    onApiKeyChange,
    onBaseUrlChange,
    onModelNameChange,
    showPresets = false,
    showAdvanced = false,
    advanced,
    onAdvancedChange,
    baseUrlHint,
    modelPlaceholder = "gpt-3.5-turbo",
    live = null,
    saveWarnings = [],
}: ApiConfigFormProps) {
    const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
    /**
     * 用户手动选了「自定义」后钉住回显，否则下方 URL/模型名没变、matchPreset 仍命中
     * 原预设，下拉框会立刻弹回去——看起来又成了「点了没反应」。
     * 选任一预设或下次打开设置页（重新挂载）时解除。
     */
    const [isCustomPinned, setIsCustomPinned] = useState(false);

    // 从当前填写值反推命中的预设（值被手改过就自动落到「自定义」）
    const activePreset = isCustomPinned ? "custom" : matchPreset(baseUrl, modelName);
    const activePresetNote = PROVIDER_PRESETS.find((p) => p.id === activePreset)?.note;

    const adv = advanced ?? DEFAULT_ADVANCED_CONFIG;
    const patchAdvanced = (patch: Partial<AdvancedChatConfig>) => onAdvancedChange?.(patch);

    /**
     * 地址分级在「输入时就显示」，而不是等保存失败后弹一句「请检查后端连接」：
     * block 与后端的拒绝结论一致，warn 与后端 warnings 的文案逐字一致。
     */
    const assessment = assessBaseUrl(baseUrl);
    const gradeStyle = assessment.grade === "ok" ? null : GRADE_STYLE[assessment.grade];
    /** 后端已生效但表单还没保存的地址（保存前后对得上才算真的生效） */
    const normalizedFormUrl = baseUrl.trim().replace(/\/$/, "");
    const liveUrl = live?.baseUrl?.replace(/\/$/, "") ?? null;
    const liveDiffers = !!liveUrl && liveUrl !== normalizedFormUrl;

    return (
        <>
            {showPresets && (
                <div className="space-y-1">
                    <Field label="服务商">
                        <Select
                            ariaLabel="服务商"
                            options={PROVIDER_OPTIONS}
                            value={activePreset}
                            onChange={(id) => {
                                if (id === "custom") {
                                    // 选「自定义」→ 不覆盖当前值，只把回显钉在「自定义」，
                                    // 表示下方 URL / 模型名可以自由编辑
                                    setIsCustomPinned(true);
                                    return;
                                }
                                // 选预设 → 一键填充对应 baseUrl + modelName，并解除钉住
                                const preset = PROVIDER_PRESETS.find((p) => p.id === id);
                                if (preset) {
                                    setIsCustomPinned(false);
                                    onBaseUrlChange(preset.baseUrl);
                                    onModelNameChange(preset.modelName);
                                }
                            }}
                        />
                    </Field>
                    {/* 警示条条件渲染 + 高度动画：选「自定义」（无 note）时不再留空洞，
                        切换预设时平滑展开/收起而不是整块跳位（取代旧的常驻两行占位） */}
                    <AnimatePresence initial={false}>
                        {activePresetNote && (
                            <motion.div
                                key="preset-note"
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: "auto", opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{ duration: 0.2 }}
                                className="overflow-hidden"
                            >
                                <p className="pl-1 text-[10px] leading-relaxed text-status-warning">
                                    ⚠️ {activePresetNote}
                                </p>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            )}

            <Field label="API 密钥">
                <Input
                    type="password"
                    value={apiKey}
                    onChange={(e) => onApiKeyChange(e.target.value)}
                    placeholder="sk-..."
                />
            </Field>

            <Field label="基础 URL" hint={baseUrlHint}>
                <Input
                    type="text"
                    value={baseUrl}
                    onChange={(e) => onBaseUrlChange(e.target.value)}
                    placeholder="https://api.openai.com/v1"
                    className={gradeStyle?.input}
                />
                {/* 分级说明：warn 用后端的原话，block 表示「这样保存会被拒绝」 */}
                {gradeStyle && assessment.message && (
                    <p className={cn("pl-1 text-[10px] leading-relaxed", gradeStyle.note)}>
                        {gradeStyle.label} {assessment.message}
                    </p>
                )}
                {/* 「当前生效」以后端为准：界面显示已保存、后端其实还是旧地址，
                    是这类配置页最常见的自欺（Key 未回灌时也在这里暴露） */}
                {live && (
                    <p className="pl-1 text-[10px] leading-relaxed text-content-muted">
                        后端当前生效：{liveUrl || "（尚未设置）"}
                        {liveDiffers && " ｜与上方填写不同，保存后才会切换"}
                    </p>
                )}
                {live && !live.configured && (
                    <p className="pl-1 text-[10px] leading-relaxed text-status-warning">
                        ⚠️ 后端进程里还没有 API Key（后端刚重启过就是这种状态）——
                        点一次「保存设置」即可恢复对话。
                    </p>
                )}
            </Field>

            <Field label="模型名称">
                <Input
                    type="text"
                    value={modelName}
                    onChange={(e) => onModelNameChange(e.target.value)}
                    placeholder={modelPlaceholder}
                />
            </Field>

            {showAdvanced && (
                <div className="rounded-2xl border border-line-subtle bg-surface-2/40 p-3">
                    <button
                        type="button"
                        aria-expanded={isAdvancedOpen}
                        onClick={() => setIsAdvancedOpen((open) => !open)}
                        className="flex w-full items-center justify-between rounded-xl px-1 py-1 text-left transition-colors duration-fast ease-out-expo hover:text-content-secondary"
                    >
                        <span className="text-[10px] font-bold uppercase tracking-widest text-content-muted">
                            高级选项
                        </span>
                        <span className="flex items-center gap-1 text-[10px] text-content-muted">
                            {isAdvancedOpen ? "收起" : "展开"}
                            <ChevronDown
                                className={cn(
                                    "h-4 w-4 transition-transform duration-fast ease-out-expo",
                                    isAdvancedOpen && "rotate-180"
                                )}
                            />
                        </span>
                    </button>

                    {/* 折叠区：展开/收起只改高度，按钮行常驻，切换时上方字段不位移 */}
                    <AnimatePresence initial={false}>
                        {isAdvancedOpen && (
                            <motion.div
                                key="advanced-body"
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: "auto", opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{ duration: 0.2 }}
                                className="overflow-hidden"
                            >
                                <div className="space-y-4 pt-3">
                                    {/* 无限上下文：开启后忽略条数，带上全部保留的对话 */}
                                    <div className="flex items-center justify-between rounded-xl bg-surface-1/60 px-3 py-2.5">
                                        <div>
                                            <p className="text-sm font-medium text-content-primary">无限上下文</p>
                                            <p className="text-[10px] text-content-muted">
                                                {adv.unlimitedContext
                                                    ? "每次带上全部保留的对话（最多 200 条），更连贯但 token 消耗明显增加"
                                                    : "关闭时按下方条数裁剪上下文，更快更省"}
                                            </p>
                                        </div>
                                        <Switch
                                            checked={adv.unlimitedContext}
                                            onChange={(v) => patchAdvanced({ unlimitedContext: v })}
                                            label="无限上下文"
                                        />
                                    </div>

                                    {/* 无限上下文开启时条数无意义，整个字段隐藏（带高度动画避免下方字段跳位） */}
                                    <AnimatePresence initial={false}>
                                        {!adv.unlimitedContext && (
                                            <motion.div
                                                key="context-count"
                                                initial={{ height: 0, opacity: 0 }}
                                                animate={{ height: "auto", opacity: 1 }}
                                                exit={{ height: 0, opacity: 0 }}
                                                transition={{ duration: 0.2 }}
                                                className="overflow-hidden"
                                            >
                                                <NumberField
                                                    label="上下文条数"
                                                    value={adv.maxPromptHistory}
                                                    min={CHAT_NUMBER_LIMITS.maxPromptHistory.min}
                                                    max={CHAT_NUMBER_LIMITS.maxPromptHistory.max}
                                                    step={CHAT_NUMBER_LIMITS.maxPromptHistory.step}
                                                    fallback={CHAT_NUMBER_LIMITS.maxPromptHistory.fallback}
                                                    placeholder="30"
                                                    hint="每次请求带上的最近对话条数（5–100）。调小更快更省，调大更连贯。"
                                                    onChange={(v) =>
                                                        patchAdvanced({
                                                            maxPromptHistory:
                                                                v ??
                                                                CHAT_NUMBER_LIMITS.maxPromptHistory
                                                                    .fallback,
                                                        })
                                                    }
                                                />
                                            </motion.div>
                                        )}
                                    </AnimatePresence>

                                    <NumberField
                                        label="温度 Temperature"
                                        value={adv.temperature}
                                        min={CHAT_NUMBER_LIMITS.temperature.min}
                                        max={CHAT_NUMBER_LIMITS.temperature.max}
                                        step={CHAT_NUMBER_LIMITS.temperature.step}
                                        fallback={CHAT_NUMBER_LIMITS.temperature.fallback}
                                        placeholder="0.75"
                                        hint="0 = 一板一眼，2 = 天马行空（步进 0.05）。"
                                        onChange={(v) =>
                                            patchAdvanced({
                                                temperature:
                                                    v ??
                                                    CHAT_NUMBER_LIMITS.temperature.fallback,
                                            })
                                        }
                                    />

                                    <NumberField
                                        label="最大输出 Tokens"
                                        value={adv.maxTokens}
                                        min={CHAT_NUMBER_LIMITS.maxTokens.min}
                                        max={CHAT_NUMBER_LIMITS.maxTokens.max}
                                        step={CHAT_NUMBER_LIMITS.maxTokens.step}
                                        fallback={CHAT_NUMBER_LIMITS.maxTokens.fallback}
                                        allowEmpty
                                        placeholder="留空 = 不限制"
                                        hint="256–8192。留空则不发送该参数，由模型自行决定。"
                                        onChange={(v) => patchAdvanced({ maxTokens: v })}
                                    />

                                    <Field
                                        label="思考强度 Reasoning Effort"
                                        hint="仅对支持的推理模型生效；普通模型请保持「不传」，否则部分厂商会报 400。"
                                    >
                                        <Select
                                            ariaLabel="思考强度"
                                            options={REASONING_EFFORT_OPTIONS}
                                            value={adv.reasoningEffort}
                                            onChange={(v) =>
                                                patchAdvanced({ reasoningEffort: v })
                                            }
                                        />
                                    </Field>
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            )}

            {/* 后端保存成功后回传的 warnings（未知字段、本机/局域网地址等）。
                留在表单里而不是只弹 3 秒 toast：这些是「配置没按你以为的生效」的信号。 */}
            {saveWarnings.length > 0 && (
                <div className="space-y-1 rounded-2xl border border-status-warning/40 bg-status-warning/5 p-3">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-status-warning">
                        已保存，但有 {saveWarnings.length} 条提醒
                    </p>
                    {saveWarnings.map((warning) => (
                        <p
                            key={warning}
                            className="pl-1 text-[10px] leading-relaxed text-content-secondary"
                        >
                            · {warning}
                        </p>
                    ))}
                </div>
            )}
        </>
    );
}
