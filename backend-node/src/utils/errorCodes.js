/**
 * errorCodes.js — **本机业务错误**的稳定码表（B7-①「前端按码分支」的后端一半）。
 *
 * 分工（别越界，否则会出现两份真相）：
 *   - `utils/upstreamError.js` 的 `UPSTREAM_ERROR_CODES` 管**上游模型服务**的异常
 *     （鉴权、限流、超时、上下文超长……），它自带文案表与 HTTP 状态映射；
 *   - 本表管**应用自己**的入参与状态问题（配置非法、资源不存在、需要凭证、语音没配 Key…）；
 *   - 两边的值合起来就是对外契约，前端 `lib/errorCodes.ts` 是它的镜像，
 *     由 `frontend/src/lib/__tests__/errorCodes.test.ts` 直接 import 这两个模块钉住。
 *
 * 为什么要「每个错误体都带 error_code」而不是「重要的那几个带上」：
 * 前端只要有一个分支还得靠 `message.includes('409')` 这种中文/状态文字匹配，
 * 那条分支就会在一次文案微调后静默失效 —— 这正是审计里已经抓过两轮的失效模式。
 * 所以默认值由 `codeFor(status)` 兜住：**漏传不会退化成「没有码」，只会退化成「按状态码分类」**。
 */

import { UPSTREAM_ERROR_CODES } from './upstreamError.js';

/** 本机业务码（对外契约：前端只按这些值分支，禁止匹配文案） */
export const ERROR_CODES = Object.freeze({
    /** 通用入参不合法（fail() 未指定具体码时的默认值） */
    INVALID_REQUEST: 'invalid_request',
    /** POST /config 的字段校验没过；响应体里另有 errors[] 逐条原因 */
    INVALID_CONFIG: 'invalid_config',
    /** 需要凭证：未配置 token 且请求来自非本机 */
    UNAUTHORIZED_OPEN: 'unauthorized_open',
    /** 需要凭证：完全没带 Authorization 头 */
    UNAUTHORIZED_MISSING: 'unauthorized_missing',
    /** 需要凭证：带了但不对（前端可提示「去设置里重新填 token」） */
    UNAUTHORIZED_TOKEN: 'unauthorized_token',
    /** 资源找不到（通用默认值） */
    NOT_FOUND: 'not_found',
    /** 事实记忆已存在语义重复（前端给「已有类似记忆」而不是「添加失败」） */
    DUPLICATE_FACT: 'duplicate_fact',
    FACT_NOT_FOUND: 'fact_not_found',
    MEMORY_NOT_FOUND: 'memory_not_found',
    NARRATIVE_NOT_FOUND: 'narrative_not_found',
    TASK_NOT_FOUND: 'task_not_found',
    /** 方法不对（旧的消费型 GET 保留在这里明确失败，而不是悄悄变只读） */
    METHOD_NOT_ALLOWED: 'method_not_allowed',
    /** 上传体积超限 */
    PAYLOAD_TOO_LARGE: 'payload_too_large',
    /** 上传部件名/格式不对 */
    UPLOAD_REJECTED: 'upload_rejected',
    /** 没配语音（TTS/ASR 共用）专属 Key —— 不是故障，是功能未开启 */
    VOICE_NOT_CONFIGURED: 'voice_not_configured',
    /** 配了语音 Key 但被上游拒绝（无效/无余额），前端要能跳设置页 */
    VOICE_AUTH_FAILED: 'voice_auth_failed',
    /** 主动消息没能生成（总开关关闭 / 同类在途 / 队列满） */
    PROACTIVE_TRIGGER_FAILED: 'proactive_trigger_failed',
    /** 子系统还没就绪（LifeSimulator 未初始化） */
    SERVICE_NOT_READY: 'service_not_ready',
    /**
     * 兜底：意外异常，细节只在日志里。
     * ⚠️ 刻意复用上游表的 UNKNOWN 值 —— `internal_error` 全站只能有一处定义，
     * 两张表各写一遍就是「同一个码两个来源」，早晚漂移（这个重复就是本次新增的
     * 契约测试抓出来的，不是人看出来的）。
     */
    INTERNAL_ERROR: UPSTREAM_ERROR_CODES.UNKNOWN,

    // —— 档案导入导出（值保持不变：README 与已发布的前端都按这些字符串写过）——
    BACKUP_INVALID: 'backup_invalid',
    /** 快照成功但部分数据文件写盘失败（磁盘只写了一半，必须让人看 writeFailed） */
    BACKUP_PARTIAL: 'backup_partial',
    BACKUP_TOO_LARGE: 'backup_too_large',
    BACKUP_SECRET_LEAK: 'backup_secret_leak',
    BACKUP_BAD_REQUEST: 'backup_bad_request',
    BACKUP_SNAPSHOT_NOT_FOUND: 'backup_snapshot_not_found',
});

/**
 * 状态码 → 默认稳定码。
 * 漏传 code 时用它兜底，保证「错误体一定有 error_code」这条不变量。
 */
const DEFAULT_CODE_BY_STATUS = Object.freeze({
    400: ERROR_CODES.INVALID_REQUEST,
    401: ERROR_CODES.UNAUTHORIZED_MISSING,
    403: ERROR_CODES.UNAUTHORIZED_TOKEN,
    404: ERROR_CODES.NOT_FOUND,
    405: ERROR_CODES.METHOD_NOT_ALLOWED,
    409: ERROR_CODES.DUPLICATE_FACT,
    413: ERROR_CODES.PAYLOAD_TOO_LARGE,
    415: ERROR_CODES.UPLOAD_REJECTED,
    422: ERROR_CODES.INVALID_REQUEST,
    429: UPSTREAM_ERROR_CODES.RATE_LIMITED,   // 与上游表同一个值，不另立
    500: ERROR_CODES.INTERNAL_ERROR,
    503: ERROR_CODES.SERVICE_NOT_READY,
});

/** 按状态码取默认稳定码（未知状态一律 INTERNAL_ERROR，绝不返回 undefined） */
export function codeFor(status) {
    return DEFAULT_CODE_BY_STATUS[status] ?? ERROR_CODES.INTERNAL_ERROR;
}

/** 全部对外码（含上游表），供测试与文档核对 */
export function allLocalCodes() {
    return Object.values(ERROR_CODES);
}
