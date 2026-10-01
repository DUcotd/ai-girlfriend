"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import Field from "@/components/ui/Field";
import Input from "@/components/ui/Input";
import Note from "@/components/ui/Note";
import SegmentedControl from "@/components/ui/SegmentedControl";
import Switch from "@/components/ui/Switch";
import { cn } from "@/lib/cn";

/** 与后端 config.memory.retrieval.mode 的合法值保持一致 */
const RETRIEVAL_MODE_OPTIONS = [
    { value: "auto", label: "自动" },
    { value: "embedding", label: "语义" },
    { value: "keyword", label: "关键词" },
] as const;

export type MemoryRetrievalMode = (typeof RETRIEVAL_MODE_OPTIONS)[number]["value"];

interface SettingsMemoryTabProps {
    embApiKey: string;
    embBaseUrl: string;
    embModelName: string;
    onEmbApiKeyChange: (value: string) => void;
    onEmbBaseUrlChange: (value: string) => void;
    onEmbModelNameChange: (value: string) => void;
    memoryFactsEnabled: boolean;
    onMemoryFactsEnabledChange: (value: boolean) => void;
    memoryRetrievalMode: MemoryRetrievalMode;
    onMemoryRetrievalModeChange: (value: MemoryRetrievalMode) => void;
}

/**
 * 设置 → 记忆页签：检索模式（双方案切换）、事实提取开关、嵌入服务配置。
 *
 * 检索两套方案：
 * - 语义（方案 A）：嵌入向量余弦检索，更懂「意思相近」，需要嵌入 API；
 * - 关键词（方案 B）：BM25 风格打分，零外部依赖，离线可用；
 * - 自动：配好嵌入服务就用语义检索，否则自动落关键词。
 *
 * 嵌入服务配置默认收起、不预填任何默认值——只有切到「语义」（必须配）
 * 或在「自动」下想启用语义检索时才展开填写。
 */
export default function SettingsMemoryTab({
    embApiKey,
    embBaseUrl,
    embModelName,
    onEmbApiKeyChange,
    onEmbBaseUrlChange,
    onEmbModelNameChange,
    memoryFactsEnabled,
    onMemoryFactsEnabledChange,
    memoryRetrievalMode,
    onMemoryRetrievalModeChange,
}: SettingsMemoryTabProps) {
    // 展开状态：语义模式强制展开（嵌入式检索的硬依赖）；
    // 其余模式默认收起，由用户手动展开。派生值即可表达，无需 effect 同步。
    const [manualOpen, setManualOpen] = useState(false);
    const embeddingRequired = memoryRetrievalMode === "embedding";
    const embeddingOpen = embeddingRequired || manualOpen;
    // 是否已填过任意嵌入配置（三项都不为空才算未配置）
    const embeddingConfigured = !!(embApiKey.trim() || embBaseUrl.trim() || embModelName.trim());

    return (
        <>
            {/* 检索模式（双方案切换） */}
            <div className="rounded-2xl border border-line-subtle bg-surface-1/50 p-4">
                <h4 className="text-sm font-bold text-content-primary">回忆检索方式</h4>
                <p className="mt-0.5 mb-3 text-[10px] text-content-muted">
                    决定小爱从过往对话中回忆细节的方式
                </p>
                <SegmentedControl
                    options={RETRIEVAL_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                    value={memoryRetrievalMode}
                    onChange={(v) => onMemoryRetrievalModeChange(v as MemoryRetrievalMode)}
                />
                <p className="mt-3 text-xs leading-relaxed text-content-muted">
                    {memoryRetrievalMode === "keyword"
                        ? "🔑 关键词模式：按词语匹配打分（BM25），零外部依赖、离线可用。"
                        : memoryRetrievalMode === "embedding"
                          ? "🧠 语义模式：按含义相近程度检索，需要展开下方嵌入服务完成配置。"
                          : "✨ 自动：配好嵌入服务就用语义检索，否则自动用关键词检索。"}
                </p>
            </div>

            {/* 事实提取开关 */}
            <div className="flex items-center justify-between rounded-2xl border border-line-subtle bg-surface-1/50 p-4">
                <div>
                    <h4 className="text-sm font-bold text-content-primary">记住重要的事</h4>
                    <p className="mt-0.5 text-[10px] text-content-muted">
                        聊天后自动提炼你的喜好、约定等重要信息（每轮多一次后台调用）
                    </p>
                </div>
                <Switch checked={memoryFactsEnabled} onChange={onMemoryFactsEnabledChange} label="记忆事实提取" />
            </div>

            {/* 嵌入服务配置：默认收起，按需展开填写 */}
            <div className="rounded-2xl border border-line-subtle bg-surface-1/50">
                <button
                    type="button"
                    onClick={() => setManualOpen(!embeddingOpen)}
                    disabled={embeddingRequired}
                    className="flex w-full items-center justify-between gap-2 p-4 text-left disabled:cursor-default"
                >
                    <div className="min-w-0">
                        <div className="flex items-center gap-2">
                            <h4 className="text-sm font-bold text-content-primary">嵌入服务配置</h4>
                            <span
                                className={cn(
                                    "rounded-full px-2 py-0.5 text-[10px] font-bold",
                                    embeddingConfigured
                                        ? "bg-status-success/15 text-status-success"
                                        : "bg-surface-2/80 text-content-muted"
                                )}
                            >
                                {embeddingConfigured ? "已配置" : "未配置"}
                            </span>
                        </div>
                        <p className="mt-0.5 truncate text-[10px] text-content-muted">
                            {embeddingRequired
                                ? "语义检索需要嵌入服务，请展开填写"
                                : memoryRetrievalMode === "auto"
                                  ? "可选。填好后自动模式将启用语义检索"
                                  : "关键词模式无需嵌入服务"}
                        </p>
                    </div>
                    <ChevronDown
                        size={16}
                        className={cn(
                            "shrink-0 text-content-muted transition-transform duration-fast",
                            embeddingOpen && "rotate-180"
                        )}
                    />
                </button>

                {embeddingOpen && (
                    <div className="space-y-4 border-t border-line-subtle p-4">
                        <Field label="嵌入 API 密钥">
                            <Input
                                type="password"
                                value={embApiKey}
                                onChange={(e) => onEmbApiKeyChange(e.target.value)}
                                placeholder="sk-... (留空则使用主 Key)"
                            />
                        </Field>

                        <Field label="嵌入基础 URL">
                            <Input
                                type="text"
                                value={embBaseUrl}
                                onChange={(e) => onEmbBaseUrlChange(e.target.value)}
                                placeholder="https://api.siliconflow.cn/v1"
                            />
                        </Field>

                        <Field label="嵌入模型名称">
                            <Input
                                type="text"
                                value={embModelName}
                                onChange={(e) => onEmbModelNameChange(e.target.value)}
                                placeholder="text-embedding-3-small"
                            />
                        </Field>
                    </div>
                )}
            </div>

            <Note tone="accent">
                🧠 「记住重要的事」不依赖嵌入服务——即使不配置嵌入，小爱也能记住你的重要信息。
            </Note>
        </>
    );
}
