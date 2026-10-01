/**
 * emotionTurnTrigger - 情绪转折触发源（REQ-04）。
 *
 * 定位（docs/companion-upgrade/02-architecture.md REQ-04 2.4.1）：
 *   订阅 `user_emotion_turn` 事件（由 AiGirlfriend._persistAfterReply 在 ingestTurn 返回
 *   turned=true 时发布）→ evaluate 判断是否达到「情绪强转折」阈值 → 产出候选 →
 *   由 TriggerRegistry 入队 → ProactiveEngine.consumeEventQueue() 走 trigger() 全闸门。
 *
 * 纯函数原则：evaluate 不读文件、不 new Date()（时间从 ctx.now 取），便于单测。
 * 阈值全部来自 triggerEvents.js.TRIGGER_THRESHOLDS.emotion（唯一事实源，禁止硬编码）。
 */
import { TRIGGER_EVENTS, TRIGGER_DEFS, TRIGGER_THRESHOLDS } from '../triggerEvents.js';

const DEF = TRIGGER_DEFS.EMOTION_TURN;

/**
 * 判定一个情绪转折事件是否值得触发共情关怀。
 *
 * 放行条件（全部为「强转折」的正向信号，宁可漏发不可滥发）：
 *   1. turned=true（ingestTurn 已判定的显著转折）；
 *   2. 效价转负（valence ≤ negativeValenceMax）——只对「变差」共情，不打扰「变好」；
 *   3. 达到强度下限（intensity ≥ minIntensity）；
 *   4. 或趋势在明确下滑（declining / slope ≤ decliningSlopeMax）——兜底再抓一类。
 *
 * @param {object} payload - user_emotion_turn 事件 payload
 * @param {object} ctx - { event, now }
 * @returns {object|null} 命中返回候选（含 data/dedupeKey），否则 null
 */
export function evaluate(payload, ctx = {}) {
    if (!payload || typeof payload !== 'object') return null;

    const { valence, intensity, label, turned, ts } = payload;
    if (turned !== true) return null;                       // 非显著转折，交给轮询兜底
    if (typeof valence !== 'number' || valence > TRIGGER_THRESHOLDS.emotion.negativeValenceMax) {
        return null;                                        // 未转负（或转好）不共情
    }
    const strong = typeof intensity === 'number'
        && intensity >= TRIGGER_THRESHOLDS.emotion.minIntensity;
    const declining = !!(payload.trend && payload.trend.declining === true)
        || !!(payload.trend && typeof payload.trend.slope === 'number'
            && payload.trend.slope <= TRIGGER_THRESHOLDS.emotion.decliningSlopeMax);
    if (!strong && !declining) return null;                 // 强度与趋势都不够，判定为弱转折

    const now = Number.isFinite(ctx.now) ? ctx.now : (Number.isFinite(ts) ? ts : Date.now());
    // 去重键：同一情绪阶段（负向）在冷却窗内只关怀一次。用转负的「小时桶」而非精确 ts，
    // 避免同一场对话里连续多轮轻微波动被当成多次独立事件刷屏。
    const hourBucket = Math.floor(now / (60 * 60 * 1000));
    return {
        data: {
            valence,
            arousal: typeof payload.arousal === 'number' ? payload.arousal : 0,
            intensity: typeof intensity === 'number' ? intensity : 0,
            label: typeof label === 'string' ? label : '低落',
            trend: payload.trend && typeof payload.trend === 'object' ? payload.trend : null,
            ts: now,
        },
        dedupeKey: `emotion_turn:negative:${hourBucket}`,
    };
}

/**
 * 触发源定义（供 container.js 注册）。
 * evaluate 由本模块导出，其余元数据取自 triggerEvents.js 的唯一事实源。
 */
export const emotionTurnTrigger = {
    id: DEF.id,
    events: DEF.events.map((e) => e),   // 引用常量，不复制字面量
    evaluate,
    targetType: DEF.targetType,
    priority: DEF.priority,
    cooldownMs: DEF.cooldownMs,
    ttlMs: DEF.ttlMs,
};

export { TRIGGER_EVENTS };
export default emotionTurnTrigger;
