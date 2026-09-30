/**
 * 全局错误处理中间件。
 * 统一响应格式 { detail }。意外异常仍压成 500 不泄漏内部细节；
 * 但业务层主动标记了 err.status 的错误（如语音模块的 400/401「key 未配置/无效」）
 * 是有意给用户看的可操作提示，透传 status 与 message，否则前端的提示分支永远不命中。
 */
export function errorHandler(err, req, res, _next) {
    console.error(`[${req.method} ${req.path}]`, err.message || err);
    if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
        return res.status(err.status).json({ detail: err.message });
    }
    res.status(500).json({ detail: 'Internal server error' });
}
