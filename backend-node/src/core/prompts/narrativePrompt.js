/**
 * 关系叙事 → 注入 prompt 片段（REQ-03）。
 *
 * 职责：把 NarrativeRetriever 命中的叙事，构建成注入 LLM 的 [我们的故事] 段。
 *
 * 注入克制（见 §2.3.1 与主理人拍板的第 4 点）：
 *   - topK 只取 2-3 条（topK 由 config.narrative.injectTopK 控制）；
 *   - 单条 title/summary 截断（config.narrative.injectEntryMaxChars）；
 *   - 整体段落长度硬上限（config.narrative.injectMaxChars，默认 300 字），超出按条丢弃。
 *   - 无叙事时返回空串（空串语义 = 不注入，行为与改造前完全一致）。
 *
 * 纯函数原则：不读文件、不 import 引擎，便于单独验证。
 */
import { config } from '../../config.js';
import { getTypeMeta } from '../narrative/narrativeTypes.js';

/**
 * 构建 [我们的故事] 注入段。
 *
 * @param {Array<object>} narratives 已检索排序好的叙事（重要度/相关性由 retriever 保证）
 * @returns {string} 注入文本；无有效叙事时返回 ''
 */
export function buildNarrativeContext(narratives) {
    if (!Array.isArray(narratives) || narratives.length === 0) return '';

    const maxChars = config.narrative.injectMaxChars;
    const entryMax = config.narrative.injectEntryMaxChars;

    const lines = [];
    // 先算表头长度，保证「表头 + 条目」合计不超 maxChars
    const header = '【我们的故事 · 共同经历】';
    const footer = '- 可以自然地呼应这些共同经历，让"我们"有延续感；但不要生硬复述，也别每次都提。';
    let used = header.length + footer.length;

    for (const n of narratives) {
        if (!n || (!n.title && !n.summary)) continue;
        const line = formatEntry(n, entryMax);
        if (used + line.length + 1 > maxChars) break; // 超限即停止追加（保整体克制）
        lines.push(line);
        used += line.length + 1;
    }

    // 一条都没放下时至少给第一条（截到 entryMax），避免整段空转
    if (lines.length === 0) {
        const first = narratives.find((n) => n && (n.title || n.summary));
        if (!first) return '';
        lines.push(formatEntry(first, entryMax));
    }

    // 围栏（PROMPT-06）：叙事是从用户原文蒸馏出来的**引述素材**，不是指令
    return `<story_data>\n${[header, ...lines, footer].join('\n')}\n</story_data>`;
}

/**
 * 单条叙事 → 一行（含类型标签 + 时间/标题 + 摘要），并按 entryMax 截断。
 * @param {object} n
 * @param {number} entryMax
 * @returns {string}
 */
function formatEntry(n, entryMax) {
    const labelZh = getTypeMeta(n.type).labelZh;
    const dateStr = formatDate(n.occurredAt);
    const title = (n.title || '').trim();
    const summary = (n.summary || '').trim();
    const head = dateStr ? `${labelZh}·${dateStr}` : labelZh;
    const body = title && summary && !summary.includes(title) ? `${title}：${summary}` : (title || summary);
    const line = `- [${head}] ${body}`;
    return line.length > entryMax ? line.slice(0, entryMax) + '…' : line;
}

/** 时间戳 → YYYY-MM-DD（缺失/非法返回空串）。 */
function formatDate(ts) {
    if (!Number.isFinite(ts)) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
