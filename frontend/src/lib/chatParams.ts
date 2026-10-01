/**
 * 聊天高级参数（上下文条数 / 温度 / 最大输出 / 思考强度）的唯一真源：
 * 默认值、取值范围、钳制规则、空值语义都在这里，UI 表单与 storage 共用一份，
 * 避免「前端放开范围、后端收到脏值」这类两边不一致。
 *
 * ⚠️ 下发到后端仍必须走 `api.syncConfig`（内部 toBackendConfigPayload 转 snake_case）。
 */

/**
 * 思考强度：空串 = 不传该参数（普通模型收到会 400，所以默认必须空）。
 * none / minimal 仅较新的模型支持（如 OpenAI gpt-5 系）；设了不支持的档位
 * 厂商会直接 400，改回「不传」即可。
 */
export type ReasoningEffort = "" | "none" | "minimal" | "low" | "medium" | "high";

export interface ReasoningEffortOption {
    value: ReasoningEffort;
    label: string;
}

export const REASONING_EFFORT_OPTIONS: readonly ReasoningEffortOption[] = [
    { value: "", label: "不传（跟随模型默认）" },
    { value: "none", label: "none · 关闭思考" },
    { value: "minimal", label: "minimal · 极简思考" },
    { value: "low", label: "low · 省思考" },
    { value: "medium", label: "medium · 均衡" },
    { value: "high", label: "high · 深度思考" },
];

/** 各数值参数的取值范围与回落值（step 只影响 UI 步进器） */
export const CHAT_NUMBER_LIMITS = {
    /** 发给 LLM 的最近历史条数 */
    maxPromptHistory: { min: 5, max: 100, step: 1, fallback: 30 },
    /** 采样温度 */
    temperature: { min: 0, max: 2, step: 0.05, fallback: 0.75 },
    /** 最大输出 tokens；0 / undefined = 不传该参数（由模型自行决定） */
    maxTokens: { min: 256, max: 8192, step: 64, fallback: 0 },
} as const;

export type ChatNumberKey = keyof typeof CHAT_NUMBER_LIMITS;

/** 设置页「高级选项」的形状（不含 Key/URL/模型这些基础项） */
export interface AdvancedChatConfig {
    maxPromptHistory: number;
    /** 无限上下文：true = 忽略 maxPromptHistory，带上全部保留的对话（后端 200 条持久化上限兜底） */
    unlimitedContext: boolean;
    temperature: number;
    /** undefined / 0 = 不把 max_tokens 发给模型 */
    maxTokens: number | undefined;
    reasoningEffort: ReasoningEffort;
}

export const DEFAULT_ADVANCED_CONFIG: AdvancedChatConfig = {
    maxPromptHistory: CHAT_NUMBER_LIMITS.maxPromptHistory.fallback,
    unlimitedContext: false,
    temperature: CHAT_NUMBER_LIMITS.temperature.fallback,
    maxTokens: undefined,
    reasoningEffort: "",
};

/**
 * 把任意输入钳到 [min,max]；NaN / 空串 / 非法输入回落 fallback。
 * 输入框失焦与「保存全部配置」两处都调它，保证落盘与下发的值一定是合法值。
 */
export function clampChatNumber(
    raw: number | string | null | undefined,
    key: ChatNumberKey
): number {
    const { min, max, fallback } = CHAT_NUMBER_LIMITS[key];
    if (raw === null || raw === undefined || raw === "") return fallback;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

/**
 * 可留空的数值（目前只有 maxTokens）：空串 / null → undefined（= 不传该参数），
 * 有值则按 clampChatNumber 钳制。
 */
export function parseOptionalChatNumber(
    raw: number | string | null | undefined,
    key: ChatNumberKey
): number | undefined {
    if (raw === null || raw === undefined || raw === "") return undefined;
    return clampChatNumber(raw, key);
}

/** 归一化思考强度：非法值一律回落「不传」，避免把垃圾字符串发给模型 */
export function normalizeReasoningEffort(raw: string | null | undefined): ReasoningEffort {
    if (raw === "none" || raw === "minimal" || raw === "low" || raw === "medium" || raw === "high") {
        return raw;
    }
    return "";
}

/**
 * 整包归一化（保存/下发前兜底，防止脏值进 localStorage 或后端）。
 *
 * ⚠️ maxTokens 的「留空」在 UI/localStorage 域里就是 `undefined`（不要改成 0）：
 * NumberField 靠它显示空输入框，storage 靠它写成空串；真正压成 `max_tokens: 0`
 * 是 `toBackendConfigPayload` 的事（0 才是后端认的「不传」）。把这里改成 0
 * 会导致输入框显示"0"，且下次读取时被钳到 min(256)，凭空多出一个值。
 */
export function normalizeAdvancedConfig(
    cfg: Partial<AdvancedChatConfig> | null | undefined
): AdvancedChatConfig {
    if (!cfg) return { ...DEFAULT_ADVANCED_CONFIG };
    return {
        maxPromptHistory: clampChatNumber(cfg.maxPromptHistory, "maxPromptHistory"),
        unlimitedContext: !!cfg.unlimitedContext,
        temperature: clampChatNumber(cfg.temperature, "temperature"),
        maxTokens: parseOptionalChatNumber(cfg.maxTokens, "maxTokens"),
        reasoningEffort: normalizeReasoningEffort(cfg.reasoningEffort),
    };
}
