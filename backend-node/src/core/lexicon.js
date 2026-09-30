/**
 * 好感度与情绪分析的**唯一关键词表**（PRD P0-b）。
 *
 * 背景：重构前好感度判定（affinityRules.js）与情绪分析（EmotionEngine.analyzeInput）
 * 各持一套词表，导致同一句话在两条链路上语义打架（如「抱抱/亲亲」一边算重度亲密、
 * 一边算普通亲密）。这里收敛为一份，两条链路都只从这里 import。
 *
 * 互斥原则（命中即归类，避免重复）：
 *   HARD > SOFT > DEEP > MILD > PRAISE > CRITICISM > TEASING
 * 关键修正（消除历史冲突）：
 *   - 「抱抱/亲亲」两边统一 → DEEP_INTIMACY；
 *   - 「讨厌/哼/走开」→ SOFT_REJECTION（不再同时算 CRITICISM / TEASING）；
 *   - 「喜欢你」→ MILD_INTIMACY（区别于 DEEP_INTIMACY 的「爱你」）。
 * 四类关系词两两 exact-token 交集为空，且与 7 张情绪表交集为空（有测试守护）。
 */

// ==================== 好感度四类词 ====================

/** 真实拒绝（任何阶段都是拒绝，不允许因此涨好感） */
export const HARD_REJECTION = ['不太合适', '刚认识', '陌生', '不熟', '保持距离', '后退',
    '请不要这样', '别这样', '这样不好', '我们还不熟', '太突然了'];

/** 软拒绝 / 傲娇（低阶段阻断正向；close/lover 且伴随亲密时视为调情） */
export const SOFT_REJECTION = ['讨厌', '哼', '走开', '不理你', '不跟你说了', '烦人',
    '坏人', '大坏蛋', '过分', '欺负', '坏蛋', '不理你了', '哼唧'];

/** 重度亲密（恋人层级的言行，未到阶段即越界） */
export const DEEP_INTIMACY = ['爱你', '亲亲', '抱抱', '么么', '老婆', '老公', '宝贝', '亲爱的'];

/** 轻度亲密（有好感的信号，friend 阶段已可自然表达） */
export const MILD_INTIMACY = ['喜欢你', '想你', '喜欢你呀', '想你了'];

// ==================== 情绪向词表（与上面四类互斥） ====================

export const PRAISE = ['好棒', '厉害', '可爱', '漂亮', '聪明', '温柔', '最喜欢', '真好', '谢谢', '感谢'];
/** 批评（「讨厌/走开」已移出到 SOFT_REJECTION） */
export const CRITICISM = ['烦', '丑', '恶心', '别烦我', '无语'];
/** 调戏（「哼」已移出到 SOFT_REJECTION） */
export const TEASING = ['笨蛋', '傻瓜', '猪头', '小傻瓜', '大笨蛋', '呆子'];
export const EXCITING = ['惊喜', '太棒了', '哇', '好激动', '天啊', '啊啊', '居然', '没想到'];
export const CALMING = ['晚安', '休息', '慢慢', '别急', '放松', '累了', '困了'];
export const SAD = ['难过', '伤心', '哭', '不开心', '失望', '孤独', '寂寞', '想哭'];
export const QUESTION = ['?', '？', '怎么', '为什么', '什么', '谁', '哪里', '什么时候'];

// ==================== 性格漂移专用词表（可叠加，不进关系互斥链） ====================

/** 依赖/求陪伴信号。 */
export const DEPENDENCY = ['陪我', '帮我', '陪陪', '离不开', '只有你', '需要你', '靠你', '别走', '一个人'];
/** 安抚与承诺信号。 */
export const REASSURANCE = ['不会走', '一直在', '别怕', '有我在', '放心', '永远', '我会等', '不会离开'];
/** 道歉与修复信号。 */
export const APOLOGY = ['对不起', '抱歉', '我错了', '我的错', 'sorry', '不该'];

/**
 * 关系分类表，**按优先级从高到低排列**。
 * matchCategory 依赖这个顺序：命中即返回，保证「同一句话返回同一分类」。
 */
export const RELATIONSHIP_LEXICON = [
    ['HARD_REJECTION', HARD_REJECTION],
    ['SOFT_REJECTION', SOFT_REJECTION],
    ['DEEP_INTIMACY', DEEP_INTIMACY],
    ['MILD_INTIMACY', MILD_INTIMACY],
    ['PRAISE', PRAISE],
    ['CRITICISM', CRITICISM],
    ['TEASING', TEASING],
];

/**
 * text 是否包含 words 中任意一个词条（子串匹配）。
 * @param {string} text
 * @param {string[]} words
 * @returns {boolean}
 */
export function anyIncludes(text, words) {
    if (!text || !Array.isArray(words)) return false;
    return words.some((w) => text.includes(w));
}

/**
 * 返回 text 命中的**最高优先级主分类名**，未命中返回 null。
 * 用于「同一句话在好感度判定与情绪分析里返回同一分类」（PRD P0-b 验收 2）。
 * @param {string} text
 * @returns {string | null}
 */
export function matchCategory(text) {
    if (!text) return null;
    for (const [name, words] of RELATIONSHIP_LEXICON) {
        if (anyIncludes(text, words)) return name;
    }
    return null;
}
