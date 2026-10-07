import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
// REQ-04 事件层常量块的真源仍在 core/triggerEvents.js（T03 为避开并行任务的
// 文件冲突放在那里）。这里 import 进来 re-export 进统一 config，落实「所有运行时数值
// 统一从 config 读」的项目铁律，同时**不破坏 triggerEvents.js 的既有导出**（测试依赖它）。
import { TRIGGER_REGISTRY_CONFIG, TRIGGER_THRESHOLDS } from './core/triggerEvents.js';

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

// 显式 re-export：便于调用方从 config.js 一处拿到事件层配置块，无需再 import triggerEvents。
export { TRIGGER_REGISTRY_CONFIG };

export const config = {
    // 端口也走 envNumber：`Number('abc') || 8000` 恰好也能兜住，但 `PORT=0` 会被
    // 悄悄换成 8000、`PORT=999999` 会一路传到 listen 才报错。统一成有范围、会裁剪的一种口径。
    port: envNumber(process.env.PORT, 8000, 1, 65535),
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
        // 单次请求只允许一个音频部件（多部件会让临时文件在磁盘上堆积）
        maxFiles: 1,
    },
    /**
     * 语音（TTS/ASR）入参边界（审计 HTTP-16）。
     * maxInputChars = 真正送去朗读的字数（超出截断，长文朗读比整体失败更贴合用户预期）；
     * maxRequestChars = 请求体允许的上限（超出直接 400，不再让一个 400 万字的 POST
     *   走完 JSON 解析再截断）。
     */
    tts: {
        maxInputChars: envNumber(process.env.TTS_MAX_INPUT_CHARS, 4000, 100, 8192),
        maxRequestChars: envNumber(process.env.TTS_MAX_REQUEST_CHARS, 20000, 100, 200000),
    },
    staticDir: path.join(BACKEND_ROOT, 'static'),
    /**
     * 档案导出/导入与自动快照（B5-12）。
     * `dir` 默认**留空**：由 core/backup.js 在首次使用时按「当前数据目录里的 backups/ 子目录」推导。
     * 为什么必须跟着数据目录：测试与多实例都用 AI_GIRLFRIEND_DATA_DIR 隔离，跟着走才能
     * 让自动快照永远落进那个沙盒。早先用「数据目录的上一级/backups」推导时，跑一次测试
     * 就在仓库里留下了几份快照（内容当然是测试夹具，但位置完全出人意料、也没人清理）。
     */
    backup: {
        dir: process.env.AI_GIRLFRIEND_BACKUP_DIR ? path.resolve(process.env.AI_GIRLFRIEND_BACKUP_DIR) : null,
        // 自动快照保留份数（按目录名时间序，手动导出的档案文件不计数）
        keep: envNumber(process.env.BACKUP_KEEP, 10, 1, 100),
        // 单个档案文件大小上限（MB）：这是「一个人的全部对话」，几 MB 已很多
        maxExportMb: envNumber(process.env.BACKUP_MAX_EXPORT_MB, 64, 1, 512),
    },
    /**
     * 日志策略（审计 HTTP-19）。
     * 内心独白 / 模型 CoT / metadata 原文默认**不进日志**：那是这个应用里最私密的文本，
     * 却会长期躺在 dev.log 里。要排障请显式设 `AI_GIRLFRIEND_DEBUG=true`。
     */
    logging: {
        verbose: process.env.AI_GIRLFRIEND_DEBUG === 'true',
        textPreviewChars: envNumber(process.env.LOG_PREVIEW_CHARS, 120, 0, 2000),
        // 对话请求队列上限：超出直接 429，而不是让请求无限排队把进程拖死
        maxChatQueue: envNumber(process.env.CHAT_QUEUE_MAX, 4, 1, 64),
    },
    /**
     * 自由文本入库前的长度上限（审计 HTTP-18）。
     * 这些字段会被**每一轮**对话注入 prompt：一条 100KB 的任务标题存进 tasks.json 之后，
     * 每一轮的 prefill 都要多读 100KB，而且永远没有出口 —— 所以必须在写入时就拦下，
     * 光靠注入端截断等于让脏数据永久占着磁盘与内存。
     */
    textLimits: {
        taskTitle: envNumber(process.env.LIMIT_TASK_TITLE, 200, 10, 2000),
        taskDescription: envNumber(process.env.LIMIT_TASK_DESCRIPTION, 2000, 10, 20000),
        factContent: envNumber(process.env.LIMIT_FACT_CONTENT, 500, 10, 5000),
        factCategory: envNumber(process.env.LIMIT_FACT_CATEGORY, 40, 2, 200),
        nickname: envNumber(process.env.LIMIT_NICKNAME, 50, 1, 200),
    },
    chat: {
        // 单条消息长度上限，防止异常超长输入打爆 LLM 上下文
        maxMessageLength: 8000,
        // 发送给 LLM 的最近历史条数。持久化仍保留 maxHistoryEntries 全量，
        // 但 prompt 只带最近这些条，显著降低 prefill 开销与生成耗时。
        maxPromptHistory: envNumber(process.env.CHAT_MAX_PROMPT_HISTORY, 30, 1, 500),
        /**
         * 持久化的对话条数上限（B8-7：修「设置项骗人」）。
         * 旧值 200 是硬编码常量，而设置页的 maxPromptHistory 能选到 500、
         * 「无限上下文」的注释也声称受它约束 —— 于是用户选 500 实际只有 199 生效。
         * 现在把它做成真配置，并且默认值 >= maxPromptHistory 的可调上限（500），
         * 界面那几个档位从此是真的。代价是 state.json 更大、每轮写盘更慢，
         * 所以给了 envNumber 的上限 5000 而不是无界。
         */
        maxHistoryEntries: envNumber(process.env.CHAT_MAX_HISTORY_ENTRIES, 500, 10, 5000),
        // 无限上下文：true = 忽略 maxPromptHistory，每次请求带上全部保留的对话
        // （仍受 chat.maxHistoryEntries 条数上限 + prompt.budget.maxHistoryChars 字符上限
        //   双重约束，token/字符都不会无界膨胀 —— B8-3/B8-6）
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
        timeoutMs: envNumber(process.env.CHAT_TIMEOUT_MS, 60_000, 1_000, 600_000),
        // 响应里回传「思考」字段（inner_thought 人设独白 / model_reasoning 原生思考）的
        // 最大字符数，超出截断。原生 CoT 可能上万字，不宜整个塞进 HTTP 响应。
        thinkingMaxChars: envNumber(process.env.CHAT_THINKING_MAX_CHARS, 2000, 100, 100_000),
        /**
         * 入库字符上限（B8-4，审计 CORE-20「history 的单条长度无上限」）。
         * maxMessageLength 只管**用户**消息，模型侧一直是裸的：max_tokens 默认 0（不传），
         * 一次 2 万字的回复会原样进 state.json 并在之后**每一轮**回灌进 prompt，
         * 而 HTTP 层的 thinkingMaxChars 只截响应、不截磁盘 —— 于是脏数据永久留着。
         * 这里截断而不是丢弃：正文是用户要看的，截总比没有好（丢弃等于吞掉回复）。
         */
        maxAssistantChars: envNumber(process.env.CHAT_MAX_ASSISTANT_CHARS, 4000, 100, 100_000),
        // 内心独白入库上限：超过这个长度基本是模型把 CoT 灌进了 <monologue>
        maxThoughtChars: envNumber(process.env.CHAT_MAX_THOUGHT_CHARS, 2000, 100, 100_000),
    },
    /**
     * Prompt 注入预算（B8-3，审计 CORE-09「没有任何 token/字符预算护栏」）。
     * 每条块各自有「单条上限」（retrieval.injectEpisodeMaxChars 等），
     * 这里补的是**总量**与**总量超限后的裁剪顺序**：低价值的块先缩、先丢，
     * 人设与【回复要求】这类核心块永不丢（服务端从头部静默截断时最先掉的就是它们）。
     * 单位一律是字符（不是 token）：本地应用没有可靠的 tokenizer，
     * 而字符数是可断言、可复现的下界，中文场景下约 1 字 ≈ 1 token 偏保守。
     */
    prompt: {
        budget: {
            // 【已知事实】+【相关回忆】整段上限
            maxMemoryChars: envNumber(process.env.PROMPT_MAX_MEMORY_CHARS, 2400, 200, 200_000),
            // 【我们的故事】整段上限（叙事层自己还有 injectMaxChars 的单段上限，这是总量兜底）
            maxNarrativeChars: envNumber(process.env.PROMPT_MAX_NARRATIVE_CHARS, 1200, 100, 200_000),
            // 【任务清单】+ 任务意图指令合计上限
            maxTaskChars: envNumber(process.env.PROMPT_MAX_TASK_CHARS, 2400, 100, 200_000),
            // 整条动态 system 块上限（含【回复要求】等固定骨架）
            maxSystemChars: envNumber(process.env.PROMPT_MAX_SYSTEM_CHARS, 12_000, 500, 200_000),
            // 对话窗口（历史消息正文）整段上限：unlimitedContext 也受它约束
            maxHistoryChars: envNumber(process.env.PROMPT_MAX_HISTORY_CHARS, 24_000, 500, 2_000_000),
            // 一次请求全部消息的总上限（最后一道闸：只裁历史窗口，绝不动人设/system/本轮提问）
            maxRequestChars: envNumber(process.env.PROMPT_MAX_REQUEST_CHARS, 60_000, 2000, 4_000_000),
        },
    },
    /**
     * 待办清单容量（B8-4，审计 CORE-20）。
     * maxActive = tasks.json 里的活跃条目上限；已完成的条目移出主文件、
     * 归档到 tasks_completed.json（cap = maxCompleted，超出丢最旧）。
     * 为什么分文件而不是加分区：tasks.json 的既有形状是**裸数组**（档案导入的
     * 种子数据、老用户磁盘上的文件都是），改成对象会让每一条读取路径都要判形状。
     */
    tasks: {
        maxActive: envNumber(process.env.TASKS_MAX_ACTIVE, 60, 5, 1000),
        maxCompleted: envNumber(process.env.TASKS_MAX_COMPLETED, 50, 1, 2000),
    },
    /**
     * 模型调用计数（B1-2）。目的是**排障与理解行为**：
     * 一轮对话到底调了几次模型（主对话/事实提取/叙事抽取/嵌入/主动消息/TTS/ASR），
     * 以前只能靠猜。窗口是滚动的、内存有界（环形缓冲，超容量丢最旧）。
     */
    llmCalls: {
        windowMs: envNumber(process.env.LLM_CALLS_WINDOW_MS, 60 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
        // 时间戳环形缓冲容量：单人应用每轮最多 ~5 次调用，512 条足够覆盖 100 轮
        maxEvents: envNumber(process.env.LLM_CALLS_MAX_EVENTS, 512, 16, 100_000),
    },
    /**
     * 情绪模型（EmotionEngine）的输入约束。prompt 里已经告诉模型 emotion_delta 是
     * −0.5~+0.5，但**代码必须自己守住**：PAD 同时驱动风格指南、主动消息情绪闸门与
     * 记忆情绪染色，被模型一句话拉满就等于让模型自己开关这些行为（审计 CORE-05/CORE-13）。
     */
    emotion: {
        // LLM 单轮每轴的最大幅度（超出即裁剪并记 warning）
        llmAxisCap: envNumber(process.env.EMOTION_LLM_AXIS_CAP, 0.5, 0, 1),
        // 词表与 LLM 两路的混合权重：同一轮里同一个情绪事件只该被记一次，
        // 所以是加权混合而不是先后各 apply 一次（旧写法约 2 倍幅度）
        keywordWeight: envNumber(process.env.EMOTION_KEYWORD_WEIGHT, 0.5, 0, 1),
        llmWeight: envNumber(process.env.EMOTION_LLM_WEIGHT, 0.5, 0, 1),
        /**
         * 混合后再加共振项的**单轮总上限**（逐轴）。
         * 词表通道原本就是 P±0.5 / A±0.4 / D±0.3，加上共振之后允许略高一点，
         * 但绝不能没有上限：一轮之内把 PAD 拉满等于让「他今天心情不好」
         * 直接 trip 她的冷暴力判定（审计 CORE-05 守的是同一条不变量）。
         */
        totalAxisCap: {
            P: envNumber(process.env.EMOTION_TOTAL_P_CAP, 0.6, 0, 1),
            A: envNumber(process.env.EMOTION_TOTAL_A_CAP, 0.5, 0, 1),
            D: envNumber(process.env.EMOTION_TOTAL_D_CAP, 0.4, 0, 1),
        },
        /**
         * 情绪共振（REQ-02）：他的情绪改变她自己的 PAD。
         * 纯函数与阶段系数表在 core/emotionResonance.js，这里只放可调数值。
         */
        resonance: {
            // 关 = 她的增量与改造前逐轴一致（关闭态安全）
            enabled: process.env.EMOTION_RESONANCE_ENABLED !== 'false',
            // 全局强度：共振增量 = strength × 阶段系数 × 他的强度 × 各通道系数
            strength: envNumber(process.env.EMOTION_RESONANCE_STRENGTH, 0.35, 0, 2),
            // 他的情绪强度低于此值就不打扰她的情绪（中性噪声不该传染）
            minIntensity: envNumber(process.env.EMOTION_RESONANCE_MIN_INTENSITY, 0.25, 0, 1),
            // 唤醒传染系数：他激动/焦急，她的 A 跟着抬
            arousalContagion: envNumber(process.env.EMOTION_RESONANCE_AROUSAL, 0.4, 0, 2),
            // 担心系数：他越低落，她越提心吊胆（A 上升，与「他也一起低沉」是两回事）
            concernArousal: envNumber(process.env.EMOTION_RESONANCE_CONCERN, 0.5, 0, 2),
            // 让步系数：他低落时她放低姿态（D 下移）
            yieldD: envNumber(process.env.EMOTION_RESONANCE_YIELD_D, 0.4, 0, 2),
            // 共振项自己的逐轴上限（在总上限之前先裁一道）
            axisCap: {
                P: envNumber(process.env.EMOTION_RESONANCE_P_CAP, 0.2, 0, 1),
                A: envNumber(process.env.EMOTION_RESONANCE_A_CAP, 0.15, 0, 1),
                D: envNumber(process.env.EMOTION_RESONANCE_D_CAP, 0.15, 0, 1),
            },
        },
        /**
         * 主动消息的情绪回灌（B6-α③）：她主动找他说话这件事本身要让她有感觉。
         * 增量表在 core/proactiveTypes.js 的各类型 emotionFeedback 字段（唯一事实源），
         * 这里只管开关与衰减系数。
         */
        proactiveFeedback: {
            // 关 = 主动消息完全不改动她的情绪（与改造前一致）
            enabled: process.env.PROACTIVE_EMOTION_ENABLED !== 'false',
            // 惯性：与 applyDelta 同一口径，实际位移 = delta × (1 - inertia)
            inertia: envNumber(process.env.PROACTIVE_EMOTION_INERTIA, 0.55, 0, 0.95),
        },
    },
    /**
     * 记忆检索用的 embedding。
     * 这里的承诺（B1-4 之后才是真的）：「慢/坏就快速降级」——连续失败达到阈值即熔断，
     * 冷却期内 available=false，检索直接走关键词，不再每轮白等两次 timeout。
     * cacheMax 是**同一轮 query 嵌入只发一次网络往返**的有界 LRU（B1-5）：
     * 这是延迟修复（首字更快），不是成本修复（省 token）——一次命中省下的是
     * 一整趟 2500 ms 上限的往返，用户等的是第一个字，不是账单。
     */
    embedding: {
        timeoutMs: envNumber(process.env.EMBEDDING_TIMEOUT_MS, 2500, 200, 60_000),
        maxRetries: 0,
        // 熔断：连续失败多少次后打开（打开期间不再发起任何嵌入调用）
        failureThreshold: envNumber(process.env.EMBEDDING_FAILURE_THRESHOLD, 3, 1, 50),
        // 熔断冷却时长：到期后自动半开，下一次调用当探针（成功即清零）
        cooldownMs: envNumber(process.env.EMBEDDING_COOLDOWN_MS, 5 * 60 * 1000, 1000, 6 * 60 * 60 * 1000),
        // (model, text) → 向量的 LRU 容量。0 = 关掉 memoize
        cacheMax: envNumber(process.env.EMBEDDING_CACHE_MAX, 128, 0, 4096),
    },
    /**
     * 记忆系统（core/memory/）：情节记忆（原始对话轮）+ 事实记忆（LLM 提取的持久信息）。
     * 检索双模式：
     *   embedding —— 语义向量检索（需配置嵌入 Key）
     *   keyword   —— BM25 风格关键词检索（无任何外部依赖）
     *   auto      —— 配置了嵌入 Key 且库里有向量时用 embedding，否则 keyword
     */
    memory: {
        /**
         * 情节记忆条数上限，超出丢最旧。
         * 上限（envNumber 的 max）从 100000 收到 5000（B8-4 / 审计 CORE-08）：
         * 10 万条 × 1024 维向量的 memory.json 是 3 GB 级的一次性同步写盘，
         * 会把进程按在事件循环上；5000 条在 B8-2 的紧凑编码下约 29 MB
         * （默认 500 条约 2.9 MB），并且走去抖写盘而不是每轮同步重写。
         * 默认仍是 500 —— 对单人应用足够，想要更长的回忆线请显式调高，
         * 代价是每轮检索与落盘更慢。
         */
        maxEpisodes: envNumber(process.env.MEMORY_MAX_EPISODES, 500, 10, 5000),
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
            // 每条「相关回忆」注入前的字符上限：episode 文本是 "User: …\nXiao Ai: …"
            // 的原文，用户单条最长可达 chat.maxMessageLength(8000)，不设上限时
            // 3 条回忆就能把整段人设挤出请求（审计 CORE-09 的预算护栏）
            injectEpisodeMaxChars: envNumber(process.env.MEMORY_INJECT_EPISODE_MAX_CHARS, 300, 20, 4000),
            /**
             * 查询词项上限（B8-1）。8000 字的合法长消息会切出上千个 bigram 词项，
             * 而 df/idf 是按「每词 × 每篇」算的 —— 不截查询，一条长消息就能把
             * 请求路径按住几秒（审计 CORE-07 的实测：91 词 = 2888 ms）。
             * ⚠️ 只截**查询**，绝不截**文档**：文档侧的分词与 df 是完整索引，
             * 截查询只是丢掉最后一个（最远、信息量最低的）词项，召回排序不受影响。
             */
            maxQueryTerms: envNumber(process.env.MEMORY_RETRIEVAL_MAX_QUERY_TERMS, 64, 4, 1024),
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
            // 每条事实注入前的字符上限（事实由 LLM 生成，可能超长）
            injectFactMaxChars: envNumber(process.env.MEMORY_FACTS_INJECT_CHAR_LIMIT, 120, 20, 2000),
            /**
             * 后台提取队列的**合并**阈值（B1-6，审计 CORE-18）。
             * 积压超过 mergeThreshold 轮时，不再一轮一次调模型，而是把最旧的
             * 若干轮**合并成一次提取**——合并而不是丢弃：一次不落地扔掉用户的原话，
             * 那些信息就永久丢了（这条链路的产出是长期事实库，丢一轮 = 丢一辈子）。
             * mergeBatchMax = 单次合并的最多轮数（输入长度上限，避免一次塞进 200 轮）。
             */
            mergeThreshold: envNumber(process.env.MEMORY_FACTS_MERGE_THRESHOLD, 3, 1, 50),
            mergeBatchMax: envNumber(process.env.MEMORY_FACTS_MERGE_BATCH_MAX, 12, 1, 50),
            // 提取用的模型：空 = 复用主对话模型
            extractModel: process.env.MEMORY_EXTRACT_MODEL || '',
            // 提取调用的采样温度（低温保证 JSON 输出稳定）
            extractTemperature: envNumber(process.env.MEMORY_EXTRACT_TEMPERATURE, 0.2, 0, 2),
        },
    },
    /**
     * 用户情绪识别通道（REQ-01，docs/companion-upgrade/02-architecture.md §2.1）。
     * 混合方案：词表优先 + 复用主对话 <metadata> 的 user_emotion 字段做 LLM 校准，
     * 不新增任何 LLM 调用。所有阈值/容量/权重集中于此，模块内禁止魔法数字。
     */
    userEmotion: {
        // 总开关：关 = 完全退回改造前行为（不分析、不注入、不落盘）
        enabled: process.env.USER_EMOTION_ENABLED !== 'false',
        // 时间线滑动窗口容量（timeline cap）
        timelineMax: envNumber(process.env.USER_EMOTION_TIMELINE_MAX, 50, 5, 1000),
        // 融合权重：词表结果权重
        lexiconWeight: envNumber(process.env.USER_EMOTION_LEXICON_WEIGHT, 0.4, 0, 1),
        // 融合权重：LLM 结果权重（高于词表；LLM 需过置信阈值才被采信）
        llmWeight: envNumber(process.env.USER_EMOTION_LLM_WEIGHT, 0.6, 0, 1),
        // LLM 结果被采信的最低置信度（低于它则忽略 LLM，纯用词表）
        llmConfidenceThreshold: envNumber(process.env.USER_EMOTION_LLM_CONFIDENCE_THRESHOLD, 0.5, 0, 1),
        // 显著转折判定阈值：|Δvalence| 超过它视为情绪发生显著转折（供 REQ-04 消费）
        turnThreshold: envNumber(process.env.USER_EMOTION_TURN_THRESHOLD, 0.35, 0, 2),
        // 近期趋势窗口（毫秒），默认 30 分钟
        trendWindowMs: envNumber(process.env.USER_EMOTION_TREND_WINDOW_MS, 30 * 60 * 1000, 1000, 86400000),
        // 趋势「下滑」判定：窗口内 valence 斜率低于它视为下滑
        decliningSlope: envNumber(process.env.USER_EMOTION_DECLINING_SLOPE, -0.05, -1, 0),
        // timeline 落盘去抖间隔（毫秒），参照 MemoryStore.flushDebounceMs，禁止每轮同步全量重写
        flushDebounceMs: envNumber(process.env.USER_EMOTION_FLUSH_DEBOUNCE_MS, 2000, 100, 60000),
        // excerpt 截断长度（仅用于调试/前端展示，不参与分析）
        excerptMax: envNumber(process.env.USER_EMOTION_EXCERPT_MAX, 40, 0, 500),
        // 否定判定的邻域窗口：情绪词**前 N 个字符**内出现否定词才算否定该词。
        // 0 = 退化成「永不否定」；过大等于整句判定（旧行为，会把
        // 「今天不开会…超开心」读成低落）。见 core/userEmotionLexicon.js
        negationWindow: envNumber(process.env.USER_EMOTION_NEGATION_WINDOW, 4, 0, 20),
    },
    /**
     * 共同经历叙事层（REQ-03，docs/companion-upgrade/02-architecture.md §2.3）。
     * 从 episodes 派生「我们的故事」，独立落 data/narrative.json，不回改 MemoryStore schema。
     * 所有阈值/容量/注入参数集中于此，事件类型/prompt 常量在 narrative/narrativeTypes.js。
     */
    narrative: {
        // 总开关：关 = 完全退回改造前行为（不抽取、不注入、不落盘）
        enabled: process.env.NARRATIVE_ENABLED !== 'false',
        // 叙事库上限：超出先丢重要度最低、再丢最旧
        maxNarratives: envNumber(process.env.NARRATIVE_MAX, 60, 5, 10000),
        // 去抖写盘间隔（参照 MemoryStore.flushDebounceMs），禁止每轮同步全量重写
        flushDebounceMs: envNumber(process.env.NARRATIVE_FLUSH_DEBOUNCE_MS, 2000, 100, 60000),
        // ---- 三层节流参数（三者全满足才调 LLM）----
        // ① 轮次节流：每 N 轮尝试一次
        extractEveryNTurns: envNumber(process.env.NARRATIVE_EXTRACT_EVERY_N_TURNS, 5, 1, 1000),
        // ② 时间窗节流：距上次抽取的最小间隔（毫秒），默认 10 分钟
        minIntervalMs: envNumber(process.env.NARRATIVE_MIN_INTERVAL_MS, 10 * 60 * 1000, 1000, 86400000),
        // ③ 信号节流：好感度单轮跃迁达到该幅度即视为关键信号
        affinityJumpThreshold: envNumber(process.env.NARRATIVE_AFFINITY_JUMP_THRESHOLD, 2, 0, 100),
        // 抽取 LLM 调用参数（低温保证 JSON 稳定）
        extractModel: process.env.NARRATIVE_EXTRACT_MODEL || '',
        extractTemperature: envNumber(process.env.NARRATIVE_EXTRACT_TEMPERATURE, 0.2, 0, 2),
        extractMaxTokens: envNumber(process.env.NARRATIVE_EXTRACT_MAX_TOKENS, 800, 100, 8000),
        // 抽取结果一次最多应用的 add 条数（防单轮批量灌库）
        maxAddPerExtract: envNumber(process.env.NARRATIVE_MAX_ADD_PER_EXTRACT, 3, 1, 20),
        // ---- 注入参数（克制）----
        // 每轮注入的相关叙事条数（topK）
        injectTopK: envNumber(process.env.NARRATIVE_INJECT_TOP_K, 3, 1, 10),
        // 注入段整体字符上限（默认 300 字，超出按条丢弃）
        injectMaxChars: envNumber(process.env.NARRATIVE_INJECT_MAX_CHARS, 300, 50, 2000),
        // 单条注入条目字符上限（超出截断）
        injectEntryMaxChars: envNumber(process.env.NARRATIVE_INJECT_ENTRY_MAX_CHARS, 80, 20, 500),
        /**
         * 联想召回（F-3）的条数上限：本轮用户话里命中「专属梗 / 线索词」时，
         * 最多额外带几条故事进注入段（排在检索结果前面）。
         * = 0 等于关掉联想注入（字段照旧落盘，只是不参与召回）。
         */
        associationMaxInject: envNumber(process.env.NARRATIVE_ASSOCIATION_MAX_INJECT, 2, 0, 5),
        /**
         * 主动回顾的冷却窗（B6-α④）：一条故事提起后多久之内不再拿出来讲。
         * 旧做法是在内存里记一个 `_recentStoryIds` 集合（重启即失忆，
         * 而且 getRandomStory 是随机重掷，小池子里几乎每次都掷回同一条），
         * 现在改为从**已落盘的 lastRecalledAt** 派生，重启也拦得住复读。
         */
        recallCooldownMs: envNumber(
            process.env.NARRATIVE_RECALL_COOLDOWN_MS,
            3 * 24 * 60 * 60 * 1000,
            60 * 1000,
            30 * 24 * 60 * 60 * 1000
        ),
        // 语义检索模式：余弦入选门槛
        semanticThreshold: envNumber(process.env.NARRATIVE_SEMANTIC_THRESHOLD, 0.3, 0, 1),
        // 关键词检索模式：至少命中的查询词项数（叙事池小、注入已按 topK+重要度收敛，
        // 门槛取 1 可让短 query 也能召回，避免小池子下检索恒空）
        keywordMinHits: envNumber(process.env.NARRATIVE_KEYWORD_MIN_HITS, 1, 1, 10),
        // 写入去重：新叙事与既有叙事嵌入余弦超过该值视为重复（标题包含判定另有时刻生效）
        dedupWriteSimilarity: envNumber(process.env.NARRATIVE_DEDUP_WRITE_SIMILARITY, 0.92, 0.5, 1),
        // ---- 纪念日查询（REQ-04 触发源）----
        // 纪念日**查询窗**：未来多少天内的纪念日会被挑出来发成事件。
        // 默认值取自 triggerEvents 的 TRIGGER_THRESHOLDS.anniversary.queryWithinDays（唯一真源），
        // 与「主动窗」announceWithinDays 是两个不同概念，别再合并成一个数字。
        anniversaryWithinDays: envNumber(
            process.env.NARRATIVE_ANNIVERSARY_WITHIN_DAYS,
            TRIGGER_THRESHOLDS.anniversary.queryWithinDays, 0, 365),
    },
    /**
     * 主动消息（她主动找他说话）的运行时参数。
     * 类型目录与冷却/配额在 core/proactiveTypes.js / ProactiveEngine 的档位表里，
     * 这里只放「一次生成要带多少上下文」这类可调数值（B8-6：旧写法是代码里的裸 10）。
     */
    proactive: {
        // 送给模型的最近对话条数（成对裁剪，与主对话同一实现）
        historyEntries: envNumber(process.env.PROACTIVE_HISTORY_ENTRIES, 10, 1, 200),
    },
    /**
     * 事件层（REQ-04，docs/companion-upgrade/02-architecture.md §2.4）。
     * 事件总线 + 触发源注册表 + 事件候选队列的统一配置入口。
     *
     * 收敛方式：直接 re-export core/triggerEvents.js 的 TRIGGER_REGISTRY_CONFIG（唯一事实源），
     * 使「所有运行时数值统一从 config 读」——调用方既可 `config.triggerRegistry.enabled`
     * 也可继续 import triggerEvents 的常量，两者指向同一对象、不会漂移。
     * enabled 默认值与 T03 保持一致（env 未设 = true；'false' = 一键回退纯轮询）。
     */
    triggerRegistry: TRIGGER_REGISTRY_CONFIG,
};
