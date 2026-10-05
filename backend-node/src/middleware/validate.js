/**
 * fail - 请求体字段校验的轻量工具。
 *
 * 命名读起来像双重否定（`if (fail(res, 条件是「坏了」, 原因)) return;`），
 * 但**条件参数一律写成「这个字段坏了吗」**而不是「正常吗」——全站 12 处调用都遵循
 * 这一条，混用会造出「取反与否」这类最难查的静默放行（审计 HTTP-19）。
 *
 * @param {import('express').Response} res
 * @param {boolean} isBad  true = 请求不合法（会回 400）
 * @param {string} detail   给用户看的原因（中文或英文皆可，前端只按 error_code 分支）
 * @param {string} [code]   稳定错误码（utils/upstreamError.js 的 UPSTREAM_ERROR_CODES 之一）；
 *                          带上它，前端才能给「去设置页检查 Key」这类可操作提示，
 *                          而不是只会弹一句文案（HTTP-14 的同一条约定）
 * @returns {boolean} 是否已经响应过（调用方 `if (fail(...)) return;` 直接退出）
 */
export function fail(res, isBad, detail, code = null) {
    if (!isBad) return false;
    res.status(400).json({ detail, ...(code ? { error_code: code } : {}) });
    return true;
}

/**
 * 非 400 的同类快捷出口（404/409/413/429…）。
 * 与 fail 同一份响应形状 `{ detail, error_code? }`，全站只有一种错误体。
 */
export function failWith(res, status, detail, code = null) {
    res.status(status).json({ detail, ...(code ? { error_code: code } : {}) });
    return true;
}
