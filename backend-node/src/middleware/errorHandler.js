/**
 * 全局错误处理中间件。
 * 统一响应格式 { detail }，与旧版接口契约保持一致，但不再向前端泄漏内部错误细节。
 */
export function errorHandler(err, req, res, _next) {
    console.error(`[${req.method} ${req.path}]`, err.message || err);
    res.status(500).json({ detail: 'Internal server error' });
}
