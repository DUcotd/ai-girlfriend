/**
 * anniversaryTrigger - 纪念日触发源（REQ-04）。
 *
 * 定位（docs/companion-upgrade/02-architecture.md REQ-04 2.4.1）：
 *   订阅 `narrative_milestone` 事件（type='anniversary'，由 AiGirlfriend 在
 *   getUpcomingAnniversaries() 命中临近纪念日时发布）→ evaluate 判断是否临近 →
 *   产出候选 → TriggerRegistry 入队 → ProactiveEngine.consumeEventQueue() 走 trigger() 全闸门。
 *
 * 依赖 T02（REQ-03 叙事层）：payload 里的 narrative 来自 NarrativeRetriever.getUpcomingAnniversaries()。
 * 纯函数原则：evaluate 不读文件、不 new Date()（时间从 ctx.now 取）。
 */
import { TRIGGER_EVENTS, TRIGGER_DEFS, TRIGGER_THRESHOLDS } from '../triggerEvents.js';

const DEF = TRIGGER_DEFS.ANNIVERSARY;

/**
 * 判定一个叙事里程碑事件是否为「临近的纪念日」。
 *
 * 放行条件：
 *   1. type === 'anniversary'（promise/其它类型交给别的触发源）；
 *   2. daysUntil 在 withinDays 窗内（0 天=今天，也放行）；
 *
 * @param {object} payload - narrative_milestone 事件 payload
 * @param {object} ctx - { event, now }
 * @returns {object|null} 命中返回候选，否则 null
 */
export function evaluate(payload, ctx = {}) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.type !== 'anniversary' && payload.anniversary !== true) return null;

    const daysUntil = Number.isFinite(payload.daysUntil)
        ? payload.daysUntil
        : (Number.isFinite(payload.daysAgo) ? -payload.daysAgo : null);
    if (daysUntil === null) return null;
    if (daysUntil > TRIGGER_THRESHOLDS.anniversary.withinDays) return null;
    // 已经过去超过 1 天的不再补提（避免翻旧账）
    if (daysUntil < -1) return null;

    const narrativeId = typeof payload.narrativeId === 'string' ? payload.narrativeId : 'unknown';
    return {
        data: {
            narrativeId,
            title: typeof payload.title === 'string' ? payload.title : '',
            daysUntil: daysUntil === 0 ? 0 : daysUntil,
            occurredAt: Number.isFinite(payload.occurredAt) ? payload.occurredAt : null,
            kind: 'anniversary',
        },
        // 同一条纪念日在冷却窗内只回顾一次
        dedupeKey: `anniversary:${narrativeId}:${Math.floor((Number.isFinite(ctx.now) ? ctx.now : Date.now()) / (24 * 60 * 60 * 1000))}`,
    };
}

/** 触发源定义（供 container.js 注册）。 */
export const anniversaryTrigger = {
    id: DEF.id,
    events: DEF.events.map((e) => e),
    evaluate,
    targetType: DEF.targetType,
    priority: DEF.priority,
    cooldownMs: DEF.cooldownMs,
    ttlMs: DEF.ttlMs,
};

export { TRIGGER_EVENTS };
export default anniversaryTrigger;
