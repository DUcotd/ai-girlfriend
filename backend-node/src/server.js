/**
 * 服务入口：创建 app、监听端口、优雅停机。
 */
import { createApp } from './app.js';
import { config } from './config.js';
import { shutdownServices } from './services/container.js';

const app = createApp();

const server = app.listen(config.port, () => {
    console.log(`Server running on http://localhost:${config.port}`);
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
