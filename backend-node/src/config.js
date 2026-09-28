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
    chat: {
        // 单条消息长度上限，防止异常超长输入打爆 LLM 上下文
        maxMessageLength: 8000,
        // 发送给 LLM 的最近历史条数。持久化仍保留 MAX_HISTORY 全量，
        // 但 prompt 只带最近这些条，显著降低 prefill 开销与生成耗时。
        maxPromptHistory: Number(process.env.CHAT_MAX_PROMPT_HISTORY) || 30,
        // 主 LLM 请求超时（与前端 60s 超时对齐，避免后端无限挂起）
        timeoutMs: Number(process.env.CHAT_TIMEOUT_MS) || 60_000,
        // 响应里回传「思考」字段（inner_thought 人设独白 / model_reasoning 原生思考）的
        // 最大字符数，超出截断。原生 CoT 可能上万字，不宜整个塞进 HTTP 响应。
        thinkingMaxChars: Number(process.env.CHAT_THINKING_MAX_CHARS) || 2000,
    },
    // 记忆检索用的 embedding：慢就快速降级为关键词检索，不拖垮主链路
    embedding: {
        timeoutMs: Number(process.env.EMBEDDING_TIMEOUT_MS) || 2500,
        maxRetries: 0,
    },
};
