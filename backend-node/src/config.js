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
            // 每条「相关回忆」注入前的字符上限：episode 文本是 "User: …\nXiao Ai: …"
            // 的原文，用户单条最长可达 chat.maxMessageLength(8000)，不设上限时
            // 3 条回忆就能把整段人设挤出请求（审计 CORE-09 的预算护栏）
            injectEpisodeMaxChars: envNumber(process.env.MEMORY_INJECT_EPISODE_MAX_CHARS, 300, 20, 4000),
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
