/**
 * Express 应用装配：中间件 → 静态资源 → 路由 → 错误处理。
 * 与 server.js 分离，便于测试时单独导入 app。
 */
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import { config } from './config.js';
import { dataDir } from './utils/jsonStore.js';
import { aiGirlfriend, proactiveEngine } from './services/container.js';
import chatRoutes from './routes/chat.js';
import configRoutes from './routes/configRoutes.js';
import taskRoutes from './routes/tasks.js';
import audioRoutes from './routes/audio.js';
import stateRoutes from './routes/state.js';
import lifeRoutes from './routes/life.js';
import personalityRoutes from './routes/personalityRoutes.js';
import backupRoutes from './routes/backup.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createAuthMiddleware } from './middleware/auth.js';

/**
 * 版本号只在进程启动时读一次 package.json：/health 与排障都要能回答
 * 「现在跑的是哪个版本」——今晚就出现过「代码已改，服务还跑着旧版本」的情况。
 */
const APP_VERSION = (() => {
    try {
        const raw = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8');
        return JSON.parse(raw).version || null;
    } catch {
        return null;
    }
})();

export function createApp() {
    const app = express();
    app.disable('x-powered-by');

    app.use(cors({
        origin: config.cors.origins,
        // PATCH 必须在列：routes/state.js 有 PATCH /memories/facts/:id 且前端在用，
        // 漏掉会让浏览器预检直接失败（设置页「编辑事实」永远保存不了）。
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['*']
    }));
    // 档案导入要接收「一整份档案」：重度用户的 memory.json 单文件就有十几 MB，
    // 全局 1MB 的 JSON 限制会先把请求打成 413。所以这条路由**先于**全局解析器挂自己的。
    app.use('/backup/import', express.json({ limit: `${config.backup.maxExportMb}mb` }));
    // 请求体上限 1MB：防止超大 JSON 体打爆内存（既有行为未限制，此处收紧）。
    // 音频上传走 multer 独立管道（见 routes/audio.js），不受此 limit 影响。
    app.use(express.json({ limit: '1mb' }));

    // 鉴权中间件：必须位于 express.json() 之后（JSON 解析就绪、错误处理已可捕获）、
    // 业务路由之前（否则等于没挂）。豁免规则由中间件内部处理：
    // CORS 预检 OPTIONS 与健康检查 GET /；静态资源在未配 token 时免检、
    // 配了 token 时需要 ?token= 。详见 middleware/auth.js 顶部的防护策略说明。
    app.use(createAuthMiddleware());

    // 静态资源（TTS 音频等）
    fs.mkdirSync(config.staticDir, { recursive: true });
    app.use('/static', express.static(config.staticDir));

    // 上传临时目录
    fs.mkdirSync(config.upload.dir, { recursive: true });

    app.get('/', (req, res) => {
        res.json({ message: "AI Girlfriend Node Backend is Running" });
    });

    /**
     * 健康检查（B5-10）。免鉴权（见 middleware/auth.js 的 HEALTH_PATHS），
     * 只回**可判断状态**的信息，绝不回 Key、baseUrl 全串或任何对话内容。
     *
     * 为什么每个字段都值得存在：`start_services.py` 以前只探 TCP 端口 —— 端口通了
     * 但服务其实起不来（数据目录不可写 / 容器装配抛错）它照样报 OK。现在改成探 /health
     * 并看 `ok`；`llmConfigured` 则把「后端重启后 Key 还没被浏览器下发」这件最容易
     * 让人以为坏了的事，变成一眼可读的状态。
     */
    app.get('/health', (req, res) => {
        let dataDirWritable = false;
        try {
            fs.accessSync(dataDir(), fs.constants.W_OK);
            dataDirWritable = true;
        } catch { /* 不可写或目录不存在，保持 false */ }
        const host = (() => {
            try { return new URL(aiGirlfriend.baseUrl).host; } catch { return null; }
        })();
        res.json({
            ok: dataDirWritable,
            version: APP_VERSION,
            node: process.version,
            uptimeSeconds: Math.round(process.uptime()),
            // 只报「有没有」与主机名，绝不外泄 Key 或完整地址
            llmConfigured: !!aiGirlfriend.apiKey && !!aiGirlfriend.openai,
            model: aiGirlfriend.modelName || null,
            baseUrlHost: host,
            dataDirWritable,
            companion: aiGirlfriend.getCompanionStatus(),
            chatQueueDepth: aiGirlfriend._queueDepth ?? 0,
            proactiveQueueSize: proactiveEngine?.messageQueue?.length ?? 0,
        });
    });

    app.use('/', chatRoutes);
    app.use('/', configRoutes);
    app.use('/', taskRoutes);
    app.use('/', audioRoutes);
    app.use('/', stateRoutes);
    app.use('/', lifeRoutes);
    app.use('/', personalityRoutes);
    // 档案导出/导入/快照（B5-12）
    app.use('/', backupRoutes);

    // 未匹配路径的 JSON 兜底：Express 默认回 HTML「Cannot GET /x」，前端 api.ts 会对
    // HTML 做 JSON.parse，用户看到的是一条语法类报错而不是「接口不存在」。
    app.use((req, res) => {
        res.status(404).json({ detail: `Not found: ${req.method} ${req.path}` });
    });

    app.use(errorHandler);

    return app;
}
