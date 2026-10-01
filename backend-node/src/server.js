/**
 * 服务入口：创建 app、监听端口、优雅停机。
 */
import { createApp } from './app.js';
import { config } from './config.js';
import { shutdownServices } from './services/container.js';
import { warnIfTokenMissing } from './middleware/auth.js';

const app = createApp();

/**
 * 监听地址（纵深防御的关键一环）：
 * 默认只绑定 127.0.0.1（回环），避免服务被局域网 / 公网直接访问。
 * 仅当用户显式设置 HOST=0.0.0.0（或其它地址）时才对外暴露——
 * 这种场景务必同时配置 AI_GIRLFRIEND_TOKEN，否则等同于把全部数据敞开。
 * （原实现 app.listen(port) 会监听 0.0.0.0，是本次体检判定的 P0 风险面之一。）
 */
const host = process.env.HOST || '127.0.0.1';

// 未配置 token 时打印一次醒目警告（本机守卫模式）；已配置则静默。
warnIfTokenMissing();

const server = app.listen(config.port, host, () => {
    console.log(`Server running on http://${host}:${config.port}`);
    console.log(`[Server] 绑定地址 ${host}:${config.port} —— 仅监听 ${host === '127.0.0.1' ? '本机回环（推荐）' : `${host}（已对外暴露，请确认已配置 AI_GIRLFRIEND_TOKEN）`}`);
});

function gracefulShutdown(signal) {
    console.log(`\n[Server] ${signal} received, shutting down...`);
    shutdownServices();
    server.close(() => {
        console.log('[Server] Closed');
        process.exit(0);
    });
    // 兜底：3 秒后强制退出，避免句柄未释放导致挂起
    setTimeout(() => process.exit(1), 3000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
