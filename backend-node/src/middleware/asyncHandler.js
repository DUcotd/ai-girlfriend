/**
 * asyncHandler - 包装异步路由处理器，将 Promise 拒绝转发给 Express 错误中间件。
 * 有了它，路由里不再需要手写 try/catch。
 */
export function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}
