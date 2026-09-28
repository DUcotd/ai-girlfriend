/**
 * validateBody - 请求体字段校验的轻量工具。
 * 校验失败时直接响应 400 并返回 true（调用方据此 return）。
 *
 * 用法：
 *   if (fail(res, !message, 'message is required')) return;
 */
export function fail(res, condition, detail) {
    if (condition) {
        res.status(400).json({ detail });
        return true;
    }
    return false;
}
