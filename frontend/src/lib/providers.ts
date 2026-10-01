/**
 * 服务商预设：一键填好「基础 URL + 模型名称」，省得每次换服务商都要去翻文档抄模型 id。
 *
 * 只填这两项，API Key 始终要用户自己填（不落盘、不硬编码）。
 */

export interface ProviderPreset {
    id: string;
    label: string;
    baseUrl: string;
    modelName: string;
    /** 该服务商是否提供 embedding —— 不提供时语义检索不可用（自动用关键词模式），事实记忆与语音均不受影响 */
    hasEmbedding: boolean;
    /** 该服务商是否提供 TTS —— 项目里 TTS 走独立配置，仅作提示 */
    hasTts: boolean;
    note?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
    {
        id: "openai",
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        modelName: "gpt-4o-mini",
        hasEmbedding: true,
        hasTts: true,
    },
    {
        id: "sensenova",
        label: "商汤 Sensenova",
        baseUrl: "https://token.sensenova.cn/v1",
        modelName: "sensenova-6.8-flash-lite",
        hasEmbedding: false,
        hasTts: false,
        note: "商汤不提供 embedding 接口：记忆检索会自动使用关键词模式（事实记忆不受影响）；如需语义检索，可在「记忆」页签单独配置嵌入服务。",
    },
];

/** 当前填写的值命中哪个预设；都不匹配就是 custom */
export function matchPreset(baseUrl: string, modelName: string): string {
    const hit = PROVIDER_PRESETS.find((p) => p.baseUrl === baseUrl && p.modelName === modelName);
    return hit ? hit.id : "custom";
}

/**
 * 默认服务商：表单初始值用它，用户只需填 API Key。
 * 换服务商就改这一行（改 SENSENOVA 预设的值或指向别的 preset）。
 */
export const DEFAULT_PROVIDER =
    PROVIDER_PRESETS.find((p) => p.id === "sensenova") ?? PROVIDER_PRESETS[0];
