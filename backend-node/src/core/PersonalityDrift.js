/**
 * PersonalityDrift —— 自持状态的性格引擎。
 *
 * 类名沿用历史名称以减少调用面变化；内部对标 AffinityEngine：独立持有 v2 状态、
 * 同步计算内容漂移、惰性每日结算、规则疲劳、变化账本和原子落盘。
 */
import { dataPath, readJson, writeJson } from '../utils/jsonStore.js';
import { dayKey } from '../utils/dayKey.js';
import { DIM_KEYS, DIM_LABELS, DEFAULT_TRAITS, PERSONALITY_DIMS, isDimKey } from './personalityDims.js';
import {
    DEFAULT_PRESET_ID,
    PERSONALITY_PRESETS,
    PRESET_IDS,
    getPreset,
} from './personalityPresets.js';
import {
    PERSONALITY_RULES,
    applyBaselinePull,
    applyDailyCap,
    buildDayStats,
    buildSignals,
    clampCurrent,
    computeBaselineAdapt,
    computeDrift,
    round1,
} from './personalityRules.js';
import { pruneRuleHits, recordRuleHit } from './personalityFatigue.js';
import { buildPersonalityPrompt } from './prompts/personalityPrompt.js';
import { getStageForAffinity } from './relationshipStages.js';

const STATE_FILE = 'personality_state.json';
const LEDGER_MAX = 200;
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 0-100 整数。 */
function clampInt(value, fallback = 50) {
    const safeValue = Number.isFinite(value) ? value : fallback;
    return Math.max(0, Math.min(100, Math.round(safeValue)));
}

/** 合法 dayKey，否则 null。 */
function normalizeDayKey(value) {
    return typeof value === 'string' && DAY_KEY_PATTERN.test(value) ? value : null;
}

/** 把 YYYY-MM-DD 转成稳定的 UTC 日序号，仅用于计算自然日间隔。 */
function dayNumber(key) {
    const normalized = normalizeDayKey(key);
    if (!normalized) return null;
    const [year, month, date] = normalized.split('-').map(Number);
    return Math.floor(Date.UTC(year, month - 1, date) / DAY_MS);
}

/** 两个 dayKey 的非负间隔天数。 */
function dayGap(fromKey, toKey) {
    const from = dayNumber(fromKey);
    const to = dayNumber(toKey);
    if (from === null || to === null || to < from) return 0;
    return to - from;
}

/** 由日序号生成 YYYY-MM-DD。 */
function keyFromDayNumber(value) {
    const date = new Date(value * DAY_MS);
    const pad = (number) => String(number).padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** 默认统计结构。 */
function createDefaultStats(now = Date.now()) {
    const key = dayKey(new Date(now));
    return {
        totalDays: 0,
        activeDays: 0,
        totalMessages: 0,
        positiveCount: 0,
        negativeCount: 0,
        conflictCount: 0,
        lastActiveDate: null,
        consecutiveInactiveDays: 0,
        dailyMessageCounts: [],
        sentimentHistory: [],
        recentTurns: [],
        today: { dayKey: key, turns: 0, criticismCount: 0, sentiments: [] },
    };
}

/**
 * 清洗迁移或落盘读取到的统计数据。
 * 旧版 toDateString 日期一律丢弃，防止混用日界格式。
 */
function sanitizeStats(rawStats, now = Date.now()) {
    const defaults = createDefaultStats(now);
    const raw = rawStats && typeof rawStats === 'object' ? rawStats : {};
    const nonNegativeInt = (value, fallback = 0) => Number.isFinite(value)
        ? Math.max(0, Math.floor(value))
        : fallback;
    const lastActiveDate = normalizeDayKey(raw.lastActiveDate);
    const dailyMessageCounts = (Array.isArray(raw.dailyMessageCounts) ? raw.dailyMessageCounts : [])
        .filter((entry) => entry && normalizeDayKey(entry.date) && Number.isFinite(entry.count))
        .map((entry) => ({ date: entry.date, count: nonNegativeInt(entry.count) }))
        .slice(-30);
    const sentimentHistory = (Array.isArray(raw.sentimentHistory) ? raw.sentimentHistory : [])
        .filter((entry) => entry && Number.isFinite(entry.value) && Number.isFinite(entry.timestamp))
        .map((entry) => ({ value: Number(entry.value), timestamp: Number(entry.timestamp) }))
        .slice(-100);
    const recentTurns = (Array.isArray(raw.recentTurns) ? raw.recentTurns : [])
        .filter((entry) => entry && Number.isFinite(entry.at))
        .map((entry) => ({
            at: Number(entry.at),
            category: typeof entry.category === 'string' ? entry.category : null,
            sentiment: Number.isFinite(entry.sentiment) ? Number(entry.sentiment) : 0,
            criticism: entry.criticism === true,
            conflict: entry.conflict === true,
        }))
        .slice(-50);
    const rawToday = raw.today && typeof raw.today === 'object' ? raw.today : {};
    const todayKey = normalizeDayKey(rawToday.dayKey) || defaults.today.dayKey;
    const today = {
        dayKey: todayKey,
        turns: nonNegativeInt(rawToday.turns),
        criticismCount: nonNegativeInt(rawToday.criticismCount),
        sentiments: (Array.isArray(rawToday.sentiments) ? rawToday.sentiments : [])
            .filter(Number.isFinite)
            .map(Number)
            .slice(-200),
    };

    return {
        totalDays: nonNegativeInt(raw.totalDays),
        activeDays: nonNegativeInt(raw.activeDays),
        totalMessages: nonNegativeInt(raw.totalMessages),
        positiveCount: nonNegativeInt(raw.positiveCount),
        negativeCount: nonNegativeInt(raw.negativeCount),
        conflictCount: nonNegativeInt(raw.conflictCount),
        lastActiveDate,
        consecutiveInactiveDays: nonNegativeInt(raw.consecutiveInactiveDays),
        dailyMessageCounts,
        sentimentHistory,
        recentTurns,
        today,
    };
}

/** 深复制可下发的 traits。 */
function cloneTraits(traits) {
    return Object.fromEntries(DIM_KEYS.map((key) => [key, traits[key]]));
}

class PersonalityDrift {
    /**
     * @param {string} stateFileName 状态文件名，测试必须传独立的 .test.json 文件
     */
    constructor(stateFileName = STATE_FILE) {
        this.stateFile = typeof stateFileName === 'string' && stateFileName
            ? stateFileName
            : STATE_FILE;
        this.statePath = dataPath(this.stateFile);
        this._initializeDefaults();
        this._loadState();
    }

    /** 初始化温柔预设的 v2 状态。 */
    _initializeDefaults(now = Date.now()) {
        const preset = getPreset(DEFAULT_PRESET_ID);
        this.version = 2;
        this.presetId = DEFAULT_PRESET_ID;
        this.baseline = cloneTraits(preset.traits);
        this.current = cloneTraits(preset.traits);
        this.driftEnabled = true;
        this.baselineAdaptEnabled = true;
        this.stats = createDefaultStats(now);
        this.daily = { dayKey: dayKey(new Date(now)), accum: {} };
        this.ruleHits = {};
        this.adapt = {};
        this.ledger = [];
        this.lastSettledDay = null;
        this.lastUpdated = new Date(now).toISOString();
    }

    // ==================== 每日结算 ====================

    /**
     * 惰性每日结算。相同 dayKey 内幂等；跨日时依次执行模式漂移、基线回拉和基线沉淀。
     * @param {number} now 当前 epoch 毫秒
     * @returns {{settled:boolean,changes:Array<object>,adapted:Array<object>}}
     */
    settleDaily(now = Date.now()) {
        const safeNow = Number.isFinite(now) ? now : Date.now();
        const key = dayKey(new Date(safeNow));
        if (this.lastSettledDay === key) {
            return { settled: false, changes: [], adapted: [] };
        }

        this._appendMissingDays(key);
        const inactiveGap = this.stats.lastActiveDate ? dayGap(this.stats.lastActiveDate, key) : 0;
        this.stats.consecutiveInactiveDays = Math.max(0, inactiveGap - 1);
        const settleGap = this.lastSettledDay ? Math.max(1, dayGap(this.lastSettledDay, key)) : 1;
        this.stats.totalDays += settleGap;

        // 模式变化从新自然日额度开始计算，但信号仍读取刚结束一天的 stats.today。
        this.daily = { dayKey: key, accum: {} };
        const dayStats = buildDayStats(this.stats, safeNow);
        const result = this.driftEnabled
            ? computeDrift(dayStats, {
                mode: 'pattern',
                totalMessages: this.stats.totalMessages,
                fatigueCounts: {},
            })
            : { changes: [], hits: [] };
        const appliedChanges = [];
        for (const hit of result.hits) {
            const actual = this._applyAutoHit(hit, safeNow, null);
            appliedChanges.push(...actual);
        }

        // 回拉力不计入 daily.accum，也不写账本。
        if (this.driftEnabled) {
            this.current = {
                ...this.current,
                ...applyBaselinePull(this.current, this.baseline, PERSONALITY_RULES.BASELINE_PULL),
            };
        }

        const { moves, nextAdapt } = computeBaselineAdapt({
            baseline: this.baseline,
            current: this.current,
            adapt: this.adapt,
            now: safeNow,
            enabled: this.driftEnabled && this.baselineAdaptEnabled,
        });
        this.adapt = nextAdapt;
        if (moves.length > 0) {
            for (const move of moves) {
                this.baseline[move.dim] = move.after;
                this.current[move.dim] = clampCurrent(this.current[move.dim], move.after);
            }
            this._appendLedger({
                at: new Date(safeNow).toISOString(),
                source: 'baseline_adapt',
                ruleId: null,
                reason: moves.length === 1
                    ? `相处久了，「${DIM_LABELS[moves[0].dim]}」的基线慢慢跟进了`
                    : '长久相处让她的性格基线慢慢发生了变化',
                changes: moves,
            });
        }

        this.stats.today = { dayKey: key, turns: 0, criticismCount: 0, sentiments: [] };
        this.lastSettledDay = key;
        this._saveState(safeNow);
        console.log(`[Personality] settled ${key}: ${appliedChanges.length} change(s), ${moves.length} baseline move(s)`);
        return { settled: true, changes: appliedChanges, adapted: moves };
    }

    // ==================== 一次用户回合 ====================

    /**
     * 记录一次用户回合，同时更新统计并执行即时内容漂移。
     * 整条路径只做同步内存计算与本地 JSON 落盘，不发起网络请求。
     * @param {string} userInput 用户输入
     * @param {{sentiment?:number,affinity?:number,affinityChange?:number}} context 上下文
     * @param {number} now 当前 epoch 毫秒
     * @returns {{current:Record<string,number>,changes:Array<object>,hits:Array<object>}}
     */
    recordUserTurn(userInput, context = {}, now = Date.now()) {
        const safeNow = Number.isFinite(now) ? now : Date.now();
        this.settleDaily(safeNow);
        this.ruleHits = pruneRuleHits(
            this.ruleHits,
            safeNow,
            PERSONALITY_RULES.FATIGUE_WINDOW_MS,
        );
        const fatigueCounts = Object.fromEntries(
            Object.entries(this.ruleHits).map(([ruleId, timestamps]) => [ruleId, timestamps.length]),
        );
        const affinity = Number.isFinite(context.affinity) ? context.affinity : 0;
        const signals = buildSignals(userInput, {
            sentiment: context.sentiment,
            affinity,
            stage: getStageForAffinity(affinity).stage,
            affinityChange: context.affinityChange,
        });
        const totalMessagesBeforeTurn = this.stats.totalMessages;
        const result = this.driftEnabled
            ? computeDrift(signals, {
                mode: 'instant',
                totalMessages: totalMessagesBeforeTurn,
                fatigueCounts,
            })
            : { changes: [], hits: [] };

        const appliedChanges = [];
        for (const hit of result.hits) {
            const actual = this._applyAutoHit(hit, safeNow, signals.digest || null);
            appliedChanges.push(...actual);
            this.ruleHits = recordRuleHit(this.ruleHits, hit.ruleId, safeNow);
        }

        this._recordStats(signals, safeNow);
        this._saveState(safeNow);
        return {
            current: cloneTraits(this.current),
            changes: appliedChanges,
            hits: result.hits.map((hit) => ({
                code: hit.code,
                ruleId: hit.ruleId,
                reason: hit.reason,
            })),
        };
    }

    // ==================== 手动、预设与开关 ====================

    /**
     * 修改一个或多个基线值，current 保留修改前相对偏移。
     * @param {Record<string,number>} traits 局部维度值
     * @returns {object} 最新公开状态
     */
    applyManual(traits = {}) {
        const entries = Object.entries(traits && typeof traits === 'object' ? traits : {});
        for (const [key] of entries) {
            if (!isDimKey(key)) throw new Error(`unknown personality dim: ${key}`);
        }

        const beforeCurrent = cloneTraits(this.current);
        const changedDims = [];
        for (const [key, rawValue] of entries) {
            const numericValue = Number(rawValue);
            if (!Number.isFinite(numericValue)) continue;
            const oldBaseline = this.baseline[key];
            const oldOffset = this.current[key] - oldBaseline;
            const nextBaseline = clampInt(numericValue, oldBaseline);
            if (nextBaseline === oldBaseline) continue;
            this.baseline[key] = nextBaseline;
            this.current[key] = clampCurrent(nextBaseline + oldOffset, nextBaseline);
            delete this.daily.accum[key];
            delete this.adapt[key];
            changedDims.push(key);
        }

        const changes = this._buildCurrentChanges(beforeCurrent, this.current, changedDims);
        if (changes.length > 0) {
            const first = changes[0];
            const direction = first.delta > 0 ? '调高' : '调低';
            this._appendLedger({
                at: new Date().toISOString(),
                source: 'manual',
                ruleId: null,
                reason: changes.length === 1
                    ? `你把「${DIM_LABELS[first.dim]}」${direction}了`
                    : '你手动微调了小爱的性格',
                changes,
            });
        }
        this._saveState();
        return this.getPublicState();
    }

    /**
     * 应用内置预设，baseline 与 current 同步到预设并清空浮动参照。
     * @param {string} presetId 预设 ID
     * @returns {object} 最新公开状态
     */
    applyPreset(presetId) {
        const preset = getPreset(presetId);
        if (!preset) throw new Error(`unknown presetId: ${presetId}`);
        const beforeCurrent = cloneTraits(this.current);
        this.presetId = preset.id;
        this.baseline = cloneTraits(preset.traits);
        this.current = cloneTraits(preset.traits);
        this.daily.accum = {};
        this.adapt = {};

        const changes = this._buildCurrentChanges(beforeCurrent, this.current, DIM_KEYS);
        this._appendLedger({
            at: new Date().toISOString(),
            source: 'preset',
            ruleId: null,
            reason: `你把她的性格切换成了「${preset.name}」`,
            changes,
        });
        this._saveState();
        return this.getPublicState();
    }

    /**
     * 更新漂移开关。关闭漂移时 current 立即收回 baseline。
     * @param {{driftEnabled?:boolean,baselineAdaptEnabled?:boolean}} flags 开关
     * @returns {object} 最新公开状态
     */
    setFlags(flags = {}) {
        if (typeof flags.baselineAdaptEnabled === 'boolean') {
            this.baselineAdaptEnabled = flags.baselineAdaptEnabled;
        }
        if (typeof flags.driftEnabled === 'boolean' && flags.driftEnabled !== this.driftEnabled) {
            const beforeCurrent = cloneTraits(this.current);
            this.driftEnabled = flags.driftEnabled;
            if (!this.driftEnabled) {
                this.current = cloneTraits(this.baseline);
                this.daily.accum = {};
                const changes = this._buildCurrentChanges(beforeCurrent, this.current, DIM_KEYS);
                this._appendLedger({
                    at: new Date().toISOString(),
                    source: 'reset',
                    ruleId: null,
                    reason: '你关掉了「允许聊天改变性格」，她的浮动已收回基线',
                    changes,
                });
            }
        }
        this._saveState();
        return this.getPublicState();
    }

    /**
     * 恢复默认温柔预设并清空性格时间线；保留统计与两个开关。
     * @returns {{status:string}}
     */
    reset() {
        const now = Date.now();
        const preset = getPreset(DEFAULT_PRESET_ID);
        this.presetId = DEFAULT_PRESET_ID;
        this.baseline = cloneTraits(preset.traits);
        this.current = cloneTraits(preset.traits);
        this.daily = { dayKey: dayKey(new Date(now)), accum: {} };
        this.ruleHits = {};
        this.adapt = {};
        this.ledger = [];
        this.lastSettledDay = dayKey(new Date(now));
        this._saveState(now);
        return { status: 'reset' };
    }

    // ==================== 查询 ====================

    /** 返回路由直接下发的完整公开状态。 */
    getPublicState() {
        const preset = getPreset(this.presetId);
        const customizedCount = preset
            ? DIM_KEYS.filter((key) => this.baseline[key] !== preset.traits[key]).length
            : 0;
        const customized = preset ? customizedCount > 0 : true;
        return {
            version: 2,
            presetId: this.presetId,
            presetName: preset ? preset.name : null,
            customized,
            customizedCount,
            baseline: cloneTraits(this.baseline),
            current: cloneTraits(this.current),
            driftEnabled: this.driftEnabled,
            baselineAdaptEnabled: this.baselineAdaptEnabled,
            band: PERSONALITY_RULES.FLOAT_BAND,
            dims: PERSONALITY_DIMS.map((dimension) => ({ ...dimension })),
            presets: PERSONALITY_PRESETS.map((item) => ({
                ...item,
                traits: cloneTraits(item.traits),
            })),
            stats: {
                totalMessages: this.stats.totalMessages,
                totalDays: this.stats.totalDays,
                activeDays: this.stats.activeDays,
            },
        };
    }

    /** 按时间升序返回账本深副本。 */
    getLedger() {
        return this.ledger.map((entry) => ({
            ...entry,
            changes: entry.changes.map((change) => ({ ...change })),
        }));
    }

    /** 生成每轮注入系统提示词的 7 维性格段落。 */
    getPromptInjection() {
        return buildPersonalityPrompt({
            presetId: this.presetId,
            baseline: this.baseline,
            current: this.current,
            ledger: this.ledger,
        });
    }

    /**
     * 返回最多三个偏离中点最明显的性格标签。
     * 七个维度均有高低方向标签。
     */
    getDominantTraits() {
        const labels = {
            independence: ['黏人', '独立'],
            willfulness: ['温顺', '任性'],
            sensitivity: ['钝感', '敏感'],
            security: ['缺乏安全感', '安心'],
            affection: ['内敛', '热情'],
            playfulness: ['稳重', '俏皮'],
            trust: ['戒备', '信任'],
        };
        const ranked = DIM_KEYS
            .map((dim, index) => ({
                dim,
                index,
                distance: Math.abs(this.current[dim] - 50),
                label: this.current[dim] >= 50 ? labels[dim][1] : labels[dim][0],
            }))
            .filter((item) => item.distance >= 10)
            .sort((left, right) => right.distance - left.distance || left.index - right.index)
            .slice(0, 3)
            .map((item) => item.label);
        return ranked.length > 0 ? ranked : ['温和'];
    }

    // （getFullState 已删除：全仓无调用者的旧调试入口，见 2026-09-30 全量功能验证 F42。）

    // ==================== 内部：规则应用与统计 ====================

    /** 应用单个自动规则命中，返回实际 current 变化。 */
    _applyAutoHit(hit, now, digest) {
        const originalAccum = { ...this.daily.accum };
        const capped = applyDailyCap(hit.changes, originalAccum, PERSONALITY_RULES.MAX_PER_DAY);
        const actualChanges = [];

        for (const change of capped.changes) {
            const before = this.current[change.dim];
            const after = clampCurrent(before + change.delta, this.baseline[change.dim]);
            const delta = round1(after - before);
            if (delta === 0) continue;
            this.current[change.dim] = after;
            const accumulatedBefore = Number.isFinite(originalAccum[change.dim])
                ? originalAccum[change.dim]
                : 0;
            this.daily.accum[change.dim] = round1(accumulatedBefore + delta);
            actualChanges.push({ dim: change.dim, before, after, delta });
            console.log(
                `[Personality] ${hit.code} ${hit.ruleId} → ${change.dim} `
                + `${delta > 0 ? '+' : ''}${delta} (${before.toFixed(1)} → ${after.toFixed(1)})`,
            );
        }

        this._appendLedger({
            at: new Date(now).toISOString(),
            source: 'auto',
            ruleId: hit.ruleId,
            reason: hit.reason,
            userInputDigest: digest,
            changes: actualChanges,
        });
        return actualChanges;
    }

    /** 更新近 50 轮、当日与全量统计。 */
    _recordStats(signals, now) {
        const key = dayKey(new Date(now));
        this.stats.totalMessages += 1;
        if (signals.sentiment > 0.3) this.stats.positiveCount += 1;
        if (signals.sentiment < -0.3) this.stats.negativeCount += 1;
        if (signals.isConflict) this.stats.conflictCount += 1;
        this.stats.sentimentHistory.push({ value: signals.sentiment, timestamp: now });
        this.stats.sentimentHistory = this.stats.sentimentHistory.slice(-100);

        const criticism = signals.category === 'CRITICISM';
        this.stats.recentTurns.push({
            at: now,
            category: signals.category,
            sentiment: signals.sentiment,
            criticism,
            conflict: signals.isConflict,
        });
        this.stats.recentTurns = this.stats.recentTurns.slice(-50);

        if (!this.stats.today || this.stats.today.dayKey !== key) {
            this.stats.today = { dayKey: key, turns: 0, criticismCount: 0, sentiments: [] };
        }
        this.stats.today.turns += 1;
        if (criticism) this.stats.today.criticismCount += 1;
        this.stats.today.sentiments.push(signals.sentiment);
        this.stats.today.sentiments = this.stats.today.sentiments.slice(-200);

        let todayEntry = this.stats.dailyMessageCounts.find((entry) => entry.date === key);
        if (!todayEntry) {
            todayEntry = { date: key, count: 0 };
            this.stats.dailyMessageCounts.push(todayEntry);
        }
        if (todayEntry.count === 0) this.stats.activeDays += 1;
        todayEntry.count += 1;
        this.stats.dailyMessageCounts = this.stats.dailyMessageCounts.slice(-30);
        this.stats.lastActiveDate = key;
        this.stats.consecutiveInactiveDays = 0;
    }

    /** 为跨过但没有消息的自然日补 0，保证近 7 天日均与连续活跃口径准确。 */
    _appendMissingDays(currentKey) {
        const lastEntry = this.stats.dailyMessageCounts.at(-1);
        const fromKey = normalizeDayKey(lastEntry?.date) || this.stats.lastActiveDate;
        const from = dayNumber(fromKey);
        const current = dayNumber(currentKey);
        if (from === null || current === null || current <= from + 1) return;

        for (let cursor = from + 1; cursor < current; cursor += 1) {
            const key = keyFromDayNumber(cursor);
            if (!this.stats.dailyMessageCounts.some((entry) => entry.date === key)) {
                this.stats.dailyMessageCounts.push({ date: key, count: 0 });
            }
        }
        this.stats.dailyMessageCounts = this.stats.dailyMessageCounts.slice(-30);
    }

    /** 生成 current 的实际变化列表。 */
    _buildCurrentChanges(beforeTraits, afterTraits, allowedDims) {
        const allowed = new Set(allowedDims);
        return DIM_KEYS
            .filter((dim) => allowed.has(dim))
            .map((dim) => {
                const before = round1(beforeTraits[dim]);
                const after = round1(afterTraits[dim]);
                return { dim, before, after, delta: round1(after - before) };
            })
            .filter((change) => change.delta !== 0);
    }

    /** 追加非零账本并统一 FIFO 裁到 200 条。 */
    _appendLedger(entry) {
        const changes = (Array.isArray(entry.changes) ? entry.changes : [])
            .filter((change) => isDimKey(change.dim) && round1(change.delta) !== 0)
            .map((change) => ({
                dim: change.dim,
                before: round1(change.before),
                after: round1(change.after),
                delta: round1(change.delta),
            }))
            .sort((left, right) => DIM_KEYS.indexOf(left.dim) - DIM_KEYS.indexOf(right.dim));
        if (changes.length === 0) return;
        this.ledger.push({
            at: entry.at,
            source: entry.source,
            ruleId: entry.ruleId ?? null,
            reason: entry.reason || '性格有了一些变化',
            ...(entry.source === 'auto' ? { userInputDigest: entry.userInputDigest || null } : {}),
            changes,
        });
        if (this.ledger.length > LEDGER_MAX) {
            this.ledger.splice(0, this.ledger.length - LEDGER_MAX);
        }
    }

    // ==================== 内部：加载、迁移与落盘 ====================

    _loadState() {
        const data = readJson(this.stateFile, null);
        if (!data || typeof data !== 'object') return;
        if (typeof data.version !== 'number') {
            this._migrateV1(data);
            return;
        }

        this.version = 2;
        this.presetId = PRESET_IDS.includes(data.presetId) || data.presetId === 'custom'
            ? data.presetId
            : DEFAULT_PRESET_ID;
        this.baseline = Object.fromEntries(DIM_KEYS.map((key) => [
            key,
            clampInt(data.baseline?.[key], DEFAULT_TRAITS[key]),
        ]));
        this.current = Object.fromEntries(DIM_KEYS.map((key) => [
            key,
            clampCurrent(data.current?.[key], this.baseline[key]),
        ]));
        this.driftEnabled = typeof data.driftEnabled === 'boolean' ? data.driftEnabled : true;
        this.baselineAdaptEnabled = typeof data.baselineAdaptEnabled === 'boolean'
            ? data.baselineAdaptEnabled
            : true;
        if (!this.driftEnabled) this.current = cloneTraits(this.baseline);
        this.stats = sanitizeStats(data.stats);

        const dailyKey = normalizeDayKey(data.daily?.dayKey) || dayKey();
        const rawAccum = data.daily?.accum && typeof data.daily.accum === 'object'
            ? data.daily.accum
            : {};
        this.daily = {
            dayKey: dailyKey,
            accum: Object.fromEntries(Object.entries(rawAccum)
                .filter(([key, value]) => isDimKey(key) && Number.isFinite(value))
                .map(([key, value]) => [key, round1(Math.max(-3, Math.min(3, value)))])),
        };
        this.ruleHits = {};
        if (data.ruleHits && typeof data.ruleHits === 'object' && !Array.isArray(data.ruleHits)) {
            for (const [ruleId, timestamps] of Object.entries(data.ruleHits)) {
                if (!Array.isArray(timestamps)) continue;
                const valid = timestamps.filter(Number.isFinite).map(Number).slice(-50);
                if (valid.length > 0) this.ruleHits[ruleId] = valid;
            }
        }
        this.adapt = {};
        if (data.adapt && typeof data.adapt === 'object' && !Array.isArray(data.adapt)) {
            for (const dim of DIM_KEYS) {
                const value = data.adapt[dim];
                if (!value || typeof value !== 'object') continue;
                this.adapt[dim] = {
                    streak: Number.isFinite(value.streak) ? Math.max(0, Math.floor(value.streak)) : 0,
                    dir: value.dir === -1 || value.dir === 1 ? value.dir : 0,
                    lastAdaptAt: Number.isFinite(value.lastAdaptAt) ? value.lastAdaptAt : null,
                };
            }
        }
        this.ledger = (Array.isArray(data.ledger) ? data.ledger : [])
            .filter((entry) => entry && typeof entry === 'object' && Array.isArray(entry.changes))
            .slice(-LEDGER_MAX)
            .map((entry) => ({
                at: typeof entry.at === 'string' ? entry.at : new Date(0).toISOString(),
                source: typeof entry.source === 'string' ? entry.source : 'auto',
                ruleId: typeof entry.ruleId === 'string' ? entry.ruleId : null,
                reason: typeof entry.reason === 'string' ? entry.reason : '性格有了一些变化',
                ...(entry.source === 'auto' ? {
                    userInputDigest: typeof entry.userInputDigest === 'string'
                        ? entry.userInputDigest.slice(0, 20)
                        : null,
                } : {}),
                changes: entry.changes
                    .filter((change) => change && isDimKey(change.dim) && Number.isFinite(change.delta))
                    .map((change) => ({
                        dim: change.dim,
                        before: round1(change.before),
                        after: round1(change.after),
                        delta: round1(change.delta),
                    })),
            }))
            .filter((entry) => entry.changes.length > 0);
        this.lastSettledDay = normalizeDayKey(data.lastSettledDay);
        this.lastUpdated = typeof data.lastUpdated === 'string'
            ? data.lastUpdated
            : new Date().toISOString();
        console.log(`[Personality] Loaded: ${this.getDominantTraits().join(', ')}`);
    }

    /** v1 traits 单次前向迁移到 v2，迁移完成立即落盘。 */
    _migrateV1(data) {
        const base = {};
        for (const key of DIM_KEYS) {
            if (key === 'playfulness') {
                base[key] = 50;
                continue;
            }
            base[key] = clampInt(data.traits?.[key], DEFAULT_TRAITS[key]);
        }
        this.version = 2;
        this.presetId = 'custom';
        this.baseline = { ...base };
        this.current = { ...base };
        this.driftEnabled = true;
        this.baselineAdaptEnabled = true;
        this.stats = sanitizeStats(data.stats);
        this.daily = { dayKey: dayKey(), accum: {} };
        this.ruleHits = {};
        this.adapt = {};
        this.ledger = [];
        this.lastSettledDay = null;
        this._saveState();
        console.log('[Personality] Migrated v1 → v2 (presetId=custom, playfulness=50)');
    }

    /** 原子落盘全部 v2 状态。 */
    _saveState(now = Date.now()) {
        const safeNow = Number.isFinite(now) ? now : Date.now();
        this.lastUpdated = new Date(safeNow).toISOString();
        const preset = getPreset(this.presetId);
        const customizedCount = preset
            ? DIM_KEYS.filter((key) => this.baseline[key] !== preset.traits[key]).length
            : 0;
        const customized = preset ? customizedCount > 0 : true;
        writeJson(this.stateFile, {
            version: 2,
            presetId: this.presetId,
            customized,
            customizedCount,
            baseline: this.baseline,
            current: this.current,
            driftEnabled: this.driftEnabled,
            baselineAdaptEnabled: this.baselineAdaptEnabled,
            stats: this.stats,
            daily: this.daily,
            ruleHits: this.ruleHits,
            adapt: this.adapt,
            ledger: this.ledger,
            lastSettledDay: this.lastSettledDay,
            lastUpdated: this.lastUpdated,
        });
    }
}

export default PersonalityDrift;
