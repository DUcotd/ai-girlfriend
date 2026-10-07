/**
 * ApiError — 前端唯一的「后端说失败了」形状（B7-①）。
 *
 * 解决的问题：以前 `request()` 把所有失败压成 `new Error(detail)`，于是
 *   - 状态码与稳定码丢了，界面只能回去匹配中文文案（`message.includes("409")` 那种），
 *     后端改一个字这条分支就静默失效；
   - 「后端离线」与「后端拒了这个请求」共用一句提示，用户被支去查网络，
 *     而真正的问题是他刚填的地址。
 *
 * 现在：`message` 仍然等于 detail（老调用方一个字都不用改就能继续跑），
 * 但 `status / code / errors / action` 都在，界面按 `code` 分支、按 `action` 决定行动。
 */
import {
    CLIENT_ONLY_ERROR_CODES,
    actionFor,
    withActionHint,
} from "./errorCodes";
import type { ErrorAction } from "./errorCodes";

/** 后端错误体：{ detail, error_code?, errors?, ...附加字段 } */
export interface ApiErrorBody {
    detail?: unknown;
    error_code?: unknown;
    errors?: unknown;
}

interface ApiErrorInit {
    status: number | null;
    code: string | null;
    detail: string;
    errors?: string[];
}

export class ApiError extends Error {
    readonly status: number | null;
    readonly code: string | null;
    readonly detail: string;
    /** 字段级错误的逐条原因（目前只有 POST /config 会带） */
    readonly errors: string[];
    /** 该码对应的行动（去设置页 / 可重试 / 语气），未知码走默认值 */
    readonly action: ErrorAction;

    constructor({ status, code, detail, errors = [] }: ApiErrorInit) {
        // message 保持等于 detail：历史上所有调用方都读 e.message，语义不变
        super(detail);
        this.name = "ApiError";
        this.status = status;
        this.code = code;
        this.detail = detail;
        this.errors = errors;
        this.action = actionFor(code);
    }

    /** 请求没走到后端（服务没起 / DNS / 连接被拒）——与「后端拒了」是两回事 */
    get isNetworkError(): boolean {
        return this.status === null;
    }

    /**
     * 直接可显示的一句话。
     * 后端给了中文 detail 就用它（文案的唯一来源在后端），前端只补行动指引；
     * 网络层失败只有前端知道，所以这一句由这里负责。
     */
    get userMessage(): string {
        if (this.isNetworkError) {
            return "连不上后端（默认 8000 端口），请确认服务已启动后重试";
        }
        const base = this.detail || `请求失败（HTTP ${this.status}）`;
        // 文案本体永远来自后端 detail；withActionHint 只负责补「去哪改」，
        // 且后端文案里已经写了「设置」时不重复追加
        return withActionHint(base, this.code);
    }
}

/** 从响应状态与错误体构造 ApiError（体缺失/不是 JSON 时退化成状态码描述） */
export function apiErrorFrom(status: number, body: ApiErrorBody | null): ApiError {
    const detail = typeof body?.detail === "string" ? body.detail : "";
    const code = typeof body?.error_code === "string" ? body.error_code : null;
    const errors = Array.isArray(body?.errors)
        ? body.errors.filter((e): e is string => typeof e === "string")
        : [];
    return new ApiError({ status, code, detail, errors });
}

/** 网络层失败：没有状态码，固定用前端侧的 network_error */
export function networkError(cause?: unknown): ApiError {
    const detail = cause instanceof Error && cause.message
        ? cause.message
        : "Network request failed";
    return new ApiError({ status: null, code: CLIENT_ONLY_ERROR_CODES.NETWORK, detail });
}

/** 把任意 catch 到的东西规整成 ApiError（AbortError 等非请求错误保持原样信息） */
export function toApiError(error: unknown): ApiError {
    if (error instanceof ApiError) return error;
    if (error instanceof Error && error.name === "AbortError") {
        // 超时/主动断开由调用方决定文案，这里不抢
        return new ApiError({
            status: null,
            code: CLIENT_ONLY_ERROR_CODES.ABORTED,
            detail: error.message,
        });
    }
    const detail = error instanceof Error ? error.message : String(error ?? "");
    return new ApiError({ status: null, code: CLIENT_ONLY_ERROR_CODES.NETWORK, detail });
}
