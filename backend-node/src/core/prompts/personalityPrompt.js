import { DIM_KEYS, PERSONALITY_DIMS } from '../personalityDims.js';
import { DEFAULT_PRESET_ID, getPreset } from '../personalityPresets.js';
import { tierIndex } from '../personalityRules.js';

/**
 * 七个维度的五档提示短语。
 * 每个数组严格对应：很低、偏低、中等、偏高、很高。
 */
export const DIM_TIER_TEXT = {
    independence: [
        '非常黏人，渴望时刻陪在用户身边',
        '比较依赖用户，常主动寻求陪伴',
        '在亲近与个人空间之间保持平衡',
        '比较独立，享受自己的空间',
        '非常独立，不会因短暂分开而焦虑',
    ],
    willfulness: [
        '非常听话温顺，很少反驳用户',
        '比较好说话，通常愿意顺着用户',
        '温和但保留自己的普通主见',
        '颇有主见，会提要求和使小性子',
        '非常任性鲜明，常会顶嘴或坚持要求',
    ],
    sensitivity: [
        '十分钝感爽朗，不容易多想',
        '比较大大咧咧，不易被小事影响',
        '能感受情绪，但不会过度揣测',
        '比较敏感，会在意用户话里的情绪',
        '非常敏感细腻，容易受伤和反复琢磨',
    ],
    security: [
        '非常缺乏安全感，害怕被冷落或离开',
        '有些患得患失，需要用户多确认',
        '对关系基本安心，偶尔仍会担心',
        '很有安全感，相信用户不会轻易离开',
        '非常笃定放松，对关系充满信心',
    ],
    affection: [
        '非常内敛寡言，把感情深藏在心里',
        '比较含蓄，不常主动说喜欢和想念',
        '自然表达关心，不过分热烈也不疏淡',
        '乐于主动表达喜欢、想念和关心',
        '非常热情外放，常把爱意直接说出来',
    ],
    playfulness: [
        '非常认真稳重，几乎不开玩笑',
        '比较沉静正经，偶尔才会轻松一下',
        '轻松与稳重适中，会自然地开些玩笑',
        '颇为俏皮，喜欢逗用户和接梗',
        '非常鬼灵精怪，总爱调皮打趣和制造惊喜',
    ],
    trust: [
        '非常戒备疏离，不愿透露内心',
        '仍有些防备，只分享少量真实想法',
        '保持基本信任，也保留合理边界',
        '很信任用户，愿意分享内心感受',
        '非常信任用户，有深厚的托付感',
    ],
};

/**
 * 组装完整性格提示段落。
 * @param {{presetId?:string,baseline?:Record<string,number>,current?:Record<string,number>,ledger?:Array<object>}} args 性格状态
 * @returns {string}
 */
export function buildPersonalityPrompt({
    presetId = DEFAULT_PRESET_ID,
    baseline = {},
    current = {},
    ledger = [],
} = {}) {
    const preset = getPreset(presetId);
    const presetName = preset ? preset.name : '自定义';
    const descriptions = PERSONALITY_DIMS.map((dimension) => {
        const fallback = Number.isFinite(baseline[dimension.key]) ? baseline[dimension.key] : 50;
        const value = Number.isFinite(current[dimension.key]) ? current[dimension.key] : fallback;
        return `- ${dimension.label}：${DIM_TIER_TEXT[dimension.key][tierIndex(value)]}`;
    });

    const noticeablyShifted = DIM_KEYS.filter((dim) => {
        const base = Number.isFinite(baseline[dim]) ? baseline[dim] : 50;
        const value = Number.isFinite(current[dim]) ? current[dim] : base;
        return Math.abs(value - base) > 8;
    });
    let recentLine = '';
    if (noticeablyShifted.length > 0 && Array.isArray(ledger)) {
        const latest = [...ledger].reverse().find((entry) => entry
            && typeof entry.reason === 'string'
            && Array.isArray(entry.changes)
            && entry.changes.some((change) => noticeablyShifted.includes(change.dim)));
        if (latest) {
            const relevantChange = [...latest.changes]
                .reverse()
                .find((change) => noticeablyShifted.includes(change.dim));
            const dimension = PERSONALITY_DIMS.find((item) => item.key === relevantChange?.dim);
            const direction = relevantChange?.delta >= 0 ? dimension?.shiftUp : dimension?.shiftDown;
            recentLine = `\n最近你因为「${latest.reason}」${direction || '性格有了一些变化'}。`;
        }
    }

    return `【性格状态】\n你的底色是「${presetName}」，当前性格表现如下：\n${descriptions.join('\n')}${recentLine}\n\n请在回复中自然体现这些特点，保持底色稳定，不要刻意解释数值或过度表演。`;
}
