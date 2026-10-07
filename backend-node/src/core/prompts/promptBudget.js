/**
 * promptBudget —— 每轮 prompt 的**总量**护栏（B8-3，审计 CORE-09）。
 *
 * 改造前的形状：每条回忆 ≤300 字、每条事实 ≤120 字（B2 补的单条上限），
 * 但**没有任何总量**：12 条事实 + 3 条回忆 + 任务清单 + 叙事段 + 性格 + 情绪
 * 全部塞进同一条 system 消息，`unlimitedContext` 还另外带上整段历史 ——
 * 最坏情况单请求 12~16 万 token，服务商要么直接 400，要么**从头部静默截断**：
 * 最先掉的永远是「【本轮上下文】/人设」，模型于是半路失忆成人。
 *
 * 现在的口径（全部可配，见 config.prompt.budget）：
 *   1. 每个**输入块**各自有总量（记忆/叙事/任务），先按块裁；
 *   2. 整条 system 消息再有总上限 maxSystemChars，超了就**按优先级丢块**：
 *      低价值块（叙事、用户情绪、任务指令）先整段丢，高价值块（记忆、性格、情绪、
 *      关系阶段）最后动；【回复要求】与表达优先级这类**固定骨架**永远不丢
 *      —— 丢了模型就不知道要输出 <metadata>，整条结算链路会静默失效。
 *   3. 裁剪是**确定性**的（同一输入永远得到同一输出、同一丢弃顺序），
 *      并且只打一行日志、只报长度（内容不进日志，见 utils/log.js）。
 *
 * 单位是字符不是 token：本地应用没有可靠的 tokenizer，字符数是可断言、可复现的下界。
 */
import { config } from '../../config.js';

/** 块间裁剪顺序：越靠前的越**先被丢**（价值最低的先让路） */
export const TRIM_ORDER = Object.freeze([
    'narrativePrompt',
    'userEmotionPrompt',
    'taskActionText',
    'taskText',
    'contextStr',
    'personalityPrompt',
    'emotionPrompt',
    // 再往下就是关系阶段说明书 —— 丢它等于让模型自己猜「现在是什么关系」，代价太大
]);

/** 输入块的总量：key → config.prompt.budget 里的字段名（任务两块共享一个额度） */
function blockCaps(budget) {
    return {
        contextStr: budget.maxMemoryChars,
        narrativePrompt: budget.maxNarrativeChars,
        taskText: budget.maxTaskChars,
        taskActionText: budget.maxTaskChars,
    };
}

/**
 * 行级裁剪：保留头部（我们的段落本来就是「价值从高到低」排的，尾部就是最该丢的），
 * 并且**不切断行**；带 <xxx_data> 围栏的块会自动补回闭合标签，
 * 否则模型看到的是没闭合的引用块（围栏的意义就没了）。
 *
 * @param {string} text
 * @param {number} max 上限字符；<=0 或非法 = 不裁
 * @returns {{text:string, trimmedChars:number}}
 */
export function clampBlock(text, max) {
    const s = String(text ?? '');
    if (!Number.isFinite(max) || max <= 0 || s.length <= max) return { text: s, trimmedChars: 0 };

    const closing = /<\/([a-z_]+)>\s*$/.exec(s);
    const tail = closing ? `\n${closing[0].trim()}` : '';
    const allowed = Math.max(0, max - tail.length);
    const head = s.slice(0, allowed);
    // 只保留完整的行（最后一个换行之前的部分），实在一行都放不下就硬截（保证有内容）
    const lastBreak = head.lastIndexOf('\n');
    const kept = lastBreak > 0 ? head.slice(0, lastBreak) : head;
    const out = kept + tail;
    return { text: out, trimmedChars: Math.max(0, s.length - out.length) };
}

/**
 * 按预算组装【本轮上下文】。
 *
 * @param {(args:object)=>string} buildFn systemPrompt.buildSystemContext
 * @param {object} args 各输入块（与 buildSystemContext 的入参同名）
 * @param {object} [budget] config.prompt.budget（默认读全局）
 * @returns {{text:string, trimmed:Array<{block:string, action:string, from:number, to:number}>}}
 */
export function buildBudgetedSystemContext(buildFn, args, budget = config.prompt.budget) {
    const caps = blockCaps(budget);
    const trimmed = [];
    const working = { ...args };

    // ① 逐块总量：先各自裁到自己的额度
    for (const [key, cap] of Object.entries(caps)) {
        const before = String(working[key] ?? '').length;
        const clamped = clampBlock(working[key], cap);
        working[key] = clamped.text;
        if (clamped.trimmedChars > 0) {
            trimmed.push({ block: key, action: 'shrunk', from: before, to: clamped.text.length });
        }
    }

    // ② 整条上限：还超就按 TRIM_ORDER 整段丢，直到装得下或只剩固定骨架
    let text = buildFn(working);
    let overflow = text.length > budget.maxSystemChars;
    for (const key of TRIM_ORDER) {
        if (!overflow) break;
        const current = String(working[key] ?? '');
        if (!current) continue;
        // 记忆/任务这类块先缩到一半再丢，能多留住内容；纯装饰性的短块直接丢
        const half = Math.floor(current.length / 2);
        if (half > 80 && (key === 'contextStr' || key === 'taskText' || key === 'narrativePrompt')) {
            const clamped = clampBlock(current, half);
            trimmed.push({ block: key, action: 'shrunk', from: current.length, to: clamped.text.length });
            working[key] = clamped.text;
        } else {
            trimmed.push({ block: key, action: 'dropped', from: current.length, to: 0 });
            working[key] = '';
        }
        text = buildFn(working);
        overflow = text.length > budget.maxSystemChars;
    }

    return { text, trimmed };
}

/** 一行摘要（只有块名与长度，没有任何内容 —— 日志隐私规则） */
export function describeTrims(trimmed) {
    if (!trimmed || trimmed.length === 0) return '';
    return trimmed.map((t) => `${t.block} ${t.from}→${t.to}(${t.action})`).join(', ');
}
