/**
 * 用户情绪识别的**唯一事实源**（REQ-01 用户情绪识别通道）。
 *
 * 背景与定位（docs/companion-upgrade/02-architecture.md REQ-01 §2.1.1~2.1.2）：
 *   - 本文件只负责「用户情绪」的标签枚举、词表、强度/否定词与三维→标签映射，
 *     以及纯函数 classifyUserEmotion(text)。
 *   - 它**与 AI 自身的 EmotionEngine（PAD）完全解耦**：EmotionEngine 描述「小爱」的情绪，
 *     本文件描述「用户」的情绪，二者状态不互通、不复用。
 *   - 词表优先复用 lexicon.js 的既有情绪词（SAD / EXCITING / CALMING / PRAISE /
 *     CRITICISM 等），保证「同一句话在两条链路上语义不打架」；只有用户专属的情绪
 *     （疲惫 / 愤怒 / 焦虑 / 开心 / 兴奋…）才在此新增。
 *
 * 纯函数原则：本文件不读文件、不 new Date()、不 import 引擎，便于单独验证与测试。
 */

import {
    SAD, EXCITING, CALMING, PRAISE, CRITICISM,
} from './lexicon.js';

// ==================== 标签枚举 ====================

/**
 * 用户情绪的**全部合法标签**（唯一枚举）。
 * 三维 → 标签的映射结果必须落在本枚举内，测试守护此不变量。
 * 固定 9 类，覆盖 valence × arousal 的正负/高低组合：
 *   开心/平静/低落/焦虑/疲惫/兴奋/烦闷/愤怒/中性
 */
export const USER_EMOTION_LABELS = [
    '开心', '平静', '低落', '焦虑', '疲惫', '兴奋', '烦闷', '愤怒', '中性',
];

/** 中性兜底标签（无任何信号时的默认输出） */
export const NEUTRAL_LABEL = '中性';

/** 无法判定时的默认三维（零向量 = 中性） */
export const NEUTRAL_EMOTION = Object.freeze({
    valence: 0,
    arousal: 0,
    intensity: 0,
    label: NEUTRAL_LABEL,
});

// ==================== 用户情绪专用词表 ====================

/**
 * 用户情绪关键词表：每个标签对应一组词条。
 * 命中后由 classifyUserEmotion 换算成 (valence, arousal, intensity) 三维。
 *
 * 复用原则：能复用 lexicon.js 的（SAD/EXCITING/CALMING/PRAISE/CRITICISM）一律复用，
 * 此处只列「用户情绪专属」的新增词，避免词表双写导致语义漂移。
 */
export const USER_EMOTION_LEXICON = {
    // 低落 / 悲伤：直接复用 lexicons.js 的 SAD，额外补「emo/心累」
    低落: [...SAD, 'emo', '心累', '没意思', '提不起劲'],
    // 疲惫：AI 自身无此情绪类别，用户情绪专属
    疲惫: ['累', '好累', '好累啊', '困', '好困', '疲惫', '没精神', '熬夜', '加班', '顶不住', '撑不住', '想睡'],
    // 焦虑：担心 / 紧张 / 不安
    焦虑: ['焦虑', '紧张', '担心', '害怕', '怕', '不安', '慌', '压力', '压力大', '怎么办', '来不及', '崩溃'],
    // 愤怒：生气 / 气愤（区别于烦闷的「烦」）
    愤怒: ['生气', '气死', '气人', '愤怒', '恼火', '火大', '气炸', '发火', '太过分', '可恶', '气死了'],
    // 烦闷：烦躁 / 无聊 / 郁闷（复用 CRITICISM 的「烦/无语」）
    烦闷: [...CRITICISM, '烦死', '好烦', '无聊', '郁闷', '郁闷死', '烦死了', '没劲', '烦躁'],
    // 开心：正向愉悦（复用 PRAISE）
    开心: [...PRAISE, '开心', '高兴', '快乐', '幸福', '满足', '美滋滋', '哈哈', '嘿嘿', '嘻嘻', '太好了'],
    // 兴奋：高唤醒正向（复用 EXCITING）
    兴奋: [...EXCITING, '兴奋', '超开心', '太爽了', '爽', '嗨', '冲', '热血', '上头'],
    // 平静：低唤醒中性偏正（复用 CALMING）
    平静: [...CALMING, '还行', '还好', '一般', '平常', '挺平静', '没什么', '淡淡的'],
};

/**
 * 情绪标签的三维基准（valence / arousal / intensity），**唯一映射表**。
 * 词表命中某标签后以此为基准，再叠加强度词与否定词修正。
 *
 * 取值范围：valence∈[-1,1]（负=不悦 正=愉悦）、arousal∈[-1,1]（低=平静 高=激动）、
 * intensity∈[0,1]（情绪强度）。数值为经验值，集中于此便于调参。
 */
export const EMOTION_DIMENSIONS = {
    低落: { valence: -0.5, arousal: -0.2, intensity: 0.5 },
    疲惫: { valence: -0.3, arousal: -0.6, intensity: 0.5 },
    焦虑: { valence: -0.4, arousal: 0.6, intensity: 0.6 },
    愤怒: { valence: -0.7, arousal: 0.7, intensity: 0.8 },
    烦闷: { valence: -0.4, arousal: 0.2, intensity: 0.5 },
    开心: { valence: 0.6, arousal: 0.3, intensity: 0.5 },
    兴奋: { valence: 0.7, arousal: 0.8, intensity: 0.7 },
    平静: { valence: 0.1, arousal: -0.5, intensity: 0.3 },
    中性: { valence: 0, arousal: 0, intensity: 0 },
};

// ==================== 强度词与否定词 ====================

/**
 * 强度修饰词：命中后按权重放大/缩小情绪强度（intensity）。
 * 命中即用最大的倍数（有序：从强到弱，取第一个命中）。
 */
export const INTENSITY_MODIFIERS = [
    { words: ['特别', '超级', '超', '极其', '非常', '巨', '爆'], factor: 1.5 },
    { words: ['好', '很', '太', '真', '贼'], factor: 1.3 },
    { words: ['有点', '稍微', '稍微有点', '一点点', '有些'], factor: 0.6 },
    { words: ['还行', '一般般', '还凑合'], factor: 0.5 },
];

/**
 * 否定词：命中后对「命中词表」的情绪取反（愉悦↔不悦）。
 * 例：「不开心」→ 词表命中「开心」但被否定 → 归为低落。
 * 注意：否定只翻转 valence，不改变 arousal（「不兴奋」仍是低唤醒）。
 */
export const NEGATION_WORDS = ['不', '没', '别', '无', '不是', '没有', '不太', '不曾', '未'];

// ==================== 三维 → 标签映射 ====================

/**
 * 三维 (valence, arousal) → 标签的映射表（有序，命中即返回）。
 *
 * 规则顺序即优先级：先判极端情绪（愤怒/兴奋），再判中度（低落/焦虑/疲惫/烦闷/开心），
 * 最后兜底为平静/中性。阈值经验值，集中于此。
 */
export const DIMENSION_TO_LABEL_RULES = [
    // 高唤醒负向 → 愤怒
    (v, a, i) => v <= -0.5 && a >= 0.4 && i >= 0.6 ? '愤怒' : null,
    // 高唤醒正向 → 兴奋
    (v, a, i) => v >= 0.5 && a >= 0.5 ? '兴奋' : null,
    // 低唤醒负向 → 疲惫（放在低落之前：a≤-0.4 是更强的低唤醒信号，避免被「低落」抢先命中）
    (v, a, i) => a <= -0.4 ? '疲惫' : null,
    // 负向低唤醒、强 → 低落
    (v, a, i) => v <= -0.3 && a < 0.2 && i >= 0.5 ? '低落' : null,
    // 负向高唤醒、中强度 → 焦虑
    (v, a, i) => v <= -0.2 && a >= 0.4 ? '焦虑' : null,
    // 负向中唤醒 → 烦闷
    (v, a, i) => v <= -0.2 ? '烦闷' : null,
    // 正向中高 → 开心
    (v, a, i) => v >= 0.3 ? '开心' : null,
    // 低唤醒微弱正向 → 平静
    (v, a, i) => v > 0 && a <= 0 ? '平静' : null,
];

/** 依据三维映射出标签；无规则命中回退中性。 */
export function mapDimensionsToLabel(valence, arousal, intensity) {
    for (const rule of DIMENSION_TO_LABEL_RULES) {
        const label = rule(valence, arousal, intensity);
        if (label) return label;
    }
    return NEUTRAL_LABEL;
}

// ==================== 数值工具 ====================

/** 将 v 夹取到 [min, max]。 */
export function clamp(v, min, max) {
    if (!Number.isFinite(v)) return min;
    return Math.max(min, Math.min(max, v));
}

/** 保留 n 位小数（避免浮点误差堆积，便于落盘与测试断言）。 */
export function round(v, n = 3) {
    if (!Number.isFinite(v)) return 0;
    const p = 10 ** n;
    return Math.round(v * p) / p;
}

// ==================== 核心纯函数 ====================

/** 判断 text 是否命中 words（子串匹配）。 */
function anyHit(text, words) {
    return words.some((w) => text.includes(w));
}

/**
 * 检测 text 命中的**情绪标签集合**（可能多标签，用于融合时加权）。
 * 返回 [{ label, count }]，count 为该标签命中的词条数（越多越可信）。
 */
export function detectLabels(text) {
    const input = (text || '').toLowerCase();
    if (!input.trim()) return [];
    const hits = [];
    for (const [label, words] of Object.entries(USER_EMOTION_LEXICON)) {
        let count = 0;
        for (const w of words) {
            if (input.includes(w.toLowerCase())) count++;
        }
        if (count > 0) hits.push({ label, count });
    }
    // 命中词条数降序，保证主标签稳定
    return hits.sort((a, b) => b.count - a.count);
}

/**
 * 计算强度放大倍数：命中强度词则取倍数，同时返回是否命中「弱化档」。
 * 返回 { factor }，未命中为 1。
 */
export function intensityFactor(text) {
    const input = text || '';
    for (const mod of INTENSITY_MODIFIERS) {
        if (anyHit(input, mod.words)) return mod.factor;
    }
    return 1;
}

/** 是否命中否定词。 */
export function hasNegation(text) {
    return anyHit(text || '', NEGATION_WORDS);
}

/**
 * classifyUserEmotion(text) —— 词表快速分析**纯函数**（引擎与测试共用）。
 *
 * 流程：
 *   1. 命中标签集合 → 取主标签（命中词条最多者）；
 *   2. 以主标签的三维基准为起点；
 *   3. 叠加强度词放大 intensity；
 *   4. 若命中否定词**且**主标签为正向情绪 → 翻转 valence 并重映射标签
 *      （「不开心」应从开心翻成低落，而非仍是开心）。
 *
 * @param {string} text 用户输入原文
 * @returns {{ valence:number, arousal:number, intensity:number, label:string, confidence:number, source:'lexicon', matched:string[] }}
 *          confidence∈[0,1]，无任何命中时为 0（纯中性）。
 */
export function classifyUserEmotion(text) {
    const input = (text || '').trim();
    const hits = detectLabels(input);

    if (hits.length === 0) {
        return {
            ...NEUTRAL_EMOTION,
            confidence: 0,
            source: 'lexicon',
            matched: [],
        };
    }

    const primary = hits[0].label;
    const base = EMOTION_DIMENSIONS[primary] || { valence: 0, arousal: 0, intensity: 0 };

    // 强度：基础强度 × 强度词倍数，clamp 到 [0,1]
    const factor = intensityFactor(input);
    let intensity = clamp(base.intensity * factor, 0, 1);

    let valence = base.valence;
    let arousal = base.arousal;
    let label = primary;

    // 否定词处理：只对「正向主标签」取反（负向词再加否定语义模糊，不做翻转，避免误判）。
    // 取反时把 arousal 压低到 [-0.2, 0.1]：否定的正向情绪（「不开心」）应落到「低落」，
    // 而不是因残留的高唤醒被误判为「烦闷/焦虑」。
    if (hasNegation(input) && base.valence > 0) {
        valence = -base.valence;
        arousal = clamp(base.arousal * 0.2 - 0.1, -0.2, 0.1);
        // 不额外衰减 intensity：否定的正向情绪本身仍是一种明确的低落感受
        label = mapDimensionsToLabel(valence, arousal, intensity);
    } else {
        // 未翻转时，也允许三维重映射校正标签（保证标签始终落在枚举内）
        label = mapDimensionsToLabel(valence, arousal, intensity);
    }

    // 置信度：命中词条数越多越高；单标签单命中约 0.5，多命中逼近 1
    const totalHits = hits.reduce((s, h) => s + h.count, 0);
    const confidence = clamp(0.3 + totalHits * 0.2, 0, 1);

    return {
        valence: round(valence),
        arousal: round(arousal),
        intensity: round(intensity),
        label,
        confidence: round(confidence),
        source: 'lexicon',
        matched: hits.map((h) => h.label),
    };
}
