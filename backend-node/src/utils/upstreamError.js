/**
 * upstreamError.js - 把上游模型服务的异常翻译成**稳定码 + 中文文案**（审计 HTTP-14）。
 *
 * 旧写法是 `reply: \`发生了点小意外: ${e.message}\``：
 *   1. SDK 的原文里带着上游主机名、模型名、请求 id 甚至 Key 片段
 *      （`Connection error (cause: getaddrinfo ENOTFOUND api.xxx.com)`），
 *      这些会被当成回复气泡显示、写进对话历史、再喂回下一轮的 prompt；
 *   2. 文案每次都不一样，前端没有任何可编程的分支（无法给出「去设置页检查 Key」这种可操作提示）。
 *
 * 本模块的约定：**细节只进日志，用户只看到分类文案，程序只依赖 error_code**。
 * 纯函数、不碰 IO，方便直接断言。
 */

/** 稳定错误码（对外契约：前端按它分支，禁止再按 message 文案匹配） */
export const UPSTREAM_ERROR_CODES = Object.freeze({
    AUTH: 'upstream_auth',
    RATE_LIMITED: 'upstream_rate_limited',
    BAD_REQUEST: 'upstream_bad_request',
    NOT_FOUND: 'upstream_not_found',
    UNAVAILABLE: 'upstream_unavailable',
    NETWORK: 'upstream_network',
    TIMEOUT: 'upstream_timeout',
    CONTEXT_LENGTH: 'upstream_context_length',
    /** 本机还没配 Key —— 不是上游故障，但同样需要一句可操作的文案与一个稳定码 */
    NOT_CONFIGURED: 'not_configured',
    /** 对话队列已满（有人在等 LLM 时又压进来太多轮）：直接拒，而不是无限排队 */
    BUSY: 'service_busy',
    UNKNOWN: 'internal_error',
});

/** 用户看得懂的文案（气泡直接显示）。措辞保持「她」的口吻之外还保持可操作 */
const COPY = Object.freeze({
    [UPSTREAM_ERROR_CODES.AUTH]: '模型服务拒绝了这次请求（API Key 无效或过期）。请到设置页检查一下 Key。',
    [UPSTREAM_ERROR_CODES.RATE_LIMITED]: '模型那边有点忙，我先停一下——过一会儿再说好吗？',
    [UPSTREAM_ERROR_CODES.BAD_REQUEST]: '模型服务没有接受这次请求（可能是模型名或参数不对）。可以在设置页检查一下模型与 Base URL。',
    [UPSTREAM_ERROR_CODES.NOT_FOUND]: '设置里的那个模型不存在，请检查模型名是否正确。',
    [UPSTREAM_ERROR_CODES.CONTEXT_LENGTH]: '这段对话太长了，我在设置页的「高级选项」里把历史条数调小一点就能继续。',
    [UPSTREAM_ERROR_CODES.UNAVAILABLE]: '模型服务暂时不可用，稍等一下再试。',
    [UPSTREAM_ERROR_CODES.NETWORK]: '连不上模型服务，请检查网络或 Base URL 是否正确。',
    [UPSTREAM_ERROR_CODES.TIMEOUT]: '模型服务回应太慢了，我先断了——可以再说一次吗？',
    [UPSTREAM_ERROR_CODES.NOT_CONFIGURED]: '请先配置 API Key 才能和小爱聊天哦~（在侧边栏输入或配置 .env 文件）',
    [UPSTREAM_ERROR_CODES.BUSY]: '我正在想刚才那句话，等我一下再说好吗？',
    [UPSTREAM_ERROR_CODES.UNKNOWN]: '刚才出了点小意外，再说一次试试？',
});

/** HTTP 状态码：路由据此决定 502/503/429/400 */
const STATUS = Object.freeze({
    [UPSTREAM_ERROR_CODES.AUTH]: 401,
    [UPSTREAM_ERROR_CODES.RATE_LIMITED]: 429,
    [UPSTREAM_ERROR_CODES.BAD_REQUEST]: 400,
    [UPSTREAM_ERROR_CODES.NOT_FOUND]: 404,
    [UPSTREAM_ERROR_CODES.CONTEXT_LENGTH]: 400,
    [UPSTREAM_ERROR_CODES.UNAVAILABLE]: 502,
    [UPSTREAM_ERROR_CODES.NETWORK]: 502,
    [UPSTREAM_ERROR_CODES.TIMEOUT]: 504,
    [UPSTREAM_ERROR_CODES.NOT_CONFIGURED]: 400,
    [UPSTREAM_ERROR_CODES.BUSY]: 429,
    [UPSTREAM_ERROR_CODES.UNKNOWN]: 500,
});

/** 网络层错误码（Node 的 errno / fetch 的 TypeError） */
const NETWORK_CODES = new Set([
    'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EPIPE',
    'EHOSTUNREACH', 'ENETUNREACH', 'ERR_INVALID_URL', 'ERR_INVALID_ARG', 'ERR_BAD_RESPONSE',
]);

/**
 * 判定一个异常来自上游的哪一种故障。
 * @param {unknown} err SDK/网络异常（可能有 .status / .code / .name / .error.code）
 * @returns {{code: string, message: string, status: number}}
 */
export function classifyUpstreamError(err) {
    const status = typeof err?.status === 'number' ? err.status : undefined;
    const code = typeof err?.code === 'string' ? err.code : '';
    const name = typeof err?.name === 'string' ? err.name : '';
    const message = String(err?.message ?? err ?? '').toLowerCase();

    // 上下文超长：这类只能由用户把历史调大触发，给的是可操作建议而不是泛泛的「出错了」
    if (status === 400 && (message.includes('context length') || message.includes('maximum context')
        || message.includes('too many tokens') || message.includes('reduce'))) {
        return pick(UPSTREAM_ERROR_CODES.CONTEXT_LENGTH);
    }
    if (status === 401 || status === 403) return pick(UPSTREAM_ERROR_CODES.AUTH);
    if (status === 429) return pick(UPSTREAM_ERROR_CODES.RATE_LIMITED);
    if (status === 404) return pick(UPSTREAM_ERROR_CODES.NOT_FOUND);
    if (status === 400 || status === 422) return pick(UPSTREAM_ERROR_CODES.BAD_REQUEST);
    if (typeof status === 'number' && status >= 500) return pick(UPSTREAM_ERROR_CODES.UNAVAILABLE);

    if (name === 'APIConnectionTimeoutError' || name === 'TimeoutError'
        || code === 'ETIMEDOUT' || message.includes('timeout') || message.includes('timed out')) {
        return pick(UPSTREAM_ERROR_CODES.TIMEOUT);
    }
    if (NETWORK_CODES.has(code) || name === 'APIConnectionError'
        || message.includes('fetch failed') || message.includes('getaddrinfo')
        || message.includes('connection error') || message.includes('socket hang up')) {
        return pick(UPSTREAM_ERROR_CODES.NETWORK);
    }
    return pick(UPSTREAM_ERROR_CODES.UNKNOWN);
}

function pick(code) {
    return { code, message: COPY[code], status: STATUS[code] };
}

/** 按稳定码取那份唯一文案（路由/守卫要复用，不许再各写一句中文） */
export function messageFor(code) {
    return COPY[code] ?? COPY[UPSTREAM_ERROR_CODES.UNKNOWN];
}

/** 按稳定码构造一个分类结果（守卫路径没有异常，也要走同一份表） */
export function classifiedByCode(code) {
    return pick(UPSTREAM_ERROR_CODES[code.toUpperCase()] ?? code);
}

/**
 * 安全的日志行：只打分类与**截断后的**原始 message，且绝不打 Authorization / Key。
 * 排查时需要的上游主机名等信息在 message 里，日志保留（磁盘上），但不会进对话历史。
 */
export function upstreamLogLine(err, classified) {
    const raw = String(err?.message ?? err ?? '').replace(/\s+/g, ' ').slice(0, 300);
    return `[upstream ${classified.code}] ${classified.status} —— ${raw}`;
}
