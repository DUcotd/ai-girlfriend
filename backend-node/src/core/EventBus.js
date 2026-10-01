/**
 * EventBus - 进程内同步事件总线（REQ-04 事件层地基）。
 *
 * 为什么需要它：
 *   现状 ProactiveEngine 是 setInterval(60s) 定时轮询，无法表达「事件发生的那一刻」
 *   （用户情绪刚崩、纪念日到了）。事件层叠加在轮询之上，
 *   由 EventBus 承载「业务事件」（情绪转折、叙事里程碑、话题开闭…）。
 *
 * 设计要点（对照 docs/companion-upgrade/02-architecture.md REQ-04 2.4.3）：
 *   1. 极简 API：on / off / once / emit，无任何外部依赖。
 *   2. **同步派发**：emit 时按注册顺序依次调用 handler（不 await、不 microtask）。
 *      事件层是轮询的「前置钩子」，必须瞬时完成，不能引入异步竞态。
 *   3. **异常隔离**：单个 handler 抛异常会被捕获并记日志，绝不拖垮调用方，
 *      也不影响其他 handler（`_emit` 的 try/catch 保证）。
 *   4. 无持久化：事件是瞬时的；需要跨重启恢复的是「队列」，那由 TriggerRegistry 负责。
 *
 * 唯一事实源：事件名枚举在 ./triggerEvents.js，本文件不硬编码任何事件名字面量。
 */

/** 单个订阅者包一层 once 标记，off 时按原 handler 相等性比对 */
class Subscription {
    constructor(handler, once) {
        this.handler = handler;
        this.once = once;
    }
}

export class EventBus {
    constructor() {
        /**
         * event -> Subscription[]
         * 用 Map 而非对象：事件名可能来自外部字符串，避免 prototype 污染（如 'constructor'）。
         * @type {Map<string, Subscription[]>}
         */
        this._listeners = new Map();
    }

    /**
     * 订阅事件。
     * @param {string} event - 事件名（取自 triggerEvents.js 的 TRIGGER_EVENTS）
     * @param {Function} handler - 回调 (payload, event) => void
     * @returns {Function} 解绑函数（等价于 off(event, handler)，便于订阅方清理）
     */
    on(event, handler) {
        if (typeof event !== 'string' || !event) {
            throw new TypeError('[EventBus] on(event): event 必须是非空字符串');
        }
        if (typeof handler !== 'function') {
            throw new TypeError('[EventBus] on(event, handler): handler 必须是函数');
        }
        const list = this._listeners.get(event) || [];
        list.push(new Subscription(handler, false));
        this._listeners.set(event, list);
        // 返回解绑闭包：订阅方（如 AiGirlfriend）在 resetAll / 关闭事件层时一键清理
        return () => this.off(event, handler);
    }

    /**
     * 订阅一次：首次触发后自动解绑。
     * @param {string} event
     * @param {Function} handler
     * @returns {Function} 解绑函数
     */
    once(event, handler) {
        if (typeof event !== 'string' || !event) {
            throw new TypeError('[EventBus] once(event): event 必须是非空字符串');
        }
        if (typeof handler !== 'function') {
            throw new TypeError('[EventBus] once(event, handler): handler 必须是函数');
        }
        const list = this._listeners.get(event) || [];
        list.push(new Subscription(handler, true));
        this._listeners.set(event, list);
        return () => this.off(event, handler);
    }

    /**
     * 解绑事件（按原始 handler 相等性匹配；同时移除该 handler 的普通与 once 订阅）。
     * @param {string} event
     * @param {Function} handler
     * @returns {boolean} 是否移除了至少一个订阅
     */
    off(event, handler) {
        const list = this._listeners.get(event);
        if (!list || list.length === 0) return false;
        const before = list.length;
        const kept = list.filter((sub) => sub.handler !== handler);
        if (kept.length === 0) this._listeners.delete(event);
        else this._listeners.set(event, kept);
        return kept.length < before;
    }

    /**
     * 同步派发事件。**永不抛出**：单个 handler 的异常被吞掉并记日志。
     *
     * 关键实现细节：
     *   - 先取订阅列表的**快照**再遍历：handler 内部若 off/on 改动列表，
     *     不会影响本轮派发（避免迭代中删除元素导致的漏发/乱序）。
     *   - once 订阅在调用前先从列表移除，但**仍包含在本轮快照中**只调一次。
     *   - payload 缺省统一为 {} 而非 undefined，让 evaluate(payload) 的字段访问安全。
     *
     * @param {string} event
     * @param {object} [payload]
     * @returns {number} 实际被调用的 handler 数量（便于测试断言）
     */
    emit(event, payload = {}) {
        if (typeof event !== 'string' || !event) return 0;
        const list = this._listeners.get(event);
        if (!list || list.length === 0) return 0; // 无订阅者：O(1) 零开销返回

        // 快照：即使 handler 内部增删订阅，本轮也只调用快照里的订阅者
        const snapshot = [...list];

        // once 订阅在本轮派发前从活动列表中摘除（先摘除，再统一同步调用）
        const onceSubs = snapshot.filter((sub) => sub.once);
        if (onceSubs.length > 0) {
            const remaining = list.filter((sub) => !sub.once);
            if (remaining.length === 0) this._listeners.delete(event);
            else this._listeners.set(event, remaining);
        }

        let delivered = 0;
        for (const sub of snapshot) {
            try {
                sub.handler(payload, event);
                delivered++;
            } catch (e) {
                // 异常隔离：单个订阅者失败不影响其他订阅者，也不冒泡给 emit 调用方
                console.error(
                    `[EventBus] handler for '${event}' threw: ${e?.message || e}`
                );
            }
        }
        return delivered;
    }

    /** 当前某事件的有效订阅数（测试/状态展示用） */
    listenerCount(event) {
        const list = this._listeners.get(event);
        return list ? list.length : 0;
    }

    /** 清空所有订阅（resetAll / 关闭事件层时使用） */
    clear() {
        this._listeners.clear();
    }
}

export default EventBus;
