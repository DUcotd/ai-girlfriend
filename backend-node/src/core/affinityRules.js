/**
 * 好感度变化校验规则（纯函数）。
 * 从 AiGirlfriend._validateAffinityChange 拆出，规则逻辑保持原样：
 * 区分硬拒绝 / 软拒绝（傲娇信号），并对过低 / 过高好感度施加保护。
 */

// 硬拒绝信号（任何阶段都是真实拒绝）
const HARD_REJECTION = ['不太合适', '刚认识', '陌生', '不熟', '保持距离', '后退',
                        '请不要这样', '别这样', '这样不好', '我们还不熟', '太突然了'];

// 软拒绝/傲娇信号（高好感度时可能是调情）
const SOFT_REJECTION = ['讨厌', '哼', '走开', '不理你', '不跟你说了', '烦人',
                        '坏人', '大坏蛋', '过分', '欺负', '坏蛋', '不理你了', '哼唧'];

const INTIMACY_SIGNALS = ['爱你', '亲亲', '抱抱', '么么', '老婆', '老公', '喜欢你', '想你', '宝贝', '亲爱的'];

const anyIncludes = (text, words) => words.some(s => text.includes(s));

/**
 * 校验并修正 LLM 给出的好感度变化。
 *
 * @param {number} rawChange - LLM 输出的原始变化值
 * @param {string} userInput - 用户消息
 * @param {string} aiReply - AI 回复
 * @param {number} affinity - 当前好感度
 * @param {string} stage - 当前关系阶段（stranger/acquaintance/friend/close/lover）
 * @returns {number} 修正后的变化值
 */
export function validateAffinityChange(rawChange, userInput, aiReply, affinity, stage = 'stranger') {
    let change = Math.max(-10, Math.min(10, rawChange));

    const hasHardRejection = anyIncludes(aiReply, HARD_REJECTION);
    const hasSoftRejection = anyIncludes(aiReply, SOFT_REJECTION);
    const hasIntimacy = anyIncludes(userInput, INTIMACY_SIGNALS);

    // 规则1: 硬拒绝 → 永远不允许正向变化
    if (hasHardRejection && change > 0) {
        console.log(`[Affinity] Hard rejection detected, change ${change} → 0`);
        change = 0;
    }
    if (hasHardRejection && hasIntimacy) {
        change = Math.min(change, -2);
        console.log(`[Affinity] Hard rejection + forced intimacy → penalty, change=${change}`);
    }

    // 规则2: 软拒绝 → 根据阶段判断
    if (hasSoftRejection) {
        if ((stage === 'lover' || stage === 'close') && hasIntimacy) {
            if (change < 0) {
                change = Math.max(change, 0);
                console.log(`[Affinity] Soft rejection at ${stage} stage → tsundere play, change → ${change}`);
            }
            if (change === 0 && hasIntimacy) {
                change = 1;
                console.log(`[Affinity] Soft rejection + intimacy at ${stage} stage → bonus +1`);
            }
        } else if (change > 0) {
            console.log(`[Affinity] Soft rejection at ${stage} stage → blocking positive change`);
            change = 0;
        }
    }

    // 规则3: 低好感度保护
    if (affinity <= 20 && hasIntimacy && !hasHardRejection && !hasSoftRejection) {
        change = Math.min(change, -1);
        console.log(`[Affinity] Low affinity(${affinity}) forced intimacy, change → ${change}`);
    }

    // 规则4: 超低好感度保护
    if (affinity < 10 && change > 0) {
        change = Math.round(change * 0.3);
        console.log(`[Affinity] Ultra-low affinity protection, change dampened to ${change}`);
    }

    // 规则5: 高好感度惯性（与规则4对称 — 高好感度应"粘滞"，难以骤降）
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
