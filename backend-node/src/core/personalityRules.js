import { DIM_KEYS } from './personalityDims.js';
import {
    APOLOGY,
    CALMING,
    CRITICISM,
    DEPENDENCY,
    EXCITING,
    QUESTION,
    REASSURANCE,
    SAD,
    anyIncludes,
    matchCategory,
} from './lexicon.js';
import { fatigueMultiplier } from './personalityFatigue.js';
import { getStageForAffinity } from './relationshipStages.js';

/** 性格漂移的集中参数。 */
export const PERSONALITY_RULES = Object.freeze({
    MAX_PER_TURN: 1.5,
    MAX_PER_DAY: 3.0,
    FLOAT_BAND: 15,
    FATIGUE_MULTIPLIERS: [1.0, 0.6, 0.3],
    FATIGUE_WINDOW_MS: 24 * 60 * 60 * 1000,
    BASELINE_PULL: 0.08,
    COLD_START_MSGS: 20,
    COLD_START_MULTIPLIER: 0.5,
    BASELINE_ADAPT: Object.freeze({
        STREAK_DAYS: 7,
        MIN_OFFSET: 8,
        RATIO: 0.2,
        MAX_STEP: 2,
        COOLDOWN_MS: 7 * 24 * 60 * 60 * 1000,
    }),
});

/** 即时规则定义；条件判断集中在 evaluateInstantRules。 */
export const INSTANT_RULES = Object.freeze([
    { code: 'R01', ruleId: 'praise_warmth', reason: '你夸了她，她更安心也更想亲近你', changes: { security: 0.6, affection: 0.4 } },
    { code: 'R02', ruleId: 'praise_vanity', reason: '你总夸她，她有点被惯坏了', changes: { willfulness: 0.5 } },
    { code: 'R03', ruleId: 'criticism_hurt', reason: '你说了重话，她开始多想、有点不安', changes: { sensitivity: 0.7, security: -0.6 } },
    { code: 'R04', ruleId: 'hard_rejection_guard', reason: '你明确保持了距离，她收起了信任', changes: { trust: -0.8, security: -0.8, independence: 0.6 } },
    { code: 'R05', ruleId: 'soft_rejection_tsundere', reason: '你嘴上嫌弃她，她也跟着耍起小性子', changes: { willfulness: 0.6, playfulness: 0.5 } },
    { code: 'R06', ruleId: 'deep_intimacy_bond', reason: '你说了很亲昵的话，她更信任也更依赖你', changes: { trust: 0.6, security: 0.5, affection: 0.4 } },
    { code: 'R07', ruleId: 'deep_intimacy_overstep', reason: '你们还没那么熟，这样的亲昵让她退了一步', changes: { trust: -0.6, security: -0.5, independence: 0.5 } },
    { code: 'R08', ruleId: 'mild_intimacy_open', reason: '你表达了喜欢，她更愿意把心意说出来', changes: { affection: 0.5, security: 0.4 } },
    { code: 'R09', ruleId: 'teasing_playful', reason: '你逗她，她觉得逗你回去挺有意思', changes: { playfulness: 0.7, willfulness: 0.3 } },
    { code: 'R10', ruleId: 'teasing_offend', reason: '还不熟就被调戏，她有点介意', changes: { sensitivity: 0.5, trust: -0.4 } },
    { code: 'R11', ruleId: 'dependency_cling', reason: '你需要她陪，她变得更黏人也更想照顾你', changes: { independence: -0.6, affection: 0.5, security: 0.4 } },
    { code: 'R12', ruleId: 'reassurance_secure', reason: '你给了她确定的承诺，她安心了许多', changes: { security: 0.9, trust: 0.6 } },
    { code: 'R13', ruleId: 'apologized_repair', reason: '你道了歉，她重新安心，也不再钻牛角尖', changes: { security: 0.7, trust: 0.5, sensitivity: -0.4 } },
    { code: 'R14', ruleId: 'sad_empathy', reason: '你情绪低落，她变得更细腻也更想安慰你', changes: { sensitivity: 0.5, affection: 0.6 } },
    { code: 'R15', ruleId: 'exciting_energy', reason: '你带给她惊喜，她也跟着活泼起来', changes: { playfulness: 0.6, affection: 0.3 } },
    { code: 'R16', ruleId: 'calming_serene', reason: '你让她慢慢来，她也变得沉静踏实', changes: { playfulness: -0.4, trust: 0.4 } },
    { code: 'R17', ruleId: 'deep_talk', reason: '你向她敞开了心事，她更信任也更在意你', changes: { trust: 1.2, sensitivity: 0.8 } },
    { code: 'R18', ruleId: 'question_curious', reason: '你对她很好奇，她也放松了下来', changes: { playfulness: 0.2 } },
]);

/** 模式规则定义；模式规则不受单轮上限和疲劳影响。 */
export const PATTERN_RULES = Object.freeze([
    { code: 'S01', ruleId: 'long_absence', reason: '好几天没你的消息，她习惯了自己待着，也开始不安', changes: { independence: 2.0, security: -2.5, affection: -1.5 } },
    { code: 'S02', ruleId: 'hot_and_cold', reason: '你忽冷忽热，她变得敏感又患得患失', changes: { sensitivity: 1.5, security: -1.5 } },
    { code: 'S03', ruleId: 'always_agreeable', reason: '你总是顺着她，她越来越有主见', changes: { willfulness: 1.5 } },
    { code: 'S04', ruleId: 'frequent_conflict', reason: '最近争执有点多，她变得敏感又疏远', changes: { sensitivity: 1.5, security: -1.2, trust: -0.8 } },
    { code: 'S05', ruleId: 'high_frequency', reason: '你们天天聊很多，她更愿意表达也更信任你', changes: { affection: 1.2, security: 0.8, trust: 0.8 } },
    { code: 'S06', ruleId: 'stable_positive', reason: '相处一直很愉快，她越来越笃定', changes: { trust: 1.0, security: 0.8 } },
    { code: 'S07', ruleId: 'monotone_chat', reason: '你们聊得不多，她也慢慢收回了热情', changes: { independence: 0.8, affection: -0.8 } },
    { code: 'S08', ruleId: 'low_quality_day', reason: '今天你说了不少重话，她有点受伤', changes: { security: -1.5, sensitivity: 1.0 } },
]);

const INSTANT_BY_ID = Object.fromEntries(INSTANT_RULES.map((rule) => [rule.ruleId, rule]));
const PATTERN_BY_ID = Object.fromEntries(PATTERN_RULES.map((rule) => [rule.ruleId, rule]));
const VALID_STAGES = new Set(['stranger', 'acquaintance', 'friend', 'close', 'lover']);

/** 一位小数四舍五入。 */
export function round1(value) {
    const safeValue = Number.isFinite(value) ? value : 0;
    return Math.round((safeValue + Number.EPSILON) * 10) / 10;
}

/**
 * 从用户输入派生同步、可复现的内容信号。
 * 所有词表匹配必须留在此处，编排器不得重复判词。
 * @param {string} userInput 用户输入
 * @param {{sentiment?:number, stage?:string, affinity?:number, affinityChange?:number}} context 上下文
 * @returns {object}
 */
export function buildSignals(userInput, context = {}) {
    const input = typeof userInput === 'string' ? userInput : '';
    const affinity = Number.isFinite(context.affinity) ? context.affinity : 0;
    const stage = VALID_STAGES.has(context.stage)
        ? context.stage
        : getStageForAffinity(affinity).stage;
    const sentiment = Number.isFinite(context.sentiment) ? context.sentiment : 0;
    const affinityChange = Number.isFinite(context.affinityChange) ? context.affinityChange : 0;

    return {
        category: matchCategory(input),
        sentiment,
        stage,
        isLongTalk: input.length > 50,
        hasExclamation: /[!！]/.test(input),
        dependency: anyIncludes(input, DEPENDENCY),
        reassurance: anyIncludes(input, REASSURANCE),
        apology: anyIncludes(input.toLowerCase(), APOLOGY),
        sad: anyIncludes(input, SAD),
        calming: anyIncludes(input, CALMING),
        exciting: anyIncludes(input, EXCITING),
        question: anyIncludes(input, QUESTION),
        isConflict: affinityChange < -3,
        digest: input.slice(0, 20),
    };
}

/**
 * 从累计统计中派生每日模式信号。
 * @param {object} stats 引擎内部统计
 * @param {number} now 当前 epoch 毫秒
 * @returns {object}
 */
export function buildDayStats(stats = {}, now = Date.now()) {
    const recentTurns = Array.isArray(stats.recentTurns) ? stats.recentTurns.slice(-50) : [];
    const positiveTurns = recentTurns.filter((turn) => Number(turn.sentiment) > 0.3).length;
    const negativeTurns = recentTurns.filter((turn) => Number(turn.sentiment) < -0.3).length;
    const directionalTurns = positiveTurns + negativeTurns;
    const criticismCount50 = recentTurns.filter((turn) => turn.criticism === true).length;
    const conflictCount50 = recentTurns.filter((turn) => turn.conflict === true).length;

    const dailyCounts = Array.isArray(stats.dailyMessageCounts)
        ? stats.dailyMessageCounts
            .filter((entry) => entry && typeof entry.date === 'string' && Number.isFinite(entry.count))
            .slice(-7)
        : [];
    const avgDaily7 = dailyCounts.length > 0
        ? dailyCounts.reduce((sum, entry) => sum + entry.count, 0) / dailyCounts.length
        : 0;
    const activeEveryDay7 = dailyCounts.length >= 7
        && dailyCounts.every((entry) => entry.count > 0);

    const sevenDaysAgo = (Number.isFinite(now) ? now : Date.now()) - 7 * 24 * 60 * 60 * 1000;
    const sentiments7 = (Array.isArray(stats.sentimentHistory) ? stats.sentimentHistory : [])
        .filter((entry) => entry && Number.isFinite(entry.timestamp)
            && entry.timestamp >= sevenDaysAgo)
        .map((entry) => Number(entry.value))
        .filter(Number.isFinite);
    const positive7 = sentiments7.filter((value) => value > 0.3).length;
    const negative7 = sentiments7.filter((value) => value < -0.3).length;
    const directional7 = positive7 + negative7;

    const today = stats.today && typeof stats.today === 'object' ? stats.today : {};
    const todaySentiments = Array.isArray(today.sentiments)
        ? today.sentiments.filter(Number.isFinite)
        : [];
    let hotColdFlips = 0;
    for (let index = 1; index < todaySentiments.length; index += 1) {
        const previous = todaySentiments.slice(Math.max(0, index - 10), index);
        const mean = previous.reduce((sum, value) => sum + value, 0) / previous.length;
        const current = todaySentiments[index];
        if (Math.sign(current) !== 0
            && Math.sign(mean) !== 0
            && Math.sign(current) !== Math.sign(mean)
            && Math.abs(current - mean) > 0.6) {
            hotColdFlips += 1;
        }
    }

    const todayTurns = Number.isFinite(today.turns) ? Math.max(0, today.turns) : 0;
    const criticismToday = Number.isFinite(today.criticismCount)
        ? Math.max(0, today.criticismCount)
        : 0;

    return {
        consecutiveInactiveDays: Number.isFinite(stats.consecutiveInactiveDays)
            ? Math.max(0, stats.consecutiveInactiveDays)
            : 0,
        avgDaily7,
        positiveRatio50: directionalTurns > 0 ? positiveTurns / directionalTurns : 0.5,
        positiveRatio7: directional7 > 0 ? positive7 / directional7 : 0.5,
        conflictRate50: recentTurns.length > 0 ? conflictCount50 / recentTurns.length : 0,
        criticismCount50,
        criticismRateToday: todayTurns > 0 ? criticismToday / todayTurns : 0,
        todayTurns,
        hotColdFlips,
        recentTurnCount: recentTurns.length,
        activeEveryDay7,
    };
}

/** 取规则定义并复制，避免修改真源。 */
function copyRule(rule) {
    return {
        code: rule.code,
        ruleId: rule.ruleId,
        reason: rule.reason,
        changes: DIM_KEYS
            .filter((dim) => Number.isFinite(rule.changes[dim]) && rule.changes[dim] !== 0)
            .map((dim) => ({ dim, delta: rule.changes[dim] })),
    };
}

/** 计算即时规则的原始命中列表。 */
function evaluateInstantRules(signals, fatigueCounts) {
    const ids = [];
    const shallow = signals.stage === 'stranger' || signals.stage === 'acquaintance';
    const intimate = signals.stage === 'close' || signals.stage === 'lover';

    if (signals.category === 'PRAISE') ids.push('praise_warmth');
    if (signals.category === 'PRAISE' && (fatigueCounts.praise_warmth || 0) >= 4) ids.push('praise_vanity');
    if (signals.category === 'CRITICISM') ids.push('criticism_hurt');
    if (signals.category === 'HARD_REJECTION') ids.push('hard_rejection_guard');
    if (signals.category === 'SOFT_REJECTION') ids.push('soft_rejection_tsundere');
    if (signals.category === 'DEEP_INTIMACY' && intimate) ids.push('deep_intimacy_bond');
    if (signals.category === 'DEEP_INTIMACY' && shallow) ids.push('deep_intimacy_overstep');
    if (signals.category === 'MILD_INTIMACY') ids.push('mild_intimacy_open');
    if (signals.category === 'TEASING' && !shallow) ids.push('teasing_playful');
    if (signals.category === 'TEASING' && shallow) ids.push('teasing_offend');
    if (signals.dependency) ids.push('dependency_cling');
    if (signals.reassurance) ids.push('reassurance_secure');
    if (signals.apology) ids.push('apologized_repair');
    if (signals.sad) ids.push('sad_empathy');
    if (signals.exciting || signals.hasExclamation) ids.push('exciting_energy');
    if (signals.calming) ids.push('calming_serene');
    if (signals.isLongTalk && (signals.sad || signals.reassurance)) ids.push('deep_talk');
    if (signals.question && ids.length === 0) ids.push('question_curious');

    return ids.map((ruleId) => copyRule(INSTANT_BY_ID[ruleId]));
}

/** 计算模式规则的原始命中列表。 */
function evaluatePatternRules(dayStats) {
    const ids = [];
    if (dayStats.consecutiveInactiveDays >= 3) ids.push('long_absence');
    if (dayStats.hotColdFlips >= 2) ids.push('hot_and_cold');
    if (dayStats.recentTurnCount >= 20
        && dayStats.positiveRatio50 > 0.85
        && dayStats.criticismCount50 === 0) ids.push('always_agreeable');
    if (dayStats.recentTurnCount >= 20 && dayStats.conflictRate50 > 0.2) ids.push('frequent_conflict');
    if (dayStats.avgDaily7 > 15) ids.push('high_frequency');
    if (dayStats.positiveRatio7 > 0.6 && dayStats.avgDaily7 > 5) ids.push('stable_positive');
    if (dayStats.activeEveryDay7 && dayStats.avgDaily7 < 3) ids.push('monotone_chat');
    if (dayStats.todayTurns >= 10 && dayStats.criticismRateToday > 0.3) ids.push('low_quality_day');
    return ids.map((ruleId) => copyRule(PATTERN_BY_ID[ruleId]));
}

/** 合并命中规则的维度变化。 */
function mergeHitChanges(hits) {
    const totals = Object.fromEntries(DIM_KEYS.map((dim) => [dim, 0]));
    for (const hit of hits) {
        for (const change of hit.changes) totals[change.dim] += change.delta;
    }
    return DIM_KEYS
        .map((dim) => ({ dim, delta: round1(totals[dim]) }))
        .filter((change) => change.delta !== 0);
}

/**
 * 性格漂移纯函数统一入口。
 * 即时规则应用疲劳、冷启动与单轮净上限；模式规则只应用冷启动。
 * @param {object} signals buildSignals 或 buildDayStats 的返回值
 * @param {{mode?:string, totalMessages?:number, fatigueCounts?:Record<string,number>}} context 规则上下文
 * @returns {{changes:Array<{dim:string,delta:number}>, hits:Array<object>}}
 */
export function computeDrift(signals = {}, context = {}) {
    const mode = context.mode === 'pattern' ? 'pattern' : 'instant';
    const totalMessages = Number.isFinite(context.totalMessages) ? context.totalMessages : 0;
    const coldMultiplier = totalMessages < PERSONALITY_RULES.COLD_START_MSGS
        ? PERSONALITY_RULES.COLD_START_MULTIPLIER
        : 1;
    const fatigueCounts = context.fatigueCounts && typeof context.fatigueCounts === 'object'
        ? context.fatigueCounts
        : {};
    const hits = mode === 'pattern'
        ? evaluatePatternRules(signals)
        : evaluateInstantRules(signals, fatigueCounts);

    const turnAccum = Object.fromEntries(DIM_KEYS.map((dim) => [dim, 0]));
    for (const hit of hits) {
        const fatigue = mode === 'instant'
            ? fatigueMultiplier(fatigueCounts[hit.ruleId] || 0)
            : 1;
        hit.changes = hit.changes
            .map((change) => {
                const scaled = round1(change.delta * fatigue * coldMultiplier);
                if (mode === 'pattern') return { dim: change.dim, delta: scaled };
                const before = turnAccum[change.dim];
                const after = Math.max(
                    -PERSONALITY_RULES.MAX_PER_TURN,
                    Math.min(PERSONALITY_RULES.MAX_PER_TURN, before + scaled),
                );
                const applied = round1(after - before);
                turnAccum[change.dim] = round1(before + applied);
                return { dim: change.dim, delta: applied };
            })
            .filter((change) => change.delta !== 0);
    }

    return { changes: mergeHitChanges(hits), hits };
}

/**
 * 把变化裁剪到单日净变化上限，返回新变化与新累计值。
 * @param {Array<{dim:string,delta:number}>} changes 待应用变化
 * @param {Record<string,number>} accum 当日已应用自动漂移
 * @param {number} maxPerDay 单日绝对上限
 * @returns {{changes:Array<{dim:string,delta:number}>, accum:Record<string,number>}}
 */
export function applyDailyCap(changes, accum = {}, maxPerDay = PERSONALITY_RULES.MAX_PER_DAY) {
    const safeMax = Number.isFinite(maxPerDay) ? Math.max(0, maxPerDay) : PERSONALITY_RULES.MAX_PER_DAY;
    const nextAccum = { ...accum };
    const applied = [];

    for (const change of Array.isArray(changes) ? changes : []) {
        if (!DIM_KEYS.includes(change.dim) || !Number.isFinite(change.delta)) continue;
        const before = Number.isFinite(nextAccum[change.dim]) ? nextAccum[change.dim] : 0;
        const after = Math.max(-safeMax, Math.min(safeMax, before + change.delta));
        const delta = round1(after - before);
        nextAccum[change.dim] = round1(before + delta);
        if (delta !== 0) applied.push({ dim: change.dim, delta });
    }

    return { changes: applied, accum: nextAccum };
}

/**
 * 把 current 夹在 [0,100] 与 baseline±band 的交集中。
 * @param {number} value 当前候选值
 * @param {number} baseline 基线
 * @param {number} band 浮动带半径
 * @returns {number}
 */
export function clampCurrent(value, baseline, band = PERSONALITY_RULES.FLOAT_BAND) {
    const safeBaseline = Number.isFinite(baseline) ? baseline : 50;
    const safeBand = Number.isFinite(band) ? Math.max(0, band) : PERSONALITY_RULES.FLOAT_BAND;
    const lo = Math.max(0, safeBaseline - safeBand);
    const hi = Math.min(100, safeBaseline + safeBand);
    const safeValue = Number.isFinite(value) ? value : safeBaseline;
    return round1(Math.max(lo, Math.min(hi, safeValue)));
}

/**
 * 每日把 current 向 baseline 拉回固定比例；不计入日上限、不写账本。
 * @param {Record<string,number>} current 当前值
 * @param {Record<string,number>} baseline 基线值
 * @param {number} rate 回拉比例
 * @returns {Record<string,number>}
 */
export function applyBaselinePull(current = {}, baseline = {}, rate = PERSONALITY_RULES.BASELINE_PULL) {
    const safeRate = Number.isFinite(rate) ? Math.max(0, Math.min(1, rate)) : PERSONALITY_RULES.BASELINE_PULL;
    const keys = DIM_KEYS.filter((dim) => current[dim] !== undefined || baseline[dim] !== undefined);
    return Object.fromEntries(keys.map((dim) => {
        const base = Number.isFinite(baseline[dim]) ? baseline[dim] : 50;
        const value = Number.isFinite(current[dim]) ? current[dim] : base;
        return [dim, round1(value + (base - value) * safeRate)];
    }));
}

/** 基线值统一存为 0-100 整数。 */
function clampInt(value, fallback = 50) {
    const safeValue = Number.isFinite(value) ? value : fallback;
    return Math.max(0, Math.min(100, Math.round(safeValue)));
}

/**
 * 计算连续偏移导致的基线沉淀，不修改入参。
 * @param {{baseline:Record<string,number>,current:Record<string,number>,adapt?:Record<string,object>,now:number,enabled:boolean}} args 参数
 * @returns {{moves:Array<object>, nextAdapt:Record<string,object>}}
 */
export function computeBaselineAdapt({ baseline = {}, current = {}, adapt = {}, now = Date.now(), enabled = true } = {}) {
    const nextAdapt = {};
    const moves = [];
    const rules = PERSONALITY_RULES.BASELINE_ADAPT;

    for (const dim of DIM_KEYS) {
        const previous = adapt[dim] && typeof adapt[dim] === 'object' ? adapt[dim] : {};
        const previousLast = Number.isFinite(previous.lastAdaptAt) ? previous.lastAdaptAt : null;
        const base = Number.isFinite(baseline[dim]) ? baseline[dim] : 50;
        const value = Number.isFinite(current[dim]) ? current[dim] : base;
        const offset = round1(value - base);
        const dir = Math.abs(offset) >= rules.MIN_OFFSET ? Math.sign(offset) : 0;
        const streak = dir === 0 ? 0 : (previous.dir === dir ? Math.max(0, previous.streak || 0) + 1 : 1);
        nextAdapt[dim] = { streak, dir, lastAdaptAt: previousLast };

        if (!enabled || dir === 0 || streak < rules.STREAK_DAYS) continue;
        const cooldownReady = previousLast === null || now - previousLast >= rules.COOLDOWN_MS;
        if (!cooldownReady) continue;

        const rawStep = Math.max(-rules.MAX_STEP, Math.min(rules.MAX_STEP, offset * rules.RATIO));
        const after = clampInt(base + rawStep, base);
        const delta = round1(after - base);
        if (delta === 0) continue;
        moves.push({ dim, before: base, after, delta });
        nextAdapt[dim] = { streak: 0, dir, lastAdaptAt: now };
    }

    return { moves, nextAdapt };
}

/**
 * 0-100 值映射到五档下标。
 * @param {number} value 维度值
 * @returns {0|1|2|3|4}
 */
export function tierIndex(value) {
    const safeValue = Number.isFinite(value) ? value : 50;
    if (safeValue < 20) return 0;
    if (safeValue < 40) return 1;
    if (safeValue < 60) return 2;
    if (safeValue < 80) return 3;
    return 4;
}
