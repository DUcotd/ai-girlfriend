import { DEFAULT_TRAITS, DIM_KEYS } from './personalityDims.js';

/** 默认预设 ID。 */
export const DEFAULT_PRESET_ID = 'gentle';

/**
 * 六种内置性格预设。
 * 数值与产品需求表保持一致，前端必须通过 API 获取，禁止另建镜像。
 */
export const PERSONALITY_PRESETS = [
    {
        id: 'gentle',
        name: '温柔',
        emoji: '🌸',
        tagline: '体贴顺从，说话轻声细语，会照顾你的情绪',
        traits: { ...DEFAULT_TRAITS },
    },
    {
        id: 'tsundere',
        name: '傲娇',
        emoji: '💢',
        tagline: '嘴上嫌弃，心里在意，一戳就炸毛',
        traits: {
            independence: 65,
            willfulness: 70,
            sensitivity: 70,
            security: 50,
            affection: 45,
            playfulness: 55,
            trust: 45,
        },
    },
    {
        id: 'cheerful',
        name: '活泼',
        emoji: '✨',
        tagline: '元气满满，话多爱闹，不太容易受伤',
        traits: {
            independence: 45,
            willfulness: 45,
            sensitivity: 30,
            security: 70,
            affection: 80,
            playfulness: 85,
            trust: 70,
        },
    },
    {
        id: 'aloof',
        name: '高冷',
        emoji: '❄️',
        tagline: '话少、不主动、保持距离，偶尔毒舌',
        traits: {
            independence: 80,
            willfulness: 60,
            sensitivity: 45,
            security: 75,
            affection: 25,
            playfulness: 20,
            trust: 35,
        },
    },
    {
        id: 'intellectual',
        name: '知性姐姐',
        emoji: '📖',
        tagline: '沉稳可靠，能看穿你的情绪，会讲道理',
        traits: {
            independence: 70,
            willfulness: 30,
            sensitivity: 65,
            security: 80,
            affection: 50,
            playfulness: 25,
            trust: 75,
        },
    },
    {
        id: 'clingy',
        name: '撒娇妹妹',
        emoji: '🧸',
        tagline: '黏人爱撒娇，要关注，容易吃醋',
        traits: {
            independence: 20,
            willfulness: 55,
            sensitivity: 70,
            security: 40,
            affection: 85,
            playfulness: 70,
            trust: 65,
        },
    },
];

/** 固定顺序的预设 ID。 */
export const PRESET_IDS = PERSONALITY_PRESETS.map((preset) => preset.id);

/**
 * 按 ID 查找预设。
 * @param {unknown} id 预设 ID
 * @returns {object | null}
 */
export function getPreset(id) {
    if (typeof id !== 'string') return null;
    return PERSONALITY_PRESETS.find((preset) => preset.id === id) || null;
}

// 模块加载时即守护预设完整性，防止后续漏填新维度。
for (const preset of PERSONALITY_PRESETS) {
    if (!DIM_KEYS.every((key) => Number.isFinite(preset.traits[key]))) {
        throw new Error(`personality preset ${preset.id} does not cover all dimensions`);
    }
}
