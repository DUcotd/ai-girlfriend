/**
 * logger.js - 极简日志（B5-10 / 审计 INFRA-11）。
 *
 * 为什么需要：以前所有日志都是裸 `console.log`，**没有时间戳、没有级别、500 的堆栈被
 * errorHandler 压成一行 message**。结果是「日志里能看到出过事，但对不上是哪一次、
 * 几点几分、跟着哪个请求」。今晚排查一个配置覆盖问题时，dev.log 因为没有时间戳
 * 完全无法重建时间线 —— 这就是这条缺陷的实际代价。
 *
 * 设计取向：不引第三方依赖、不改调用点。
 * `installConsoleTimestamps()` 在**服务进程启动时**给 console 的三个方法包一层
 * 前缀（时间戳 + 级别 + 可选 tag），业务代码里那两百来处 `console.log` 一个字都不用动。
 * 测试进程**故意不装**：它们的输出要保证可读、可比对。
 */
import { config } from '../config.js';

const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

/** ISO 时间戳到毫秒；本地时区比 UTC 更好读（本机自用场景） */
function stamp(date = new Date()) {
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const offsetMin = -date.getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
        + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
        + `.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function prefix(level) {
    return `${stamp()} ${level.padEnd(5)}`;
}

/**
 * 给 console 装上时间戳与级别前缀（只在服务进程调用一次，幂等）。
 * @param {{quiet?: boolean}} [opts] quiet=true 时连原始输出都不打（测试用）
 * @returns {boolean} 是否真的装了（重复调用返回 false）
 */
let installed = false;
export function installConsoleTimestamps(opts = {}) {
    if (installed) return false;
    installed = true;
    const map = { log: 'INFO', info: 'INFO', warn: 'WARN', error: 'ERROR' };
    for (const [method, level] of Object.entries(map)) {
        const original = console[method] ? console[method].bind(console) : null;
        if (!original) continue;
        console[method] = (...args) => {
            if (opts.quiet) return undefined;
            return original(prefix(level), ...args);
        };
    }
    return true;
}

/** 结构化取一条错误的可诊断信息（堆栈优先，message 兜底） */
export function describeError(err) {
    if (!err) return { message: 'unknown error', stack: null };
    if (err instanceof Error) {
        return { message: err.message, stack: typeof err.stack === 'string' ? err.stack : null };
    }
    return { message: String(err), stack: null };
}

/**
 * 打一条带堆栈的错误日志。
 * 旧 errorHandler 只打 `err.message`，500 的真实成因（抛错位置）永远看不到。
 */
export function logError(tag, err, context = '') {
    const { message, stack } = describeError(err);
    const head = `${prefix('ERROR')} [${tag}] ${message}${context ? ` ${context}` : ''}`;
    // 默认就打堆栈：这是本机单人应用，磁盘上的日志只有用户自己看得到，
    // 用「省两行输出」换「排障时看不到抛错位置」不值。
    console.error(head + (stack ? `\n${stack}` : ''));
    return message;
}

/** debug 级：默认静默，`AI_GIRLFRIEND_DEBUG=true` 才输出（与 utils/log.js 同一个开关） */
export function logDebug(tag, ...args) {
    if (!config.logging?.verbose) return false;
    console.log(`${prefix('DEBUG')} [${tag}]`, ...args);
    return true;
}

export const logger = {
    info: (tag, ...args) => console.log(`${prefix('INFO')} [${tag}]`, ...args),
    warn: (tag, ...args) => console.warn(`${prefix('WARN')} [${tag}]`, ...args),
    error: (tag, err, context) => logError(tag, err, context),
    debug: logDebug,
};

/** 供测试断言：当前级别集合（顺序即严重度顺序） */
export const LOG_LEVELS = LEVELS;
