/**
 * llmCalls —— 模型调用计数的唯一出口（B1-2）。
 *
 * 为什么要它：一轮对话到底调了几次模型（主对话、事实提取、叙事抽取、嵌入、主动消息、
 * TTS/ASR），以前**完全不可观测** —— 排障只能靠猜，而「写了没接线」的重复调用
 * （同一轮 query 嵌入两次，审计 CORE-18）也就永远不会被发现。
 * 目的写在 config 里也写了：这是排障与理解行为，不是为了压成本。
 *
 * 两个口径：
 *   - `turn`     ：本轮（最近一次用户对话轮 / 主动消息轮开始之后的调用）
 *   - `lastHour` ：滚动窗口内（config.llmCalls.windowMs，默认 1 小时）
 * 窗口是**有界**的：时间戳数组超过 config.llmCalls.maxEvents 就丢最旧的，
 * 读快照时也会把超出窗口的尾巴剪掉 —— 不做无界数组累积（审计 CORE-20 同一类失效）。
 *
 * 只记通道名与时间戳，**绝不记任何文本**（日志隐私规则，见 utils/log.js）。
 */
import { config } from '../config.js';

/** 通道枚举（对外契约：前端按这些 key 渲染，新增通道要同步给前端） */
export const LLM_CHANNELS = Object.freeze({
    CHAT: 'chat',                 // 主对话（非流式）
    CHAT_STREAM: 'chatStream',    // 主对话（流式）
    PROACTIVE: 'proactive',       // 主动消息生成
    FACT: 'fact',                 // 事实提取（记忆层后台）
    NARRATIVE: 'narrative',       // 共同经历抽取（叙事层后台）
    EMBEDDING: 'embedding',       // 嵌入（语义检索通道）
    TTS: 'tts',                   // 语音合成
    ASR: 'asr',                   // 语音转写
});

/** 中文标签：随快照一起下发，前端不必自己再抄一份（两份真相必然漂移） */
export const LLM_CHANNEL_LABELS_ZH = Object.freeze({
    chat: '主对话',
    chatStream: '主对话(流式)',
    proactive: '主动消息',
    fact: '事实提取',
    narrative: '叙事抽取',
    embedding: '嵌入',
    tts: '朗读',
    asr: '转写',
});

const ALL_CHANNELS = Object.values(LLM_CHANNELS);

const state = {
    turnId: 0,
    turnCounts: emptyCounts(),
    turnStartedAt: 0,
    /** 滚动窗口：[{ ch, ts }]，容量受 config.llmCalls.maxEvents 约束 */
    events: [],
};

function emptyCounts() {
    const out = {};
    for (const ch of ALL_CHANNELS) out[ch] = 0;
    return out;
}

/** 开一轮（对话轮与主动消息轮都算「一轮」）：本轮计数清零、turnId 自增 */
export function startTurn() {
    state.turnId += 1;
    state.turnCounts = emptyCounts();
    state.turnStartedAt = Date.now();
    return state.turnId;
}

/** 记一次调用。channel 用 LLM_CHANNELS 里的值；未知通道也收（便于加通道不必改这里） */
export function record(channel, at = Date.now()) {
    const ch = String(channel || 'unknown');
    if (typeof state.turnCounts[ch] !== 'number') state.turnCounts[ch] = 0;
    state.turnCounts[ch] += 1;
    state.events.push({ ch, ts: at });
    // 有界：超出容量丢最旧（丢的是最旧的时间戳，本轮计数不受影响）
    const cap = Math.max(16, config.llmCalls?.maxEvents ?? 512);
    if (state.events.length > cap) state.events.splice(0, state.events.length - cap);
    return ch;
}

function totalsOf(counts) {
    let total = 0;
    for (const v of Object.values(counts)) total += v;
    return total;
}

/** 窗口内各通道计数（顺带把过老的尾巴剪掉，保持数组有界） */
function windowCounts(now = Date.now()) {
    const windowMs = config.llmCalls?.windowMs ?? 3_600_000;
    const cutoff = now - windowMs;
    while (state.events.length > 0 && state.events[0].ts < cutoff) state.events.shift();
    const counts = emptyCounts();
    for (const e of state.events) {
        if (typeof counts[e.ch] !== 'number') counts[e.ch] = 0;
        counts[e.ch] += 1;
    }
    return counts;
}

/**
 * 快照（只读，给 /health 与 /config/status 用）。
 * 形状（前端渲染「本轮：主对话 1 + 事实 1 + 嵌入 0」所需的一切都在这里）：
 * {
 *   turnId, turnStartedAt,
 *   turn:     { chat, chatStream, proactive, fact, narrative, embedding, tts, asr, total },
 *   lastHour: { ...同键, total, windowMs },
 *   labelsZh: { chat: '主对话', ... }
 * }
 */
export function snapshot(now = Date.now()) {
    const windowMs = config.llmCalls?.windowMs ?? 3_600_000;
    const turn = { ...state.turnCounts };
    const lastHour = windowCounts(now);
    return {
        turnId: state.turnId,
        turnStartedAt: state.turnStartedAt || null,
        turn: { ...turn, total: totalsOf(turn) },
        lastHour: { ...lastHour, total: totalsOf(lastHour), windowMs },
        labelsZh: { ...LLM_CHANNEL_LABELS_ZH },
    };
}

/** 测试用：清空全部计数与窗口（不影响任何业务路径） */
export function reset() {
    state.turnId = 0;
    state.turnCounts = emptyCounts();
    state.turnStartedAt = 0;
    state.events = [];
}

export default { LLM_CHANNELS, LLM_CHANNEL_LABELS_ZH, startTurn, record, snapshot, reset };
