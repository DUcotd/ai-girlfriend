/**
 * errorCodes.ts — 后端稳定错误码在前端的镜像 + 「码 → 行动」映射（B7-①）。
 *
 * ⚠️ 分工：文案归后端（`utils/errorCodes.js` 与 `utils/upstreamError.js` 各自带中文
 * detail），本文件**不复制任何用户可见文案**。前端只回答一个问题：
 * 「这个码需要用户做什么」—— 去设置页、稍后再试，还是就这样播报。
 * 两处各写一份中文必然漂移，那是本项目已经付过两次学费的失效模式。
 *
 * 镜像由 `__tests__/errorCodes.test.ts` 钉住：它直接 import 后端两张表比对，
 * 新增码没同步、或前端留了后端已删的码，测试就会红。
 */

/** 上游模型服务类（backend-node/src/utils/upstreamError.js） */
export const UPSTREAM_ERROR_CODES = {
    AUTH: "upstream_auth",
    RATE_LIMITED: "upstream_rate_limited",
    BAD_REQUEST: "upstream_bad_request",
    NOT_FOUND: "upstream_not_found",
    UNAVAILABLE: "upstream_unavailable",
    NETWORK: "upstream_network",
    TIMEOUT: "upstream_timeout",
    CONTEXT_LENGTH: "upstream_context_length",
    NOT_CONFIGURED: "not_configured",
    BUSY: "service_busy",
    UNKNOWN: "internal_error",
} as const;

/** 本机业务类（backend-node/src/utils/errorCodes.js） */
export const LOCAL_ERROR_CODES = {
    INVALID_REQUEST: "invalid_request",
    INVALID_CONFIG: "invalid_config",
    UNAUTHORIZED_OPEN: "unauthorized_open",
    UNAUTHORIZED_MISSING: "unauthorized_missing",
    UNAUTHORIZED_TOKEN: "unauthorized_token",
    NOT_FOUND: "not_found",
    DUPLICATE_FACT: "duplicate_fact",
    FACT_NOT_FOUND: "fact_not_found",
    MEMORY_NOT_FOUND: "memory_not_found",
    NARRATIVE_NOT_FOUND: "narrative_not_found",
    TASK_NOT_FOUND: "task_not_found",
    METHOD_NOT_ALLOWED: "method_not_allowed",
    PAYLOAD_TOO_LARGE: "payload_too_large",
    UPLOAD_REJECTED: "upload_rejected",
    VOICE_NOT_CONFIGURED: "voice_not_configured",
    VOICE_AUTH_FAILED: "voice_auth_failed",
    PROACTIVE_TRIGGER_FAILED: "proactive_trigger_failed",
    SERVICE_NOT_READY: "service_not_ready",
    INTERNAL_ERROR: UPSTREAM_ERROR_CODES.UNKNOWN,
    BACKUP_INVALID: "backup_invalid",
    BACKUP_PARTIAL: "backup_partial",
    BACKUP_TOO_LARGE: "backup_too_large",
    BACKUP_SECRET_LEAK: "backup_secret_leak",
    BACKUP_BAD_REQUEST: "backup_bad_request",
    BACKUP_SNAPSHOT_NOT_FOUND: "backup_snapshot_not_found",
} as const;

/**
 * 纯前端侧的码：请求根本没走到后端（离线 / DNS / 被拒连接），或本轮被主动中止。
 * 后端不可能发这两个值，所以跨端测试比对时会把它们排除。
 */
export const CLIENT_ONLY_ERROR_CODES = {
    NETWORK: "network_error",
    ABORTED: "aborted",
} as const;

export type UpstreamErrorCode = (typeof UPSTREAM_ERROR_CODES)[keyof typeof UPSTREAM_ERROR_CODES];

/** 用户拿到提示之后能做什么。加字段而不是加分支，界面只读这一个出口 */
export interface ErrorAction {
    /** 需要改配置（Key / Base URL / 语音 Key / token）——提示指向设置页 */
    openSettings: boolean;
    /** 稍后重试有意义（限流、排队满、上游抖动、网络） */
    retry: boolean;
    /**
     * 提示的语气：语音/朗读这类「她没做到」的失败用 info，
     * 只有会阻断使用的才用 error，避免每次都糊一屏红。
     */
    tone: "error" | "info";
}

const ACTION_BY_CODE: Record<string, ErrorAction> = {
    [UPSTREAM_ERROR_CODES.AUTH]: { openSettings: true, retry: false, tone: "error" },
    [UPSTREAM_ERROR_CODES.NOT_CONFIGURED]: { openSettings: true, retry: false, tone: "error" },
    [UPSTREAM_ERROR_CODES.BAD_REQUEST]: { openSettings: true, retry: false, tone: "error" },
    [UPSTREAM_ERROR_CODES.NOT_FOUND]: { openSettings: true, retry: false, tone: "error" },
    [UPSTREAM_ERROR_CODES.CONTEXT_LENGTH]: { openSettings: true, retry: false, tone: "info" },
    [UPSTREAM_ERROR_CODES.RATE_LIMITED]: { openSettings: false, retry: true, tone: "info" },
    [UPSTREAM_ERROR_CODES.BUSY]: { openSettings: false, retry: true, tone: "info" },
    [UPSTREAM_ERROR_CODES.UNAVAILABLE]: { openSettings: false, retry: true, tone: "info" },
    [UPSTREAM_ERROR_CODES.NETWORK]: { openSettings: true, retry: true, tone: "info" },
    [UPSTREAM_ERROR_CODES.TIMEOUT]: { openSettings: false, retry: true, tone: "info" },
    [LOCAL_ERROR_CODES.VOICE_NOT_CONFIGURED]: { openSettings: true, retry: false, tone: "info" },
    [LOCAL_ERROR_CODES.VOICE_AUTH_FAILED]: { openSettings: true, retry: false, tone: "error" },
    [LOCAL_ERROR_CODES.UNAUTHORIZED_OPEN]: { openSettings: true, retry: false, tone: "error" },
    [LOCAL_ERROR_CODES.UNAUTHORIZED_MISSING]: { openSettings: true, retry: false, tone: "error" },
    [LOCAL_ERROR_CODES.UNAUTHORIZED_TOKEN]: { openSettings: true, retry: false, tone: "error" },
    [LOCAL_ERROR_CODES.INVALID_CONFIG]: { openSettings: true, retry: false, tone: "error" },
    [LOCAL_ERROR_CODES.BACKUP_SECRET_LEAK]: { openSettings: false, retry: false, tone: "error" },
    [LOCAL_ERROR_CODES.BACKUP_PARTIAL]: { openSettings: false, retry: true, tone: "error" },
    [LOCAL_ERROR_CODES.SERVICE_NOT_READY]: { openSettings: false, retry: true, tone: "info" },
    [LOCAL_ERROR_CODES.PROACTIVE_TRIGGER_FAILED]: { openSettings: false, retry: true, tone: "info" },
    [CLIENT_ONLY_ERROR_CODES.NETWORK]: { openSettings: false, retry: true, tone: "error" },
    [CLIENT_ONLY_ERROR_CODES.ABORTED]: { openSettings: false, retry: true, tone: "info" },
};

/** 没登记过的码：不猜、不崩，就是一条普通错误（后端新增码时前端不会因为漏映射而坏） */
const DEFAULT_ACTION: ErrorAction = { openSettings: false, retry: false, tone: "error" };

/** 全部已知码（跨端测试的口径；含前端独有的两个） */
export const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
    ...Object.values(UPSTREAM_ERROR_CODES),
    ...Object.values(LOCAL_ERROR_CODES),
    ...Object.values(CLIENT_ONLY_ERROR_CODES),
]);

/** 码 → 行动。null/未知码一律走默认值，调用方不需要判空 */
export function actionFor(code: string | null | undefined): ErrorAction {
    if (!code) return DEFAULT_ACTION;
    return ACTION_BY_CODE[code] ?? DEFAULT_ACTION;
}

/** 后端已经给了中文 detail；前端只在「需要去设置页」时补一句行动指引 */
export const SETTINGS_HINT = "（设置 → 通用）";

/**
 * 后端 detail 里已经自带行动指引时不再追加，免得一句话挂两个括号。
 * 判断依据是「这句话有没有告诉用户去哪做」：出现 设置/配置/检查/稍后/重试，
 * 或者整句以括号收尾（那种括号本身就是指引）。
 */
function hasOwnHint(detail: string): boolean {
    const trimmed = detail.trim();
    return (
        /(设置|配置|检查|稍后|重试)/.test(trimmed) ||
        /[）)]$/.test(trimmed)
    );
}

export function withActionHint(detail: string, code: string | null | undefined): string {
    const action = actionFor(code);
    if (!action.openSettings || !detail) return detail;
    if (hasOwnHint(detail)) return detail;
    return `${detail}${SETTINGS_HINT}`;
}
