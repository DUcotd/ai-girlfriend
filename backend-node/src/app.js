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

export function createApp() {
    const app = express();

    app.use(cors({
        origin: config.cors.origins,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['*']
    }));
    app.use(express.json());

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
