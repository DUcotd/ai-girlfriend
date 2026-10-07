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
import { DATE_SOURCE } from '../narrative/narrativeDate.js';

/**
 * 「她记得日子」的来源集合。取值直接取自 narrativeDate 的 DATE_SOURCE 常量，
 * 不在这里另抄一份字符串（单一真源：以后加一种日期写法只会改一处）。
 */
const TRUSTED_DATE_SOURCES = new Set([
    DATE_SOURCE.stated, DATE_SOURCE.relative, DATE_SOURCE.monthDay,
]);

/**
 * 构建 [我们的故事] 注入段。
 *
 * @param {Array<object>} narratives 已检索排序好的叙事（重要度/相关性由 retriever 保证）
 * @param {{notes?: Map<string,string>}} [opts]
 *   notes：id → 「她是怎么想起这条的」（F-3 联想命中）。写进条目里，让她知道
 *   这句回忆是**被用户刚刚的话勾起来的**，而不是凭空翻出来的——没有这层说明，
 *   「她突然提起三年前的一次火锅」在模型眼里就是一句可复述的素材，接不上话头。
 * @returns {string} 注入文本；无有效叙事时返回 ''
 */
export function buildNarrativeContext(narratives, opts = {}) {
    if (!Array.isArray(narratives) || narratives.length === 0) return '';

    const maxChars = config.narrative.injectMaxChars;
    const entryMax = config.narrative.injectEntryMaxChars;
    const notes = opts.notes instanceof Map ? opts.notes : null;

    const lines = [];
    // 先算表头长度，保证「表头 + 条目」合计不超 maxChars
    const header = '【我们的故事 · 共同经历】';
    const footer = '- 可以自然地呼应这些共同经历，让"我们"有延续感；但不要生硬复述，也别每次都提。';
    let used = header.length + footer.length;

    for (const n of narratives) {
        if (!n || (!n.title && !n.summary)) continue;
        const line = formatEntry(n, entryMax, notes ? notes.get(n.id) : undefined);
        if (used + line.length + 1 > maxChars) break; // 超限即停止追加（保整体克制）
        lines.push(line);
        used += line.length + 1;
    }

    // 一条都没放下时至少给第一条（截到 entryMax），避免整段空转
    if (lines.length === 0) {
        const first = narratives.find((n) => n && (n.title || n.summary));
        if (!first) return '';
        lines.push(formatEntry(first, entryMax, notes ? notes.get(first.id) : undefined));
    }

    // 围栏（PROMPT-06）：叙事是从用户原文蒸馏出来的**引述素材**，不是指令
    return `<story_data>\n${[header, ...lines, footer].join('\n')}\n</story_data>`;
}

/**
 * 单条叙事 → 一行（含类型标签 + 时间/标题 + 摘要），并按 entryMax 截断。
 * @param {object} n
 * @param {number} entryMax
 * @param {string} [note] 联想说明（「她顺着"熬夜"想起了这件事」）
 * @returns {string}
 */
function formatEntry(n, entryMax, note) {
    const labelZh = getTypeMeta(n.type).labelZh;
    // 只在「她真的知道日子」时把日期写进 prompt。白名单而不是排除法：
    // fallback（补成抽取当天）与 null（改造前入库的老故事，日期同样是补的）都不能当真 ——
    // 模型会照念成「我们 10 月 7 日第一次互道晚安」，把一个统计口径说成她的回忆。
    const dateStr = TRUSTED_DATE_SOURCES.has(n.occurredAtSource) ? formatDate(n.occurredAt) : '';
    const title = (n.title || '').trim();
    const summary = (n.summary || '').trim();
    const head = dateStr ? `${labelZh}·${dateStr}` : labelZh;
    const body = title && summary && !summary.includes(title) ? `${title}：${summary}` : (title || summary);
    const suffix = note ? `（${note}）` : '';
    const line = `- [${head}] ${body}${suffix}`;
    // 截断预算给联想说明留出余地：宁可正文短一点，也别把「她为什么想起」切掉——
    // 那半句才是让她能接话的东西，正文只是被想起的内容。
    const budget = Math.max(entryMax, 20 + suffix.length);
    return line.length > budget ? line.slice(0, budget) + '…' : line;
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
