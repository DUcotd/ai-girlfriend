/**
 * Express 应用装配：中间件 → 静态资源 → 路由 → 错误处理。
 * 与 server.js 分离，便于测试时单独导入 app。
 */
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import { config } from './config.js';
import chatRoutes from './routes/chat.js';
import configRoutes from './routes/configRoutes.js';
import taskRoutes from './routes/tasks.js';
import audioRoutes from './routes/audio.js';
import stateRoutes from './routes/state.js';
import lifeRoutes from './routes/life.js';
import personalityRoutes from './routes/personalityRoutes.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createAuthMiddleware } from './middleware/auth.js';

export function createApp() {
    const app = express();

    app.use(cors({
        origin: config.cors.origins,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['*']
    }));
    // 请求体上限 1MB：防止超大 JSON 体打爆内存（既有行为未限制，此处收紧）。
    // 音频上传走 multer 独立管道（见 routes/audio.js），不受此 limit 影响。
    app.use(express.json({ limit: '1mb' }));

    // 鉴权中间件：必须位于 express.json() 之后（JSON 解析就绪、错误处理已可捕获）、
    // 业务路由之前（否则等于没挂）。豁免规则由中间件内部处理：
    // CORS 预检 OPTIONS、健康检查 GET /、静态资源 /static。
    // 详见 middleware/auth.js 顶部的防护策略说明。
    app.use(createAuthMiddleware());

    // 静态资源（TTS 音频等）
    fs.mkdirSync(config.staticDir, { recursive: true });
    app.use('/static', express.static(config.staticDir));

    // 上传临时目录
    fs.mkdirSync(config.upload.dir, { recursive: true });

    app.get('/', (req, res) => {
        res.json({ message: "AI Girlfriend Node Backend is Running" });
    });

    app.use('/', chatRoutes);
    app.use('/', configRoutes);
    app.use('/', taskRoutes);
    app.use('/', audioRoutes);
    app.use('/', stateRoutes);
    app.use('/', lifeRoutes);
    app.use('/', personalityRoutes);

    app.use(errorHandler);

    return app;
}
