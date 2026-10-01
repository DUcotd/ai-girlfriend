/**
 * TriggerRegistry - 触发源统一注册表 + 事件队列（REQ-04 事件层核心）。
 *
 * 职责（对照 docs/companion-upgrade/02-architecture.md REQ-04 2.4.3）：
 *   1. register(triggerDef)   —— 注册触发源（id / events / evaluate / targetType / priority / cooldown / ttl）
 *   2. attach(bus)            —— 订阅所有触发源声明的事件
 *   3. _onEvent(event,payload)—— 遍历订阅该事件的触发源 → evaluate() → 命中则入队
 *   4. consume()              —— 取出优先级最高、未过期的一条候选（写冷却/去重）
 *   5. getStatus()            —— 队列快照 + 各触发源冷却状态
 *   6. 持久化 data/trigger_state.json（队列 + 冷却 + 去重标记）
 *
 * **与 ProactiveEngine 的契约**：consume() 只产出「候选请求」，
 * 是否真正发送由 ProactiveEngine.trigger() 的全闸门（情绪/ghost/配额/自发间隔/去重）决定。
 * 事件触发**不得**绕过 trigger() 直接发消息——复用而非旁路。
 *
 * 关键设计：
 *   - evaluate 是「纯函数」性质的判定，由调用方（ProactiveEngine）注入，实现业务与基建解耦。
 *   - 持久化走去抖写盘（对照 MemoryStore），禁止每轮全量重写。
 *   - 队列排序：priority 降序，同级 createdAt 升序（先来先出，FIFO 公平）。
 *   - 队列上限：超出丢优先级最低（同级丢最新入队的，保留更早的候补）。
 */

import { dataPath, readJson, writeJson } from '../utils/jsonStore.js';
import {
    TRIGGER_EVENTS,
    TRIGGER_EVENT_NAMES,
    TRIGGER_REGISTRY_CONFIG,
    TRIGGER_STATE_FILE,
} from './triggerEvents.js';

/**
 * 模块级运行时开关。
 * 允许「运行时可切换」——setEventLayerEnabled(true/false) 无需重启进程；
 * 初始值取自 TRIGGER_REGISTRY_CONFIG.enabled（可被 env 覆盖）。
 * 为什么用模块级变量而非实例字段：consumeEventQueue() 的 O(1) 预检需要在不触达
 * 任何实例内部状态的前提下判断，避免事件层关闭时引入额外调用开销。
 */
let _eventLayerEnabled = TRIGGER_REGISTRY_CONFIG.enabled;

/** 运行时覆盖事件层总开关（enabled=false 一键回退纯轮询） */
export function setEventLayerEnabled(enabled) {
    _eventLayerEnabled = !!enabled;
    console.log(`[TriggerRegistry] Event layer ${_eventLayerEnabled ? 'ENABLED' : 'DISABLED'}`);
    return _eventLayerEnabled;
}

/** 读取当前事件层开关状态 */
export function isEventLayerEnabled() {
    return _eventLayerEnabled;
}

/** 生成短随机后缀，避免同一毫秒内多条候选 id 冲突 */
function randomSuffix() {
    return Math.random().toString(36).slice(2, 8);
}

export class TriggerRegistry {
    /**
     * @param {object} options
     * @param {import('./EventBus.js').EventBus} [options.bus] - 事件总线（可后续 attach）
     * @param {object} [options.config] - 覆盖 TRIGGER_REGISTRY_CONFIG 的部分字段
     */
    constructor({ bus = null, config = {} } = {}) {
        /** 事件总线引用 */
        this.bus = bus;
        /** 生效配置（TRIGGER_REGISTRY_CONFIG 为默认值） */
        this.config = { ...TRIGGER_REGISTRY_CONFIG, ...config };

        /**
         * 触发源注册表：id -> { id, events, evaluate, targetType, priority, cooldownMs, ttlMs }
         * @type {Map<string, object>}
         */
        this.triggers = new Map();

        /** 事件名 -> 触发源 id 列表（attach 时构建，派发时 O(订阅数) 遍历） */
        this.subscribers = new Map();

        /**
         * 事件候选队列。每项：
         * { id, triggerId, targetType, priority, data, dedupeKey, createdAt, expiresAt }
         * @type {Array<object>}
         */
        this.eventQueue = [];

        /** 触发源冷却时间戳：triggerId -> 上次命中时间（毫秒） */
        this.cooldowns = {};

        /** 去重标记：dedupeKey -> 首次入队时间（毫秒） */
        this.dedupeSeen = {};

        /** bus 解绑函数列表（reset / detach 时清理订阅） */
        this._unsubscribers = [];

        /** 去抖写盘定时器 */
        this._saveTimer = null;
        this._dirty = false;

        this._load();
    }

    // ==================== 持久化 ====================

    _load() {
        const data = readJson(TRIGGER_STATE_FILE, null);
        if (!data || typeof data !== 'object') return;

        if (Array.isArray(data.eventQueue)) {
            const now = Date.now();
            this.eventQueue = data.eventQueue
                .filter((q) => q && typeof q === 'object' && typeof q.triggerId === 'string')
                // 恢复时丢弃已过期候选（重启期间过期的没必要再带着）
                .filter((q) => !q.expiresAt || q.expiresAt > now)
                .slice(0, this.config.maxQueueSize);
        }
        if (data.cooldowns && typeof data.cooldowns === 'object') {
            this.cooldowns = Object.fromEntries(
                Object.entries(data.cooldowns).filter(([, v]) => typeof v === 'number')
            );
        }
        if (data.dedupeSeen && typeof data.dedupeSeen === 'object') {
            this.dedupeSeen = Object.fromEntries(
                Object.entries(data.dedupeSeen).filter(([, v]) => typeof v === 'number')
            );
        }
        console.log(
            `[TriggerRegistry] Restored state (queue=${this.eventQueue.length}, cooldowns=${Object.keys(this.cooldowns).length})`
        );
    }

    /** 去抖写盘（对照 MemoryStore.scheduleSave）：合并高频变更，禁止每轮全量重写 */
    scheduleSave() {
        this._dirty = true;
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this.flush();
        }, this.config.flushDebounceMs);
        // 去抖定时器不应阻止进程退出
        if (typeof this._saveTimer.unref === 'function') this._saveTimer.unref();
    }

    /** 立即落盘（幂等；无待写数据时空操作）。停机前必须调用 */
    flush() {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        if (!this._dirty) return;
        this._dirty = false;
        writeJson(TRIGGER_STATE_FILE, {
            version: this.config.stateVersion,
            eventQueue: this.eventQueue,
            cooldowns: this.cooldowns,
            dedupeSeen: this.dedupeSeen,
            lastUpdated: new Date().toISOString(),
        });
    }

    // ==================== 注册与订阅 ====================

    /**
     * 注册一个触发源。
     * @param {object} triggerDef
     * @param {string} triggerDef.id
     * @param {string[]} triggerDef.events - 订阅事件名（取自 TRIGGER_EVENTS）
     * @param {(payload: object, ctx: object) => (object|null)} triggerDef.evaluate - 判定；命中返回候选 data，否则 null
     * @param {string} triggerDef.targetType - 目标 ProactiveEngine type
     * @param {number} [triggerDef.priority] - 队列优先级（默认 0）
     * @param {number} [triggerDef.cooldownMs] - 冷却毫秒（默认 0 = 无冷却）
     * @param {number} [triggerDef.ttlMs] - 候选存活毫秒（默认 1 小时）
     * @returns {boolean} 是否注册成功
     */
    register(triggerDef) {
        if (!triggerDef || typeof triggerDef !== 'object') {
            console.warn('[TriggerRegistry] register: triggerDef 非法，已忽略');
            return false;
        }
        const { id, events, evaluate, targetType } = triggerDef;
        if (typeof id !== 'string' || !id) {
            console.warn('[TriggerRegistry] register: triggerDef.id 缺失，已忽略');
            return false;
        }
        if (!Array.isArray(events) || events.length === 0) {
            console.warn(`[TriggerRegistry] register(${id}): events 为空，已忽略`);
            return false;
        }
        if (typeof evaluate !== 'function') {
            console.warn(`[TriggerRegistry] register(${id}): evaluate 必须是函数，已忽略`);
            return false;
        }
        if (typeof targetType !== 'string' || !targetType) {
            console.warn(`[TriggerRegistry] register(${id}): targetType 缺失，已忽略`);
            return false;
        }
        // 未知事件名只告警不阻断：扩展期订阅 P1 事件不应让装配整体失败
        for (const ev of events) {
            if (!TRIGGER_EVENT_NAMES.includes(ev)) {
                console.warn(`[TriggerRegistry] register(${id}): 未知事件名 '${ev}'（仍注册，派发时自然不会命中）`);
            }
        }

        this.triggers.set(id, {
            id,
            events: [...events],
            evaluate,
            targetType,
            priority: Number.isFinite(triggerDef.priority) ? triggerDef.priority : 0,
            cooldownMs: Number.isFinite(triggerDef.cooldownMs) ? triggerDef.cooldownMs : 0,
            ttlMs: Number.isFinite(triggerDef.ttlMs) && triggerDef.ttlMs > 0
                ? triggerDef.ttlMs
                : 60 * 60 * 1000,
        });
        return true;
    }

    /**
     * 订阅总线：为每个触发源声明的事件挂上派发回调。
     * 幂等：重复 attach 会先清理旧订阅，避免重复派发。
     * @param {import('./EventBus.js').EventBus} bus
     */
    attach(bus) {
        if (!bus || typeof bus.on !== 'function') {
            console.warn('[TriggerRegistry] attach: bus 非法，跳过');
            return;
        }
        // 先解绑旧订阅（若之前 attach 过同一 bus）
        this.detach();
        this.bus = bus;

        // 事件名 -> 触发源 id 列表
        this.subscribers = new Map();
        for (const trigger of this.triggers.values()) {
            for (const ev of trigger.events) {
                const list = this.subscribers.get(ev) || [];
                list.push(trigger.id);
                this.subscribers.set(ev, list);
            }
        }

        // 只对「确实有触发源订阅」的事件挂一个总线回调，减少无谓的 emit 派发
        for (const ev of this.subscribers.keys()) {
            const unsub = bus.on(ev, (payload) => this._onEvent(ev, payload));
            if (typeof unsub === 'function') this._unsubscribers.push(unsub);
        }
        console.log(`[TriggerRegistry] Attached to bus (${this.triggers.size} triggers, ${this.subscribers.size} events)`);
    }

    /** 解绑总线订阅 */
    detach() {
        for (const unsub of this._unsubscribers) {
            try { unsub(); } catch { /* 解绑失败不影响流程 */ }
        }
        this._unsubscribers = [];
        this.subscribers = new Map();
    }

    // ==================== 事件派发 ====================

    /**
     * 收到事件：遍历订阅该事件的触发源 → evaluate → 命中则入队。
     * 单个触发源的 evaluate 抛异常不影响其他触发源（try/catch 隔离）。
     * @param {string} event
     * @param {object} payload
     */
    _onEvent(event, payload = {}) {
        const ids = this.subscribers.get(event);
        if (!ids || ids.length === 0) return;

        const now = Date.now();
        for (const id of ids) {
            const trigger = this.triggers.get(id);
            if (!trigger) continue;

            let candidate = null;
            try {
                candidate = trigger.evaluate(payload, { event, now });
            } catch (e) {
                console.error(`[TriggerRegistry] trigger '${id}' evaluate threw: ${e?.message || e}`);
                continue;
            }
            if (!candidate || typeof candidate !== 'object') continue;

            this._enqueue(trigger, candidate, now);
        }
        // 入队后去抖落盘
        this.scheduleSave();
    }

    /**
     * 候选入队：冷却检查 → 去重检查 → 构造队列项 → 上限裁剪。
     * @param {object} trigger
     * @param {object} candidate - evaluate 返回的候选（含 data；可选覆盖 priority/dedupeKey）
     * @param {number} now
     * @returns {boolean} 是否成功入队
     */
    _enqueue(trigger, candidate, now = Date.now()) {
        // 冷却检查：冷却期内同一触发源不再入队
        const lastFired = this.cooldowns[trigger.id] || 0;
        if (trigger.cooldownMs > 0 && (now - lastFired) < trigger.cooldownMs) {
            return false;
        }

        // 去重键：候选可自带 dedupeKey，否则用 trigger 默认键
        const dedupeKey = typeof candidate.dedupeKey === 'string' && candidate.dedupeKey
            ? candidate.dedupeKey
            : `${trigger.id}:auto`;

        // 去重检查：同键已见过（在保留窗内）则丢弃
        const seenAt = this.dedupeSeen[dedupeKey];
        if (typeof seenAt === 'number' && (now - seenAt) < this.config.dedupeRetentionMs) {
            return false;
        }

        const ttlMs = Number.isFinite(candidate.ttlMs) && candidate.ttlMs > 0
            ? candidate.ttlMs
            : trigger.ttlMs;

        const item = {
            id: `q_${now}_${randomSuffix()}`,
            triggerId: trigger.id,
            targetType: candidate.targetType || trigger.targetType,
            priority: Number.isFinite(candidate.priority) ? candidate.priority : trigger.priority,
            data: candidate.data && typeof candidate.data === 'object' ? candidate.data : {},
            dedupeKey,
            createdAt: now,
            expiresAt: now + ttlMs,
        };

        // 去重标记在**入队时**写入：冷却/去重是「防重复事件」而非「防重复发送」，
        // 是否真正发送由 ProactiveEngine.trigger() 全闸门决定（见类注释契约）。
        this.dedupeSeen[dedupeKey] = now;
        this.cooldowns[trigger.id] = now;

        this.eventQueue.push(item);
        this._sortQueue();
        this._capQueue();

        console.log(`[TriggerRegistry] Queued candidate from '${trigger.id}' (target=${item.targetType}, size=${this.eventQueue.length})`);
        return true;
    }

    /** 队列排序：priority 降序，同级 createdAt 升序（FIFO） */
    _sortQueue() {
        this.eventQueue.sort((a, b) =>
            (b.priority - a.priority) || (a.createdAt - b.createdAt)
        );
    }

    /** 队列上限裁剪：超出丢优先级最低（同级丢最新入队者，保留更早候补） */
    _capQueue() {
        if (this.eventQueue.length <= this.config.maxQueueSize) return;
        this.eventQueue = this.eventQueue.slice(0, this.config.maxQueueSize);
    }

    /** 丢弃过期候补（不占任何配额；由 consume / getStatus 惰性触发） */
    _prune() {
        if (this.eventQueue.length === 0) return;
        const now = Date.now();
        const before = this.eventQueue.length;
        this.eventQueue = this.eventQueue.filter((q) => !q.expiresAt || q.expiresAt > now);
        if (this.eventQueue.length !== before) this.scheduleSave();
    }

    /** 清理过老的去重标记，防 dedupeSeen 无界增长 */
    _pruneDedupe(now = Date.now()) {
        const cutoff = now - this.config.dedupeRetentionMs;
        let changed = false;
        for (const [key, ts] of Object.entries(this.dedupeSeen)) {
            if (ts < cutoff) {
                delete this.dedupeSeen[key];
                changed = true;
            }
        }
        return changed;
    }

    // ==================== 消费 ====================

    /**
     * 取出优先级最高、未过期的一条候选。**不改变冷却/去重**（已在入队时写）。
     * @returns {{triggerId: string, targetType: string, data: object}|null}
     */
    consume() {
        this._prune();
        if (this.eventQueue.length === 0) return null;

        const item = this.eventQueue.shift();
        this.scheduleSave();
        return {
            triggerId: item.triggerId,
            targetType: item.targetType,
            data: item.data,
        };
    }

    /**
     * 将某条候选放回队列头部（供 ProactiveEngine 消费但 trigger 失败时重排）。
     * 注意：本次实现不主动回填（符合「新增 type 命中失败不记账、下轮可重试」的语义——
     * 事件会在下次 emit 时重新判定），此方法作为扩展点保留。
     * @param {{triggerId: string, targetType: string, data: object}} _candidate
     * @returns {boolean} 是否放回成功
     */
    requeue(_candidate) {
        // 预留扩展点：当前不实现回填，避免与冷却语义冲突
        return false;
    }

    // ==================== 状态 ====================

    /**
     * 队列快照 + 各触发源下次可触发时间（供 getStatus / 路由展示）。
     * @returns {{enabled: boolean, queueSize: number, queue: Array<object>, cooldowns: object, nextEligible: object, triggers: string[]}}
     */
    getStatus() {
        this._prune();
        const now = Date.now();
        const nextEligible = {};
        for (const trigger of this.triggers.values()) {
            const last = this.cooldowns[trigger.id] || 0;
            nextEligible[trigger.id] = (trigger.cooldownMs > 0 && last)
                ? last + trigger.cooldownMs
                : null;
        }
        return {
            enabled: _eventLayerEnabled,
            queueSize: this.eventQueue.length,
            queue: this.eventQueue.map((q) => ({
                id: q.id,
                triggerId: q.triggerId,
                targetType: q.targetType,
                priority: q.priority,
                dedupeKey: q.dedupeKey,
                createdAt: q.createdAt,
                expiresAt: q.expiresAt,
            })),
            cooldowns: { ...this.cooldowns },
            nextEligible,
            triggers: [...this.triggers.keys()],
        };
    }

    // ==================== 重置 ====================

    /** 清空队列/冷却/去重标记（resetAll 用，容错友好：内部全防御式） */
    reset() {
        this.eventQueue = [];
        this.cooldowns = {};
        this.dedupeSeen = {};
        this.scheduleSave();
    }
}

export default TriggerRegistry;
