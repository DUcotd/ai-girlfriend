/**
 * AiGirlfriend - 核心编排器（重构版）
 *
 * 职责收敛为：
 * 1. 对话编排（记忆检索 → 上下文构建 → LLM 调用 → 元数据解析 → 状态更新）
 * 2. 配置与持久化状态管理（affinity / nickname / history）
 *
 * prompt 资源在 ./prompts/，好感度规则在 ./affinityRules.js，持久化在 ../utils/jsonStore.js
 */
import OpenAI from 'openai';
import dotenv from 'dotenv';
import Memory from './Memory.js';
import TaskManager, { REMINDER_KIND, REMINDER_FIELD } from './TaskManager.js';
import EmotionEngine from './EmotionEngine.js';
import UserEmotionEngine from './UserEmotionEngine.js';
import { TRIGGER_EVENTS } from './triggerEvents.js';
import NarrativeStore from './narrative/NarrativeStore.js';
import NarrativeExtractor from './narrative/NarrativeExtractor.js';
import NarrativeRetriever from './narrative/NarrativeRetriever.js';
import { EmbeddingClient } from './memory/EmbeddingClient.js';
import { normalizeText as normalizeForDedup } from './memory/textSim.js';
import { setEventLayerEnabled, isEventLayerEnabled } from './TriggerRegistry.js';
import PersonalityDrift from './PersonalityDrift.js';
import AffinityEngine from './AffinityEngine.js';
import { PERSONA_SYSTEM_PROMPT, buildSystemContext } from './prompts/systemPrompt.js';
import { buildNarrativeContext } from './prompts/narrativePrompt.js';
import { buildRelationshipContext } from './prompts/relationshipContext.js';
import { buildProactivePrompt, buildProactiveDirective, buildProactivePersonaDirective } from './prompts/proactivePrompts.js';
import { buildTaskContextText, buildTaskActionInstruction, buildTaskNudgeText, pickNudgeTasks } from './prompts/taskPrompt.js';
import { executeTaskAction } from './taskActions.js';
import { dataPath, readJson, writeJson } from '../utils/jsonStore.js';
import { config, REASONING_EFFORTS } from '../config.js';
import { createStreamFilter, splitDelta, extractReasoning, parseFullText } from './streamFilter.js';

dotenv.config();

const STATE_FILE = 'state.json';
const MAX_HISTORY = 200;

/**
 * 对话内提及同一任务的防抖窗口（P1-2）。
 * 「每次注入软提醒就标记」会让用户在同一场对话里被同一条任务反复念叨。
 */
const DIALOG_MENTION_DEBOUNCE_MS = 24 * 60 * 60 * 1000;

class AiGirlfriend {
    constructor(config = {}) {
        this.statePath = dataPath(STATE_FILE);
        this.systemPrompt = PERSONA_SYSTEM_PROMPT;

        // 默认值与前端 lib/providers.ts 的 DEFAULT_PROVIDER 保持一致（商汤 Sensenova）。
        // 改这里就要同步改前端，否则前后端默认服务商会打架。
        this.apiKey = null;
        this.baseUrl = "https://token.sensenova.cn/v1";
        this.modelName = "sensenova-6.8-flash-lite";
        this.embeddingApiKey = null;
        this.embeddingBaseUrl = null;
        this.embeddingModelName = null;

        // 好感度是自持状态的引擎（落 data/affinity_state.json），本类不再自己持有。
        // 只通过下面的 get affinity() 暴露只读视图，写操作一律走 this.affinityEngine。
        this.affinityEngine = new AffinityEngine();
        this.nickname = "你";
        this.history = [];

        this._loadState();

        if (config.apiKey) this.apiKey = config.apiKey;
        if (config.baseUrl) this.baseUrl = config.baseUrl;
        if (config.modelName) this.modelName = config.modelName;
        if (config.embeddingApiKey) this.embeddingApiKey = config.embeddingApiKey;
        if (config.embeddingBaseUrl) this.embeddingBaseUrl = config.embeddingBaseUrl;
        if (config.embeddingModelName) this.embeddingModelName = config.embeddingModelName;

        if (Object.keys(config).length > 0) {
            this._saveState();
        }

        if (this.history.length === 0) {
            this.history = [{ role: "system", content: this.systemPrompt }];
        }

        this.memory = new Memory("memory_db", {
            apiKey: this.apiKey,
            baseUrl: this.baseUrl,
            embeddingApiKey: this.embeddingApiKey,
            embeddingBaseUrl: this.embeddingBaseUrl,
            embeddingModelName: this.embeddingModelName,
            // 事实提取复用主对话客户端；getter 形式保证配置热更新后拿到的是当前实例
            getChatClient: () => (this.openai ? { client: this.openai, model: this.modelName } : null),
        });

        this.emotionEngine = new EmotionEngine();
        // 用户情绪识别通道（REQ-01）：与 emotionEngine 解耦，只描述「用户」的情绪。
        this.userEmotionEngine = new UserEmotionEngine();
        // 共同经历叙事层（REQ-03，I7）：从 episodes 派生「我们的故事」，独立落 narrative.json。
        // 复用主对话客户端（getChatClient 与 memory 同款，配置热更新后拿到当前实例）。
        this.narrativeStore = new NarrativeStore();
        this.narrativeExtractor = new NarrativeExtractor({
            getClient: () => (this.openai ? { client: this.openai, model: this.modelName } : null),
            store: this.narrativeStore,
        });
        // 叙事检索复用记忆层的嵌入通道（同一套 embedding Key）；无嵌入时自动走关键词。
        this.narrativeRetriever = new NarrativeRetriever({
            store: this.narrativeStore,
            embedding: this.memory?.embedding || null,
        });
        // 叙事抽取串行队列 + 轮次计数 + 世代号（清空后作废在途抽取，防复活）
        this._narrativeQueue = Promise.resolve();
        this._narrativeGeneration = 0;
        this._turnCount = 0;
        this._recentStoryIds = new Set();
        this.personalityDrift = new PersonalityDrift();
        console.log(`[AiGirlfriend] Emotion: ${this.emotionEngine.getEmotionLabel()}, Personality: ${this.personalityDrift.getDominantTraits().join(', ')}`);

        this.openai = null;
        this._chatQueue = Promise.resolve();
        // REQ-04 事件层（I16）：由 container.js 通过 attachEventBus() 注入；
        // 缺省为 null 时所有发布点静默 no-op（emit 走可选链），保证未装配事件层时零行为变更。
        this.eventBus = null;
        // 触发源注册表引用（可选，container 通过 attachTriggerRegistry 注入）：
        // 仅为 resetAll 能一并清空事件队列/冷却/去重标记；未注入时跳过该步，行为同改造前。
        this.triggerRegistry = null;
        if (this.apiKey) {
            this.initOpenAI();
        }
    }

    /**
     * 注入事件总线（REQ-04，容器装配时调用）。
     * 事件发布全部走 _emitEvent()，未注入时为空操作，绝不抛错、绝不阻塞主链路。
     * @param {import('./EventBus.js').EventBus} bus
     */
    attachEventBus(bus) {
        this.eventBus = bus || null;
        return this.eventBus;
    }

    /**
     * 注入触发源注册表引用（REQ-04，容器装配时调用）。
     * 仅用于 resetAll() 一并清空事件队列/冷却/去重标记；不注入时该步自动跳过，
     * 保证「未装配事件层」的行为与改造前一致。
     * @param {object} registry - TriggerRegistry 实例（需有 reset()）
     */
    attachTriggerRegistry(registry) {
        this.triggerRegistry = registry || null;
        return this.triggerRegistry;
    }

    /**
     * 安全发布一个业务事件（REQ-04）。事件层未装配 / emit 抛错都只记日志，
     * 绝不影响调用方（对照 I16 的低风险约束）。
     * @param {string} event - 事件名（取自 core/triggerEvents.js 的 TRIGGER_EVENTS）
     * @param {object} payload
     */
    _emitEvent(event, payload) {
        if (!this.eventBus || typeof this.eventBus.emit !== 'function') return;
        try {
            this.eventBus.emit(event, payload);
        } catch (e) {
            console.error(`[Chat] emit '${event}' failed: ${e.message || e}`);
        }
    }

    /**
     * 好感度只读视图（兼容 getter）。
     * ProactiveEngine / 本类多处代码按 this.aiGirlfriend.affinity 读取，
     * 改持 affinityEngine 后必须保留这个 getter，否则这些读取点会全线 undefined。
     */
    get affinity() {
        return this.affinityEngine.affinity;
    }

    // ==================== 持久化 ====================

    _loadState() {
        const data = readJson(STATE_FILE, null);
        if (!data) return;

        if (data.config) {
            this.baseUrl = data.config.baseUrl || this.baseUrl;
            this.modelName = data.config.modelName || this.modelName;
            this.embeddingBaseUrl = data.config.embeddingBaseUrl;
            this.embeddingModelName = data.config.embeddingModelName;
        }

        if (data.history && Array.isArray(data.history)) {
            this.history = [
                { role: "system", content: this.systemPrompt },
                ...data.history.filter(msg => msg.role !== 'system')
            ];
            console.log(`[State] Loaded ${data.history.length} messages from history`);
        }

        if (data.nickname) {
            this.nickname = data.nickname;
            console.log(`[State] Loaded nickname: ${this.nickname}`);
        }
        // affinity 与 24h 增益事件已迁出到 data/affinity_state.json（AffinityEngine 自持）
    }

    _saveState() {
        const ok = writeJson(STATE_FILE, {
            nickname: this.nickname || "亲爱的",
            history: this.history.filter(msg => msg.role !== 'system'),
            config: {
                baseUrl: this.baseUrl,
                modelName: this.modelName,
                embeddingBaseUrl: this.embeddingBaseUrl,
                embeddingModelName: this.embeddingModelName
            },
            lastUpdated: new Date().toISOString()
        });
        if (ok) {
            console.log(`[State] Saved state with history and configuration`);
        }
    }

    // ==================== LLM 客户端 ====================

    initOpenAI() {
        try {
            this.openai = new OpenAI({
                apiKey: this.apiKey,
                baseURL: this.baseUrl,
                // 与前端等待上限对齐，避免后端请求无限挂起
                timeout: config.chat.timeoutMs,
            });
        } catch (e) {
            console.error(`Error initializing OpenAI: ${e}`);
        }
    }

    // ==================== 对话主流程 ====================

    /**
     * 组装 LLM 请求参数（主对话：非流式与流式共用）。
     *
     * temperature 取 config.chat.temperature（设置页「高级选项」可调，默认 0.75）。
     * max_tokens / reasoning_effort 只在配置非空时才带上——它们不是所有厂商都认，
     * 传了不认的字段轻则被忽略、重则 400，所以「不传」比「传默认值」安全。
     * 若确实设了 reasoning_effort 而厂商不支持，请求会直接报错，日志里能看到，
     * 这里不做降级重试（用户改回「不传」即可）。
     */
    _buildChatParams(messages) {
        const params = {
            model: this.modelName,
            messages,
            temperature: config.chat.temperature
        };
        if (config.chat.maxTokens > 0) {
            params.max_tokens = config.chat.maxTokens;
        }
        if (config.chat.reasoningEffort) {
            params.reasoning_effort = config.chat.reasoningEffort;
        }
        return params;
    }

    /**
     * 把设置页下发的高级参数写进运行时 config.chat（全局单例，进程内生效）。
     * 非法值一律忽略（保留原值），避免一条脏配置把整个对话链路打挂。
     *
     * @returns {boolean} 是否真的发生了变更
     */
    _applyChatParams({ maxPromptHistory, unlimitedContext, temperature, maxTokens, reasoningEffort } = {}) {
        let changed = false;

        /** @returns {boolean} 写入是否生效 */
        const setNumber = (key, raw, min, max) => {
            if (raw === undefined || raw === null || raw === '') return false;
            const n = Number(raw);
            if (!Number.isFinite(n)) return false;
            const next = Math.min(max, Math.max(min, n));
            if (config.chat[key] === next) return false;
            config.chat[key] = next;
            return true;
        };

        if (setNumber('maxPromptHistory', maxPromptHistory, 1, 500)) changed = true;
        if (unlimitedContext !== undefined && unlimitedContext !== null) {
            const next = !!unlimitedContext;
            if (config.chat.unlimitedContext !== next) {
                config.chat.unlimitedContext = next;
                changed = true;
            }
        }
        if (setNumber('temperature', temperature, 0, 2)) changed = true;
        // maxTokens: 0 是合法值，语义为「不传 max_tokens」
        if (setNumber('maxTokens', maxTokens, 0, 1_000_000)) changed = true;

        if (reasoningEffort !== undefined && reasoningEffort !== null) {
            // 档位表以 config.js 的 REASONING_EFFORTS 为唯一真源，勿在此处另抄一份
            const next = REASONING_EFFORTS.includes(reasoningEffort) ? reasoningEffort : '';
            if (config.chat.reasoningEffort !== next) {
                config.chat.reasoningEffort = next;
                changed = true;
            }
        }

        return changed;
    }

    /** 供 /config/status 回显的高级参数当前值 */
    getChatParams() {
        return {
            maxPromptHistory: config.chat.maxPromptHistory,
            unlimitedContext: config.chat.unlimitedContext,
            temperature: config.chat.temperature,
            maxTokens: config.chat.maxTokens,
            reasoningEffort: config.chat.reasoningEffort
        };
    }

    /**
     * 构造发送给 LLM 的消息：system prompt + 最近 N 条历史。
     * 完整历史仍保留在 this.history 并落盘，这里只裁剪 prompt 以加快生成。
     * 条数 N 即 config.chat.maxPromptHistory（设置页「高级选项」可改）；
     * 开启「无限上下文」（config.chat.unlimitedContext）时带上全部保留的对话，
     * 不再按条数裁剪（持久化上限 MAX_HISTORY 兜底，token 不会无界膨胀）。
     */
    _buildPromptMessages() {
        // history 里的 assistant 消息可能带 thought（内心独白），只对前端有意义，
        // 这里统一剥成 { role, content }，避免多余字段打进 LLM 请求。
        const toPromptMsg = (m) => ({ role: m.role, content: m.content });
        if (config.chat.unlimitedContext) {
            return this.history.map(toPromptMsg);
        }
        const max = config.chat.maxPromptHistory;
        // history[0] 固定为 system prompt
        if (this.history.length <= max + 1) return this.history.map(toPromptMsg);

        let tail = this.history.slice(1).slice(-max);
        // 保证上下文从 user 消息开始，避免出现孤立的 assistant 回复
        if (tail.length > 0 && tail[0].role === 'assistant') {
            tail = tail.slice(1);
        }
        return [toPromptMsg(this.history[0]), ...tail.map(toPromptMsg)];
    }

    /**
     * 回复生成后的收尾：记忆 embedding + 状态落盘。
     * 这些都不在用户等待的关键路径上，改为后台执行，失败只记日志。
     *
     * @param {number} affinityDelta 本轮好感度变化（供叙事层「好感度跃迁」信号判定，REQ-03）
     */
    _persistAfterReply(userInput, replyText, llmUserEmotion = null, affinityDelta = 0) {
        // 快照要在当前 tick 取，避免后台执行时读到已被后续对话改动的状态
        const snapshot = this.emotionEngine.getSnapshot();
        setImmediate(() => {
            if (this.memory) {
                this.memory
                    .recordTurn(userInput, replyText, { emotionSnapshot: snapshot })
                    .catch((e) => console.error(`[Chat] recordTurn failed: ${e.message}`));
            }
            // 用户情绪摄入（REQ-01，I3）：融合词表 + LLM metadata，更新时间线与状态。
            // 在后台路径执行，不阻塞响应；失败只记日志，绝不影响主链路。
            let userEmotionTurned = false;
            let userEmotionResult = null;
            try {
                if (this.userEmotionEngine) {
                    const r = this.userEmotionEngine.ingestTurn(userInput, replyText, llmUserEmotion);
                    userEmotionTurned = !!(r && r.turned);
                    userEmotionResult = r;
                }
            } catch (e) {
                console.error(`[Chat] userEmotion ingestTurn failed: ${e.message}`);
            }
            // 【REQ-04 / I16】情绪强转折 → 发布 user_emotion_turn 事件。
            // 只在 turned=true 时发布（弱波动交给定时轮询兜底），最大限度减少无谓派发。
            if (userEmotionTurned && userEmotionResult) {
                const cur = userEmotionResult.current || {};
                this._emitEvent(TRIGGER_EVENTS.USER_EMOTION_TURN, {
                    valence: cur.valence ?? 0,
                    arousal: cur.arousal ?? 0,
                    intensity: cur.intensity ?? 0,
                    label: cur.label ?? '',
                    turned: true,
                    trend: userEmotionResult.trend || null,
                    ts: Date.now(),
                });
            }
            // 【REQ-04 / I16】叙事里程碑 → 发布 narrative_milestone 事件（纪念日 / 约定）。
            // 放在抽取调度之后：里程碑从叙事库派生，emit 时读取的是当前已入库的叙事。
            try {
                this._publishNarrativeMilestones();
            } catch (e) {
                console.error(`[Chat] publishNarrativeMilestones failed: ${e.message}`);
            }
            // 共同经历叙事抽取（REQ-03，I9）：三层节流命中才调 LLM，写入叙事库。
            try {
                this._scheduleNarrativeExtraction(userInput, replyText, { affinityDelta, userEmotionTurned });
            } catch (e) {
                console.error(`[Chat] narrative extraction schedule failed: ${e.message}`);
            }
            try {
                this._saveState();
            } catch (e) {
                console.error(`[Chat] saveState failed: ${e.message}`);
            }
        });
    }

    async chat(userInput) {
        return this._chatQueue = this._chatQueue.then(() => this._doChat(userInput)).catch(e => {
            console.error(`[Chat] Queue error: ${e.message}`);
            this._chatQueue = Promise.resolve();
            return { reply: "发生了点小意外", token_usage: {}, emotion: this.emotionEngine.getEmotionLabel(), affinity: this.affinity };
        });
    }

    /**
     * 对话前的准备工作（非流式与流式共用）：
     * ghosting 判定、情感基准、记忆检索、prompt 组装。
     *
     * @returns {{done?: object, messagesToSend?: Array}} done 存在表示无需调用 LLM
     */
    async _prepare(userInput) {
        // 性格每日结算必须早于 ghosting 早退，否则冷淡期跨天规则永远无法执行。
        const now = Date.now();
        this.personalityDrift.settleDaily(now);

        // ========== Layer -1: 好感度时间衰减惰性结算（必须在任何 LLM 交互之前） ==========
        // 顺序不可颠倒：先按久未互动补扣衰减，再打卡刷新互动时间。
        // 反了会把待结算的空闲时间抹掉，衰减永远触发不了。
        this.affinityEngine.settleDecay(now);
        this.affinityEngine.notifyUserActive(now);

        // ========== Layer 5: Ghosting 检测（优先于基准更新，避免 nudge 消解冷暴力） ==========
        if (this.emotionEngine.shouldGhost()) {
            console.log(`[Chat] Ghosting triggered: P=${this.emotionEngine.state.P.toFixed(2)}`);
            this.emotionEngine.decay(0.05);
            return {
                done: {
                    reply: null,
                    token_usage: {},
                    emotion: "冷漠",
                    affinity: this.affinity,
                    special_action: "ghosting"
                }
            };
        }

        // ========== Layer 0: 亲和度驱动情感基准 ==========
        this.emotionEngine.updateBaselineForAffinity(this.affinity);

        // ========== Layer 4: 记忆上下文（事实常驻 + 双模式检索回忆） ==========
        let contextStr = "";
        if (this.memory) {
            try {
                contextStr = await this.memory.buildMemoryContext(userInput, this.emotionEngine.state);
            } catch (e) {
                console.error(`[Chat] buildMemoryContext failed: ${e.message}`);
            }
        }

        // ========== 任务上下文 + 意图识别指令 ==========
        // 意图识别不额外调 LLM：指令随本次请求一起发出，模型在既有 <metadata> 里回传 task_action（硬约束 C2）。
        // 注意：不要缓存 new Date()，也不要复用上面的 now（那是 Date.now() 的时间戳）
        const nowDate = new Date();
        const pendingTasks = TaskManager.getPendingTasks();
        const taskText = buildTaskContextText(pendingTasks, nowDate);

        const nudgeText = buildTaskNudgeText(pendingTasks, nowDate);
        const nudgeTaskIds = nudgeText ? pickNudgeTasks(pendingTasks, nowDate).map(t => t.id) : [];
        const taskActionText = [buildTaskActionInstruction(), nudgeText].filter(Boolean).join('\n\n');

        // ========== 用户情绪识别（REQ-01，I2） ==========
        // 词表分析当轮即得、零网络成本；这里先 analyze 一次给 prompt 注入用。
        // 全链路容错：任何异常都降级为空段，绝不打断主对话。
        let userEmotionPrompt = '';
        try {
            if (this.userEmotionEngine) {
                this.userEmotionEngine.analyze(userInput); // 预热（ingestTurn 会再次融合，纯计算无副作用）
                userEmotionPrompt = this.userEmotionEngine.getPromptInjection();
            }
        } catch (e) {
            console.error(`[Chat] userEmotion prompt injection failed: ${e.message}`);
            userEmotionPrompt = '';
        }

        // ========== 共同经历叙事（REQ-03，I8） ==========
        // 从叙事池检索与本轮相关的 [我们的故事] 段（topK 2-3、整体 300 字内）。
        // 全链路容错：检索/构建失败一律降级为空段，绝不打断主对话。
        let narrativePrompt = '';
        try {
            if (this._narrativeEnabled() && this.narrativeRetriever && this.narrativeStore.narratives.length > 0) {
                const hits = await this.narrativeRetriever.getRelevantNarratives(userInput);
                narrativePrompt = buildNarrativeContext(hits);
            }
        } catch (e) {
            console.error(`[Chat] narrative prompt injection failed: ${e.message}`);
            narrativePrompt = '';
        }

        // ========== 构建消息 ==========
        // 只把最近若干条历史送进 prompt：上下文越短，prefill 与生成都越快。
        // 完整历史仍持久化在 state.json，不受影响。
        const messagesToSend = this._buildPromptMessages();

        const consolidatedSystemInfo = buildSystemContext({
            nickname: this.nickname,
            taskText,
            contextStr,
            relationshipContext: buildRelationshipContext(this.emotionEngine.getRelationshipContext(this.affinity)),
            emotionPrompt: this.emotionEngine.getPromptInjection(),
            personalityPrompt: this.personalityDrift.getPromptInjection(),
            styleGuide: this.emotionEngine.getStyleGuide(),
            userEmotionPrompt,
            narrativePrompt,
            taskActionText,
        });
        messagesToSend.push({ role: "system", content: consolidatedSystemInfo });
        messagesToSend.push({ role: "user", content: userInput });

        return { messagesToSend, nudgeTaskIds };
    }

    /**
     * 标记「本轮对话已经把某条任务提给模型了」（P1-2 软提醒的 24h 防抖）。
     *
     * 近似判定（Q2）：只要本轮注入了软提醒文本且走完了正常对话路径就算提及 ——
     * 精确判断「模型真的在正文里说了它」需要再解析一次回复，收益不抵成本。
     */
    _markDialogMention(taskIds = []) {
        if (!Array.isArray(taskIds) || taskIds.length === 0) return;
        const nowMs = Date.now();
        for (const id of taskIds) {
            const task = TaskManager.getTasks().find(t => t.id === id);
            if (!task) continue;
            const last = task.reminderState?.[REMINDER_FIELD.dialog];
            if (last) {
                const lastMs = Date.parse(last);
                if (Number.isFinite(lastMs) && nowMs - lastMs < DIALOG_MENTION_DEBOUNCE_MS) continue;
            }
            TaskManager.markReminded(id, REMINDER_KIND.dialog, new Date(nowMs).toISOString());
        }
    }

    /**
     * LLM 返回后的收尾（非流式与流式共用）：
     * 任务动作执行、情绪更新、好感度校验、历史写入与裁剪。
     */
    _finalize(parsed, userInput, usage, { nudgeTaskIds = [] } = {}) {
        const { replyText, affinityChange, emotionDelta, innerThought, modelReasoning, taskAction, llmUserEmotion } = parsed;

        // 轮次计数（REQ-03 叙事抽取的「轮次节流」依赖它）：只统计真正走完 LLM 的一轮。
        // 放在 _finalize 而非 _prepare：ghosting 早退不算有效轮，避免虚增轮次。
        this._turnCount += 1;

        // 任务意图：直接拿本次 LLM 回复的 metadata 执行，**不新增任何网络往返**。
        // 执行结果只走 taskResult 字段下发，绝不拼进 replyText（气泡里不该出现埋点式文字）。
        let taskResult = null;
        try {
            taskResult = executeTaskAction(taskAction, { now: new Date() });
        } catch (e) {
            console.error(`[Chat] Execute task action failed: ${e.message}`);
            taskResult = null;
        }
        if (taskResult) {
            console.log(
                `[Chat] Task action: ${taskResult.action} ok=${taskResult.ok}` +
                (taskResult.reason ? ` reason=${taskResult.reason}` : '')
            );
        }
        this._markDialogMention(nudgeTaskIds);

        // 关键词分析总是生效，LLM delta 叠加混合
        const autoDelta = this.emotionEngine.analyzeInput(userInput, this.affinity);
        this.emotionEngine.applyDelta(autoDelta);
        if (emotionDelta) {
            this.emotionEngine.applyDelta(emotionDelta);
        }

        this.emotionEngine.decay(0.03);

        // 好感度结算：裁窗 / 疲劳 / 越界 / 超低保护 / 惯性 / 日上限全部在引擎内部完成，
        // 这里只把「用户消息 + LLM 原始变化 + AI 回复」交给引擎，拿回 affinity / trace / 阶段元数据。
        const { affinity, change, trace, meta } =
            this.affinityEngine.recordUserTurn(userInput, affinityChange, replyText);

        const sentiment = emotionDelta?.P ?? autoDelta.P;
        this.personalityDrift.recordUserTurn(userInput, {
            sentiment,
            affinity,
            affinityChange,
        });

        this.history.push({ role: "user", content: userInput });
        // 内心独白随消息一起持久化，刷新后 hover 小图标仍可查看；
        // 送进 LLM 时会被 _buildPromptMessages 剥掉，不会污染上下文。
        const assistantMsg = { role: "assistant", content: replyText };
        if (innerThought) assistantMsg.thought = innerThought;
        this.history.push(assistantMsg);

        // 裁剪历史：保留最近 MAX_HISTORY 条消息（含 system prompt）
        while (this.history.length > MAX_HISTORY) {
            this.history.splice(1, 2); // 跳过 [0]=system prompt，成对删除
        }

        // 回复已经生成完毕，记忆 embedding 与落盘不再阻塞响应
        // affinity 变化（change）同时传给叙事层做「好感度跃迁」关键信号判定（REQ-03）
        this._persistAfterReply(userInput, replyText, llmUserEmotion, change);

        return {
            reply: replyText,
            token_usage: usage || {},
            emotion: this.emotionEngine.getEmotionLabel(),
            affinity,
            affinityTrace: trace,
            affinityMeta: meta,
            emotionalState: this.emotionEngine.getFullState(),
            innerThought,
            modelReasoning,
            taskResult: taskResult ?? null,
        };
    }

    async _doChat(userInput) {
        const guard = this._preChatGuard(userInput);
        if (guard) return guard;

        const { done, messagesToSend, nudgeTaskIds } = await this._prepare(userInput);
        if (done) return done;

        try {
            const completion = await this.openai.chat.completions.create(
                this._buildChatParams(messagesToSend)
            );

            const parsed = this._parseCompletion(completion, userInput);
            return this._finalize(parsed, userInput, completion.usage, { nudgeTaskIds });
        } catch (e) {
            console.error(`Chat Error: ${e}`);
            return {
                reply: `发生了点小意外: ${e.message}`,
                token_usage: {},
                emotion: this.emotionEngine.getEmotionLabel(),
                affinity: this.affinity
            };
        }
    }

    /**
     * 流式对话：边生成边通过 onDelta 吐出正文，
     * 让用户看到第一个字的时间从「整段生成完」提前到「首个 token 到达」。
     *
     * @returns 与 chat() 相同结构的结果对象（含完整 reply）
     */
    async chatStream(userInput, onDelta) {
        return this._chatQueue = this._chatQueue
            .then(() => this._doChatStream(userInput, onDelta))
            .catch(e => {
                console.error(`[Chat] Stream queue error: ${e.message}`);
                this._chatQueue = Promise.resolve();
                return {
                    reply: "发生了点小意外",
                    token_usage: {},
                    emotion: this.emotionEngine.getEmotionLabel(),
                    affinity: this.affinity
                };
            });
    }

    async _doChatStream(userInput, onDelta) {
        const guard = this._preChatGuard(userInput);
        if (guard) return guard;

        const { done, messagesToSend, nudgeTaskIds } = await this._prepare(userInput);
        if (done) return done;

        const filter = createStreamFilter();
        let fullContent = "";
        let visibleText = "";

        try {
            const stream = await this.openai.chat.completions.create({
                ...this._buildChatParams(messagesToSend),
                stream: true
            });

            let reasoningText = "";
            for await (const chunk of stream) {
                const { content: delta, reasoning } = splitDelta(chunk);
                if (reasoning) reasoningText += reasoning;
                if (!delta) continue;
                fullContent += delta;
                const visible = filter.push(delta);
                if (visible) {
                    visibleText += visible;
                    onDelta(visible);
                }
            }

            const { tail, cot, monologue, metadata } = filter.finish();
            if (tail) {
                visibleText += tail;
                onDelta(tail);
            }

            const parsed = this._parseReplyText(fullContent, userInput, { cot, monologue, metadata, reasoning: reasoningText });
            // 以实际流式展示给用户的正文为准，保证界面显示与历史记录一致
            if (visibleText.trim()) {
                parsed.replyText = visibleText.trim();
            }
            // 注：正文为空（模型只输出了独白/CoT/元数据）时，此前这里再手写一刀正则剥离标签，
            // 现在已无必要——_parseReplyText 的 replyText 来自 streamFilter.parseFullText()
            // 单一真源，三类标签（含未闭合 metadata）都会被状态机统一剥离，不会残留在气泡里。
            return this._finalize(parsed, userInput, null, { nudgeTaskIds });
        } catch (e) {
            console.error(`Chat Stream Error: ${e}`);
            return {
                reply: `发生了点小意外: ${e.message}`,
                token_usage: {},
                emotion: this.emotionEngine.getEmotionLabel(),
                affinity: this.affinity
            };
        }
    }

    /** 进入对话前的通用校验，返回非 null 时直接作为结果返回 */
    _preChatGuard(userInput) {
        if (!this.openai) {
            return {
                reply: "请先配置 API Key 才能和小爱聊天哦~ (在侧边栏输入或配置 .env 文件)",
                token_usage: {},
                emotion: "default",
                affinity: this.affinity
            };
        }
        if (!userInput || !userInput.trim()) {
            return {
                reply: "",
                token_usage: {},
                emotion: "default",
                affinity: this.affinity
            };
        }
        return null;
    }

    /**
     * 解析 LLM 输出：把三类片段各归各位。
     */
    _parseCompletion(completion, userInput) {
        const message = completion.choices[0].message;
        return this._parseReplyText(message.content, userInput, { reasoning: extractReasoning(message) });
    }

    /**
     * 解析回复文本。
     *
     * 「思考」有两个来源，语义完全不同，这里显式分流、绝不混淆：
     *   innerThought   —— 人设内心独白：我们 prompt 要求小爱写的 <monologue>，走 content。
     *                     默认隐藏，前端小图标 hover 可见。
     *   modelReasoning —— 模型自己的推理链：① 原生字段 reasoning_content；
     *                     ② 部分推理/蒸馏模型把 CoT 写进正文的 <think>。永不展示。
     *
     * 兼容旧行为：若只有 <think> 且原生通道为空（非推理模型 + 旧格式），
     * 那这个 <think> 就是我们要的独白，仍归入 innerThought。
     *
     * 三类思考之外，metadata 里可能带可选的 `task_action`（任务清单系统重构追加的可选字段，
     * 见 core/taskActions.js）——它走 RPC 式的写操作通道，不参与正文渲染。
     *
     * @param hints 流式场景下由 streamFilter 给出已分离好的 cot / monologue / metadata / reasoning
     */
    _parseReplyText(fullContent, userInput, hints = {}) {
        const raw = fullContent || "";
        let emotion = "default";
        let affinityChange = 0;
        let emotionDelta = null;
        let innerThought = null;
        let modelReasoning = null;
        let taskAction = null;
        let llmUserEmotion = null;

        // ---- 标签剥离：单一真源 ----
        // 「三类标签如何被识别与剥离」只有 streamFilter 一处实现。
        // 流式路径由调用方（chat 流）把已分离好的片段作为 hints 传入，此处直接采信、
        // 绝不被下面 parseFullText 的结果覆盖——这是 hints 短路的承诺。
        // 非流式路径（无 hints）才走状态机的一次性等价实现 parseFullText()，
        // 它与逐字符流式喂入结果一致（对照测试锁定），且同样处理未闭合 metadata 截断。
        const parsed = parseFullText(raw);
        let replyText = hints.replyText != null ? hints.replyText : parsed.replyText;

        // 人设内心独白 <monologue>
        const monologue = (hints.monologue || parsed.monologue || "").trim();

        // 模型 CoT（正文里的 <think>）
        const cot = (hints.cot || parsed.cot || "").trim();

        // metadata 文本：hints 优先（流式已分离，含未闭合残片），否则用状态机结果
        const metadataText = hints.metadata != null ? hints.metadata : parsed.metadata;

        // ---- 模型 CoT（原生 reasoning_content 通道）----
        const native = (hints.reasoning || "").trim();

        modelReasoning = [native, cot].filter(Boolean).join("\n\n") || null;
        innerThought = monologue || null;
        if (!innerThought && cot && !native) {
            innerThought = cot;      // 旧格式：唯一的 <think> 就是人设独白
            modelReasoning = null;
        }

        if (innerThought) {
            console.log(`\n[Inner Monologue]: ${innerThought}\n`);
            if (innerThought.length > 400) {
                console.warn(`[Chat] 内心独白异常长（${innerThought.length} 字符），注意是否混入了模型 CoT`);
            }
        }
        if (modelReasoning) {
            const preview = modelReasoning.length > 300 ? modelReasoning.slice(0, 300) + ' …' : modelReasoning;
            console.log(`\n[Model Reasoning] (${modelReasoning.length} chars): ${preview}\n`);
        }

        // ---- 元数据 ----
        // 无论 hints 还是状态机，得到的都已是「剥离标签后的 JSON 文本」（含未闭合残片）。
        // 未闭合场景（生成被 max_tokens 截断在 metadata 中间）由状态机统一收敛，
        // 残片不会残留进 replyText，因此不会展示给用户——与流式路径行为一致。
        const metadataJson = (metadataText || "").trim() || null;

        if (metadataJson) {
            try {
                const normalized = metadataJson.replace(/:\s*\+([0-9.]+)/g, ': $1');
                const metadata = JSON.parse(normalized);
                emotion = metadata.emotion || "default";
                affinityChange = metadata.affinity_change || 0;
                emotionDelta = metadata.emotion_delta || null;
                // 任务意图：老模型不输出这个字段时恒为 null，下游行为完全不变（向后兼容）
                taskAction = metadata.task_action ?? null;
                // 用户情绪（REQ-01）：可选字段，老模型不返回时恒为 null，下游纯用词表兜底
                llmUserEmotion = metadata.user_emotion ?? null;
            } catch (e) {
                console.error(`Metadata parse error: ${e}. Raw: ${metadataJson}`);
            }
        }

        return { replyText, emotion, affinityChange, emotionDelta, innerThought, modelReasoning, taskAction, llmUserEmotion };
    }

    // ==================== 主动消息生成 ====================

    async generateProactiveMessage(reason, data = {}) {
        if (!this.openai) {
            console.error("[AiGirlfriend] OpenAI not initialized for proactive message");
            return null;
        }

        const contextInfo = await this._buildProactiveContext(reason, data);
        const scenarioPrompt = buildProactivePrompt(reason, data, this.affinity);

        const messages = [
            // 人设 system prompt 固定带上：此前用 history.slice(-10)，历史短时才会
            // 恰好包含它、历史长了就被挤掉，导致主动消息的人设时有时无。
            { role: "system", content: this.systemPrompt },
            // 同样剥掉 thought 与 system，只把最近 10 条真实对话交给 LLM
            ...this.history
                .filter(m => m.role !== 'system')
                .slice(-10)
                .map(m => ({ role: m.role, content: m.content })),
            // 动态上下文三件套与主对话 _prepare() 同源：此前主动消息只有阶段标签、
            // 没有情绪/性格，愤怒冷暴力下照样生成友善搭话（docs/proactive-consistency/DIAGNOSIS.md P0-1）。
            // 不带任务清单与记忆块——主动消息不需要「回应任务」的口吻，记忆走 memory_share 专属通道。
            { role: "system", content: [
                buildRelationshipContext(this.emotionEngine.getRelationshipContext(this.affinity)),
                this.emotionEngine.getPromptInjection(),
                this.personalityDrift.getPromptInjection(),
            ].join('\n\n') },
            { role: "system", content: buildProactiveDirective(reason, this.affinity, contextInfo) },
            { role: "system", content: buildProactivePersonaDirective(scenarioPrompt, this.affinity) }
        ];

        try {
            // ⚠️ 主动消息刻意不跟随设置页的 temperature：这是「小爱主动找你说话」的
            // 场景，需要比主对话（默认 0.75）更高的变化度才不显得复读，故固定 0.85。
            // 确认过语义：它不是记忆摘要之类的工具调用，而是另一条独立的人设链路，
            // 所以这里保持原值不动（将来要统一，需连 proactivePrompts 一起评估）。
            const completion = await this.openai.chat.completions.create({
                model: this.modelName,
                messages: messages,
                temperature: 0.85
            });

            const content = completion.choices[0].message.content;
            // 主动消息直接进气泡：三类标签（含 CoT 与独白）一并清掉（万一模型带了出来）。
            // 这里不再手写正则——同一套「标签如何被识别与剥离」的规则收敛到
            // streamFilter.parseFullText() 单一真源，避免未来标签格式变更漏改此处。
            const parsed = parseFullText(content || "");
            let reply = parsed.replyText.trim();
            let emotion = "default";

            const metadataJson = (parsed.metadata || "").trim();
            if (metadataJson) {
                try {
                    const normalized = metadataJson.replace(/:\s*\+([0-9]+)/g, ': $1');
                    const metadata = JSON.parse(normalized);
                    emotion = metadata.emotion || "default";
                } catch (e) {
                    console.error("[AiGirlfriend] Metadata parse error in proactive:", e);
                }
            }

            console.log(`[AiGirlfriend] Proactive message generated: ${reason} -> ${reply.substring(0, 50)}...`);
            return { reply, emotion, reason };
        } catch (e) {
            console.error("[AiGirlfriend] Proactive generation error:", e);
            return null;
        }
    }

    async _buildProactiveContext(reason, data) {
        let context = "";

        if (reason === 'memory_share' && this.memory) {
            try {
                // 走 facade 方法（内部避开最近 5 条与最近已分享的），不再直读内部数组
                const memory = this.memory.getRandomMemory(5);
                if (memory) {
                    context += `\n- 可参考的历史记忆: "${memory.text.substring(0, 100)}..."`;
                }
            } catch (e) {
                // 忽略记忆检索失败，不影响主动消息生成
            }
        }

        return context;
    }

    /**
     * 把小爱主动发出的消息写进对话历史。
     *
     * 为什么需要：
     * 1. 上下文 —— 用户回复主动消息（"早呀"）时，模型要能看到自己刚才说了什么，
     *    否则会答非所问（此前主动消息只存在于前端 UI，后端历史里没有）。
     * 2. 一致性 —— 刷新页面会重新拉 /history，不写历史的话主动消息会凭空消失。
     *
     * 注意：只追加历史 + 落盘，不触发情绪/好感度变化——那两条链路的职责在 chat()。
     */
    recordProactiveMessage(text, reason = 'random_chat') {
        if (!text) return;
        this.history.push({ role: 'assistant', content: text });

        const nonSystem = this.history.filter(m => m.role !== 'system');
        if (nonSystem.length > MAX_HISTORY) {
            this.history = [{ role: 'system', content: this.systemPrompt }, ...nonSystem.slice(-MAX_HISTORY)];
        }

        try {
            this._saveState();
        } catch (e) {
            console.error(`[Proactive] saveState failed: ${e.message}`);
        }
        console.log(`[Proactive] Message recorded to history (${reason})`);
    }

    // ==================== 访问器与配置 ====================

    getHistory() {
        return this.history.filter(msg => msg.role === 'user' || msg.role === 'assistant');
    }

    /**
     * 只清对话历史 —— 这是「新对话」的语义。
     *
     * 为什么只清历史：用户点「新对话」的诉求只是「别让前面的对话碍眼」，
     * 好感度与长期记忆必须保留，否则用户只是想清理画面就会丢掉整段关系。
     * 历史上这里顺手调了 affinityEngine.reset() + memory.clearMemory()，
     * 导致「开个新对话」被当成「格式化人格」——那正是要拆开的两种语义。
     * 需要把关系一起抹掉的场景走 resetAll()。
     */
    clearHistory() {
        this.history = [{ role: "system", content: this.systemPrompt }];
        this._saveState();
    }

    /**
     * 完全重置：清对话历史 + 好感度 + 性格 + 情绪 + 任务 + 长期记忆
     * （设置页「完全重置」的语义）。
     *
     * 与 clearHistory() 的区别就在「要不要抹掉整段关系」。affinityEngine.reset()
     * 与 memory.clearMemory() 各自会落盘，这里最后再补一次 _saveState() 把
     * history 一并收尾，保证多份数据同批落盘。
     *
     * 清理范围（7 类，第 7 类仅在事件层已装配时生效）：
     *   1. history        → data/state.json（保留 system prompt）
     *   2. affinityEngine → data/affinity_state.json（好感度/账本/增益）
     *   3. personalityDrift → data/personality_state.json（性格回预设）
     *   4. emotionEngine  → data/emotion_state.json（情绪回初值）
     *   5. userEmotionEngine → data/user_emotion_state.json（用户情绪时间线，REQ-01）
     *   6. narrative      → data/narrative.json（共同经历叙事，REQ-03）
     *   7. TaskManager    → data/tasks.json（任务全清）
     *   8. memory         → data/memory.json（情节+事实）
     *   9. triggerRegistry→ data/trigger_state.json（事件队列/冷却/去重，REQ-04，可选）
     *
     * 容错策略：各引擎独立重置，任一失败只记录并继续，最后把失败的引擎名回传，
     * 避免「某个引擎抛错导致后续引擎全部没重置」的半重置状态。
     * （真正的事务回滚需要跨文件快照，成本过高；这里保证「尽力全部重置」并把
     *   失败面如实暴露给调用方与日志，好过静默留下半重置。）
     *
     * @returns {{ reset: string[], failed: { step: string, message: string }[] }}
     */
    resetAll() {
        /** 依次执行的重置步骤；每步独立容错 */
        const steps = [
            ['history', () => {
                this.history = [{ role: "system", content: this.systemPrompt }];
            }],
            ['affinity', () => this.affinityEngine.reset()],
            ['personality', () => this.personalityDrift.reset()],
            ['emotion', () => this.emotionEngine?.reset()],
            ['userEmotion', () => this.userEmotionEngine?.reset()],
            ['narrative', () => this._resetNarratives()],
            ['tasks', () => TaskManager.clearAll()],
            ['memory', () => this.memory?.clearMemory()],
        ];
        // 事件层重置（REQ-04）：仅当容器注入了 registry 才纳入，避免把「未装配」当成功重置。
        // registry.reset() 清空事件队列 + 冷却 + 去重标记（内部全防御式，不会抛）。
        if (this.triggerRegistry) {
            steps.push(['triggerRegistry', () => this.triggerRegistry.reset()]);
        }

        const reset = [];
        const failed = [];
        for (const [name, run] of steps) {
            try {
                run();
                reset.push(name);
            } catch (e) {
                // 不中断——继续重置剩余引擎，把失败项收集起来
                failed.push({ step: name, message: e?.message || String(e) });
                console.error(`[AiGirlfriend] resetAll: step "${name}" failed: ${e?.message || e}`);
            }
        }

        // 收尾落盘（history 无独立落盘点，靠这里写入；其余引擎已各自落盘）
        try {
            this._saveState();
        } catch (e) {
            failed.push({ step: 'state', message: e?.message || String(e) });
            console.error(`[AiGirlfriend] resetAll: final _saveState failed: ${e?.message || e}`);
        }

        return { reset, failed };
    }

    /**
     * 重置叙事层（「完全重置」的一步）：清空叙事池与轮次计数，作废在途抽取，立即落盘。
     * 与记忆层独立：叙事清空不影响 MemoryStore，反之亦然。
     */
    _resetNarratives() {
        this._narrativeGeneration++;
        this._turnCount = 0;
        this._recentStoryIds.clear();
        if (this.narrativeStore) {
            this.narrativeStore.clear();
            this.narrativeStore._saveNow();
        }
    }

    getSystemPrompt() {
        return this.systemPrompt;
    }

    updateSystemPrompt(newPrompt) {
        this.systemPrompt = newPrompt;
        this.history = [{ role: "system", content: this.systemPrompt }];
    }

    getState() {
        return {
            affinity: this.affinity,
            nickname: this.nickname || "亲爱的",
            historyCount: this.history.filter(m => m.role !== 'system').length,
            memoryCount: this.memory ? this.memory.store.episodes.length : 0,
            factCount: this.memory ? this.memory.store.facts.length : 0,
            // 平铺情绪标签：前端刷新后 syncState 直接回填主徽章，
            // 不用等下一条消息的 chat 响应才校正
            emotion: this.emotionEngine ? this.emotionEngine.getEmotionLabel() : null,
            emotionalState: this.emotionEngine ? this.emotionEngine.getFullState() : null,
            // 平铺阶段元数据 + recentChangeReason / decaying / dailyCapReached，
            // 前端 /state 与 /chat 响应共用同一份字段（前端零阈值）。
            ...this.affinityEngine.getMeta()
        };
    }

    /**
     * 配置热更新。⚠️ 参数故意叫 cfg 而不是 config：旧参数名会遮蔽全局导入 config，
     * 函数体内写 config.memory.* 会命中请求体而非运行时配置（与 Memory 构造器同款陷阱）。
     */
    updateConfig(cfg) {
        let changed = false;

        if (cfg.apiKey && cfg.apiKey !== this.apiKey) {
            this.apiKey = cfg.apiKey;
            changed = true;
        }
        if (cfg.baseUrl && cfg.baseUrl !== this.baseUrl) {
            this.baseUrl = cfg.baseUrl;
            changed = true;
        }
        if (cfg.modelName && cfg.modelName !== this.modelName) {
            this.modelName = cfg.modelName;
            changed = true;
        }
        // 嵌入配置允许「清空回退」：前端把输入框清空会送来空串，
        // 这里归一化成 null，Memory 层随即回退到「使用主 Key」的语义
        if (cfg.embeddingApiKey !== undefined) {
            const nextKey = cfg.embeddingApiKey === '' ? null : cfg.embeddingApiKey;
            if (nextKey !== this.embeddingApiKey) {
                this.embeddingApiKey = nextKey;
                changed = true;
            }
        }
        if (cfg.embeddingBaseUrl !== undefined) {
            const nextUrl = cfg.embeddingBaseUrl === '' ? null : cfg.embeddingBaseUrl;
            if (nextUrl !== this.embeddingBaseUrl) {
                this.embeddingBaseUrl = nextUrl;
                changed = true;
            }
        }
        if (cfg.embeddingModelName !== undefined) {
            const nextModel = cfg.embeddingModelName === '' ? null : cfg.embeddingModelName;
            if (nextModel !== this.embeddingModelName) {
                this.embeddingModelName = nextModel;
                changed = true;
            }
        }

        // 高级选项（上下文条数 / 温度 / 最大输出 / 思考强度）：写运行时 config.chat，
        // 单独记 changed，不并入上面的连接类变更（改这些不需要重建 OpenAI 客户端）。
        const paramsChanged = this._applyChatParams({
            maxPromptHistory: cfg.maxPromptHistory,
            unlimitedContext: cfg.unlimitedContext,
            temperature: cfg.temperature,
            maxTokens: cfg.maxTokens,
            reasoningEffort: cfg.reasoningEffort
        });

        // 记忆选项（事实提取开关 / 检索模式）：同为运行时参数，改这些不需要动任何客户端
        let memoryParamsChanged = false;
        if (cfg.memoryFactsEnabled !== undefined) {
            const next = !!cfg.memoryFactsEnabled;
            if (config.memory.facts.enabled !== next) {
                config.memory.facts.enabled = next;
                memoryParamsChanged = true;
            }
        }
        if (cfg.memoryRetrievalMode !== undefined) {
            const next = ['auto', 'embedding', 'keyword'].includes(cfg.memoryRetrievalMode)
                ? cfg.memoryRetrievalMode
                : 'auto';
            if (config.memory.retrieval.mode !== next) {
                config.memory.retrieval.mode = next;
                memoryParamsChanged = true;
            }
        }

        // 陪伴感增强子系统开关（REQ-01/03/04）：与 memory 同款「运行时参数」处理，
        // 改这些不需要动任何客户端。关闭态语义 = 完全退回改造前行为（关闭态安全）。
        let companionParamsChanged = false;
        if (cfg.userEmotionEnabled !== undefined) {
            const next = !!cfg.userEmotionEnabled;
            if (config.userEmotion.enabled !== next) {
                config.userEmotion.enabled = next;
                companionParamsChanged = true;
            }
        }
        if (cfg.narrativeEnabled !== undefined) {
            const next = !!cfg.narrativeEnabled;
            if (config.narrative.enabled !== next) {
                config.narrative.enabled = next;
                companionParamsChanged = true;
            }
        }
        // 事件层总开关：走 TriggerRegistry 的 setEventLayerEnabled（模块级变量，唯一写点），
        // 不直接改 config.triggerRegistry.enabled —— 后者是常量默认值，模块级变量才是运行时态。
        if (cfg.triggerEnabled !== undefined) {
            const next = !!cfg.triggerEnabled;
            if (isEventLayerEnabled() !== next) {
                setEventLayerEnabled(next);
                companionParamsChanged = true;
            }
        }

        if (paramsChanged) {
            const p = this.getChatParams();
            console.log(
                `[Config] Chat params: history=${p.unlimitedContext ? '∞ (unlimited)' : p.maxPromptHistory}, ` +
                `temperature=${p.temperature}, ` +
                `maxTokens=${p.maxTokens > 0 ? p.maxTokens : 'auto'}, reasoningEffort=${p.reasoningEffort || 'off'}`
            );
        }
        if (memoryParamsChanged) {
            console.log(
                `[Config] Memory: facts=${config.memory.facts.enabled ? 'on' : 'off'}, ` +
                `mode=${config.memory.retrieval.mode} (effective: ${this.memory?.retriever.resolveMode() ?? '?'})`
            );
        }
        if (companionParamsChanged) {
            console.log(
                `[Config] Companion: userEmotion=${config.userEmotion.enabled ? 'on' : 'off'}, ` +
                `narrative=${config.narrative.enabled ? 'on' : 'off'}, ` +
                `eventLayer=${isEventLayerEnabled() ? 'on' : 'off'}`
            );
        }

        if (changed) {
            if (this.apiKey) this.initOpenAI();
            if (this.memory) {
                this.memory.updateConfig({
                    apiKey: this.apiKey,
                    baseUrl: this.baseUrl,
                    embeddingApiKey: this.embeddingApiKey,
                    embeddingBaseUrl: this.embeddingBaseUrl,
                    embeddingModelName: this.embeddingModelName
                });
            }
            this._saveState();
            console.log(`[Config] Updated: model=${this.modelName}, baseUrl=${this.baseUrl}`);
        }

        return { modelName: this.modelName, baseUrl: this.baseUrl };
    }

    updateState(updates) {
        if (typeof updates.affinity === 'number') {
            this.affinityEngine.setAffinity(updates.affinity);
        }
        if (updates.nickname !== undefined) {
            this.nickname = updates.nickname;
        }
        this._saveState();
        return this.getState();
    }

    /** 全量记忆导出：{facts, episodes(时间倒序), stats}；embedding 大字段不下发 */
    getMemories() {
        if (!this.memory) {
            return { facts: [], episodes: [], stats: { episodeCount: 0, factCount: 0, retrievalMode: 'keyword' } };
        }
        return this.memory.getAll();
    }

    addFact(content, options = {}) {
        if (!this.memory) return Promise.resolve(null);
        return this.memory.addFact(content, options);
    }

    updateFact(id, updates = {}) {
        if (!this.memory) return Promise.resolve(null);
        return this.memory.updateFact(id, updates);
    }

    /** 删除单条记忆（事实或情节）；返回命中类型或 null */
    deleteMemory(id) {
        return this.memory ? this.memory.deleteMemory(id) : null;
    }

    clearMemoriesOnly() {
        if (this.memory) {
            this.memory.clearMemory();
        }
    }

    /** 供 /config/status：检索模式与事实提取开关的当前生效值 */
    getMemoryStatus() {
        return {
            ...(this.memory ? this.memory.getStats() : { episodeCount: 0, factCount: 0, retrievalMode: 'keyword' }),
            factsEnabled: config.memory.facts.enabled,
        };
    }

    /**
     * 供 /config/status：陪伴感增强三个子系统的当前生效开关（REQ-01/03/04）。
     * 事件层开关取模块级运行时态（isEventLayerEnabled），与纯 config 常量区分。
     */
    getCompanionStatus() {
        return {
            userEmotionEnabled: config.userEmotion.enabled,
            narrativeEnabled: config.narrative.enabled,
            // 事件层运行时开关（可由 POST /config 热更新）
            triggerEnabled: isEventLayerEnabled(),
            // 事件层配置块（唯一事实源：core/triggerEvents.js TRIGGER_REGISTRY_CONFIG）
            triggerRegistry: { ...config.triggerRegistry },
        };
    }

    // ==================== 共同经历叙事层（REQ-03） ====================

    /** 叙事层是否启用（总开关 + 依赖就绪）。 */
    _narrativeEnabled() {
        return config.narrative.enabled && !!this.narrativeStore;
    }

    /**
     * 后台触发一次叙事抽取（串行队列；三层节流在 extractor 内判定，未命中不调 LLM）。
     *
     * 节流判定所需的结构化上下文：
     *   - turnCount          轮次节流依据（本类维护）
     *   - affinityDelta      好感度单轮跃迁（信号层）
     *   - userEmotionTurned  用户情绪强转折（信号层，来自 REQ-01 引擎）
     * 文本信号（第一次/约定/纪念日词）由 extractor 在合并 userInput+replyText 后自查。
     *
     * @param {string} userInput
     * @param {string} replyText
     * @param {{affinityDelta?:number, userEmotionTurned?:boolean}} ctx
     */
    _scheduleNarrativeExtraction(userInput, replyText, ctx = {}) {
        if (!this._narrativeEnabled()) return;
        // 轮次节流在入队前先做一次快速判定，避免每轮都往队列塞任务
        if (this._turnCount % config.narrative.extractEveryNTurns !== 0) return;

        const generation = this._narrativeGeneration;
        const turnCount = this._turnCount;
        this._narrativeQueue = this._narrativeQueue
            .then(async () => {
                // 期间叙事库被清空（resetAll）→ 本轮抽取作废，防清空后残留叙事复活
                if (generation !== this._narrativeGeneration) return;
                const { extracted, ops } = await this.narrativeExtractor.maybeExtract(userInput, replyText, {
                    turnCount,
                    affinityDelta: ctx.affinityDelta,
                    userEmotionTurned: ctx.userEmotionTurned,
                });
                if (!extracted) return;
                const changed = ops.add.length + ops.update.length + ops.delete.length;
                if (changed === 0) {
                    // 抽了但无变化也记一次抽取时间，避免短时间内反复触发 LLM
                    this.narrativeStore.setStats({ lastExtractTurn: turnCount, lastExtractAt: Date.now() });
                    this.narrativeStore.scheduleSave();
                    return;
                }
                if (generation !== this._narrativeGeneration) return;
                await this._applyNarrativeOps(ops);
                this.narrativeStore.setStats({ lastExtractTurn: turnCount, lastExtractAt: Date.now() });
                this.narrativeStore.scheduleSave();
                console.log(`[Narrative] Story: +${ops.add.length} ~${ops.update.length} -${ops.delete.length}`);
            })
            .catch((e) => console.error(`[Narrative] extraction failed: ${e.message}`));
    }

    /**
     * 应用 LLM 返回的叙事操作（add/update/delete），与事实库 _applyFactOps 同构。
     * add 会算嵌入（可用时）用于后续语义检索；delete 直接按 id 移除。
     */
    async _applyNarrativeOps(ops) {
        // delete
        for (const id of ops.delete) {
            this.narrativeStore.removeNarrative(id);
        }

        // update
        for (const upd of ops.update) {
            const norm = NarrativeExtractor.normalizeUpdate(upd);
            if (!norm) continue;
            const updated = this.narrativeStore.updateNarrative(norm.id, norm);
            // 摘要变更后重算嵌入，保证语义检索用最新文本
            if (updated && norm.summary && this.memory?.embedding) {
                try {
                    const emb = await this.memory.embedding.embed(`${updated.title} ${updated.summary}`);
                    if (emb) {
                        updated.embedding = emb;
                        updated.embeddingModel = this.memory.embedding.model;
                    }
                } catch (e) {
                    console.error(`[Narrative] update embedding failed: ${e.message}`);
                }
            }
        }

        // add（单轮上限，防批量灌库）
        const adds = ops.add.slice(0, config.narrative.maxAddPerExtract);
        for (const add of adds) {
            const norm = NarrativeExtractor.normalizeAdd(add);
            if (!norm) continue;
            if (this._isDuplicateNarrative(norm)) continue;
            let embedding = null;
            let embeddingModel = null;
            if (this.memory?.embedding) {
                try {
                    embedding = await this.memory.embedding.embed(`${norm.title} ${norm.summary}`);
                    embeddingModel = embedding ? this.memory.embedding.model : null;
                } catch (e) {
                    console.error(`[Narrative] add embedding failed: ${e.message}`);
                }
            }
            this.narrativeStore.addNarrative({ ...norm, embedding, embeddingModel });
        }
    }

    /**
     * 叙事写入去重：标题归一化后互为包含即视为同一事件。
     * 嵌入可用时再叠加余弦判定（参照 FactExtractor.isDuplicateFact 范式）。
     * @param {object} candidate { title, summary, embedding? }
     * @returns {boolean}
     */
    _isDuplicateNarrative(candidate) {
        const normTitle = normalizeForDedup(candidate.title);
        const normSummary = normalizeForDedup(candidate.summary);
        const threshold = config.narrative.dedupWriteSimilarity;
        return this.narrativeStore.narratives.some((n) => {
            const nt = normalizeForDedup(n.title);
            const ns = normalizeForDedup(n.summary);
            if (nt && normTitle && (nt === normTitle || nt.includes(normTitle) || normTitle.includes(nt))) {
                return true;
            }
            if (ns && normSummary && (ns === normSummary || ns.includes(normSummary) || normSummary.includes(ns))) {
                return true;
            }
            if (candidate.embedding && n.embedding) {
                return EmbeddingClient.cosineSimilarity(candidate.embedding, n.embedding) > threshold;
            }
            return false;
        });
    }

    /** 全量叙事导出（供路由 /state/narratives）。 */
    getNarratives() {
        if (!this.narrativeStore) return { narratives: [], stats: { total: 0 } };
        return this.narrativeStore.getAll();
    }

    /** 手动删除一条叙事（A7：不级联，另给删除入口）。 */
    deleteNarrative(id) {
        if (!this.narrativeStore) return false;
        const ok = this.narrativeStore.removeNarrative(id);
        if (ok) {
            this.narrativeStore.scheduleSave();
            // 同步清理随机回顾的去重集合，避免残留 id 干扰后续挑选
            this._recentStoryIds.delete(id);
        }
        return ok;
    }

    /** 即将到来的纪念日（REQ-04 触发源）。 */
    getUpcomingAnniversaries(now = new Date(), withinDays) {
        if (!this.narrativeRetriever) return [];
        return this.narrativeRetriever.getUpcomingAnniversaries(now, withinDays);
    }

    /**
     * 发布叙事里程碑事件（REQ-04 / I16）——纪念日与约定。
     *
     * 为什么要在这里统一发布：触发源 emotionTurnTrigger/anniversaryTrigger/promiseFollowupTrigger
     * 只消费事件、不反向依赖 AiGirlfriend；由本类作为「事件发布方」把叙事层的产物翻译成事件。
     *
     * 两条发布线：
     *   1. 纪念日：getUpcomingAnniversaries() 命中的每一条 → narrative_milestone（type='anniversary'）。
     *   2. 约定：叙事库里 type='promise' 的事件 → narrative_milestone（type='promise'）。
     * 事件层未装配时 _emitEvent 为空操作，本方法仍可安全调用（几乎零开销）。
     */
    _publishNarrativeMilestones(now = new Date()) {
        if (!this.eventBus) return;              // 未装配事件层 → 直接跳过（O(1)）
        if (!this.narrativeStore) return;

        // —— 纪念日 ——
        const anniversaries = this.getUpcomingAnniversaries(now);
        for (const { narrative, daysUntil } of anniversaries) {
            this._emitEvent(TRIGGER_EVENTS.NARRATIVE_MILESTONE, {
                narrativeId: narrative.id,
                type: 'anniversary',
                title: narrative.title,
                occurredAt: narrative.occurredAt,
                anniversary: true,
                daysUntil,
            });
        }

        // —— 约定 ——
        const promises = (this.narrativeStore.narratives || []).filter((n) => n.type === 'promise');
        for (const n of promises) {
            this._emitEvent(TRIGGER_EVENTS.NARRATIVE_MILESTONE, {
                narrativeId: n.id,
                type: 'promise',
                title: n.title,
                summary: n.summary,
                occurredAt: n.occurredAt,
                anniversary: false,
                followupCount: Number.isFinite(n.followupCount) ? n.followupCount : 0,
            });
        }
    }

    /** 停机/兜底：立即落盘叙事库。 */
    flushNarratives() {
        try {
            this.narrativeStore?.flush();
        } catch (e) {
            console.error(`[Narrative] flush failed: ${e.message}`);
        }
    }

    /**
     * 停机/兜底：立即落盘用户情绪时间线（REQ-01）。
     * UserEmotionEngine 内部走去抖异步写盘，这里在停机前强制 flush，
     * 避免最后一批时间线数据随进程退出丢失。
     */
    flushUserEmotion() {
        try {
            this.userEmotionEngine?.flush?.();
        } catch (e) {
            console.error(`[UserEmotion] flush failed: ${e.message}`);
        }
    }
}

export default AiGirlfriend;
