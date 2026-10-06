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

import { readJson, writeJson } from '../utils/jsonStore.js';
import { getStageForAffinity, buildStageMeta } from './relationshipStages.js';
import { validateAffinityChange, AFFINITY_RULES } from './affinityRules.js';
import { pruneGainEvents, recordGain } from './affinityFatigue.js';
import { dayKey } from '../utils/dayKey.js';

const STATE_FILE = 'affinity_state.json';        // 构造参数可覆盖（测试用）
// 导出为唯一真源：此前 35 这个魔数散落在 routes/chat.js（两处）、ProactiveEngine（两处）
// 与本文件里，改默认档要同时改五个地方才能对齐。
export const DEFAULT_AFFINITY = 35;              // 与前端默认档位一致
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

    /**
     * 手动覆盖（updateState / 设置页调分用），clamp 0-100 后存盘。
     * 也写一条 kind:'manual' 的账本：此前手动改分在「好感度变更账本」里完全无痕，
     * 面板解释不了自己显示的数字（审计 HTTP-19）。不动日额度与疲劳窗口。
     */
    setAffinity(value, now = Date.now()) {
        const before = this._affinity;
        this._affinity = clampAffinity(value);
        if (this._affinity !== before) {
            this._appendLedger({
                at: new Date(now).toISOString(),
                kind: 'manual',
                before,
                after: this._affinity,
                rawChange: 0,
                finalChange: this._affinity - before,
                stage: getStageForAffinity(before).stage,
                userInputDigest: null,
                trace: [{ rule: 'manual_set', from: 0, to: this._affinity - before, reason: '你在设置里手动调整了数值' }],
            });
        }
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
                // kind 让「时间衰减」与「真实一轮」在账本里可区分：两者共用同一条
                // 不变量口径（rawChange + Σ(to-from) === finalChange），
                // 但混在一起做审计会得出无意义的结论（CORE-16）
                kind: 'decay',
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
        // 引擎侧再兜一道强类型：非有限值不再静默当 0 却把原始脏值写进账本
        // （旧写法账本里是 rawChange:"+3" / finalChange:0，任何按不变量做的审计都会错，
        //  见 CORE-16；上游 AiGirlfriend 已做同样的强转，这里是纵深防御）
        const raw = Number.isFinite(rawChange) ? rawChange : (Number(rawChange) || 0);
        const { change, trace } = validateAffinityChange(
            raw, userInput, aiReply, before, recentPositiveCount, dailyGainedToday
        );
        const after = clampAffinity(before + change);
        this._affinity = after;
        // 真正入到账上的分数：触到 0/100 边界时 change 会被 clamp 吃掉一部分
        const credited = after - before;

        // 日配额与疲劳窗口按**实际入账分**计费。旧写法用 clamp 前的 change：
        // 好感度 99 时模型给 +3 只涨 1 分，却扣掉 3 点日额度（上限 8），
        // 满级用户一句贴心话烧掉 1/3 预算，UI 还显示 dailyCapReached（CORE-16）。
        if (credited > 0) {
            this.gainEvents = recordGain(this.gainEvents, now);
            this.daily.gained += credited;
        }

        this._appendLedger({
            at: new Date(now).toISOString(),
            kind: 'turn',
            before,
            after,
            rawChange: raw,
            finalChange: credited,
            requestedChange: change,
            stage: getStageForAffinity(before).stage,
            userInputDigest: (userInput || '').slice(0, 40) || null,
            trace,
        });
        this._saveState();

        console.log(`[Affinity] ${before} → ${after} (change ${credited > 0 ? '+' : ''}${credited}, stage ${getStageForAffinity(after).stage})`);

        return { affinity: after, change: credited, trace, meta: this.getMeta(now) };
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
     *
     * 「最近一次变化」的口径是**最近一次真正发生的变化**（finalChange ≠ 0），
     * 不是「最近一个回合」——因为一个回合完全可能 0 变化（寒暄等），此时不应
     * 把面板上的原因/数字清空。
     *
     * @returns {{
     *   stage:string, stageLabel:string, stageShortLabel:string,
     *   nextStage:string|null, nextStageLabel:string|null,
     *   pointsToNextStage:number, stageProgress:number,
     *   recentChange:number, recentChangeReason:string|null,
     *   decaying:boolean, dailyCapReached:boolean
     * }}
     */
    getMeta(now = Date.now()) {
        const meta = buildStageMeta(this._affinity);
        const stage = getStageForAffinity(this._affinity);
        const lastChanged = this._lastChangedEntry();
        const recentChange = lastChanged ? lastChanged.finalChange : 0;
        const recentChangeReason = this._reasonFor(lastChanged);
        const idle = now - this.lastUserActiveTime;
        const decaying = idle >= DECAY.START_MS && this._affinity > stage.min;
        // 日额度必须**读时也 roll**（审计 HTTP-19）：以前只有 recordUserTurn 写之前才 roll，
        // 于是过了零点还没说过话的用户，面板仍然显示「今日额度已满」——那是昨天的账。
        // roll 本身幂等（同一天多次调用只归零一次），读路径调用它没有副作用。
        const gainedToday = this._rollDayIfNeeded(now);
        const dailyCapReached = gainedToday >= AFFINITY_RULES.DAILY_POSITIVE_CAP;

        return { ...meta, recentChange, recentChangeReason, decaying, dailyCapReached };
    }

    /** 回默认档位并清空事件/账本/当日（AiGirlfriend.resetAll()「完全重置」用；「新对话」不走这里） */
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

    /** 账本（时间升序）里最近一条**最终变化非 0** 的记录；无则 null */
    _lastChangedEntry() {
        for (let i = this.ledger.length - 1; i >= 0; i--) {
            if (this.ledger[i].finalChange !== 0) return this.ledger[i];
        }
        return null;
    }

    /**
     * 「最近一次变化」的可读原因。
     *
     * ⚠️ trace 的语义是「**被哪些规则改过**」——正常回合（无越界/拒绝/疲劳/超低保护等）
     * trace 为空是**对的**，不能往 trace 里塞合成条目。但空 trace 不代表「没有变化」：
     * 此时要按变化符号合成兜底文案，否则最常见的涨分路径会被前端误显示为「最近还没有变化」。
     */
    _reasonFor(entry) {
        if (!entry) return null;
        if (Array.isArray(entry.trace) && entry.trace.length > 0) {
            return entry.trace[entry.trace.length - 1].reason;
        }
        if (entry.finalChange > 0) return '相处得不错，她对你的好感上升了';
        if (entry.finalChange < 0) return '这次相处让她有点失落';
        return null;
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
        return writeJson(this.stateFile, {
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
