/**
 * 服务入口：创建 app、监听端口、优雅停机。
 */
import { createApp } from './app.js';
import { config } from './config.js';
import { shutdownServices } from './services/container.js';
import { warnIfTokenMissing, getConfiguredToken } from './middleware/auth.js';

const app = createApp();

/**
 * 监听地址（纵深防御的关键一环）：
 * 默认只绑定 127.0.0.1（回环），避免服务被局域网 / 公网直接访问。
 * 仅当用户显式设置 HOST=0.0.0.0（或其它地址）时才对外暴露——
 * 这种场景务必同时配置 AI_GIRLFRIEND_TOKEN，否则等同于把全部数据敞开。
 * （原实现 app.listen(port) 会监听 0.0.0.0，是本次体检判定的 P0 风险面之一。）
 */
const host = process.env.HOST || '127.0.0.1';
const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';

// 对外暴露却没配令牌 = 把对话历史、记忆和「POST /reset」敞开给局域网。
// 以前只打一行警告就照常启动（等于没有警告），现在直接拒绝启动。
if (!isLoopback && !getConfiguredToken()) {
    console.error(
        `[Server] 拒绝启动：HOST=${host} 对外暴露，但未设置访问令牌。\n`
        + '        请任选其一：\n'
        + '        · 只本机使用：去掉 HOST 或设 HOST=127.0.0.1\n'
        + '        · 需要外部访问：设置环境变量 AI_GIRLFRIEND_TOKEN=你的密钥\n'
        + '        （前端还需在 localStorage 写入同名键：ai-girlfriend-token）'
    );
    process.exit(1);
}

// 未配置 token 时打印一次醒目警告（本机守卫模式）；已配置则静默。
warnIfTokenMissing();

/**
 * 全局兜底：Node ≥15 会因为一个 unhandledRejection 直接结束进程。
 * 本项目有大量「后台副作用不阻塞响应」的 fire-and-forget 链路（记忆嵌入、
 * 事实/叙事抽取、主动消息生成），任何一条漏 catch 都不该把整个服务带走。
 * 拒绝：记录完整堆栈后继续运行；异常：状态已不可信，落盘后退出。
 */
process.on('unhandledRejection', (reason) => {
    console.error('[Server] 未处理的 Promise 拒绝（已忽略，服务继续运行）:');
    console.error(reason instanceof Error ? (reason.stack || reason.message) : reason);
});
process.on('uncaughtException', (err) => {
    console.error('[Server] 未捕获异常，进程即将退出:');
    console.error(err?.stack || err);
    try { shutdownServices(); } catch { /* ignore */ }
    process.exit(1);
});

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
