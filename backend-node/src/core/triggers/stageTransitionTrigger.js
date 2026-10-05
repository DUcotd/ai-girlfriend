/**
 * stageTransitionTrigger - 关系跃迁触发源（REQ-06，B6-α②）。
 *
 * 定位：订阅 `stage_advanced` 事件（由 AiGirlfriend._finalize 在好感度跨过阶段线时发布）
 * → evaluate 判定是否值得专门说一句 → 候选入队 → ProactiveEngine.consumeEventQueue()
 * 走 trigger() 全闸门（情绪/ghost/配额/自发间隔/去重），**不旁路**。
 *
 * 为什么只做「向上」：向下的跃迁（她正在疏远他）同样是真的，但要不要由她主动点破，
 * 取决于 PRD §5 的 Q2「能否接受负面情绪」——那条还没拍板，所以这里先把事实发成事件
 * （状态可见、以后可接），候选一律返回 null。行为差异只写在这一处，别的地方不判方向。
 *
 * 纯函数原则：evaluate 不读文件；时间优先取 ctx.now，便于单测注入。
 */
import { TRIGGER_EVENTS, TRIGGER_DEFS } from '../triggerEvents.js';
import { RELATIONSHIP_STAGES } from '../relationshipStages.js';

const DEF = TRIGGER_DEFS.STAGE_ADVANCED;

const HOUR = 60 * 60 * 1000;

/** 取某个阶段的解锁项（措辞与关系说明书同源，都在 relationshipStages.js） */
function unlocksOf(stage) {
    return (RELATIONSHIP_STAGES.find(s => s.stage === stage) || {}).unlocks || [];
}

/**
 * 判定一次阶段跃迁是否值得她主动说出来。
 *
 * @param {object} payload - stage_advanced 事件 payload
 * @param {object} ctx - { event, now }
 * @returns {object|null} 命中返回候选（含 data/dedupeKey）
 */
export function evaluate(payload, ctx = {}) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.direction !== 'up') return null;

    const toStage = typeof payload.toStage === 'string' ? payload.toStage : '';
    const fromStage = typeof payload.fromStage === 'string' ? payload.fromStage : '';
    if (!toStage || !fromStage || toStage === fromStage) return null;

    const now = Number.isFinite(ctx.now) ? ctx.now
        : (Number.isFinite(payload.ts) ? payload.ts : Date.now());

    return {
        data: {
            fromStage,
            fromLabel: typeof payload.fromLabel === 'string' ? payload.fromLabel : fromStage,
            toStage,
            toLabel: typeof payload.toLabel === 'string' ? payload.toLabel : toStage,
            affinity: Number.isFinite(payload.affinity) ? payload.affinity : null,
            // 到这一层新解锁的行为：让她说得具体，而不是空泛的「我们更近了」
            unlocks: Array.isArray(payload.unlocks) && payload.unlocks.length > 0
                ? payload.unlocks
                : unlocksOf(toStage),
            ts: now,
        },
        // 按「天 + 目标阶段」去重：好感度在同一条阶段线上来回抖，一天之内只说一次，
        // 但真的又往前跨了一格（friend→close）时不该被上一格的键挡掉。
        dedupeKey: `stage_advanced:up:${toStage}:${Math.floor(now / HOUR / 24)}`,
    };
}

/** 触发源定义（供 container.js 注册），元数据取自 triggerEvents.js 唯一事实源 */
export const stageTransitionTrigger = {
    id: DEF.id,
    events: DEF.events.map((e) => e),
    evaluate,
    targetType: DEF.targetType,
    priority: DEF.priority,
    cooldownMs: DEF.cooldownMs,
    ttlMs: DEF.ttlMs,
};

export { TRIGGER_EVENTS };
export default stageTransitionTrigger;
