/**
 * UserEmotionEngine - 用户情绪识别通道（REQ-01）。
 *
 * 定位（docs/companion-upgrade/02-architecture.md REQ-01 §2.1.3）：
 *   持有「用户」的当前情绪状态与时间线，落盘 data/user_emotion_state.json。
 *   ⚠️ 与 AI 自身的 EmotionEngine（PAD）**完全解耦**——本类只描述用户，不复用其状态。
 *
 * 混合方案（不新增任何 LLM 调用）：
 *   1. 词表层：analyze() 调 classifyUserEmotion() 纯函数，零网络成本、当轮即得；
 *   2. LLM 层：主对话 <metadata> 已回传 user_emotion（见 systemPrompt），本类在
 *      ingestTurn() 里把 LLM 结果与词表结果融合（fuse），LLM 权重更高但需过置信阈值；
 *   3. 兜底：LLM 未返回 user_emotion（老模型/不支持）时纯用词表结果，功能不失效。
 *
 * 落盘策略：时间线走去抖异步写盘（参照 MemoryStore.flushDebounceMs），
 *   禁止每轮同步全量重写 JSON；flush() 兜底，reset() 立即落盘。
 */
import { readJson, writeJson } from '../utils/jsonStore.js';
import { config } from '../config.js';
import {
    classifyUserEmotion, mapDimensionsToLabel, clamp, round, NEUTRAL_EMOTION,
    USER_EMOTION_LABELS, NEUTRAL_LABEL,
} from './userEmotionLexicon.js';

const STATE_FILE = 'user_emotion_state.json';
const SCHEMA_VERSION = 1;

class UserEmotionEngine {
    constructor() {
        // 当前用户情绪三维 + 标签（默认中性）
        this.state = {
            valence: NEUTRAL_EMOTION.valence,
            arousal: NEUTRAL_EMOTION.arousal,
            intensity: NEUTRAL_EMOTION.intensity,
            label: NEUTRAL_LABEL,
            updatedAt: null,
        };
        this.timeline = [];
        this._saveTimer = null;
        this._dirty = false;
        this._load();
    }

    // ==================== 词表分析（同步纯计算，不落盘） ====================

    /**
     * 当轮即时分析（不落盘）：产出词表结果，供 prompt 注入与 ingest 融合使用。
     * @param {string} userInput
     * @returns {{valence:number,arousal:number,intensity:number,label:string,confidence:number,source:string,matched:string[]}}
     */
    analyze(userInput) {
        try {
            return classifyUserEmotion(userInput);
        } catch (e) {
            console.error(`[UserEmotion] analyze failed: ${e.message}`);
            return { ...NEUTRAL_EMOTION, confidence: 0, source: 'lexicon', matched: [] };
        }
    }

    /**
     * 融合词表结果与 LLM 结果（weighted average）。
     *
     * 规则：
     *   - 校验 LLM 结果合法（label 在枚举内、三维为有限数、confidence 为有限数）；
     *   - LLM 置信度 < 阈值 → 忽略 LLM，纯用词表（兜底 / 老模型路径）；
     *   - 否则按 lexiconWeight / llmWeight 加权平均三维，再重映射标签；
     *   - source 标记为 'fused'；仅 LLM（词表无命中）时 source='llm'。
     *
     * @returns {{valence:number,arousal:number,intensity:number,label:string,confidence:number,source:'lexicon'|'llm'|'fused'}}
     */
    fuse(lexiconResult, llmResult) {
        const lex = lexiconResult && typeof lexiconResult === 'object'
            ? lexiconResult : { ...NEUTRAL_EMOTION, confidence: 0 };
        const valid = this._sanitizeLLM(llmResult);

        // 无合法 LLM 结果：纯词表兜底
        if (!valid) {
            return {
                valence: round(lex.valence),
                arousal: round(lex.arousal),
                intensity: round(lex.intensity),
                label: lex.label || mapDimensionsToLabel(lex.valence, lex.arousal, lex.intensity),
                confidence: round(clamp(lex.confidence ?? 0, 0, 1)),
                source: 'lexicon',
            };
        }

        const llmConfident = valid.confidence >= config.userEmotion.llmConfidenceThreshold;
        const lexConfident = (lex.confidence ?? 0) > 0;

        // LLM 低置信度（或词表也没信号）→ 以词表为准兜底，绝不采用低信度的 LLM 数值
        if (!llmConfident) {
            return {
                valence: round(lex.valence),
                arousal: round(lex.arousal),
                intensity: round(lex.intensity),
                label: lex.label || mapDimensionsToLabel(lex.valence, lex.arousal, lex.intensity),
                confidence: round(clamp(lex.confidence ?? 0, 0, 1)),
                source: 'lexicon',
            };
        }

        // 词表无命中但 LLM 可信 → 采信 LLM
        if (!lexConfident) {
            return {
                valence: round(valid.valence),
                arousal: round(valid.arousal),
                intensity: round(valid.intensity),
                label: valid.label,
                confidence: round(valid.confidence),
                source: 'llm',
            };
        }

        // 双方都可信 → 加权平均
        const wl = config.userEmotion.lexiconWeight;
        const wm = config.userEmotion.llmWeight;
        const total = wl + wm || 1;
        const valence = round(clamp((lex.valence * wl + valid.valence * wm) / total, -1, 1));
        const arousal = round(clamp((lex.arousal * wl + valid.arousal * wm) / total, -1, 1));
        const intensity = round(clamp((lex.intensity * wl + valid.intensity * wm) / total, 0, 1));
        const label = mapDimensionsToLabel(valence, arousal, intensity);
        const confidence = round(clamp((lex.confidence * wl + valid.confidence * wm) / total, 0, 1));

        return { valence, arousal, intensity, label, confidence, source: 'fused' };
    }

    /** 校验并归一化 LLM 返回的 user_emotion；非法返回 null。 */
    _sanitizeLLM(llmResult) {
        if (!llmResult || typeof llmResult !== 'object') return null;
        const valence = Number(llmResult.valence);
        const arousal = Number(llmResult.arousal);
        const intensity = Number(llmResult.intensity);
        const confidence = Number(llmResult.confidence);
        if (![valence, arousal, intensity, confidence].every(Number.isFinite)) return null;
        const label = USER_EMOTION_LABELS.includes(llmResult.label)
            ? llmResult.label
            : mapDimensionsToLabel(valence, arousal, intensity);
        return {
            valence: clamp(valence, -1, 1),
            arousal: clamp(arousal, -1, 1),
            intensity: clamp(intensity, 0, 1),
            confidence: clamp(confidence, 0, 1),
            label,
        };
    }

    // ==================== 每轮摄入 ====================

    /**
     * 摄入一轮对话：融合 → 更新 state → 追加 timeline → 去抖落盘。
     *
     * @param {string} userInput   用户输入原文
     * @param {string} replyText   AI 回复原文（保留参数，便于后续扩展；本期不参与分析）
     * @param {object|null} llmUserEmotion 主对话 metadata 里的 user_emotion（可缺省）
     * @returns {{ current:object, turned:boolean, trend:object }}
     *          turned=true 表示本轮发生显著情绪转折（|Δvalence| ≥ turnThreshold）
     */
    ingestTurn(userInput, replyText = '', llmUserEmotion = null) {
        const lex = this.analyze(userInput);
        const fused = this.fuse(lex, llmUserEmotion);

        const prevValence = Number.isFinite(this.state.valence) ? this.state.valence : 0;
        const delta = Math.abs(fused.valence - prevValence);
        const turned = delta >= config.userEmotion.turnThreshold;

        const now = Date.now();
        this.state = {
            valence: fused.valence,
            arousal: fused.arousal,
            intensity: fused.intensity,
            label: fused.label,
            updatedAt: now,
        };

        // timeline 追加（滑动窗口）
        this.timeline.push(this._buildEntry(fused, userInput, now));
        const cap = config.userEmotion.timelineMax;
        if (this.timeline.length > cap) {
            this.timeline = this.timeline.slice(-cap);
        }

        this._scheduleSave();

        console.log(
            `[UserEmotion] ${fused.source} → ${fused.label} ` +
            `(v=${fused.valence} a=${fused.arousal} i=${fused.intensity} conf=${fused.confidence})` +
            (turned ? ' [转折]' : '')
        );

        return { current: { ...this.state }, turned, trend: this.getRecentTrend() };
    }

    /** 构造 timeline 条目（截断 excerpt）。 */
    _buildEntry(fused, userInput, ts) {
        const max = config.userEmotion.excerptMax;
        const raw = (userInput || '').trim();
        const excerpt = raw.length > max ? raw.slice(0, max) : raw;
        return {
            ts,
            valence: fused.valence,
            arousal: fused.arousal,
            intensity: fused.intensity,
            label: fused.label,
            source: fused.source,
            confidence: fused.confidence,
            excerpt,
        };
    }

    // ==================== 趋势 ====================

    /**
     * 近期趋势：窗口内的平均 valence、斜率（slope）与是否下滑。
     * @param {number} [windowMs] 默认 config.userEmotion.trendWindowMs
     * @returns {{avgValence:number, slope:number, declining:boolean, samples:number, windowMs:number, available:boolean}}
     */
    getRecentTrend(windowMs) {
        const window_ = Number.isFinite(windowMs) ? windowMs : config.userEmotion.trendWindowMs;
        const now = Date.now();
        const recent = this.timeline.filter((e) => now - e.ts <= window_);

        if (recent.length === 0) {
            return { avgValence: 0, slope: 0, declining: false, samples: 0, windowMs: window_, available: false };
        }

        const avgValence = round(recent.reduce((s, e) => s + e.valence, 0) / recent.length);
        // 最小二乘斜率（x=索引近似时间序，y=valence）
        const n = recent.length;
        let slope = 0;
        if (n >= 2) {
            const meanX = (n - 1) / 2;
            const meanY = recent.reduce((s, e) => s + e.valence, 0) / n;
            let num = 0;
            let den = 0;
            recent.forEach((e, idx) => {
                num += (idx - meanX) * (e.valence - meanY);
                den += (idx - meanX) ** 2;
            });
            slope = den === 0 ? 0 : round(num / den);
        }
        const declining = n >= 2 && slope <= config.userEmotion.decliningSlope;

        return { avgValence, slope, declining, samples: n, windowMs: window_, available: true };
    }

    // ==================== Prompt 注入 ====================

    /**
     * 产出 [User Emotion] 段。
     * ⚠️ 失败或关闭时返回 ''（空串语义 = 不注入，行为与改造前一致）。
     * @returns {string}
     */
    getPromptInjection() {
        try {
            if (!config.userEmotion.enabled) return '';
            // 从未分析过（updatedAt 为 null）→ 不注入，避免首轮凭空断言
            if (this.state.updatedAt === null) return '';

            const trend = this.getRecentTrend();
            const trendText = this._describeTrend(trend);
            const dims = `valence=${this.state.valence.toFixed(2)} arousal=${this.state.arousal.toFixed(2)} intensity=${this.state.intensity.toFixed(2)}`;

            return [
                '[User Emotion - 用户当前情绪]',
                `- 用户情绪: ${this.state.label}（${dims}）`,
                `- 近期趋势: ${trendText}`,
                '- 这是对"他"此刻情绪的观察，不是小爱自己的情绪。回应时体贴地照顾他的状态，但不要直接念出这些数值。',
            ].join('\n');
        } catch (e) {
            console.error(`[UserEmotion] getPromptInjection failed: ${e.message}`);
            return '';
        }
    }

    /** 趋势人话描述。 */
    _describeTrend(trend) {
        if (!trend.available || trend.samples < 2) return '数据不足（本轮为最新状态）';
        if (trend.declining) return `情绪在下滑（均值 ${trend.avgValence}，斜率 ${trend.slope}），请温和安抚、不要追问`;
        if (trend.slope > 0.05) return `情绪在回升（均值 ${trend.avgValence}），状态不错`;
        return `情绪较平稳（均值 ${trend.avgValence}）`;
    }

    // ==================== 访问器 ====================

    /** 供路由：当前状态 + 时间线统计。 */
    getState() {
        const trend = this.getRecentTrend();
        return {
            state: { ...this.state },
            timelineStats: {
                count: this.timeline.length,
                cap: config.userEmotion.timelineMax,
                trend,
            },
        };
    }

    /** 时间线副本（防止外部改写内部状态）。 */
    getTimeline() {
        return this.timeline.map((e) => ({ ...e }));
    }

    // ==================== 生命周期 ====================

    /**
     * 回到初始态（「完全重置」语义）。
     * 与构造函数初值保持镜像，并立即落盘（不走去抖，保证重置即时生效）。
     */
    reset() {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        this.state = {
            valence: NEUTRAL_EMOTION.valence,
            arousal: NEUTRAL_EMOTION.arousal,
            intensity: NEUTRAL_EMOTION.intensity,
            label: NEUTRAL_LABEL,
            updatedAt: null,
        };
        this.timeline = [];
        this._dirty = false;
        this._saveNow();
        return { label: this.state.label };
    }

    // ==================== 持久化 ====================

    _load() {
        const data = readJson(STATE_FILE, null);
        if (!data || typeof data !== 'object') return;
        if (data.state && typeof data.state === 'object') {
            this.state = {
                valence: Number.isFinite(data.state.valence) ? data.state.valence : NEUTRAL_EMOTION.valence,
                arousal: Number.isFinite(data.state.arousal) ? data.state.arousal : NEUTRAL_EMOTION.arousal,
                intensity: Number.isFinite(data.state.intensity) ? data.state.intensity : NEUTRAL_EMOTION.intensity,
                label: USER_EMOTION_LABELS.includes(data.state.label) ? data.state.label : NEUTRAL_LABEL,
                updatedAt: Number.isFinite(data.state.updatedAt) ? data.state.updatedAt : null,
            };
        }
        if (Array.isArray(data.timeline)) {
            this.timeline = data.timeline
                .filter((e) => e && Number.isFinite(e.ts) && Number.isFinite(e.valence))
                .slice(-config.userEmotion.timelineMax);
        }
        console.log(`[UserEmotion] Loaded state: ${this.state.label} (timeline=${this.timeline.length})`);
    }

    /** 去抖落盘：合并时间线内的多次写入，参考 MemoryStore 的做法。 */
    _scheduleSave() {
        this._dirty = true;
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this._flush();
        }, config.userEmotion.flushDebounceMs);
    }

    /** 立即落盘（幂等；无待写数据时空操作）。 */
    _flush() {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        if (!this._dirty) return;
        this._dirty = false;
        this._saveNow();
    }

    /**
     * 公开 flush（停机兜底，对照 MemoryStore.flush / NarrativeStore.flush）：
     * 把去抖中的待写时间线立即落盘。内部转发 _flush，避免外部触碰私有方法。
     */
    flush() {
        this._flush();
    }

    /** 无条件写盘（reset 用）。 */
    _saveNow() {
        writeJson(STATE_FILE, {
            version: SCHEMA_VERSION,
            state: this.state,
            timeline: this.timeline,
            lastUpdated: new Date().toISOString(),
        });
    }
}

export default UserEmotionEngine;
