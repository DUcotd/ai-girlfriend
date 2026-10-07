/**
 * fail / failWith — 全站唯一的错误出口（B7-① 之后：错误体一定带 error_code）。
 *
 * 命名读起来像双重否定（`if (fail(res, 条件是「坏了」, 原因)) return;`），
 * 但**条件参数一律写成「这个字段坏了吗」**而不是「正常吗」——全站调用都遵循
 * 这一条，混用会造出「取反与否」这类最难查的静默放行（审计 HTTP-19）。
 *
 * 2026-10-07 起 `code` 可以不传：由 `codeFor(status)` 按状态码兜底。
 * 为什么要有默认值 —— 「重要的错误带码、不重要的只给文案」这种半吊子契约，
 * 会让前端保留 `message.includes('409')` 之类的文字匹配分支；那次文案一改，
 * 分支就静默失效（本项目已为此抓过两轮）。现在的不变量是：
 * **非 2xx 响应里必然有非空 error_code**，由 `test-audit-b7.mjs` 逐路由钉住。
 *
 * @param {import('express').Response} res
 * @param {boolean} isBad  true = 请求不合法（会回 400）
 * @param {string} detail   给用户看的原因（中文或英文皆可，前端只按 error_code 分支）
 * @param {string} [code]   稳定码（utils/errorCodes.js 的 ERROR_CODES，或上游表
 *                          utils/upstreamError.js 的 UPSTREAM_ERROR_CODES）；
 *                          带上它，前端才能给「去设置页检查 Key」这类可操作提示
 * @returns {boolean} 是否已经响应过（调用方 `if (fail(...)) return;` 直接退出）
 */
import { codeFor } from '../utils/errorCodes.js';

export function fail(res, isBad, detail, code = null, extra = null) {
    if (!isBad) return false;
    return failWith(res, 400, detail, code, extra);
}

/**
 * 非 400 的同类快捷出口（404/409/413/429/503…）。
 * 与 fail 同一份响应形状 `{ detail, error_code, ...extra }`，全站只有一种错误体。
 * @param {object} [extra] 附加字段（如 405 的 `allow`、400 的 `errors[]`），不参与码兜底
 */
export function failWith(res, status, detail, code = null, extra = null) {
    res.status(status).json({
        detail,
        error_code: code || codeFor(status),
        ...(extra || {}),
    });
    return true;
}
