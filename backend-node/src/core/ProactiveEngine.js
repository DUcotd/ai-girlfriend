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
import { isEventLayerEnabled } from './TriggerRegistry.js';

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

/** 频率档位唯一事实源（路由校验入参时读这里，别再抄一份 ['low','medium','high']） */
export const FREQUENCY_LEVELS = Object.keys(FREQUENCY);

/** 深夜免打扰时段（当天分钟数，跨零点） */
const QUIET_HOURS = { from: 23 * 60 + 30, to: 7 * 60 };

/** 用户多久没出现算「想念」 */
const MISS_YOU_IDLE_MS = 2 * HOUR;

/**
 * 自发类的情绪闸门（P = EmotionEngine 的愉悦度）。
 * 主动消息此前完全不读情绪，愤怒冷暴力下照样友善搭话——
 * 全部阈值与口径见 docs/proactive-consistency/DIAGNOSIS.md。
 */
const GHOST_P = -0.75;      // 与 EmotionEngine.shouldGhost() 同口径：ghost 中连定时问候都停
const BLOCK_P = -0.5;       // 愤怒/暴躁/抑郁档：自发类不发
const SUPPRESS_P = -0.2;    // 低落/烦躁档：不拦，但自发类概率乘 SUPPRESS_FACTOR
const SUPPRESS_FACTOR = 0.3;

/** 自发类全局最小间隔：跨类型共享，防止不同类型背靠背连发（task_reminder/定时问候不受限） */
const SPONTANEOUS_GAP = 90 * MIN;

/** 相似度去重比对的已发消息条数 */
const RECENT_SENT_LIMIT = 2;

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

/**
 * 两条主动消息是否算「复读」：归一化空白后，长消息比开头 DUPLICATE_PREFIX_LEN 个字符
 * （现实案例里两条复读的共同前缀「那个……下午好。」恰好 8 字符——实测 10 拦不住，
 * 见 docs/proactive-consistency/DIAGNOSIS.md），短消息全等才算。
 */
const DUPLICATE_PREFIX_LEN = 8;

function looksDuplicate(a, b) {
    if (!a || !b) return false;
    const x = a.replace(/\s+/g, '');
    const y = b.replace(/\s+/g, '');
    if (x.length >= DUPLICATE_PREFIX_LEN && y.length >= DUPLICATE_PREFIX_LEN) {
        return x.slice(0, DUPLICATE_PREFIX_LEN) === y.slice(0, DUPLICATE_PREFIX_LEN);
    }
    return x === y;
}

class ProactiveEngine {
    constructor(aiGirlfriend, triggerRegistry = null) {
        this.aiGirlfriend = aiGirlfriend;
        /**
         * 事件层注册表（REQ-04）。缺省为 null 时事件层整体降级为 no-op：
         * consumeEventQueue() 直接返回 false，_runCheck 行为与改造前逐字节一致。
         * 装配顺序由 container.js 保证：Bus → Registry → register → ProactiveEngine(registry)。
         */
        this.triggerRegistry = triggerRegistry;

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
        /** 最近一条自发消息的时间戳（跨类型共享的全局自发间隔） */
        this.lastSpontaneousAt = 0;
        /** 最近已发出的自发消息文本（相似度去重用，只留最近 RECENT_SENT_LIMIT 条） */
        this.recentSentTexts = [];
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

        /**
         * 新增的默认开启类型必须能到达「早就存过配置」的用户（B6-α② 顺带修的历史坑）。
         *
         * _applyConfig 只做「过滤掉未知 id」，于是老用户磁盘上的 8 条会一直只有 8 条：
         * REQ-04 后来加的 emotion_resonance / anniversary_recall / promise_followup
         * 以及本次的 stage_transition 永远进不了他们的 enabledTypes ——
         * 事件层辛苦触发，最后被 canTrigger() 一句「该类型未启用」静默拦死。
         *
         * 记账方式：每次存盘都写下「这份配置是对着哪一版类型目录表达的」(knownTypeIds)。
         * 加载时把「目录里新增且默认开启」的类型补进去；用户显式关掉的旧类型
         * 一定在 knownTypeIds 里，因此不会被补回来。
         * 老文件没有 knownTypeIds 字段时，只补事件驱动类（它们正是这批新增项），
         * 定时问候/任务提醒一类绝不动，把「误恢复用户选择」的面压到最小。
         */
        const known = Array.isArray(data.knownTypeIds) ? data.knownTypeIds : null;
        const missing = DEFAULT_ENABLED_TYPES.filter(id => !this.config.enabledTypes.includes(id));
        if (missing.length > 0) {
            const toAdd = known
                ? missing.filter(id => !known.includes(id))
                : missing.filter(id => getProactiveType(id)?.eventDriven === true);
            if (toAdd.length > 0) {
                this.config.enabledTypes = [...this.config.enabledTypes, ...toAdd];
                console.log(`[ProactiveEngine] 新增默认开启的主动消息类型已补全: ${toAdd.join(', ')}`);
            }
        }

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
        if (typeof data.lastSpontaneousAt === 'number') this.lastSpontaneousAt = data.lastSpontaneousAt;
        if (Array.isArray(data.recentSentTexts)) {
            this.recentSentTexts = data.recentSentTexts
                .filter(t => typeof t === 'string')
                .slice(0, RECENT_SENT_LIMIT);
        }

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
        return writeJson(STATE_FILE, {
            config: this.config,
            // 这份 enabledTypes 是对着哪一版类型目录表达的（供 _loadState 判断哪些类型是新增的）
            knownTypeIds: [...PROACTIVE_TYPE_IDS],
            dailyMessageCount: this.dailyMessageCount,
            lastDayKey: this.lastDayKey,
            lastTriggerByType: this.lastTriggerByType,
            sentDays: this.sentDays,
            lastRandomSlotKey: this.lastRandomSlotKey,
            lastTriggerTime: this.lastTriggerTime,
            lastSpontaneousAt: this.lastSpontaneousAt,
            recentSentTexts: this.recentSentTexts,
            queue: this.messageQueue,
            lastUpdated: new Date().toISOString(),
        });
    }

    /**
     * 清运行时状态但**保留用户配置**（「完全重置」的一步，审计 B0-5）。
     *
     * 此前 resetAll() 完全不碰这里，于是重置后：
     *  - 队列里按**旧关系**生成的主动消息仍会被投递（最多 maxQueueSize 条）；
     *  - 当日配额已烧完 + sentDays/冷却仍在 → 主动关怀要到零点才恢复；
     *  - recentSentTexts 里的旧措辞还会参与去重判定。
     * @returns {boolean} 是否落盘成功
     */
    resetRuntimeState() {
        this.messageQueue = [];
        this.dailyMessageCount = 0;
        this.lastDayKey = dayKey();
        this.lastTriggerByType = {};
        this.sentDays = {};
        this.lastRandomSlotKey = null;
        this.lastSpontaneousAt = 0;
        this.lastTriggerTime = Date.now();
        this.lastUserActiveTime = Date.now();
        this.recentSentTexts = [];
        this._inflight.clear();
        return this._saveState();
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

    // ==================== 情绪闸门 ====================

    /** 当前愉悦度 P（EmotionEngine 缺失时按中性处理，闸门全开） */
    _currentP() {
        return this.aiGirlfriend.emotionEngine?.state?.P ?? 0;
    }

    /**
     * 自发类的情绪闸门。
     * 'block'：P < BLOCK_P，自发类一律不发（手动触发也被拦）；
     * 'suppress'：P < SUPPRESS_P，不拦但概率乘 SUPPRESS_FACTOR；
     * 'pass'：正常。task_reminder 完全不看这道闸（用户自己设的功能性提醒）。
     */
    getEmotionGate() {
        const P = this._currentP();
        if (P < BLOCK_P) return { mode: 'block', factor: 0, P };
        if (P < SUPPRESS_P) return { mode: 'suppress', factor: SUPPRESS_FACTOR, P };
        return { mode: 'pass', factor: 1, P };
    }

    /** 与主对话 EmotionEngine.shouldGhost() 同口径：ghost 中连定时问候都停（冷暴力的人不会说早安） */
    isGhosting() {
        return this._currentP() < GHOST_P;
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
        // minAffinity 由类型表统一声明：陌生/疏离阶段(0-15)不该主动搭话，自发类 16 解锁，
        // memory_share 50（原 _runCheck 硬编码搬入）
        const minAffinity = getProactiveType(type)?.minAffinity;
        if (minAffinity !== undefined && (this.aiGirlfriend.affinity ?? 0) < minAffinity) return false;
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
                // 【B6-α③】她主动递出去的话落了空 —— 这份失落要落到她自己的情绪上，
                // 之后情绪闸门会自然减少下一次主动（不需要另写「冷落规则」）。
                try {
                    this.aiGirlfriend.recordProactiveOutcome?.('expired', m);
                } catch (e) {
                    console.error(`[ProactiveEngine] expiry feedback failed: ${e.message || e}`);
                }
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
        // 【REQ-04 / 侵入点 I13】事件队列优先消费（在定时问候之前）。
        // 这是本次唯一的架构级侵入点，缓解策略：
        //   1) 事件层关闭或队列为空时，consumeEventQueue() O(1) 返回 false，
        //      下面 6 步轮询流程**逐字节不变**（等价于改造前）；
        //   2) config.triggerRegistry.enabled=false 可一键回退纯轮询（运行时开关）。
        // 详见 docs/companion-upgrade/02-architecture.md REQ-04 2.4.6。
        if (await this.consumeEventQueue()) return;

        this._resetDailyCountIfNeeded();
        // 配额不再是一道「全局闸」（此前第 2 行直接 return，配额打满后连用户自己设的
        // 任务提醒都发不出去）。它降级为一个标志位，由每种触发自己决定要不要看。
        const hasQuota = this._hasQuota();

        const now = new Date();
        const nowMinutes = minutesOfDay(now);
        const quiet = this.isQuietHours(now);

        // ① 定时问候：时间窗内每天一次（优先级最高，占配额）。
        // ghost 中一并停发——冷暴力状态下说「早安」同样出戏（docs/proactive-consistency/DIAGNOSIS.md）。
        if (hasQuota && !this.isGhosting()) {
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

        // 情绪闸门：愤怒/冷暴力档自发类全部止步（trigger() 还有一道兜底，这里提前省掉掷骰子）
        const emotionGate = this.getEmotionGate();
        if (emotionGate.mode === 'block') return;

        // 自发类全局间隔：90 分钟内至多一条，跨类型共享（此前只有 random_chat 自查 1h）
        if (Date.now() - this.lastSpontaneousAt < SPONTANEOUS_GAP) return;

        // ③ 情绪关怀（窗口内概率触发）
        const moodType = getProactiveType('mood_check');
        if (this._inWindow(nowMinutes, moodType?.window) && this.canTrigger('mood_check')) {
            if (Math.random() < 0.2 * this.getAffinityBonus() * emotionGate.factor) return this.trigger('mood_check');
        }

        // ④ 想念：用户一段时间没出现
        const inactiveTime = Date.now() - this.lastUserActiveTime;
        if (inactiveTime > MISS_YOU_IDLE_MS && this.canTrigger('miss_you')) {
            const probability = 0.3 * this.getAffinityBonus() * emotionGate.factor;
            if (Math.random() < probability) {
                return this.trigger('miss_you', {
                    inactiveMinutes: Math.floor(inactiveTime / MIN),
                });
            }
        }

        // ⑤ 回忆分享：关系够近才会想起以前的事（好感门槛已由 canTrigger 的 minAffinity=50 承担）
        if (this.canTrigger('memory_share')) {
            const probability = 0.15 * this.getAffinityBonus() * emotionGate.factor;
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
                const p = baseP * this.getAffinityBonus() * emotionGate.factor;
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

        // 总闸（自动轮询 / 欢迎回来 / 手动触发共用）：情绪与好感度门槛在 trigger 里兜底，
        // _runCheck 里的提前 return 只是省骰子，绕过它也绕不过这里。
        if (this.isGhosting() && (type.spontaneous || type.dailyOnce)) {
            console.log(`[ProactiveEngine] Blocked ${reason}: ghosting (P=${this._currentP().toFixed(2)})`);
            return false;
        }
        if (type.spontaneous && this.getEmotionGate().mode === 'block') {
            console.log(`[ProactiveEngine] Blocked ${reason}: negative emotion (P=${this._currentP().toFixed(2)})`);
            return false;
        }
        if (type.minAffinity !== undefined && (this.aiGirlfriend.affinity ?? 0) < type.minAffinity) {
            console.log(`[ProactiveEngine] Blocked ${reason}: affinity ${this.aiGirlfriend.affinity ?? 0} < minAffinity ${type.minAffinity}`);
            return false;
        }
        if (type.spontaneous && Date.now() - this.lastSpontaneousAt < SPONTANEOUS_GAP) {
            console.log(`[ProactiveEngine] Blocked ${reason}: spontaneous gap (${Math.round((SPONTANEOUS_GAP - (Date.now() - this.lastSpontaneousAt)) / MIN)}min left)`);
            return false;
        }

        // 同一类型不并发生成（手动触发与定时轮询可能同时命中）
        if (this._inflight.has(type.id)) return false;

        this._pruneQueue();
        if (this.messageQueue.length >= this.maxQueueSize) return false;

        this._inflight.add(type.id);
        try {
            const message = await this.aiGirlfriend.generateProactiveMessage(reason, data);
            if (!message || !message.reply) return false;

            const text = message.reply.trim();

            // 相似度去重：与队列内及最近已发的自发消息比对，开头雷同即视为复读丢弃。
            // 丢弃发生在记账之前（配额不占），但写同类型冷却时间戳——否则每个轮询周期
            // 都会重新掷骰、重新调一次 LLM、再丢一次，纯烧 token。
            if (type.spontaneous &&
                [...this.messageQueue.map(m => m.content), ...this.recentSentTexts]
                    .some(prev => looksDuplicate(text, prev))) {
                console.log(`[ProactiveEngine] Dropped duplicate proactive message (${reason})`);
                this.lastTriggerByType[reason] = Date.now();
                return false;
            }

            this.messageQueue.push({
                id: `${Date.now()}-${type.id}`,
                content: text,
                emotion: message.emotion,
                timestamp: new Date().toISOString(),
                reason,
                priority: type.priority,
                expiresAt: Date.now() + (type.ttl || HOUR),
            });
            this.messageQueue.sort((a, b) => b.priority - a.priority);

            this.lastTriggerTime = Date.now();
            this.lastTriggerByType[reason] = Date.now();
            if (type.spontaneous) {
                this.lastSpontaneousAt = Date.now();
                this.recentSentTexts = [text, ...this.recentSentTexts].slice(0, RECENT_SENT_LIMIT);
            }
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

    // ==================== 事件层（REQ-04） ====================

    /**
     * 优先消费事件队列（事件的「发令出口」仍是本引擎的 trigger()）。
     *
     * 契约（docs/companion-upgrade/02-architecture.md REQ-04 2.4.5）：
     *   - 事件层关闭 / 未装配 registry / 队列为空 → **O(1) 返回 false**，_runCheck 后续不变；
     *   - 命中候选 → 走 trigger() 全部闸门（情绪/ghost/配额/自发间隔/去重），
     *     复用而非旁路，保证事件驱动不会变成闸门失效；
     *   - trigger() 返回 false（被闸门拦 / LLM 挂 / 队列满）时**不重排**：
     *     事件会在下次 emit 时重新判定，符合「不记账、下轮可重试」的语义。
     *
     * @returns {Promise<boolean>} true = 已消费并成功走完 trigger 全闸门（入队成功）
     */
    async consumeEventQueue() {
        // 快速预检（O(1)）：事件层关闭 或 未装配 registry 或 队列空 → 立即返回，零副作用。
        // 顺序很关键：先判开关（模块级变量，最廉价），再判 registry，最后才判队列长度。
        if (!isEventLayerEnabled()) return false;
        if (!this.triggerRegistry || typeof this.triggerRegistry.consume !== 'function') return false;
        if (typeof this.triggerRegistry.getStatus === 'function') {
            // getStatus().queueSize 会先惰性剪枝过期候选；为空则不必继续
            const status = this.triggerRegistry.getStatus();
            if (!status || status.queueSize === 0) return false;
        }

        const candidate = this.triggerRegistry.consume();
        if (!candidate) return false;

        // 事件驱动的消息最终仍走 trigger() 全闸门；reason 用候选的 targetType。
        const ok = await this.trigger(candidate.targetType, {
            ...candidate.data,
            eventTriggerId: candidate.triggerId,
        });
        // 约定追问要记账：promiseFollowupTrigger 用 followupCount 同时做「最多追问几次」
        // 的上限判定和 dedupeKey。此前全仓没有任何地方递增它 → 上限是死代码，
        // 而 dedupeKey 恒定 + 去重表永不清理 → 一条约定一生只被追问一次（审计 CORE-03/CORE-19）。
        if (ok && candidate.data?.kind === 'promise' && candidate.data.narrativeId) {
            try {
                this.aiGirlfriend.recordNarrativeFollowup?.(candidate.data.narrativeId);
            } catch (e) {
                console.error(`[ProactiveEngine] recordNarrativeFollowup failed: ${e.message}`);
            }
        }
        console.log(
            `[ProactiveEngine] Event-driven consume: trigger=${candidate.triggerId} → ${candidate.targetType} (delivered=${ok})`
        );
        return ok;
    }

    consumeMessage() {
        this._pruneQueue();
        if (this.messageQueue.length === 0) return null;
        const message = this.messageQueue.shift();
        this._saveState();
        // 【B6-α③】消息真的到了他眼前 —— 回灌她自己的情绪（增量表在 proactiveTypes.js）
        try {
            this.aiGirlfriend.recordProactiveOutcome?.('delivered', message);
        } catch (e) {
            console.error(`[ProactiveEngine] delivered feedback failed: ${e.message || e}`);
        }
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

    /**
     * 事件队列状态快照（REQ-04 / 侵入点 I17）。事件层未装配或未启用时返回降级结构，
     * 保证 getStatus() 的调用方（路由/前端）无需 null 判断。
     * @returns {{enabled: boolean, queueSize: number, queue: Array<object>, cooldowns: object}}
     */
    getEventQueueStatus() {
        if (!this.triggerRegistry || typeof this.triggerRegistry.getStatus !== 'function') {
            return { enabled: false, queueSize: 0, queue: [], cooldowns: {} };
        }
        try {
            const s = this.triggerRegistry.getStatus();
            return {
                enabled: !!s.enabled,
                queueSize: s.queueSize ?? 0,
                queue: Array.isArray(s.queue) ? s.queue : [],
                cooldowns: s.cooldowns && typeof s.cooldowns === 'object' ? s.cooldowns : {},
            };
        } catch (e) {
            // 状态查询失败不应拖垮 getStatus（前端只读，容错降级）
            console.error(`[ProactiveEngine] getEventQueueStatus failed: ${e.message || e}`);
            return { enabled: false, queueSize: 0, queue: [], cooldowns: {} };
        }
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
            // 【侵入点 I17】事件队列运行状态（只加不改：旧字段全部保留，前端向后兼容）
            eventQueue: this.getEventQueueStatus(),
            dailyMessagesSent: this.dailyMessageCount,
            dailyLimit: this.getDailyLimit(),
            autoDailyLimit: this.getAutoDailyLimit(),
            stage: stage.stage,
            stageLabel: stage.shortLabel,
            affinity: this.aiGirlfriend.affinity ?? 35,
            affinityBonus: this.getAffinityBonus(),
            quietHours: this.getQuietHoursInfo(now),
            // 情绪闸门状态暴露给前端：因情绪低落/冷暴力暂缓时，设置页能明确看到原因
            emotionGate: this.getEmotionGate(),
            ghosting: this.isGhosting(),
            spontaneousGapRemainingMs: Math.max(0, SPONTANEOUS_GAP - (Date.now() - this.lastSpontaneousAt)),
            lastTriggerTime: this.lastTriggerTime,
            lastUserActiveTime: this.lastUserActiveTime,
            nextEligible,
            sentToday,
            currentCooldowns: cooldowns,
        };
    }
}

export default ProactiveEngine;
