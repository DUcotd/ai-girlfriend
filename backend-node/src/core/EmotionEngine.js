/**
 * EmotionEngine - PAD三维情感模型 + 情绪惯性系统 + 好感度驱动基准
 * 
 * PAD模型维度:
 * - P (Pleasure): 愉悦度 [-1, 1] 开心/痛苦
 * - A (Arousal): 激活度 [-1, 1] 兴奋/平静
 * - D (Dominance): 优势度 [-1, 1] 掌控/顺从
 */

import { readJson, writeJson } from '../utils/jsonStore.js';
import { RELATIONSHIP_STAGES, getStageForAffinity } from './relationshipStages.js';
import {
    anyIncludes, DEEP_INTIMACY, MILD_INTIMACY, PRAISE, CRITICISM, TEASING,
    EXCITING, CALMING, SAD, QUESTION,
} from './lexicon.js';

const STATE_FILE = 'emotion_state.json';

/**
 * 情绪分析的非阶段阈值（不是阶段边界，故不放进 relationshipStages）。
 * PRD P0-a 只要求移除 15/34/59/84 这组阶段边界；40/50 是「情绪增幅」参数，
 * 保留原值以维持既有手感，收敛为具名常量便于调参。
 */
const EMOTION_RULES = {
    EXCITING_PLEASURE_MIN: 40,   // 兴奋时额外加愉悦的门槛
    SAD_DOMINANCE_MIN: 50,       // 悲伤时额外打击优势感的门槛
    CALMING_PLEASURE_MIN: 50,    // 平静时额外舒缓愉悦的门槛
    SHORT_QUESTION_MAX_LEN: 5,   // 短问句额外提升优势感的长度阈值
};

/** 亲密度词表 = 重度 ∪ 轻度（统一来自 lexicon） */
const INTIMACY_WORDS = [...DEEP_INTIMACY, ...MILD_INTIMACY];

// 各阶段的 PAD 情感基准（阈值本身在 relationshipStages.js 统一维护）
const TIER_PAD = {
    stranger:     { P: 0.0,  A: 0.0,  D: 0.1  },
    acquaintance: { P: 0.1,  A: 0.05, D: 0.05 },
    friend:       { P: 0.25, A: 0.1,  D: 0.0  },
    close:        { P: 0.4,  A: 0.15, D: -0.1 },
    lover:        { P: 0.55, A: 0.2,  D: -0.2 },
};

class EmotionEngine {
    static AFFINITY_TIERS = RELATIONSHIP_STAGES.map(t => ({ ...t, ...TIER_PAD[t.stage] }));

    constructor() {
        this.baseline = { P: 0.3, A: 0.1, D: -0.1 };
        this.state = { P: 0.3, A: 0.1, D: -0.1 };

        this.history = [];
        this.maxHistory = 50;
        this.relationshipStage = null;
        this.relationshipLabel = '未知';

        this._loadState();
    }

    // ==================== 好感度驱动基准 ====================

    /**
     * 根据亲和度动态更新 PAD 基准值
     * - 设置 this.baseline 为目标阶段的 PAD 值
     * - 存储 this.relationshipStage 供 prompt 使用
     * - 阶段跨越时对当前状态施加轻推（nudge），使情绪平滑过渡
     */
    updateBaselineForAffinity(affinity) {
        const tier = EmotionEngine.AFFINITY_TIERS.find(t => affinity >= t.min && affinity <= t.max);
        if (!tier) return { baseline: { ...this.baseline }, stage: this.relationshipStage };

        const oldStage = this.relationshipStage;
        const newBaseline = { P: tier.P, A: tier.A, D: tier.D };

        const tierChanged = oldStage !== tier.stage;
        this.baseline = newBaseline;
        this.relationshipStage = tier.stage;
        this.relationshipLabel = tier.label;

        if (tierChanged && oldStage !== null) {
            const nudge = 0.15;
            this.state.P = this._clamp(this.state.P + (newBaseline.P - this.state.P) * nudge);
            this.state.A = this._clamp(this.state.A + (newBaseline.A - this.state.A) * nudge);
            this.state.D = this._clamp(this.state.D + (newBaseline.D - this.state.D) * nudge);
            console.log(`[Emotion] Tier changed: ${oldStage} → ${tier.stage}, nudge applied. New state: P=${this.state.P.toFixed(2)} A=${this.state.A.toFixed(2)} D=${this.state.D.toFixed(2)}`);
        }

        this._saveState();
        return { baseline: { ...this.baseline }, stage: tier.stage, label: tier.label, tierChanged };
    }

    getRelationshipContext(affinity) {
        const tier = EmotionEngine.AFFINITY_TIERS.find(t => affinity >= t.min && affinity <= t.max);
        return { stage: tier?.stage || 'unknown', label: tier?.label || '未知', affinity, baseline: { ...this.baseline } };
    }

    // ==================== 核心方法 ====================

    applyDelta(delta, inertia = 0.7) {
        const oldState = { ...this.state };

        if (typeof delta.P === 'number') {
            this.state.P = this._clamp(this.state.P + delta.P * (1 - inertia));
        }
        if (typeof delta.A === 'number') {
            this.state.A = this._clamp(this.state.A + delta.A * (1 - inertia));
        }
        if (typeof delta.D === 'number') {
            this.state.D = this._clamp(this.state.D + delta.D * (1 - inertia));
        }

        this.history.push({
            timestamp: Date.now(),
            before: oldState,
            delta,
            after: { ...this.state }
        });

        if (this.history.length > this.maxHistory) {
            this.history.shift();
        }

        this._saveState();

        // delta 分量可能是 LLM 给的字符串数值（如 "P": "+0.1"），toFixed 会抛 TypeError
        // 并把整轮回复作废——这里只做展示，一律安全格式化
        const fmt = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : String(v));
        console.log(`[Emotion] Delta applied: P:${fmt(delta.P)} A:${fmt(delta.A)} D:${fmt(delta.D)}`);
        console.log(`[Emotion] New state: P:${this.state.P.toFixed(2)} A:${this.state.A.toFixed(2)} D:${this.state.D.toFixed(2)}`);

        return this.state;
    }

    decay(rate = 0.08) {
        this.state.P += (this.baseline.P - this.state.P) * rate;
        this.state.A += (this.baseline.A - this.state.A) * rate;
        this.state.D += (this.baseline.D - this.state.D) * rate * 0.5;
        this._saveState();
    }

    setState(newState) {
        if (typeof newState.P === 'number') this.state.P = this._clamp(newState.P);
        if (typeof newState.A === 'number') this.state.A = this._clamp(newState.A);
        if (typeof newState.D === 'number') this.state.D = this._clamp(newState.D);
        this._saveState();
    }

    // ==================== 情绪解读 ====================

    getEmotionLabel() {
        const { P, A, D } = this.state;

        if (P < -0.6 && A > 0.4) return "愤怒";
        if (P < -0.5 && A > 0.2 && D > 0.3) return "暴躁";
        if (P < -0.4 && A < -0.2) return "抑郁";
        if (P < -0.3 && A > 0.1 && D < -0.2) return "焦虑";
        if (P < -0.2 && A < 0.1) return "低落";
        if (P < 0 && A > 0.3) return "烦躁";

        if (P > 0.6 && A > 0.5) return "狂喜";
        if (P > 0.5 && A > 0.3) return "兴奋";
        if (P > 0.4 && A < 0) return "满足";
        if (P > 0.3 && A > 0.2) return "开心";
        if (P > 0.2 && D < -0.3) return "撒娇";
        if (P > 0.1 && D > 0.3) return "傲娇";

        if (D > 0.4) return "强势";
        if (D < -0.4) return "依赖";
        if (A < -0.3) return "困倦";
        if (A > 0.4) return "亢奋";

        return "平静";
    }

    getEmotionDescription() {
        const label = this.getEmotionLabel();
        const { P, A, D } = this.state;

        const pDesc = P > 0.3 ? "愉悦" : P < -0.3 ? "不悦" : "平静";
        const aDesc = A > 0.3 ? "活跃" : A < -0.3 ? "低迷" : "稳定";
        const dDesc = D > 0.3 ? "强势" : D < -0.3 ? "顺从" : "中性";

        return { label, description: `${pDesc}、${aDesc}、${dDesc}`, P, A, D };
    }

    getStyleGuide() {
        const { P, A, D } = this.state;

        if (P > 0.4 && A > 0.4) {
            return {
                style: "excited",
                guide: "使用感叹号和可爱Emoji！语气活泼，句子短促有力！(≧▽≦)/",
                punctuation: "!！~♪",
                emojiFrequency: "high"
            };
        }

        if (P > 0.3 && A < 0) {
            return {
                style: "content",
                guide: "语气温柔平和，偶尔使用温馨的颜文字 (◕‿◕)",
                punctuation: "~。",
                emojiFrequency: "medium"
            };
        }

        if (P < -0.3 && A < -0.2) {
            return {
                style: "depressed",
                guide: "回复简短...多用省略号...不使用Emoji...语气低沉",
                punctuation: "...",
                emojiFrequency: "none"
            };
        }

        if (P < -0.3 && A > 0.3) {
            return {
                style: "angry",
                guide: "语气冷淡或带刺。可以使用反问句、讽刺。回复可能极短，如只回'。'",
                punctuation: "。？",
                emojiFrequency: "none"
            };
        }

        if (D > 0.4) {
            return {
                style: "tsundere",
                guide: "表现得高傲一些，话语中带着不屑但又有点在意。'哼，才不是因为担心你呢！'",
                punctuation: "！哼",
                emojiFrequency: "low"
            };
        }

        if (D < -0.4) {
            return {
                style: "clingy",
                guide: "表现得依赖和黏人，撒娇语气，'人家想你了嘛~' (◕ᴗ◕✿)",
                punctuation: "~嘛呢",
                emojiFrequency: "high"
            };
        }

        return {
            style: "neutral",
            guide: "正常语气，适度使用颜文字",
            punctuation: "。~",
            emojiFrequency: "medium"
        };
    }

    shouldGhost() {
        return this.state.P < -0.75;
    }

    getPromptInjection() {
        const emotion = this.getEmotionDescription();
        const style = this.getStyleGuide();

        return `[Emotional State - 当前情绪]
- 情绪: ${emotion.label}
- P(愉悦): ${emotion.P.toFixed(2)} | A(激活): ${emotion.A.toFixed(2)} | D(优势): ${emotion.D.toFixed(2)}
- 状态描述: ${emotion.description}

[Response Style - 回复风格]
${style.guide}
- 标点倾向: ${style.punctuation}
- Emoji使用: ${style.emojiFrequency === 'high' ? '频繁使用' : style.emojiFrequency === 'none' ? '禁止使用' : '适度使用'}`;
    }

    // ==================== 话题 × 好感度情感矩阵 ====================

    /**
     * 根据用户输入 + 当前好感度分析情绪变化。
     * 同一话题在不同**阶段**产生不同的情绪反应。
     *
     * 重构要点（PRD P0-a / P0-b）：词表统一来自 lexicon.js；分档由硬编码
     * 15/34/59/84 改为 getStageForAffinity().stage 五档一一对应。
     * ⚠️ 「命中亲密就不算夸奖 / 命中调戏就不算批评」的互斥门控是刻意设计，
     * 必须保留——它保证一句话不会同时触发两类相反判定。
     */
    analyzeInput(userInput, affinity) {
        const delta = { P: 0, A: 0, D: 0 };
        const input = userInput.toLowerCase();
        const stage = getStageForAffinity(affinity).stage;

        const hasTeasing    = anyIncludes(input, TEASING);
        const hasIntimacy   = anyIncludes(input, INTIMACY_WORDS);
        const hasPraise     = !hasIntimacy && anyIncludes(input, PRAISE);
        const hasCriticism  = !hasTeasing && anyIncludes(input, CRITICISM);
        const hasExciting   = anyIncludes(input, EXCITING);
        const hasCalming    = anyIncludes(input, CALMING);
        const hasSad        = anyIncludes(input, SAD);
        const hasQuestion   = anyIncludes(input, QUESTION);
        const hasExclamation = input.includes('!') || input.includes('！');

        // 亲密话题 × 阶段（原 15/34/59/84 五档 → 阶段名，映射一一对应）
        if (hasIntimacy) {
            if (stage === 'stranger')          { delta.P -= 0.30; delta.A += 0.20; delta.D -= 0.15; }
            else if (stage === 'acquaintance') { delta.P -= 0.10; delta.A += 0.15; delta.D -= 0.08; }
            else if (stage === 'friend')       { delta.P += 0.08; delta.A += 0.05; }
            else if (stage === 'close')        { delta.P += 0.20; delta.A += 0.10; delta.D -= 0.10; }
            else                               { delta.P += 0.30; delta.A += 0.12; delta.D -= 0.15; }
        }

        // 批评 × 阶段（stranger / acquaintance+friend / close+lover）
        if (hasCriticism) {
            if (stage === 'stranger')                        { delta.P -= 0.10; delta.A += 0.05; }
            else if (stage === 'close' || stage === 'lover') { delta.P -= 0.30; delta.A += 0.10; delta.D += 0.10; }
            else                                             { delta.P -= 0.20; delta.A += 0.08; }
        }

        // 夸奖 × 阶段（同批评的档位切分）
        if (hasPraise) {
            if (stage === 'stranger')                        { delta.P += 0.10; }
            else if (stage === 'close' || stage === 'lover') { delta.P += 0.25; delta.A += 0.08; delta.D -= 0.05; }
            else                                             { delta.P += 0.15; delta.A += 0.05; }
        }

        // 调戏 × 阶段（stranger+acquaintance / friend / close+lover）
        if (hasTeasing) {
            if (stage === 'stranger' || stage === 'acquaintance') { delta.P -= 0.15; delta.A += 0.15; delta.D += 0.10; }
            else if (stage === 'friend')                          { delta.P -= 0.03; delta.A += 0.05; }
            else                                                  { delta.P += 0.10; delta.A += 0.08; delta.D += 0.15; }
        }

        // 悲伤 × 好感度（非阶段阈值，收敛为 EMOTION_RULES）
        if (hasSad) {
            delta.P -= 0.15; delta.A -= 0.10;
            if (affinity > EMOTION_RULES.SAD_DOMINANCE_MIN) { delta.P -= 0.05; delta.D -= 0.10; }
        }

        // 兴奋
        if (hasExciting || hasExclamation) {
            delta.A += 0.15;
            if (affinity > EMOTION_RULES.EXCITING_PLEASURE_MIN) delta.P += 0.05;
        }

        // 平静
        if (hasCalming) {
            delta.A -= 0.12;
            if (affinity > EMOTION_RULES.CALMING_PLEASURE_MIN) delta.P += 0.05;
        }

        // 疑问（原 affinity<=15 即 stranger 阶段）
        if (hasQuestion) {
            delta.A += 0.05;
            if (stage === 'stranger' && userInput.trim().length < EMOTION_RULES.SHORT_QUESTION_MAX_LEN) delta.D += 0.08;
        }

        delta.P = Math.max(-0.5, Math.min(0.5, delta.P));
        delta.A = Math.max(-0.4, Math.min(0.4, delta.A));
        delta.D = Math.max(-0.3, Math.min(0.3, delta.D));

        console.log(`[Emotion] analyzeInput (affinity=${affinity}): intimacy=${hasIntimacy} praise=${hasPraise} criticism=${hasCriticism} teasing=${hasTeasing} → delta P:${delta.P.toFixed(2)} A:${delta.A.toFixed(2)} D:${delta.D.toFixed(2)}`);

        return delta;
    }

    // ==================== 生命周期 ====================

    /**
     * 回到初始情绪态（「完全重置」语义）。
     *
     * 与构造函数里的初值保持镜像：PAD 归初始档（P0.3/A0.1/D-0.1），清空情绪历史、
     * 关系阶段标记与基线，并立即落盘。
     *
     * 为什么必须清 baseline/relationshipStage：它们由 affinity 阶段推导而来，
     * 完全重置时 affinity 已回初始档，若留着旧阶段基线，重置后小爱仍会带着
     * 「恋人/亲密」阶段的情绪底色——那正是清零不彻底的表现。
     */
    reset() {
        this.baseline = { P: 0.3, A: 0.1, D: -0.1 };
        this.state = { P: 0.3, A: 0.1, D: -0.1 };
        this.history = [];
        this.relationshipStage = null;
        this.relationshipLabel = '未知';
        this._saveState();
        return { label: this.getEmotionLabel() };
    }

    getSnapshot() {
        return { ...this.state, timestamp: Date.now() };
    }

    getFullState() {
        return {
            current: { ...this.state },
            baseline: { ...this.baseline },
            label: this.getEmotionLabel(),
            style: this.getStyleGuide(),
            shouldGhost: this.shouldGhost()
        };
    }

    // ==================== 持久化 ====================

    _loadState() {
        const data = readJson(STATE_FILE, null);
        if (!data) return;
        if (data.state) this.state = data.state;
        if (data.baseline) this.baseline = data.baseline;
        if (data.history) this.history = data.history.slice(-this.maxHistory);
        if (data.relationshipStage) this.relationshipStage = data.relationshipStage;
        if (data.relationshipLabel) this.relationshipLabel = data.relationshipLabel;
        console.log(`[Emotion] Loaded state: ${this.getEmotionLabel()}`);
    }

    _saveState() {
        writeJson(STATE_FILE, {
            state: this.state,
            baseline: this.baseline,
            history: this.history,
            relationshipStage: this.relationshipStage,
            relationshipLabel: this.relationshipLabel,
            lastUpdated: new Date().toISOString()
        });
    }

    _clamp(v) {
        return Math.max(-1, Math.min(1, v));
    }
}

export default EmotionEngine;
