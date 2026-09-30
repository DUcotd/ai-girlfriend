/**
 * ProactiveEngine - 主动消息引擎（2026-09-29 重构）
 *
 * 重构要点（对照重构前的问题）：
 * 1. 类型目录外置到 ./proactiveTypes.js —— 冷却/优先级/时间窗/时效只定义一次
 *    （此前 cooldowns、priority、路由的 PROACTIVE_TYPES 是三份各自维护的重复表）。
 * 2. 阶段经济参数按 relationshipStages.js 的 stage 名挂载，不再复制 15/34/59/84
 *    这组阈值（阈值唯一事实源是 relationshipStages.js，与 EmotionEngine 的
 *    TIER_PAD 用同一套写法）。
 * 3. 配置 / 当日计数 / 各类冷却时间戳 / 待送队列 全部落盘 data/proactive_state.json。
 *    此前全在内存里：后端一重启，用户设置和配额直接回到默认值，问候可能重复发。
 * 4. 队列消息带 TTL：过期未送达的丢弃并退还当日配额。此前队列最长缓 5 条且永不过期，
 *    会出现"早上 8 点生成、晚上 22 点才送到"的错时消息。
 * 5. 深夜免打扰（23:30–07:00）：想念/回忆/闲聊/情绪关怀不打扰；定时问候与任务提醒不受限。
 * 6. 定时问候改为「时间窗内每天一次」（07:30–09:30 / 21:30–23:30），
 *    不再要求恰好落在整点后 5 分钟内——进程启动稍晚就会整天不发。
 * 7. check() / trigger() 单飞：LLM 生成慢于轮询间隔时不再叠加并发请求。
 * 8. getStatus() 暴露足够前端渲染的状态（今日已发/上限/静音时段/各类下次可发时间）。
 *
 * 任务清单系统重构追加：
 * 9. 支持 `quotaExempt` 类型：每日配额闸从「_runCheck 开头一行 return」改成「一个标志位」，
 *    trigger() 不 ++、_pruneQueue() 不退还。任务提醒是用户自己设的，不该被配额吃掉。
 * 10. 任务提醒改为消费 TaskManager.getReminderCandidates()（overdue > custom > due），
 *     **await trigger() 返回 true（真的入队了）才写去重标记**，失败下轮重试。
 */

import TaskManager, { REMINDER_KIND, OVERDUE_WINDOW } from './TaskManager.js';
import LifeSimulator from './LifeSimulator.js';
import { dataPath, readJson, writeJson } from '../utils/jsonStore.js';
import { dayKey } from '../utils/dayKey.js';
import { getStageForAffinity } from './relationshipStages.js';
import {
    PROACTIVE_TYPES,
    PROACTIVE_TYPE_IDS,
    DEFAULT_ENABLED_TYPES,
    FALLBACK_TYPE,
    getProactiveType,
} from './proactiveTypes.js';

const STATE_FILE = 'proactive_state.json';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/**
 * 阶段 → 主动消息经济参数。
 * 阈值（15/34/59/84）不在这里，仍由 relationshipStages.js 决定；
 * 这里只按 stage 名挂参数，与 EmotionEngine 的 TIER_PAD 同一套路。
 */
const STAGE_ECONOMY = {
    stranger: { bonus: 0.5, dailyBase: 3 },
    acquaintance: { bonus: 0.8, dailyBase: 5 },
    friend: { bonus: 1.0, dailyBase: 8 },
    close: { bonus: 1.3, dailyBase: 12 },
    lover: { bonus: 1.6, dailyBase: 15 },
};

/** 频率档位：cooldown 缩放冷却，dailyLimit 缩放每日上限 */
const FREQUENCY = {
    low: { cooldown: 2.0, dailyLimit: 0.5 },
    medium: { cooldown: 1.0, dailyLimit: 1.0 },
    high: { cooldown: 0.7, dailyLimit: 1.5 },
};

/** 深夜免打扰时段（当天分钟数，跨零点） */
const QUIET_HOURS = { from: 23 * 60 + 30, to: 7 * 60 };

/** 用户多久没出现算「想念」 */
const MISS_YOU_IDLE_MS = 2 * HOUR;

// 本地自然日 key 已抽到 utils/dayKey.js：好感度日上限与本引擎每日配额共用同一口径。
// （此前它是本文件私有函数，AffinityEngine 复用时会造成 core → core 的依赖方向。）

const minutesOfDay = (d) => d.getHours() * 60 + d.getMinutes();

const hhmm = (mins) =>
    `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/**
 * 从候选里挑一条发出去。
 *
 * 候选已按 overdue > custom > due 排好序，这里只做**时段**过滤：
 * 逾期提醒是「补漏」性质，凌晨 3 点说「你昨天的事没做」是骚扰，限 07:00–23:00；
 * 到期前与自定义提醒是即时性的，保持全天可发（沿用既有的 quietExempt 语义）。
 *
 * @param {Array<{task: object, kind: string}>} candidates - TaskManager.getReminderCandidates() 结果
 * @param {Date} now
 * @returns {{task: object, kind: string}|null}
 */
function pickReminderCandidate(candidates, now) {
    const nowMinutes = minutesOfDay(now);
    const inOverdueWindow = nowMinutes >= OVERDUE_WINDOW.from && nowMinutes <= OVERDUE_WINDOW.to;

    for (const candidate of candidates) {
        if (candidate.kind === REMINDER_KIND.overdue && !inOverdueWindow) continue;
        return candidate;
    }
    return null;
}

class ProactiveEngine {
    constructor(aiGirlfriend) {
        this.aiGirlfriend = aiGirlfriend;

        this.config = {
            enabled: true,
            frequencyLevel: 'medium',
            customDailyLimit: null,
            enabledTypes: [...DEFAULT_ENABLED_TYPES],
        };

        this.messageQueue = [];
        this.maxQueueSize = 5;
        this.lastTriggerTime = Date.now();
        this.lastUserActiveTime = Date.now();
        this.checkInterval = 60000;
        this.lastTriggerByType = {};
        this.dailyMessageCount = 0;
        this.lastDayKey = dayKey();
        /** { [typeId]: 'YYYY-MM-DD' } 定时问候的「今天已发」标记 */
        this.sentDays = {};
        /** 最近一次评估过的 random_chat 30 分钟时隙 key，避免同一时隙反复掷骰子 */
        this.lastRandomSlotKey = null;
        this.lifeSimulator = new LifeSimulator();

        // 并发保护
        this._checking = false;
        this._inflight = new Set();

        this._loadState();
        this.start();
    }

    // ==================== 持久化 ====================

    _loadState() {
        const data = readJson(STATE_FILE, null);
        if (!data) return;

        if (data.config) this._applyConfig(data.config, { silent: true });

        if (typeof data.dailyMessageCount === 'number' && data.dailyMessageCount >= 0) {
            this.dailyMessageCount = data.dailyMessageCount;
        }
        if (typeof data.lastDayKey === 'string') this.lastDayKey = data.lastDayKey;
        if (data.lastTriggerByType && typeof data.lastTriggerByType === 'object') {
            this.lastTriggerByType = Object.fromEntries(
                Object.entries(data.lastTriggerByType)
                    .filter(([k, v]) => PROACTIVE_TYPE_IDS.includes(k) && typeof v === 'number')
            );
        }
        if (data.sentDays && typeof data.sentDays === 'object') {
            this.sentDays = Object.fromEntries(
                Object.entries(data.sentDays).filter(([k]) => PROACTIVE_TYPE_IDS.includes(k))
            );
        }
        if (typeof data.lastRandomSlotKey === 'string') {
            this.lastRandomSlotKey = data.lastRandomSlotKey;
        }
        if (typeof data.lastTriggerTime === 'number') this.lastTriggerTime = data.lastTriggerTime;

        // 队列也持久化：重启前刚生成、还没被前端取走的消息不该丢
        if (Array.isArray(data.queue)) {
            this.messageQueue = data.queue
                .filter(m => m && typeof m.content === 'string' && PROACTIVE_TYPE_IDS.includes(m.reason))
                .slice(0, this.maxQueueSize);
        }

        this._pruneQueue();
        console.log(`[ProactiveEngine] Restored state (daily=${this.dailyMessageCount}, queue=${this.messageQueue.length})`);
    }

    _saveState() {
        writeJson(STATE_FILE, {
            config: this.config,
            dailyMessageCount: this.dailyMessageCount,
            lastDayKey: this.lastDayKey,
            lastTriggerByType: this.lastTriggerByType,
            sentDays: this.sentDays,
            lastRandomSlotKey: this.lastRandomSlotKey,
            lastTriggerTime: this.lastTriggerTime,
            queue: this.messageQueue,
            lastUpdated: new Date().toISOString(),
        });
    }

    // ==================== 配置 ====================

    /**
     * 校验并写入配置（不落盘由调用方决定，便于构造期静默恢复）。
     * 非法字段一律忽略而不是清空——重复下发部分字段不会打掉其余设置。
     */
    _applyConfig(newConfig = {}, { silent = false } = {}) {
        if (typeof newConfig.enabled === 'boolean') this.config.enabled = newConfig.enabled;

        if (typeof newConfig.frequencyLevel === 'string' &&
            Object.keys(FREQUENCY).includes(newConfig.frequencyLevel)) {
            this.config.frequencyLevel = newConfig.frequencyLevel;
        }

        if (typeof newConfig.customDailyLimit === 'number' &&
            Number.isFinite(newConfig.customDailyLimit) && newConfig.customDailyLimit >= 0) {
            this.config.customDailyLimit = Math.round(newConfig.customDailyLimit);
        } else if (newConfig.customDailyLimit === null) {
            this.config.customDailyLimit = null;
        }

        if (Array.isArray(newConfig.enabledTypes)) {
            this.config.enabledTypes = [...new Set(
                newConfig.enabledTypes.filter(t => PROACTIVE_TYPE_IDS.includes(t))
            )];
        }

        if (!silent) console.log(
            `[ProactiveEngine] Config updated: ${JSON.stringify(this.config)} (types=${this.config.enabledTypes.length})`
        );
        return this.config;
    }

    updateConfig(newConfig = {}) {
        const result = this._applyConfig(newConfig);
        this._saveState();
        return result;
    }

    getConfig() { return { ...this.config, enabledTypes: [...this.config.enabledTypes] }; }

    get triggerCooldowns() {
        const multiplier = FREQUENCY[this.config.frequencyLevel]?.cooldown ?? 1.0;
        const adjusted = {};
        for (const type of PROACTIVE_TYPES) {
            adjusted[type.id] = type.fixedCooldown
                ? type.baseCooldown
                : Math.round(type.baseCooldown * multiplier);
        }
        return adjusted;
    }

    // ==================== 生命周期 ====================

    start() {
        if (this.interval) clearInterval(this.interval);
        this.interval = setInterval(() => this.check(), this.checkInterval);
        console.log("[ProactiveEngine] Started with enhanced triggers");
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        if (this.lifeSimulator) {
            this.lifeSimulator.stop();
        }
        this._saveState();
        console.log("[ProactiveEngine] Stopped");
    }

    // ==================== 用户活动 ====================

    notifyUserActive() {
        const inactiveTime = Date.now() - this.lastUserActiveTime;
        const wasInactive = inactiveTime > 30 * MIN;
        const inactiveMinutes = Math.floor(inactiveTime / MIN);
        this.lastUserActiveTime = Date.now();
        // 总开关：这是 check() 之外的第二个触发入口，此前不查 enabled，
        // 关掉总开关后「欢迎回来」仍会真实调 LLM 生成入队
        if (!this.config.enabled) return;
        if (!wasInactive || !this.canTrigger('life_update')) return;

        // 深夜不打扰：回来很晚也只记时间，不发「欢迎回来」
        if (this.isQuietHours() && !getProactiveType('life_update')?.quietExempt) return;

        const lifeSummary = this.lifeSimulator.getWelcomeBackSummary(inactiveMinutes);
        this.trigger('life_update', {
            inactiveMinutes,
            activities: lifeSummary.activities,
            currentActivity: lifeSummary.currentActivity,
        });
    }

    // ==================== 经济参数（阶段派生） ====================

    getStage() { return getStageForAffinity(this.aiGirlfriend.affinity ?? 35); }

    getAffinityBonus() {
        return STAGE_ECONOMY[this.getStage().stage]?.bonus ?? 1.0;
    }

    /** 自动档每日上限（不含自定义覆盖）——前端也要显示这个数 */
    getAutoDailyLimit() {
        const baseLimit = STAGE_ECONOMY[this.getStage().stage]?.dailyBase ?? 8;
        const multiplier = FREQUENCY[this.config.frequencyLevel]?.dailyLimit ?? 1.0;
        return Math.round(baseLimit * multiplier);
    }

    getDailyLimit() {
        return this.config.customDailyLimit !== null
            ? this.config.customDailyLimit
            : this.getAutoDailyLimit();
    }

    // ==================== 时段 ====================

    isQuietHours(now = new Date()) {
        const m = minutesOfDay(now);
        return m >= QUIET_HOURS.from || m < QUIET_HOURS.to;
    }

    getQuietHoursInfo(now = new Date()) {
        return {
            active: this.isQuietHours(now),
            from: hhmm(QUIET_HOURS.from),
            to: hhmm(QUIET_HOURS.to),
        };
    }

    _inWindow(nowMinutes, window) {
        if (!window) return true;
        return nowMinutes >= window.from && nowMinutes <= window.to;
    }

    // ==================== 冷却与配额 ====================

    /** 该类型是否豁免每日配额（任务提醒：用户自己设的，不该被配额吃掉） */
    _isQuotaExempt(typeId) {
        return !!getProactiveType(typeId)?.quotaExempt;
    }

    /** 今天还剩配额吗 */
    _hasQuota() {
        return this.dailyMessageCount < this.getDailyLimit();
    }

    canTrigger(type) {
        if (!this.config.enabledTypes.includes(type)) return false;
        const cooldown = this.triggerCooldowns[type] ?? HOUR;
        const lastTrigger = this.lastTriggerByType[type] || 0;
        return (Date.now() - lastTrigger) >= cooldown;
    }

    _resetDailyCountIfNeeded() {
        const today = dayKey();
        if (today !== this.lastDayKey) {
            this.dailyMessageCount = 0;
            this.lastDayKey = today;
            this._saveState();
        }
    }

    _sentToday(type) {
        return this.sentDays[type] === dayKey();
    }

    /** 丢弃过期未送达的消息，并退还其占用的当日配额 */
    _pruneQueue() {
        if (this.messageQueue.length === 0) return;
        const now = Date.now();
        const kept = [];
        for (const m of this.messageQueue) {
            if (m.expiresAt && m.expiresAt <= now) {
                // 豁免类型从来没占过配额，退回去会让计数变负/偏小（变相超发）
                if (!this._isQuotaExempt(m.reason)) {
                    this.dailyMessageCount = Math.max(0, this.dailyMessageCount - 1);
                }
                console.log(`[ProactiveEngine] Dropped expired message: ${m.reason} (ttl exceeded)`);
            } else {
                kept.push(m);
            }
        }
        this.messageQueue = kept;
    }

    // ==================== 触发判定 ====================

    async check() {
        if (!this.config.enabled) return;
        // 单飞：上一轮还在等 LLM 就直接跳过，避免请求叠加
        if (this._checking) return;
        this._checking = true;
        try {
            await this._runCheck();
        } catch (e) {
            console.error('[ProactiveEngine] Check failed:', e.message || e);
        } finally {
            this._checking = false;
        }
    }

    async _runCheck() {
        this._resetDailyCountIfNeeded();
        // 配额不再是一道「全局闸」（此前第 2 行直接 return，配额打满后连用户自己设的
        // 任务提醒都发不出去）。它降级为一个标志位，由每种触发自己决定要不要看。
        const hasQuota = this._hasQuota();

        const now = new Date();
        const nowMinutes = minutesOfDay(now);
        const quiet = this.isQuietHours(now);

        // ① 定时问候：时间窗内每天一次（优先级最高，占配额）
        if (hasQuota) {
            for (const type of PROACTIVE_TYPES) {
                if (!type.window || !type.dailyOnce) continue;
                if (!this._inWindow(nowMinutes, type.window)) continue;
                if (this._sentToday(type.id)) continue;
                if (!this.canTrigger(type.id)) continue;
                return this.trigger(type.id);
            }
        }

        // ② 任务提醒：quotaExempt —— 不看 hasQuota，也不受深夜免打扰限制。
        // 位置很关键：必须在下面的 `if (!hasQuota || quiet) return;` **之前**。
        if (this.canTrigger('task_reminder')) {
            const hit = pickReminderCandidate(TaskManager.getReminderCandidates(now), now);
            if (hit) {
                const ok = await this.trigger('task_reminder', { task: hit.task, kind: hit.kind });
                // 只有真的入队了才记「已提醒」；LLM 挂了/队列满时不标记，下轮 60s 后重试
                if (ok) {
                    TaskManager.markReminded(hit.task.id, hit.kind, new Date().toISOString());
                }
                return;
            }
        }

        // 两道闸下移：从这里往下都是「自发」消息，占配额且深夜不打扰
        if (!hasQuota || quiet) return;

        // ③ 情绪关怀（窗口内概率触发）
        const moodType = getProactiveType('mood_check');
        if (this._inWindow(nowMinutes, moodType?.window) && this.canTrigger('mood_check')) {
            if (Math.random() < 0.2 * this.getAffinityBonus()) return this.trigger('mood_check');
        }

        // ④ 想念：用户一段时间没出现
        const inactiveTime = Date.now() - this.lastUserActiveTime;
        if (inactiveTime > MISS_YOU_IDLE_MS && this.canTrigger('miss_you')) {
            const probability = 0.3 * this.getAffinityBonus();
            if (Math.random() < probability) {
                return this.trigger('miss_you', {
                    inactiveMinutes: Math.floor(inactiveTime / MIN),
                });
            }
        }

        // ⑤ 回忆分享：关系够近才会想起以前的事
        if ((this.aiGirlfriend.affinity ?? 0) >= 50 && this.canTrigger('memory_share')) {
            const probability = 0.15 * this.getAffinityBonus();
            if (Math.random() < probability) return this.trigger('memory_share');
        }

        // ⑥ 随机闲聊：每 30 分钟一个评估时隙，同一时隙只掷一次骰子
        //（此前用 minute === 0 || 30 判断，轮询抖动错过就整段跳过）
        const slotKey = `${dayKey(now)}T${now.getHours()}:${now.getMinutes() < 30 ? 0 : 30}`;
        if (slotKey !== this.lastRandomSlotKey && this.canTrigger('random_chat')) {
            this.lastRandomSlotKey = slotKey;
            const timeSinceLast = (Date.now() - this.lastTriggerTime) / HOUR;
            if (timeSinceLast >= 1) {
                const baseP = (this.aiGirlfriend.affinity / 200) + (timeSinceLast / 24);
                const p = baseP * this.getAffinityBonus();
                if (Math.random() < Math.min(p, 0.4)) return this.trigger('random_chat');
            }
        }
    }

    // ==================== 生成与入队 ====================

    /**
     * 生成一条主动消息并入队。
     *
     * @returns {Promise<boolean>} true = 入队成功。调用方据此决定是否记账
     *          （任务提醒的去重标记必须在入队成功后才写，否则失败的那条会被永久跳过）。
     */
    async trigger(reason, data = {}) {
        // 总开关：手动触发（POST /chat/proactive/trigger）与自动检查共用这一道闸。
        // 此前只有 check() 查 enabled，API 层与欢迎回来路径都能绕过总开关。
        if (!this.config.enabled) return false;

        const type = getProactiveType(reason) || FALLBACK_TYPE;

        // 同一类型不并发生成（手动触发与定时轮询可能同时命中）
        if (this._inflight.has(type.id)) return false;

        this._pruneQueue();
        if (this.messageQueue.length >= this.maxQueueSize) return false;

        this._inflight.add(type.id);
        try {
            const message = await this.aiGirlfriend.generateProactiveMessage(reason, data);
            if (!message || !message.reply) return false;

            this.messageQueue.push({
                id: `${Date.now()}-${type.id}`,
                content: message.reply,
                emotion: message.emotion,
                timestamp: new Date().toISOString(),
                reason,
                priority: type.priority,
                expiresAt: Date.now() + (type.ttl || HOUR),
            });
            this.messageQueue.sort((a, b) => b.priority - a.priority);

            this.lastTriggerTime = Date.now();
            this.lastTriggerByType[reason] = Date.now();
            // 豁免类型不占配额（同时也不能被 _pruneQueue 退还）
            if (!type.quotaExempt) this.dailyMessageCount++;
            if (type.dailyOnce) this.sentDays[reason] = dayKey();

            // 写进对话历史：小爱要记得自己说过什么，用户回复主动消息时模型才看得到上下文
            this.aiGirlfriend.recordProactiveMessage?.(message.reply, reason);

            this._saveState();
            return true;
        } catch (e) {
            console.error("[ProactiveEngine] Trigger failed:", e.message || e);
            return false;
        } finally {
            this._inflight.delete(type.id);
        }
    }

    consumeMessage() {
        this._pruneQueue();
        if (this.messageQueue.length === 0) return null;
        const message = this.messageQueue.shift();
        this._saveState();
        return message;
    }

    peekQueue() {
        this._pruneQueue();
        return {
            size: this.messageQueue.length,
            messages: this.messageQueue.map(m => ({
                id: m.id, reason: m.reason, timestamp: m.timestamp, expiresAt: m.expiresAt,
            })),
        };
    }

    getStatus() {
        const stage = this.getStage();
        const now = new Date();
        const cooldowns = this.triggerCooldowns;
        const nextEligible = {};
        for (const type of PROACTIVE_TYPES) {
            const last = this.lastTriggerByType[type.id] || 0;
            nextEligible[type.id] = last ? last + cooldowns[type.id] : null;
        }
        const sentToday = {};
        for (const type of PROACTIVE_TYPES) {
            sentToday[type.id] = type.dailyOnce ? this._sentToday(type.id) : false;
        }

        return {
            config: this.getConfig(),
            queueSize: this.messageQueue.length,
            queue: this.peekQueue(),
            dailyMessagesSent: this.dailyMessageCount,
            dailyLimit: this.getDailyLimit(),
            autoDailyLimit: this.getAutoDailyLimit(),
            stage: stage.stage,
            stageLabel: stage.shortLabel,
            affinity: this.aiGirlfriend.affinity ?? 35,
            affinityBonus: this.getAffinityBonus(),
            quietHours: this.getQuietHoursInfo(now),
            lastTriggerTime: this.lastTriggerTime,
            lastUserActiveTime: this.lastUserActiveTime,
            nextEligible,
            sentToday,
            currentCooldowns: cooldowns,
        };
    }
}

export default ProactiveEngine;
