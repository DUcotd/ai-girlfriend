import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/config.js -> backend-node/
export const BACKEND_ROOT = path.resolve(__dirname, '..');

export const config = {
    port: Number(process.env.PORT) || 8000,
    cors: {
        origins: [
            'http://localhost:3000',
            'http://127.0.0.1:3000',
            process.env.FRONTEND_ORIGIN,
        ].filter(Boolean),
    },
    upload: {
        dir: path.join(BACKEND_ROOT, 'temp_uploads'),
        maxFileSize: 10 * 1024 * 1024, // 10MB
    },
    staticDir: path.join(BACKEND_ROOT, 'static'),
    // 聊天消息长度上限，防止异常超长输入打爆 LLM 上下文
    chat: {
        maxMessageLength: 8000,
    },
};
