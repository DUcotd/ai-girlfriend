/**
 * 用户情绪 → 回应策略 prompt 片段（REQ-01）。
 *
 * 本文件两块职责：
 *   buildUserEmotionContext(emotion, trend) —— 产出注入 LLM 的 [User Emotion] 段。
 *   USER_EMOTION_RESPONSE_STRATEGY          —— 情绪 → 回应策略映射表。
 *
 * ⚠️ 该映射表是 REQ-02（共情式回应）的**地基**：本期只把策略提示注入 prompt，
 *    **不直接改动回复生成逻辑**（回复仍由主 LLM 按人设自行生成）。
 *
 * 纯函数原则：不读文件、不 import 引擎，便于单独验证。
 */
import { USER_EMOTION_LABELS, NEUTRAL_LABEL } from '../userEmotionLexicon.js';

/** 未命中映射表时的兜底策略。 */
const FALLBACK_STRATEGY = '保持自然地陪伴，顺势回应他的状态，不要生硬地切换话题。';

/**
 * 情绪标签 → 回应策略提示（唯一映射表，REQ-02 地基）。
 *
 * 每条策略的写法约束：
 *   - 描述「先做什么、后做什么」，避免直接规定措辞（由人设 LLM 决定文风）；
 *   - 不写心理健康建议式话术（保持角色感），只给关系内可执行的陪伴姿态。
 */
export const USER_EMOTION_RESPONSE_STRATEGY = {
    低落: '先共情、认可他的感受，再温和陪伴；不要急着讲道理或给建议，除非他主动问。',
    疲惫: '语气放轻放慢、别追问细节；可以先让他歇一歇，或说点轻松的日常帮他从紧绷里松下来。',
    焦虑: '先接住他的担心、帮他稳住情绪；把大问题拆小、肯定他已经在努力，避免一起放大焦虑。',
    愤怒: '先让他把火发出来、站在他这边；不要在他气头上讲道理或替对方解释，也不要被带走情绪。',
    烦闷: '共情他的无聊/烦躁，主动抛一个有新鲜感的小话题或活动提议，帮他转移注意力。',
    开心: '真诚地共享他的喜悦，顺着他的话头聊下去、一起放大这份好心情，别泼冷水。',
    兴奋: '热情地呼应他的兴奋，语气可以更活泼、多用感叹，陪他一起嗨。',
    平静: '保持轻盈自然的日常节奏，不刻意制造情绪起伏；适合聊些细碎温柔的话题。',
    [NEUTRAL_LABEL]: FALLBACK_STRATEGY,
};

/**
 * 构建注入 LLM 的 [User Emotion] 段（若引擎已有自己的注入文本，则以引擎为准，
 * 本函数用于 engine 之外的独立调用/测试）。
 *
 * @param {object} emotion - { label, valence, arousal, intensity }
 * @param {object} [trend] - getRecentTrend() 结果
 * @returns {string} 注入文本；emotion 非法时返回 ''（空串 = 不注入）
 */
export function buildUserEmotionContext(emotion, trend) {
    if (!emotion || typeof emotion !== 'object') return '';
    const label = USER_EMOTION_LABELS.includes(emotion.label) ? emotion.label : NEUTRAL_LABEL;
    const strategy = USER_EMOTION_RESPONSE_STRATEGY[label] || FALLBACK_STRATEGY;

    const lines = [
        '[User Emotion - 用户当前情绪]',
        `- 用户情绪: ${label}`,
    ];
    if (trend && trend.available) {
        lines.push(`- 近期趋势: ${describeTrend(trend)}`);
    }
    lines.push(`- 回应策略: ${strategy}`);
    lines.push('- 这是对"他"此刻情绪的观察，不是小爱自己的情绪；体贴照顾即可，不要念出数值。');
    return lines.join('\n');
}

/**
 * 趋势人话描述（与引擎内 _describeTrend 口径一致；此处独立导出便于 prompt 模块单测）。
 * @param {object} trend getRecentTrend() 结果
 * @returns {string}
 */
export function describeTrend(trend) {
    if (!trend || !trend.available || trend.samples < 2) return '数据不足（本轮为最新状态）';
    if (trend.declining) return `情绪在下滑（均值 ${trend.avgValence}，斜率 ${trend.slope}），请温和安抚、不要追问`;
    if (trend.slope > 0.05) return `情绪在回升（均值 ${trend.avgValence}），状态不错`;
    return `情绪较平稳（均值 ${trend.avgValence}）`;
}
