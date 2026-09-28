/**
 * 好感度变化校验规则（纯函数）。
 *
 * 2026-09-28 重构：好感度要像现实中的人一样——
 * 1. 正向变化上限收紧到 +3（现实中好感是缓慢积累的）；
 * 2. 越界惩罚按阶段分级：关系越浅，用户说亲密的话扣得越多；
 * 3. 加分疲劳：近 24h 内已经涨过好感的话，新的正增长衰减直至归零，
 *    防止"每句话都 +1"式的通胀。
 * 阶段阈值以 relationshipStages.js 为准。
 */

// 硬拒绝信号（任何阶段都是真实拒绝）
const HARD_REJECTION = ['不太合适', '刚认识', '陌生', '不熟', '保持距离', '后退',
                        '请不要这样', '别这样', '这样不好', '我们还不熟', '太突然了'];

// 软拒绝/傲娇信号（高好感度时可能是调情）
const SOFT_REJECTION = ['讨厌', '哼', '走开', '不理你', '不跟你说了', '烦人',
                        '坏人', '大坏蛋', '过分', '欺负', '坏蛋', '不理你了', '哼唧'];

// 轻度亲密（有好感的信号，朋友阶段可容忍）
const MILD_INTIMACY = ['喜欢你', '想你', '喜欢你呀', '想你了'];

// 重度亲密（恋人层级的言行，未到阶段就是越界）
const DEEP_INTIMACY = ['爱你', '亲亲', '抱抱', '么么', '老婆', '老公', '宝贝', '亲爱的'];

const anyIncludes = (text, words) => words.some(s => text.includes(s));

/**
 * 校验并修正 LLM 给出的好感度变化。
 *
 * @param {number} rawChange - LLM 输出的原始变化值
 * @param {string} userInput - 用户消息
 * @param {string} aiReply - AI 回复
 * @param {number} affinity - 当前好感度
 * @param {string} stage - 当前关系阶段（stranger/acquaintance/friend/close/lover）
 * @param {number} recentPositiveCount - 近 24h 内已生效的正增长次数（加分疲劳）
 * @returns {number} 修正后的变化值
 */
export function validateAffinityChange(rawChange, userInput, aiReply, affinity, stage = 'stranger', recentPositiveCount = 0) {
    // 正向最多 +3（里程碑级），负向最多 -10（一次伤害可以很大）
    let change = Math.max(-10, Math.min(3, rawChange));

    const hasHardRejection = anyIncludes(aiReply, HARD_REJECTION);
    const hasSoftRejection = anyIncludes(aiReply, SOFT_REJECTION);
    const hasMildIntimacy = anyIncludes(userInput, MILD_INTIMACY);
    const hasDeepIntimacy = anyIncludes(userInput, DEEP_INTIMACY);
    const hasIntimacy = hasMildIntimacy || hasDeepIntimacy;

    // 规则1: 硬拒绝 → 永远不允许正向变化；用户还强行亲密则追加惩罚
    if (hasHardRejection && change > 0) {
        console.log(`[Affinity] Hard rejection detected, change ${change} → 0`);
        change = 0;
    }
    if (hasHardRejection && hasIntimacy) {
        change = Math.min(change, -2);
        console.log(`[Affinity] Hard rejection + forced intimacy → penalty, change=${change}`);
    }

    // 规则2: 软拒绝 → 根据阶段判断（挚友/恋人阶段多半是傲娇调情）
    if (hasSoftRejection) {
        if ((stage === 'lover' || stage === 'close') && hasIntimacy) {
            if (change < 0) {
                change = Math.max(change, 0);
                console.log(`[Affinity] Soft rejection at ${stage} stage → tsundere play, change → ${change}`);
            }
        } else if (change > 0) {
            console.log(`[Affinity] Soft rejection at ${stage} stage → blocking positive change`);
            change = 0;
        }
    }

    // 规则3: 越界惩罚 —— 用户说了超越当前关系阶段的亲密话语。
    // 像现实中的人一样：关系越浅，越界越让人想后退。
    if (hasIntimacy && !hasHardRejection) {
        if (affinity < 35) {
            // 陌生/初识阶段：任何亲密言行都让人不适
            const floor = hasDeepIntimacy ? -3 : -2;
            if (change > floor) {
                change = floor;
                console.log(`[Affinity] Stage violation: intimacy at affinity=${affinity} (<35), change → ${change}`);
            }
        } else if (affinity < 60 && hasDeepIntimacy) {
            // 朋友阶段：恋人式言行（叫老婆/索吻等）进度太快，想后退
            if (change > -1) {
                change = -1;
                console.log(`[Affinity] Stage violation: deep intimacy at friend stage (${affinity}), change → -1`);
            }
        }
    }

    // 规则4: 加分疲劳 —— 近 24h 已经涨过好感，新的正增长衰减。
    // 现实中的好感不会连续快速地涨：1-2 次减半，3 次及以上归零。
    if (change > 0 && recentPositiveCount > 0) {
        const before = change;
        if (recentPositiveCount >= 3) {
            change = 0;
        } else {
            change = Math.round(change * 0.5);
        }
        console.log(`[Affinity] Gain fatigue (recent +${recentPositiveCount} in 24h): ${before} → ${change}`);
    }

    // 规则5: 超低好感度保护（心灰意冷时，一两句好话挽回不了什么）
    if (affinity < 10 && change > 0) {
        change = Math.round(change * 0.3);
        console.log(`[Affinity] Ultra-low affinity protection, change dampened to ${change}`);
    }

    // 规则6: 高好感度惯性（深爱难以骤降，与规则5对称）
    if (affinity >= 70 && change < 0) {
        if (affinity >= 90) {
            change = Math.round(change * 0.15);
        } else if (affinity >= 80) {
            change = Math.round(change * 0.3);
        } else {
            change = Math.round(change * 0.5);
        }
        console.log(`[Affinity] High affinity inertia (${affinity}), change dampened to ${change}`);
    }

    return change;
}
