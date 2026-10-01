/**
 * promiseFollowupTrigger - 约定/承诺跟进触发源（REQ-04，同时是 REQ-05 的地基）。
 *
 * 定位（docs/companion-upgrade/02-architecture.md REQ-04 2.4.1）：
 *   订阅 `narrative_milestone` 事件（type='promise'，由 AiGirlfriend 从叙事层
 *   取出「约定」类事件后发布）→ evaluate 判断是否进入跟进窗 → 产出候选 →
 *   TriggerRegistry 入队 → ProactiveEngine.consumeEventQueue() 走 trigger() 全闸门。
 *
 * 依赖 T02（REQ-03 叙事层）：promise 是 narrativeTypes.js 的合法类型之一。
 * 纯函数原则：evaluate 不读文件、不 new Date()（时间从 ctx.now 取）。
 */
import { TRIGGER_EVENTS, TRIGGER_DEFS, TRIGGER_THRESHOLDS } from '../triggerEvents.js';

const DEF = TRIGGER_DEFS.PROMISE_FOLLOWUP;

/**
 * 判定一个叙事里程碑事件是否为「到跟进时机的约定」。
 *
 * 放行条件：
 *   1. type === 'promise'；
 *   2. 约定被记录的时间 occurredAt 距现在 ≥ followupAfterMs（有个「先给用户空间」的缓冲）；
 *   3. 未超过 followupMaxAgeMs（太老的约定不翻）；
 *   4. followupCount < maxFollowups（防同一条反复追问）。
 *
 * @param {object} payload - narrative_milestone 事件 payload
 * @param {object} ctx - { event, now }
 * @returns {object|null} 命中返回候选，否则 null
 */
export function evaluate(payload, ctx = {}) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.type !== 'promise') return null;

    const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
    const occurredAt = Number.isFinite(payload.occurredAt) ? payload.occurredAt : null;
    if (occurredAt === null) return null;

    const age = now - occurredAt;
    if (age < TRIGGER_THRESHOLDS.promise.followupAfterMs) return null;       // 还没到跟进时机
    if (age > TRIGGER_THRESHOLDS.promise.followupMaxAgeMs) return null;      // 太久远了不翻旧账

    const followupCount = Number.isFinite(payload.followupCount) ? payload.followupCount : 0;
    if (followupCount >= TRIGGER_THRESHOLDS.promise.maxFollowups) return null;

    const narrativeId = typeof payload.narrativeId === 'string' ? payload.narrativeId : 'unknown';
    return {
        data: {
            narrativeId,
            title: typeof payload.title === 'string' ? payload.title : '',
            summary: typeof payload.summary === 'string' ? payload.summary : '',
            occurredAt,
            followupCount,
            kind: 'promise',
        },
        // 同一条约定在同一「跟进轮次」内只追问一次（followupCount 抬高后 dedupeKey 自然变化）
        dedupeKey: `promise:${narrativeId}:${followupCount}`,
    };
}

/** 触发源定义（供 container.js 注册）。 */
export const promiseFollowupTrigger = {
    id: DEF.id,
    events: DEF.events.map((e) => e),
    evaluate,
    targetType: DEF.targetType,
    priority: DEF.priority,
    cooldownMs: DEF.cooldownMs,
    ttlMs: DEF.ttlMs,
};

export { TRIGGER_EVENTS };
export default promiseFollowupTrigger;
