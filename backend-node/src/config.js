import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/config.js -> backend-node/
export const BACKEND_ROOT = path.resolve(__dirname, '..');

/**
 * 读数值型环境变量：未设置/空串/非法/越界一律回落默认值。
 * 不能写 `Number(x) || fallback` —— 那样 0 会被当成没设置（temperature: 0 是合法值）。
 */
function envNumber(raw, fallback, min, max) {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) return fallback;
    return n;
}

/**
 * 思考强度合法档位；空串 = 不传该参数（普通模型收到会 400）。
 * none/minimal 仅较新的模型支持（如 OpenAI gpt-5 系）——设了不支持的档位，
 * 请求会直接 400 且日志可见，用户改回「不传」即可。
 * 导出为唯一真源：config 解析（env）与 AiGirlfriend._applyChatParams（运行时）共用。
 */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'];

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
        maxPromptHistory: envNumber(process.env.CHAT_MAX_PROMPT_HISTORY, 30, 1, 500),
        // 无限上下文：true = 忽略 maxPromptHistory，每次请求带上全部保留的对话
        // （仍受 MAX_HISTORY=200 条持久化上限约束，避免 token 无界膨胀）
        unlimitedContext: process.env.CHAT_UNLIMITED_CONTEXT === 'true',
        // 采样温度（设置页「高级选项」可调，运行时由 POST /config 覆盖）
        temperature: envNumber(process.env.CHAT_TEMPERATURE, 0.75, 0, 2),
        // 最大输出 tokens。0 = 不传该参数，由模型自行决定（默认即 0）。
        maxTokens: envNumber(process.env.CHAT_MAX_TOKENS, 0, 0, 1_000_000),
        // 思考强度：空串 = 不传。仅对支持的推理模型生效，普通模型收到会 400。
        reasoningEffort: REASONING_EFFORTS.includes(process.env.CHAT_REASONING_EFFORT)
            ? process.env.CHAT_REASONING_EFFORT
            : '',
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
    /**
     * 记忆系统（core/memory/）：情节记忆（原始对话轮）+ 事实记忆（LLM 提取的持久信息）。
     * 检索双模式：
     *   embedding —— 语义向量检索（需配置嵌入 Key）
     *   keyword   —— BM25 风格关键词检索（无任何外部依赖）
     *   auto      —— 配置了嵌入 Key 且库里有向量时用 embedding，否则 keyword
     */
    memory: {
        // 情节记忆条数上限，超出丢最旧
        maxEpisodes: envNumber(process.env.MEMORY_MAX_EPISODES, 500, 10, 100000),
        retrieval: {
            mode: ['auto', 'embedding', 'keyword'].includes(process.env.MEMORY_RETRIEVAL_MODE)
                ? process.env.MEMORY_RETRIEVAL_MODE
                : 'auto',
            // 每轮注入的相关回忆条数
            topK: envNumber(process.env.MEMORY_RETRIEVAL_TOP_K, 3, 1, 20),
            // 语义模式：余弦相似度入选门槛（低于它的记忆视为无关）
            semanticThreshold: envNumber(process.env.MEMORY_SEMANTIC_THRESHOLD, 0.3, 0, 1),
            // 关键词模式：至少命中多少个查询词项才采用（bigram 单词命中噪音太大）
            keywordMinHits: envNumber(process.env.MEMORY_KEYWORD_MIN_HITS, 2, 1, 10),
            // recency 加分上限：score += recencyWeight * 2^(-ageDays/halfLife)
            recencyWeight: envNumber(process.env.MEMORY_RECENCY_WEIGHT, 0.15, 0, 1),
            recencyHalfLifeDays: envNumber(process.env.MEMORY_RECENCY_HALF_LIFE_DAYS, 14, 0.1, 3650),
            // 情绪染色权重：当前 PAD 与记忆快照相似度的加权（负效价时用 negative 档）
            emotionWeight: envNumber(process.env.MEMORY_EMOTION_WEIGHT, 0.2, 0, 1),
            emotionWeightNegative: envNumber(process.env.MEMORY_EMOTION_WEIGHT_NEG, 0.4, 0, 1),
        },
        // 检索结果去重：相邻入选记忆相似度超过该值视为重复丢弃（语义用余弦，关键词用 bigram Jaccard）
        dedupSimilarity: envNumber(process.env.MEMORY_DEDUP_SIMILARITY, 0.92, 0.5, 1),
        // 写入去重：新情节与既有情节相似度超过该值直接不入库（防重复对话刷库）
        dedupWriteSimilarity: envNumber(process.env.MEMORY_DEDUP_WRITE_SIMILARITY, 0.95, 0.5, 1),
        // 去抖写盘间隔：情节写入后延迟合并落盘，避免每轮同步全量重写大 JSON
        flushDebounceMs: envNumber(process.env.MEMORY_FLUSH_DEBOUNCE_MS, 2000, 100, 60000),
        facts: {
            // 事实记忆层总开关（每轮对话后用主 LLM 提取持久信息）
            enabled: process.env.MEMORY_FACTS_ENABLED !== 'false',
            // 事实库上限：超出先丢重要度最低、再丢最旧
            maxFacts: envNumber(process.env.MEMORY_MAX_FACTS, 100, 10, 10000),
            // 每轮注入 prompt 的事实条数（按重要度→最新排序取前 N）
            injectTopN: envNumber(process.env.MEMORY_FACTS_INJECT_TOP_N, 12, 1, 50),
            // 提取用的模型：空 = 复用主对话模型
            extractModel: process.env.MEMORY_EXTRACT_MODEL || '',
            // 提取调用的采样温度（低温保证 JSON 输出稳定）
            extractTemperature: envNumber(process.env.MEMORY_EXTRACT_TEMPERATURE, 0.2, 0, 2),
        },
    },
};
