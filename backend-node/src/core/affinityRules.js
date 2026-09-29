/**
 * 好感度变化校验规则（纯函数）。
 *
 * 2026-09-30 重构要点（PRD P0-a / P0-c / P0-d / P1-c）：
 * 1. 所有**非阶段参数**（单次上下限、超低保护、日上限、越界分档、负向惯性）
 *    集中到顶部具名对象 AFFINITY_RULES，每项带取值理由；
 *    所有**阶段判断**一律走 getStageForAffinity(affinity).stage，不再硬编码 35/60/70/80/90。
 * 2. 词表收敛到 ./lexicon.js，本文件不再自持词表。
 * 3. 返回值升级为 { change, trace }，trace 记录每条规则的「修正前 → 修正后 + 人话原因」，
 *    使每次涨跌可回答「为什么变、被哪些规则改过」（PRD P0-d）。
 * 4. 规则顺序固定：单次上限 → 硬拒绝 → 软拒绝/傲娇 → 越界 → 疲劳 → 超低保护
 *    → 负向惯性 → 日上限（最后生效，才能正确反映「今天还剩多少额度」）。
 *
 * 不变量：rawChange + Σ(trace[i].to - trace[i].from) === change。
 */

import { getStageForAffinity } from './relationshipStages.js';
import { anyIncludes, HARD_REJECTION, SOFT_REJECTION, DEEP_INTIMACY, MILD_INTIMACY } from './lexicon.js';
import { applyGainFatigue } from './affinityFatigue.js';

/**
 * 好感度规则的具名参数（非阶段边界，集中于此）。
 * 阶段边界（15/34/59/84）只存在于 relationshipStages.js。
 */
export const AFFINITY_RULES = {
    // —— 单次变化边界 ——
    MAX_POSITIVE_PER_TURN: 3,    // 正向单次最多 +3：现实里好感是缓慢积累的
    MAX_NEGATIVE_PER_TURN: -10,  // 负向单次最多 -10：一次伤害可以很大

    // —— 超低好感保护（心灰意冷时，一两句好话挽回有限）——
    ULTRA_LOW_AFFINITY: 10,
    ULTRA_LOW_POSITIVE_MULTIPLIER: 0.3,

    // —— 每日正增长上限（本地自然日 00:00 重置；必须最后生效）——
    DAILY_POSITIVE_CAP: 8,

    // —— 越界惩罚：按 stage 名挂参数（阈值由 relationshipStages 决定）——
    // 关系越浅、越界越冒犯；friend 阶段「喜欢你」已属自然表达不再罚，
    // 仅恋人式言行（老婆/索吻等）扣分；close/lover 阶段亲密是被欢迎的。
    OVERREACH_PENALTY: {
        stranger:     { mild: -2, deep: -3 },
        acquaintance: { mild: -2, deep: -3 },
        friend:       { mild:  0, deep: -2 },
        close:        { mild:  0, deep:  0 },
        lover:        { mild:  0, deep:  0 },
    },

    // —— 负向惯性：深爱难以骤降（取消旧的 70/80/90 游离数字，改按阶段挂档）——
    NEGATIVE_INERTIA: {
        stranger: 1.0, acquaintance: 1.0, friend: 1.0, close: 0.5, lover: 0.2,
    },

    // —— 硬拒绝后仍强行亲密的追加惩罚 ——
    HARD_REJECTION_FORCED_INTIMACY_PENALTY: -2,
};

/** 一条 trace 修正记录：{ rule, from, to, reason } */

/**
 * 校验并修正 LLM 给出的好感度变化（纯函数：不读文件、不读时间、不读全局状态）。
 *
 * @param {number} rawChange LLM 输出的原始变化值
 * @param {string} userInput 用户消息（判越界/亲密）
 * @param {string} aiReply AI 回复（判硬/软拒绝）
 * @param {number} affinity 当前好感度（0-100；阶段由它派生）
 * @param {number} recentPositiveCount 近 24h 已生效正增长次数（调用方注入）
 * @param {number} dailyGainedToday 今日已累计正增长（调用方注入）
 * @returns {{ change: number, trace: Array<{ rule: string, from: number, to: number, reason: string }> }}
 */
export function validateAffinityChange(
    rawChange, userInput, aiReply, affinity,
    recentPositiveCount = 0, dailyGainedToday = 0
) {
    const R = AFFINITY_RULES;
    const stage = getStageForAffinity(affinity).stage;
    let cur = Number.isFinite(rawChange) ? rawChange : 0;
    const trace = [];

    /** 只在真的变了时记录，保证不变量 rawChange + Σ(to-from) === change */
    const rule = (name, next, reason) => {
        if (next !== cur) {
            trace.push({ rule: name, from: cur, to: next, reason });
            cur = next;
        }
    };

    // 0 单次上限
    rule('single_turn_clamp',
        Math.max(R.MAX_NEGATIVE_PER_TURN, Math.min(R.MAX_POSITIVE_PER_TURN, cur)),
        `单次变化收敛到 ${R.MAX_NEGATIVE_PER_TURN}~+${R.MAX_POSITIVE_PER_TURN}`);

    const input = userInput || '';
    const reply = aiReply || '';
    const hasHard = anyIncludes(reply, HARD_REJECTION);
    const hasSoft = anyIncludes(reply, SOFT_REJECTION);
    const deep = anyIncludes(input, DEEP_INTIMACY);
    const mild = !deep && anyIncludes(input, MILD_INTIMACY);
    const intimacy = deep || mild;

    // 1 硬拒绝 → 不允许正向；用户还强行亲密则追加惩罚
    if (hasHard) {
        rule('hard_rejection', Math.min(0, cur), '她明确拒绝了，好感度不会因此上涨');
        if (intimacy) {
            rule('forced_intimacy_penalty', Math.min(cur, R.HARD_REJECTION_FORCED_INTIMACY_PENALTY),
                '她明确拒绝后还强行亲密，扣分');
        }
    }

    // 2 软拒绝 / 傲娇
    if (hasSoft) {
        if ((stage === 'close' || stage === 'lover') && intimacy) {
            rule('tsundere_play', Math.max(cur, 0), '她只是傲娇，不阻断也不扣分');
        } else {
            rule('soft_rejection', Math.min(0, cur), '她在软拒绝，好感度不会上涨');
        }
    }

    // 3 越界惩罚（用户说了超越当前阶段的亲密话）
    if (intimacy && !hasHard) {
        const pen = R.OVERREACH_PENALTY[stage];
        const floor = deep ? pen.deep : pen.mild;
        if (floor < 0) {
            rule('overreach_penalty', Math.min(cur, floor),
                deep ? '恋人式言行，关系还没到那一步，想后退'
                     : '这么快说亲密的话，她有点别扭');
        }
    }

    // 4 加分疲劳（复用纯模块；仅正变化）
    if (cur > 0 && recentPositiveCount > 0) {
        const { change: next } = applyGainFatigue(cur, recentPositiveCount);
        rule('gain_fatigue', next, `24 小时内已经涨过 ${recentPositiveCount} 次，这次涨幅收窄`);
    }

    // 5 超低好感保护
    if (affinity < R.ULTRA_LOW_AFFINITY && cur > 0) {
        rule('ultra_low_protection', Math.round(cur * R.ULTRA_LOW_POSITIVE_MULTIPLIER),
            '她心灰意冷，一两句好话挽回有限');
    }

    // 6 负向惯性
    if (cur < 0) {
        rule('negative_inertia', Math.round(cur * R.NEGATIVE_INERTIA[stage]),
            `关系已到「${stage}」，负面变化被惯性削弱`);
    }

    // 7 日上限（最后生效，反映「今天还剩多少额度」）
    if (cur > 0) {
        const remaining = Math.max(0, R.DAILY_POSITIVE_CAP - dailyGainedToday);
        rule('daily_cap', Math.min(cur, remaining), `今天的好感额度只剩 ${remaining} 点`);
    }

    return { change: cur, trace };
}
