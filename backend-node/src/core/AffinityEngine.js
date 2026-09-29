/**
 * AffinityEngine —— 自持状态的好感度引擎（2026-09-30 重构，PRD P0/P1）。
 *
 * 与 ProactiveEngine 完全对称：自己拥有并落盘 affinity / 24h 增益事件时间戳 /
 * 变更账本 / 最后互动时间 / 当日累计涨分，落独立文件 data/affinity_state.json。
 *
 * 对抗历史缺陷：
 * - 好感度不再散落在 AiGirlfriend 的 this.affinity（改由本引擎单点持有）；
 * - 「近 24h 加分疲劳」的裁窗/计数/push 交给纯模块 affinityFatigue；
 * - 每次变化产出可追溯账本（≤200 条）与 trace；
 * - 时间衰减惰性结算（无后台定时器）+ 每日涨分上限。
 *
 * 所有方法**不抛异常**：读写失败由 jsonStore 内部兜底（最坏退化为默认值），主链路不中断。
 */

import { dataPath, readJson, writeJson } from '../utils/jsonStore.js';
import { getStageForAffinity, buildStageMeta } from './relationshipStages.js';
import { validateAffinityChange, AFFINITY_RULES } from './affinityRules.js';
import { pruneGainEvents, recordGain } from './affinityFatigue.js';
import { dayKey } from '../utils/dayKey.js';

const STATE_FILE = 'affinity_state.json';        // 构造参数可覆盖（测试用）
const DEFAULT_AFFINITY = 35;                      // 与前端默认档位一致
const GAIN_WINDOW_MS = 24 * 60 * 60 * 1000;       // 加分疲劳的 24h 窗口
const LEDGER_MAX = 200;                           // 账本上限，超出丢最旧

/** 时间衰减参数（惰性结算；「1 点/天」口径，高级阶段更慢） */
const DECAY = {
    START_MS:    72 * 60 * 60 * 1000,   // 满 72h 未互动才启动
    RATE_MS_LOW: 24 * 60 * 60 * 1000,   // stranger/acquaintance/friend：每 24h -1
    RATE_MS_HIGH: 48 * 60 * 60 * 1000,  // close/lover：每 48h -1
    HIGH_STAGES: ['close', 'lover'],
};

/** 好感度永远 clamp 到 0-100 整数 */
const clampAffinity = (v) =>
    Math.max(0, Math.min(100, Number.isFinite(v) ? Math.round(v) : DEFAULT_AFFINITY));

class AffinityEngine {
    /**
     * @param {string} stateFileName 状态文件名，默认 affinity_state.json（测试可传 .test.json）
     */
    constructor(stateFileName = STATE_FILE) {
        this.stateFile = stateFileName;
        this._affinity = DEFAULT_AFFINITY;

        // ⚠️ 与 ProactiveEngine 的同名状态是**两份独立存储**（分别在 affinity_state.json /
        // proactive_state.json），语义对齐、同时机更新（都在一次 chat 的 _prepare 里刷新）；
        // 不要跨引擎读取——两者是「对齐口径」而非共享状态。
        this.lastUserActiveTime = Date.now();

        this.gainEvents = [];                                  // 近 24h 正增长时间戳
        this.daily = { dayKey: dayKey(), gained: 0 };          // 本地自然日累计正增长
        this.ledger = [];                                      // 变更账本（≤200）

        this._loadState();
    }

    // ==================== 读写 ====================

    get affinity() { return this._affinity; }

    /** 手动覆盖（updateState 用），clamp 0-100 后存盘 */
    setAffinity(value) {
        this._affinity = clampAffinity(value);
        this._saveState();
        return this._affinity;
    }

    /**
     * 刷新「最后互动时间」为 now（用户发消息即算打卡）。
     * ⚠️ 必须在 settleDecay(now) 之后调用，否则会把待结算的空闲时间抹掉。
     * 不单独存盘：本次回合结束的 recordUserTurn() 会连它一起落盘，避免每句话多一次 IO。
     */
    notifyUserActive(now = Date.now()) {
        this.lastUserActiveTime = now;
    }

    // ==================== 时间衰减（惰性结算） ====================

    /**
     * 惰性时间衰减（不新增定时器）：凭 now - lastUserActiveTime 推算应扣点数。
     *   idle = now - lastUserActiveTime
     *   if (idle < START_MS) 直接返回 { applied: 0 }
     *   rate  = close/lover ? 48h : 24h
     *   steps = floor(idle / rate)
     *   after = max(stage.min, affinity - steps)     // 止损于当前阶段下沿，不降档
     *   lastUserActiveTime += steps*rate             // 消耗式：已结算时段不重算
     *   if (after < affinity) 写账本(time_decay) 并存盘
     *
     * @returns {{ affinity:number, applied:number, steps:number }}
     */
    settleDecay(now = Date.now()) {
        const idle = now - this.lastUserActiveTime;
        if (!Number.isFinite(idle) || idle < DECAY.START_MS) {
            return { affinity: this._affinity, applied: 0, steps: 0 };
        }

        const stage = getStageForAffinity(this._affinity);
        const rate = DECAY.HIGH_STAGES.includes(stage.stage) ? DECAY.RATE_MS_HIGH : DECAY.RATE_MS_LOW;
        const steps = Math.floor(idle / rate);
        if (steps <= 0) {
            return { affinity: this._affinity, applied: 0, steps: 0 };
        }

        const before = this._affinity;
        const after = Math.max(stage.min, before - steps);   // 止损：不跌破阶段下沿
        const applied = before - after;

        // 消耗已结算的整段空闲，避免下次调用重复扣分
        this.lastUserActiveTime += steps * rate;

        if (applied > 0) {
            this._affinity = after;
            const finalChange = after - before;              // ≤ 0
            this._appendLedger({
                at: new Date(now).toISOString(),
                before,
                after,
                rawChange: 0,
                finalChange,
                stage: stage.stage,
                userInputDigest: null,
                trace: [{ rule: 'time_decay', from: 0, to: finalChange, reason: '好久没联系，她和你有点生疏了' }],
            });
            this._saveState();
        }

        return { affinity: this._affinity, applied, steps };
    }

    // ==================== 一次用户回合（唯一写入点） ====================

    /**
     * 一次用户回合的好感度结算：
     *   1 裁窗得 recentPositiveCount
     *   2 跨自然日则重置当日额度，得 dailyGainedToday
     *   3 validateAffinityChange 逐规则修正并生成 trace
     *   4 clamp 更新 affinity
     *   5 change>0 → 记增益事件 + 累加当日涨分
     *   6 追加账本（≤200）+ 存盘
     * @returns {{ affinity:number, change:number, trace:Array, meta:object }}
     */
    recordUserTurn(userInput, rawChange, aiReply, now = Date.now()) {
        this.gainEvents = pruneGainEvents(this.gainEvents, now, GAIN_WINDOW_MS);
        const recentPositiveCount = this.gainEvents.length;
        const dailyGainedToday = this._rollDayIfNeeded(now);

        const before = this._affinity;
        const { change, trace } = validateAffinityChange(
            rawChange, userInput, aiReply, before, recentPositiveCount, dailyGainedToday
        );
        const after = clampAffinity(before + change);
        this._affinity = after;

        if (change > 0) {
            this.gainEvents = recordGain(this.gainEvents, now);
            this.daily.gained += change;
        }

        this._appendLedger({
            at: new Date(now).toISOString(),
            before,
            after,
            rawChange,
            finalChange: change,
            stage: getStageForAffinity(before).stage,
            userInputDigest: (userInput || '').slice(0, 40) || null,
            trace,
        });
        this._saveState();

        console.log(`[Affinity] ${before} → ${after} (change ${change > 0 ? '+' : ''}${change}, stage ${getStageForAffinity(after).stage})`);

        return { affinity: after, change, trace, meta: this.getMeta(now) };
    }

    // ==================== 查询 ====================

    /** 按时间升序返回账本副本（≤200 条） */
    getLedger() {
        return this.ledger.map((e) => ({
            ...e,
            trace: Array.isArray(e.trace) ? e.trace.map((t) => ({ ...t })) : [],
        }));
    }

    /**
     * 下发前端的阶段元数据 + 提示字段（字段名与前端类型逐字一致）。
     * @returns {{
     *   stage:string, stageLabel:string, stageShortLabel:string,
     *   nextStage:string|null, nextStageLabel:string|null,
     *   pointsToNextStage:number, stageProgress:number,
     *   recentChangeReason:string|null, decaying:boolean, dailyCapReached:boolean
     * }}
     */
    getMeta(now = Date.now()) {
        const meta = buildStageMeta(this._affinity);
        const stage = getStageForAffinity(this._affinity);
        const last = this.ledger[this.ledger.length - 1];
        const recentChangeReason = last && Array.isArray(last.trace) && last.trace.length > 0
            ? last.trace[last.trace.length - 1].reason
            : null;
        const idle = now - this.lastUserActiveTime;
        const decaying = idle >= DECAY.START_MS && this._affinity > stage.min;
        const dailyCapReached = this.daily.gained >= AFFINITY_RULES.DAILY_POSITIVE_CAP;

        return { ...meta, recentChangeReason, decaying, dailyCapReached };
    }

    /** 回默认档位并清空事件/账本/当日（clearHistory 用） */
    reset() {
        this._affinity = DEFAULT_AFFINITY;
        this.gainEvents = [];
        this.lastUserActiveTime = Date.now();
        this.daily = { dayKey: dayKey(), gained: 0 };
        this.ledger = [];
        this._saveState();
        return { affinity: this._affinity };
    }

    // ==================== 内部 ====================

    /** 跨本地自然日则重置当日累计，返回当日已涨分 */
    _rollDayIfNeeded(now) {
        const key = dayKey(new Date(now));
        if (this.daily.dayKey !== key) {
            this.daily = { dayKey: key, gained: 0 };
        }
        return this.daily.gained;
    }

    /** 追加账本并裁剪到 LEDGER_MAX（不落盘，由调用方决定存盘时机） */
    _appendLedger(entry) {
        this.ledger.push(entry);
        if (this.ledger.length > LEDGER_MAX) {
            this.ledger.splice(0, this.ledger.length - LEDGER_MAX);
        }
    }

    _loadState() {
        const data = readJson(this.stateFile, null);
        if (!data) return;

        if (typeof data.affinity === 'number') this._affinity = clampAffinity(data.affinity);
        if (Array.isArray(data.gainEvents)) {
            this.gainEvents = data.gainEvents.filter((t) => typeof t === 'number');
        }
        if (typeof data.lastUserActiveTime === 'number') {
            this.lastUserActiveTime = data.lastUserActiveTime;
        }
        if (data.daily && typeof data.daily === 'object') {
            this.daily = {
                dayKey: typeof data.daily.dayKey === 'string' ? data.daily.dayKey : dayKey(),
                gained: typeof data.daily.gained === 'number' ? data.daily.gained : 0,
            };
        }
        if (Array.isArray(data.ledger)) {
            this.ledger = data.ledger
                .filter((e) => e && typeof e === 'object')
                .slice(-LEDGER_MAX);
        }
    }

    _saveState() {
        writeJson(this.stateFile, {
            affinity: this._affinity,
            gainEvents: this.gainEvents,
            lastUserActiveTime: this.lastUserActiveTime,
            daily: this.daily,
            ledger: this.ledger,
            lastUpdated: new Date().toISOString(),
        });
    }
}

export default AffinityEngine;
