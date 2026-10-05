/**
 * log.js - 对话原文的日志出口（审计 HTTP-19「日志隐私」）。
 *
 * 为什么要单独一层：`<monologue>` 内心独白、模型原生 CoT、metadata 原文都曾被
 * **无条件整段打进 stdout**。这些是最私密的推理文本 —— 用户把鼠标移开气泡就看不到的
 * 那句心里话，却躺在 dev.log 里、被 `next dev` 转存、被任何看日志的人读到。
 * 默认只留长度与一眼能看懂的分类信息；要看原文请显式开
 * `AI_GIRLFRIEND_DEBUG=true`（本机排障用），并且也只打前 N 字。
 */
import { config } from '../config.js';

/** 把自由文本压成一行短预览：折叠空白、截断、带上原始长度 */
export function preview(text, max = config.logging.textPreviewChars) {
    const s = String(text ?? '');
    if (!s) return '';
    const flat = s.replace(/\s+/g, ' ').trim();
    if (max <= 0) return `(${s.length} 字)`;
    return flat.length > max
        ? `${flat.slice(0, max)}…（共 ${flat.length} 字）`
        : flat;
}

/** 调试级日志：默认静默。AI_GIRLFRIEND_DEBUG=true 才输出。 */
export function debugLog(tag, ...args) {
    if (!config.logging.verbose) return false;
    console.log(`[${tag}]`, ...args);
    return true;
}

/** 调试级的原文日志：只有开了 DEBUG 才打，且一律走 preview */
export function debugText(tag, label, text) {
    if (!config.logging.verbose) {
        const n = String(text ?? '').length;
        if (n) console.log(`[${tag}] ${label}: ${n} 字（原文仅在 AI_GIRLFRIEND_DEBUG=true 时打印）`);
        return false;
    }
    console.log(`[${tag}] ${label}: ${preview(text)}`);
    return true;
}
