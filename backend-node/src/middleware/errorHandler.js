/**
 * 全局错误处理中间件。
 * 统一响应格式 { detail, error_code? }。意外异常仍压成 500 不泄漏内部细节；
 * 但业务层主动标记了 err.status 的错误（如语音模块的 400/401「key 未配置/无效」、
 * 上传模块的 413/415）是有意给用户看的可操作提示，透传 status 与 message，
 * 否则前端的提示分支永远不命中。
 *
 * 日志侧（B5-10 / INFRA-11）：以前只打 `err.message` 一行，500 的真实成因
 * （哪个文件哪一行抛的）在日志里查不到。现在统一走 logger，**带堆栈**。
 * 堆栈只进日志，绝不进响应体 —— 响应里出现路径与栈就是信息泄漏。
 */
import { logError } from '../utils/logger.js';
import { codeFor, ERROR_CODES } from '../utils/errorCodes.js';
import { failWith } from './validate.js';

export function errorHandler(err, req, res, _next) {
    const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 600
        ? err.status
        : 500;
    const isClientError = status >= 400 && status < 500;

    // 4xx 是可预期的用户侧问题，一行足够；5xx 必须带堆栈才排得动
    logError(`${req.method} ${req.path}`, err, `(${status})`);

    if (isClientError) {
        // 只透传**应用自己的稳定码**（utils/errorCodes.js 与 utils/upstreamError.js 那一套），
        // 不读 err.code —— Node/中间件的 code（ENOENT、LIMIT_FILE_SIZE…）是内部细节，
        // 出现在响应里等于把实现暴露给调用方（审计 HTTP-14 的同一条边界）。
        // 没标码的按状态码兜底，保证错误体永远有 error_code（B7-① 的不变量）。
        return failWith(res, status, err.message || '请求不合法',
            typeof err?.errorCode === 'string' ? err.errorCode : codeFor(status));
    }
    // 5xx 的 detail 永远是同一句通用文案：堆栈与成因只在日志里
    return failWith(res, 500, 'Internal server error', ERROR_CODES.INTERNAL_ERROR);
}
