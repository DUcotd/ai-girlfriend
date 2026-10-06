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
import { normalizeDelta, blendDeltas, coerceAffinityChange, PAD_AXES } from './emotionDelta.js';
import { computeResonanceDelta, combineWithResonance } from './emotionResonance.js';
import { getStageForAffinity, RELATIONSHIP_STAGES } from './relationshipStages.js';
import { getProactiveType, PROACTIVE_EXPIRY_FEEDBACK } from './proactiveTypes.js';
import { classifyUpstreamError, upstreamLogLine, classifiedByCode, UPSTREAM_ERROR_CODES } from '../utils/upstreamError.js';
import { debugText } from '../utils/log.js';
// 只取快照这一个函数：backup.js 不 import 容器（服务集合由调用方注入），无循环依赖风险。
import { createSnapshot } from './backup.js';

dotenv.config();

const STATE_FILE = 'state.json';
const MAX_HISTORY = 200;
// 人设 prompt 长度上限：它会挂在每一条请求的 history[0] 上，不设上限等于
// 允许一次输入永久抬高所有后续请求的 token 成本。
const SYSTEM_PROMPT_MAX = 8000;

/**
 * 对话内提及同一任务的防抖窗口（P1-2）。
 * 「每次注入软提醒就标记」会让用户在同一场对话里被同一条任务反复念叨。
 */
const DIALOG_MENTION_DEBOUNCE_MS = 24 * 60 * 60 * 1000;

/**
 * 默认服务商与模型：与前端 lib/providers.ts 的 DEFAULT_PROVIDER 保持一致（商汤 Sensenova）。
 * 改这里就要同步改前端，否则前后端默认服务商会打架。
 * 构造函数与「清空连接配置」两条路径都读这两个常量，避免默认值出现第二份。
 */
const DEFAULT_BASE_URL = "https://token.sensenova.cn/v1";
const DEFAULT_MODEL_NAME = "sensenova-6.8-flash-lite";

/**
 * 「进程刚起来时」的运行时参数快照（B5-12 档案导入要用）。
 *
 * 为什么在模块加载时就抓：这些值来自环境变量，一旦被会话里的 POST /config 改过，
 * 运行时就读不到原始默认了。档案导入的语义是「整份回到那份档案的状态」，
 * 所以必须先把运行时开关与高级参数退回 env 默认，再让 _loadState 套用档案里的值 ——
 * 档案里没有的字段才不会被上一次会话的残留污染。
 */
const DEFAULT_TOGGLES = {
    userEmotionEnabled: config.userEmotion.enabled,
    narrativeEnabled: config.narrative.enabled,
    memoryFactsEnabled: config.memory.facts.enabled,
    memoryRetrievalMode: config.memory.retrieval.mode,
    triggerEnabled: isEventLayerEnabled(),
};
const DEFAULT_CHAT_PARAMS = {
    maxPromptHistory: config.chat.maxPromptHistory,
    unlimitedContext: config.chat.unlimitedContext,
    temperature: config.chat.temperature,
    maxTokens: config.chat.maxTokens,
    reasoningEffort: config.chat.reasoningEffort,
};

class AiGirlfriend {
    constructor(config = {}) {
        this.statePath = dataPath(STATE_FILE);
        this.systemPrompt = PERSONA_SYSTEM_PROMPT;

        this.apiKey = null;
        this.baseUrl = DEFAULT_BASE_URL;
        this.modelName = DEFAULT_MODEL_NAME;
        this.embeddingApiKey = null;
        this.embeddingBaseUrl = null;
        this.embeddingModelName = null;

        // 好感度是自持状态的引擎（落 data/affinity_state.json），本类不再自己持有。
        // 只通过下面的 get affinity() 暴露只读视图，写操作一律走 this.affinityEngine。
        this.affinityEngine = new AffinityEngine();
        this.nickname = "你";
        this.history = [];

        this._loadState();

        // 服务端侧的 Key 兜底：让「不开浏览器也能起后端跑脚本/被 systemd 拉起」成为可能。
        // 只进内存，绝不写进 state.json（那里只存 baseUrl/modelName 等非敏感项）。
        // 优先级低于随后浏览器 POST /config 下发的值。
        if (process.env.AI_GIRLFRIEND_API_KEY) {
            this.apiKey = process.env.AI_GIRLFRIEND_API_KEY;
        }

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
        // 防复读账改为从叙事库已落盘的 lastRecalledAt 派生（_recentlyRecalledStoryIds），
        // 这里不再另存一份内存集合 —— 那份一重启就失忆，而且与库里的数字是两个真相。
        this.personalityDrift = new PersonalityDrift();
        console.log(`[AiGirlfriend] Emotion: ${this.emotionEngine.getEmotionLabel()}, Personality: ${this.personalityDrift.getDominantTraits().join(', ')}`);

        this.openai = null;
        this._chatQueue = Promise.resolve();
        // 队列里**等待+在途**的轮数（审计 HTTP-19）：过去没有上限，脚本或卡死的
        // 前端可以一直 POST /chat，每轮都要等上一轮跑完，请求在链上无限堆积。
        this._queueDepth = 0;
        // 状态世代号：resetAll() 递增它，用来作废那些**不在 _chatQueue 上**的后台副作用
        // （setImmediate 里的记忆写入 / 用户情绪摄入 / 叙事抽取 / 落盘）。
        // 没有它，一次「完全重置」会被几秒后才跑完的在途轮次悄悄写回旧数据。
        this._stateGeneration = 0;
        // REQ-04 事件层（I16）：由 container.js 通过 attachEventBus() 注入；
        // 缺省为 null 时所有发布点静默 no-op（emit 走可选链），保证未装配事件层时零行为变更。
        this.eventBus = null;
        // 触发源注册表引用（可选，container 通过 attachTriggerRegistry 注入）：
        // 仅为 resetAll 能一并清空事件队列/冷却/去重标记；未注入时跳过该步，行为同改造前。
        this.triggerRegistry = null;
        // 主动消息引擎引用（可选，container 通过 attachProactiveEngine 注入）：
        // 仅为 resetAll 能清掉当日配额/冷却/滞留队列与生活日志。
        this.proactiveEngine = null;
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
     * 注入主动消息引擎引用（容器装配时调用）。
     * 只为让 resetAll() 能一并清掉配额/冷却/滞留队列；未注入时该步自动跳过。
     * ProactiveEngine 自身持有 lifeSimulator，所以生活日志顺着这一条引用就能清。
     * @param {object} engine - ProactiveEngine 实例（需有 resetRuntimeState()）
     */
    attachProactiveEngine(engine) {
        this.proactiveEngine = engine || null;
        return this.proactiveEngine;
    }

    /**
     * 安全发布一个业务事件（REQ-04）。事件层未装配 / emit 抛错都只记日志，
     * 绝不影响调用方（对照 I16 的低风险约束）。
     * @param {string} event - 事件名（取自 core/triggerEvents.js 的 TRIGGER_EVENTS）
     * @param {object} payload
     */
    _emitEvent(event, payload) {
        if (!this.eventBus || typeof this.eventBus.emit !== 'function') return;
        // 关闭态安全（B9-1）：事件层关掉后不该再发布任何事件。
        // 旧实现只在下游消费点判开关，发布侧照跑不误（审计 CORE-10）。
        if (!isEventLayerEnabled()) return;
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

        // 恢复运行时开关与高级参数（B9-2）：env 给默认值，上次会话的显式设置覆盖它。
        // 事件层走 setEventLayerEnabled（模块级运行时态的唯一写点），不直接改 config 常量。
        if (data.toggles && typeof data.toggles === 'object') {
            const t = data.toggles;
            if (typeof t.userEmotionEnabled === 'boolean') config.userEmotion.enabled = t.userEmotionEnabled;
            if (typeof t.narrativeEnabled === 'boolean') config.narrative.enabled = t.narrativeEnabled;
            if (typeof t.memoryFactsEnabled === 'boolean') config.memory.facts.enabled = t.memoryFactsEnabled;
            if (['auto', 'embedding', 'keyword'].includes(t.memoryRetrievalMode)) {
                config.memory.retrieval.mode = t.memoryRetrievalMode;
            }
            if (typeof t.triggerEnabled === 'boolean') setEventLayerEnabled(t.triggerEnabled);
            console.log(
                `[State] 恢复开关: userEmotion=${config.userEmotion.enabled ? 'on' : 'off'}`
                + ` narrative=${config.narrative.enabled ? 'on' : 'off'}`
                + ` eventLayer=${isEventLayerEnabled() ? 'on' : 'off'}`
            );
        }
        if (data.chatParams && typeof data.chatParams === 'object') {
            this._applyChatParams(data.chatParams);
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
        // 自定义人设：此前从不持久化 —— 改完人设若没再触发写盘，重启就回到默认人设，
        // 而历史里还留着按旧人设生成的对话，人设与历史对不上。
        if (typeof data.system_prompt === 'string' && data.system_prompt.trim()) {
            this.systemPrompt = data.system_prompt;
            if (this.history.length > 0 && this.history[0]?.role === 'system') {
                this.history[0].content = this.systemPrompt;
            }
            console.log(`[State] Loaded custom system prompt (${this.systemPrompt.length} chars)`);
        }
        // affinity 与 24h 增益事件已迁出到 data/affinity_state.json（AffinityEngine 自持）
    }

    /**
     * 落盘对话状态。**返回是否真正写成功** —— 调用方必须把它计入自己的失败面。
     * 否则 Windows 上 rename 遇 EPERM（杀软/索引句柄占用，很常见）时会出现
     * 「接口回 200 但磁盘还是旧文件」，下次开机整段关系回滚。
     * 只存 baseUrl/modelName 等非敏感配置，API Key 从不落盘。
     */
    _saveState() {
        const ok = writeJson(STATE_FILE, {
            nickname: this.nickname || "亲爱的",
            history: this.history.filter(msg => msg.role !== 'system'),
            system_prompt: this.systemPrompt,
            config: {
                baseUrl: this.baseUrl,
                modelName: this.modelName,
                embeddingBaseUrl: this.embeddingBaseUrl,
                embeddingModelName: this.embeddingModelName
            },
            // 运行时开关与高级参数（审计 CORE-10 / D-7.4）：此前只存 baseUrl/modelName，
            // 于是用户关掉的子系统在下次重启后全部弹回默认「开」，而且界面看不出来。
            // ⚠️ 这里绝不写任何 Key —— state.json 是明文落盘的用户数据文件。
            toggles: {
                userEmotionEnabled: config.userEmotion.enabled,
                narrativeEnabled: config.narrative.enabled,
                triggerEnabled: isEventLayerEnabled(),
                memoryFactsEnabled: config.memory.facts.enabled,
                memoryRetrievalMode: config.memory.retrieval.mode,
            },
            chatParams: this.getChatParams(),
            lastUpdated: new Date().toISOString()
        });
        if (ok) {
            console.log(`[State] Saved state with history and configuration`);
        } else {
            console.error(`[State] 落盘失败：本次修改未持久化（详见 jsonStore 错误日志）`);
        }
        return ok;
    }

    // ==================== LLM 客户端 ====================

    /**
     * 建立 OpenAI 客户端。
     * @returns {boolean} 成功与否 —— 调用方（POST /config）据此决定是 200 还是 400：
     *   旧写法把异常吞进日志、界面照样显示「已保存」，用户要到下一次对话才发现配置坏了。
     */
    initOpenAI() {
        try {
            this.openai = new OpenAI({
                apiKey: this.apiKey,
                baseURL: this.baseUrl,
                // 与前端等待上限对齐，避免后端请求无限挂起
                timeout: config.chat.timeoutMs,
            });
            this._configError = null;
            return true;
        } catch (e) {
            console.error(`Error initializing OpenAI: ${e}`);
            this._configError = `客户端初始化失败：${e?.message || e}`;
            return false;
        }
    }

    /** 当前配置是否能真正发起对话（有 Key 且客户端已建起来） */
    isConfigured() {
        return !!this.apiKey && !!this.openai;
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

    /**
     * 从磁盘重新载入整份状态（档案导入后用，B5-12）。
     *
     * 顺序很重要：先把运行时开关与高级参数**退回 env 默认值**，再跑 _loadState。
     * 否则导入一份「没有 toggles 字段的旧档案」时，当前会话改过的开关会残留下来，
     * 表现为「导入后有一半状态来自上一次会话」——那是最难复现的一类脏状态。
     * 不重建 OpenAI 客户端以外的东西：Key 仍然只在内存里，导入档案不该带 Key。
     */
    reloadState() {
        config.userEmotion.enabled = DEFAULT_TOGGLES.userEmotionEnabled;
        config.narrative.enabled = DEFAULT_TOGGLES.narrativeEnabled;
        config.memory.facts.enabled = DEFAULT_TOGGLES.memoryFactsEnabled;
        config.memory.retrieval.mode = DEFAULT_TOGGLES.memoryRetrievalMode;
        setEventLayerEnabled(DEFAULT_TOGGLES.triggerEnabled);
        for (const [key, value] of Object.entries(DEFAULT_CHAT_PARAMS)) {
            config.chat[key] = value;
        }

        this.nickname = "你";
        this.history = [{ role: "system", content: this.systemPrompt }];
        this.systemPrompt = PERSONA_SYSTEM_PROMPT;
        this._turnCount = 0;
        this._stateGeneration += 1;   // 作废在途的后台收尾，别让旧对话把导入结果盖回去
        this._loadState();
        if (this.memory?.store?.reload) this.memory.store.reload();
        return {
            historyCount: this.history.filter((m) => m.role !== 'system').length,
            nickname: this.nickname,
        };
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
     * @param {object|null} userEmotionFused _finalize 里已经算好的本轮用户情绪融合值
     *        （REQ-02 共振与情绪时间线共用同一份读数）；不传则照旧在摄入时自行分析。
     */
    _persistAfterReply(userInput, replyText, llmUserEmotion = null, affinityDelta = 0, userEmotionFused = null) {
        // 快照要在当前 tick 取，避免后台执行时读到已被后续对话改动的状态
        const snapshot = this.emotionEngine.getSnapshot();
        const generation = this._stateGeneration;
        setImmediate(() => {
            // 期间发生过 resetAll()：这一轮的后台副作用全部作废，
            // 否则刚清空的记忆/用户情绪/叙事会被重置前那一轮的数据重新灌满。
            if (generation !== this._stateGeneration) {
                console.log('[State] 后台收尾已作废（期间执行了完全重置）');
                return;
            }
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
                // 关闭态安全（B9-1）：开关关掉后不分析、不改状态、不落盘。
                // 旧实现照跑不误 —— ingestTurn 会更新时间线并全量重写
                // user_emotion_state.json，还会继续给事件层供数（config.js 注释里
                // 承诺的「关 = 不分析、不注入、不落盘」三条全不成立）。
                if (this.userEmotionEngine && config.userEmotion.enabled) {
                    const r = this.userEmotionEngine.ingestTurn(
                        userInput, replyText, llmUserEmotion, userEmotionFused
                    );
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

    /**
     * 失败轮的统一构造（HTTP-14 / B3-8）：/chat、/chat/stream、队列兜底三处
     * 必须给出同一份文案 + 同一个 error_code，前端只需写一个分支。
     * emotion 取实时标签：兜底轮也必须给前端一个真实存在的标签，不能写死字符串。
     */
    _fallbackResult(classified) {
        return {
            reply: classified.message,
            errorCode: classified.code,
            token_usage: {},
            emotion: this.emotionEngine.getEmotionLabel(),
            affinity: this.affinity,
        };
    }

    /** 还没配 Key 的兜底（稳定码 not_configured，前端据此提示去设置页） */
    _notConfiguredResult() {
        return this._fallbackResult(classifiedByCode(UPSTREAM_ERROR_CODES.NOT_CONFIGURED));
    }

    /**
     * 对话队列是否已经挤满（HTTP-19）。路由在动手写 SSE 头之前先问一句，超出直接 429。
     * 上限 config.logging.maxChatQueue：单用户应用默认 4 轮，够吸收连点，又不会让
     * 一个卡死的前端或脚本把请求堆到无限长。
     */
    isQueueSaturated() {
        return this._queueDepth >= config.logging.maxChatQueue;
    }

    _queueOverflowResult() {
        console.warn(`[Chat] 队列已满（${this._queueDepth}/${config.logging.maxChatQueue}），本轮被拒`);
        return this._fallbackResult(classifiedByCode(UPSTREAM_ERROR_CODES.BUSY));
    }

    /**
     * 入队执行一轮对话。
     *
     * ⚠️ `.catch` 必须留在**被存进 _chatQueue 的那条链内部**：如果先存链、再把 catch
     * 挂在链外，一旦某轮 reject，存下来的就是 rejected promise —— 下一个请求
     * `.then(nextRun)` 会被直接跳过并把同一个 rejection 传下去，于是「A 失败」
     * 连带把 B 也变成兜底回复（互斥队列最坏的失效方式）。
     */
    _enqueueTurn(run, onError) {
        this._queueDepth += 1;
        return this._chatQueue = this._chatQueue
            .then(run)
            .catch(onError)
            .finally(() => { this._queueDepth = Math.max(0, this._queueDepth - 1); });
    }

    /**
     * 串行队列：同一时刻只允许一轮对话在改共享状态（history / affinity /
     * personality / 各 store 数组）。
     *
     * ⚠️ catch 里**绝不能**把 `this._chatQueue` 重新赋成 `Promise.resolve()`：
     * 旧实现在这里做过重置，而 catch 是异步执行的 —— 等它跑的时候，请求 B 已经
     * 挂在 A 后面了，这一赋值会让后来的 C 挂到一条空队列上，与 B **并发执行**，
     * 且此后永久失去互斥（要重启才恢复）。`.catch()` 本身就把 rejection 转成了
     * fulfilled，链条天然不会断，不需要任何手动"续链"。
     */
    async chat(userInput) {
        if (this.isQueueSaturated()) return this._queueOverflowResult();
        return this._enqueueTurn(() => this._doChat(userInput), (e) => {
            const classified = classifyUpstreamError(e);
            console.error(`[Chat] Queue error: ${upstreamLogLine(e, classified)}`);
            // 兜底轮同样走分类文案：旧写法在这里回的是硬编码「发生了点小意外」，
            // 与 _doChat 的兜底不是同一份，前端无法统一处理
            return this._fallbackResult(classified);
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

        // ========== Layer 5: Ghosting 检测（优先于基准更新，避免 nudge 消解冷暴力） ==========
        if (this.emotionEngine.shouldGhost()) {
            console.log(`[Chat] Ghosting triggered: P=${this.emotionEngine.state.P.toFixed(2)}`);
            this.emotionEngine.decay(0.05);
            // 冷暴力 = 已读不回，但**不能当没看见**：这条消息必须进历史并落盘，
            // 否则情绪回正后她完全不知道用户说过什么（实测：连续三条被忽略的消息
            // 在下一轮 prompt 里一条都不存在），刷新页面也会看到自己的消息凭空消失。
            this._recordGhostedInput(userInput);
            // 冷暴力期间用户仍然算「在场」：不打卡的话 lastActiveDate 会冻结，
            // settleDaily 连着几天把他判成失联并触发 S01 扣分（审计 CORE-12）。
            this.personalityDrift.markUserActive(now);
            return {
                done: {
                    reply: null,
                    token_usage: {},
                    // 用真实标签而不是硬编码字符串：前端情绪徽章据此渲染，
                    // 硬编码 "冷漠" 不在前端映射表里，会回落到 default（= 开心）
                    emotion: this.emotionEngine.getEmotionLabel(),
                    affinity: this.affinity,
                    special_action: "ghosting"
                }
            };
        }

        // 打卡只在**真正互动**时刷新：旧实现把 notifyUserActive 放在 ghost 判定之前，
        // 于是冷暴力期间用户的每条消息都替她把「闲置计时」清零 —— miss_you 等
        // 基于离开时长的机制在最该触发的时候永远不会响。
        this.affinityEngine.notifyUserActive(now);

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
        // 全链路容错：任何异常都降级为空段，绝不打断主对话。
        // 关掉开关时整段跳过（B9-1）：旧代码在这里还白跑一次 analyze()，
        // 返回值被丢弃（注释自己承认只是"预热"），约 160 次 includes 扫描/轮。
        let userEmotionPrompt = '';
        try {
            if (config.userEmotion.enabled && this.userEmotionEngine) {
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
     * ghosting 早退时记录用户消息（不调 LLM、不进记忆、不改好感度）。
     * 只保证一件事：这条消息在历史里存在，她「看见了但没回」。
     */
    _recordGhostedInput(userInput) {
        if (!userInput || !userInput.trim()) return;
        this.history.push({ role: 'user', content: userInput });
        this._trimHistory();
        try {
            this._saveState();
        } catch (e) {
            console.error(`[Chat] ghost saveState failed: ${e.message}`);
        }
    }

    /** 裁剪历史：保留最近 MAX_HISTORY 条（含 system prompt），成对删除避免孤立 assistant */
    _trimHistory() {
        while (this.history.length > MAX_HISTORY) {
            this.history.splice(1, 2); // 跳过 [0]=system prompt
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

        // 情绪结算：词表与 LLM 两路**加权混合成一次** apply。
        // 旧写法是先 apply(autoDelta) 再 apply(emotionDelta)，同一个「我今天好难过」
        // 被词表判 −0.2、被模型判 −0.3，两轮叠加后幅度约为设计意图的 2 倍（CORE-13）；
        // 而 LLM 那一路完全没有逐轴裁剪，`{"P":-5}` 可以单轮把 P 砸到 −1 直接 trip ghosting。
        const affinityBefore = this.affinity;
        const stageBefore = getStageForAffinity(affinityBefore);
        const autoDelta = this.emotionEngine.analyzeInput(userInput, affinityBefore);
        const { delta: blendedEmotion } = blendDeltas(autoDelta, emotionDelta, {
            keywordWeight: config.emotion.keywordWeight,
            llmWeight: config.emotion.llmWeight,
        });

        // ========== 【REQ-02 / B6-α①】情绪共振：他的情绪改变她自己的 PAD ==========
        // 此前用户情绪通道只是「读到」（注入 prompt 让她说出安慰的话），她本人的
        // P/A/D 一点不动 —— 于是出现「知道他难过，但她自己不难过」的塑料共情。
        // 用**本轮**的融合读数（词表 + 本轮 metadata），而不是上一轮落盘的状态：
        // 他在这句里说难过，她就在这一句沉下去，而不是下一轮才反应过来。
        let userEmotionFused = null;
        if (config.emotion.resonance.enabled && config.userEmotion.enabled && this.userEmotionEngine) {
            try {
                userEmotionFused = this.userEmotionEngine.fuse(
                    this.userEmotionEngine.analyze(userInput), llmUserEmotion
                );
            } catch (e) {
                console.error(`[Chat] resonance read failed: ${e.message}`);
                userEmotionFused = null;
            }
        }
        const resonance = computeResonanceDelta(
            userEmotionFused, stageBefore.stage, config.emotion.resonance
        );
        const {
            delta: herEmotion, applied: resonanceApplied, clipped: resonanceClipped,
        } = combineWithResonance(blendedEmotion, resonance, config.emotion.totalAxisCap);
        if (resonanceApplied) {
            const f = (v) => (typeof v === 'number' ? v.toFixed(3) : '—');
            console.log(
                `[Chat] 情绪共振 stage=${stageBefore.stage} 用户=${userEmotionFused?.label ?? '?'} ` +
                `→ P:${f(resonance.P)} A:${f(resonance.A)} D:${f(resonance.D)}` +
                (resonanceClipped ? '（已裁剪到单轮总上限）' : '')
            );
        }
        this.emotionEngine.applyDelta(herEmotion);

        this.emotionEngine.decay(0.03);

        // 好感度结算：裁窗 / 疲劳 / 越界 / 超低保护 / 惯性 / 日上限全部在引擎内部完成，
        // 这里只把「用户消息 + LLM 原始变化 + AI 回复」交给引擎，拿回 affinity / trace / 阶段元数据。
        const { affinity, change, trace, meta } =
            this.affinityEngine.recordUserTurn(userInput, affinityChange, replyText);

        // 性格漂移的情绪输入用**混合后再叠加共振**的 P：三个成因都参与了，且不再出现
        // 「模型给了 0 就把词表判定整段抹掉」的情况（旧写法 `emotionDelta?.P ?? autoDelta.P`）
        const sentiment = herEmotion.P ?? autoDelta?.P ?? 0;
        this.personalityDrift.recordUserTurn(userInput, {
            sentiment,
            affinity,
            affinityChange,
        });

        // ========== 【REQ-06 / B6-α②】关系跃迁仪式感 ==========
        // tierChanged 早就由 EmotionEngine 算出来了，但一直没人在结算点上看它。
        // 在**跨过线的那一刻**发布事件（而不是下一轮 _prepare 才发现）：他今天把
        // 好感度推到 60，她今天就可以说「我们好像不一样了」。
        const stageAfter = getStageForAffinity(affinity);
        if (stageAfter.stage !== stageBefore.stage) {
            this._emitStageAdvanced(stageBefore, stageAfter, affinity);
        }

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
        // userEmotionFused 复用上面共振算过的那一份：两个通道必须对「他此刻什么情绪」
        // 给出同一个答案，否则她感受到的和他被记录到的会是两笔账。
        this._persistAfterReply(userInput, replyText, llmUserEmotion, change, userEmotionFused);

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
            // 本轮她因他而起的那部分情绪（REQ-02），null = 未启用或无信号。
            // 只给内部/测试观测，不进 HTTP 契约。
            emotionResonance: resonance,
            // 模型给的情绪/好感度字段不合规时不再静默归零：把原因一路带到响应里，
            // 用户与排障脚本都能看到「这一轮为什么好感度没动」
            parseWarnings: parsed.parseWarnings || [],
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
            // 上游异常一律翻译成分级文案（HTTP-14）：SDK 原文带着上游主机名/模型名，
            // 旧写法把它当回复气泡显示、写进历史、再喂回下一轮 prompt。
            const classified = classifyUpstreamError(e);
            console.error(`Chat Error: ${upstreamLogLine(e, classified)}`);
            return this._fallbackResult(classified);
        }
    }

    /**
     * 流式对话：边生成边通过 onDelta 吐出正文，
     * 让用户看到第一个字的时间从「整段生成完」提前到「首个 token 到达」。
     *
     * @param {AbortSignal} [opts.signal] 客户端断开时由路由 abort：上游 LLM 请求随即中止，
     *        不再"用户都走了还继续把这段生成完并结算好感度"（白花钱 + 状态错位）。
     * @returns 与 chat() 相同结构的结果对象（含完整 reply）
     */
    async chatStream(userInput, onDelta, opts = {}) {
        if (this.isQueueSaturated()) return this._queueOverflowResult();
        // 同 chat()：catch 留在链内（见 _enqueueTurn 的说明），文案与 chat() 同出一处
        return this._enqueueTurn(
            () => this._doChatStream(userInput, onDelta, opts),
            (e) => {
                const classified = classifyUpstreamError(e);
                console.error(`[Chat] Stream queue error: ${upstreamLogLine(e, classified)}`);
                return this._fallbackResult(classified);
            }
        );
    }

    async _doChatStream(userInput, onDelta, { signal } = {}) {
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
            }, { signal });

            let reasoningText = "";
            for await (const chunk of stream) {
                if (signal?.aborted) break;
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
            if (tail && !signal?.aborted) {
                visibleText += tail;
                onDelta(tail);
            }

            const parsed = this._parseReplyText(fullContent, userInput, { cot, monologue, metadata, reasoning: reasoningText });
            // 以实际流式展示给用户的正文为准，保证界面显示与历史记录一致
            if (visibleText.trim()) {
                parsed.replyText = visibleText.trim();
            }
            // 客户端中途断开：正文照旧入库（否则刷新后这条回复凭空消失），
            // 但**跳过情绪/好感度/性格结算与任务动作** —— 半句话不该改变关系。
            if (signal?.aborted) {
                return this._finalizeAborted(userInput, parsed);
            }
            // 注：正文为空（模型只输出了独白/CoT/元数据）时，此前这里再手写一刀正则剥离标签，
            // 现在已无必要——_parseReplyText 的 replyText 来自 streamFilter.parseFullText()
            // 单一真源，三类标签（含未闭合 metadata）都会被状态机统一剥离，不会残留在气泡里。
            return this._finalize(parsed, userInput, null, { nudgeTaskIds });
        } catch (e) {
            // abort 会由 SDK 抛成 AbortError：这不是故障，按「中断的半轮」处理
            if (signal?.aborted || e?.name === 'AbortError') {
                const parsed = this._parseReplyText(fullContent, userInput);
                if (visibleText.trim()) parsed.replyText = visibleText.trim();
                console.log(`[Chat] Stream aborted by client after ${visibleText.length} chars`);
                return this._finalizeAborted(userInput, parsed);
            }
            const classified = classifyUpstreamError(e);
            console.error(`Chat Stream Error: ${upstreamLogLine(e, classified)}`);
            return this._fallbackResult(classified);
        }
    }

    /**
     * 客户端断开后的收尾：只把已生成的正文写进历史并落盘。
     * 刻意不走 _finalize —— 情绪、好感度、性格漂移、任务动作、记忆记录都属于
     * 「这一轮真的完成了」才该发生的结算，半轮不该改关系。
     */
    _finalizeAborted(userInput, parsed) {
        const replyText = (parsed.replyText || '').trim();
        this.history.push({ role: 'user', content: userInput });
        if (replyText) {
            const assistantMsg = { role: 'assistant', content: replyText };
            if (parsed.innerThought) assistantMsg.thought = parsed.innerThought;
            this.history.push(assistantMsg);
        }
        this._trimHistory();
        this._persistAfterReply(userInput, replyText);
        return {
            reply: replyText,
            token_usage: {},
            emotion: this.emotionEngine.getEmotionLabel(),
            affinity: this.affinity,
            aborted: true,
        };
    }

    /**
     * 进入对话前的通用校验，返回非 null 时直接作为结果返回。
     *
     * ⚠️ emotion 一律取**实时标签**，不再写死 "default"（B3-8 情绪哨兵值统一）：
     * "default" 不在 EMOTION_LABELS 里，前端拿到它就回落到开心立绘 —— 于是「她拒绝了你、
     * 界面却在笑」这类穿帮（审计 FE-01 同一个根）。兜底路径最容易忘，所以在这里一次改齐。
     */
    _preChatGuard(userInput) {
        if (!this.openai) {
            const notConfigured = this._notConfiguredResult();
            notConfigured.token_usage = {};
            return notConfigured;
        }
        if (!userInput || !userInput.trim()) {
            return {
                reply: "",
                token_usage: {},
                emotion: this.emotionEngine.getEmotionLabel(),
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
        /** 模型给的情绪/好感度字段不合规时记录在此，随响应透出（不再静默归零） */
        const parseWarnings = [];

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
            // 独白是「只对前端 hover 可见」的私密文本，默认不再整段进日志（HTTP-19）
            debugText('Chat', '内心独白', innerThought);
            if (innerThought.length > 400) {
                console.warn(`[Chat] 内心独白异常长（${innerThought.length} 字符），注意是否混入了模型 CoT`);
            }
        }
        if (modelReasoning) {
            debugText('Chat', `模型 CoT（${modelReasoning.length} 字）`, modelReasoning);
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
                // ---- 解析边界强类型（审计 CORE-11）----
                // `{"affinity_change": "+3"}` 这类引号写法在这个 prompt 下极常见。
                // 旧写法 `|| 0` + 下游 `Number.isFinite` 会把它静默变成 0，
                // 于是「只要模型保持这个习惯，好感度就永久不动」且没有任何告警。
                const coercedAffinity = coerceAffinityChange(metadata.affinity_change);
                affinityChange = coercedAffinity.value;
                if (coercedAffinity.rejected) parseWarnings.push(coercedAffinity.reason);
                // emotion_delta 逐轴强转 + 裁剪到 config.emotion.llmAxisCap（CORE-05）
                const normalizedEmotion = normalizeDelta(metadata.emotion_delta, config.emotion.llmAxisCap);
                const hasAxis = PAD_AXES.some((axis) => normalizedEmotion.delta[axis] !== null);
                emotionDelta = hasAxis ? normalizedEmotion.delta : null;
                if (normalizedEmotion.clipped) parseWarnings.push(`emotion_delta 超出 ±${config.emotion.llmAxisCap} 已裁剪`);
                for (const r of normalizedEmotion.rejected) parseWarnings.push(`emotion_delta.${r}`);
                // 任务意图：老模型不输出这个字段时恒为 null，下游行为完全不变（向后兼容）
                taskAction = metadata.task_action ?? null;
                // 用户情绪（REQ-01）：可选字段，老模型不返回时恒为 null，下游纯用词表兜底
                llmUserEmotion = metadata.user_emotion ?? null;
                if (llmUserEmotion && typeof llmUserEmotion !== 'object') {
                    parseWarnings.push('user_emotion 不是对象，已忽略');
                    llmUserEmotion = null;
                }
            } catch (e) {
                console.error(`Metadata parse error: ${e}. Raw: ${metadataJson}`);
                parseWarnings.push('metadata 不是合法 JSON，已忽略');
            }
        }

        if (parseWarnings.length > 0) {
            console.warn(`[Chat] metadata 解析告警: ${parseWarnings.join('; ')}`);
        }

        return { replyText, emotion, affinityChange, emotionDelta, innerThought, modelReasoning, taskAction, llmUserEmotion, parseWarnings };
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

            console.log(`[AiGirlfriend] 主动消息已生成: ${reason}（${reply.length} 字）`);
            debugText('AiGirlfriend', `主动消息正文 (${reason})`, reply);
            return { reply, emotion, reason };
        } catch (e) {
            console.error("[AiGirlfriend] Proactive generation error:", e);
            return null;
        }
    }

    async _buildProactiveContext(reason, data) {
        let context = "";

        if (reason === 'memory_share') {
            // 优先分享「我们之间的故事」（叙事层）而不是原始对话轮：
            // PRD §2.3 的 memory_share 升级早就设计好了（NarrativeRetriever.getRandomStory
            // + NarrativeStore.markRecalled），但一直没接上，她还在复述流水账（CORE-19）。
            const story = this._pickStoryForSharing();
            if (story) {
                const summary = (story.summary || '').slice(0, 80);
                context += `\n- 你们之间的一段共同经历: 「${story.title}」`
                    + (summary ? `（${summary}）` : '')
                    + '\n  可以自然地提起来（「你还记得那次…」），但不要逐字复述。';
                return context;
            }
            if (this.memory) {
                try {
                    // 叙事池还空着（新用户）→ 退回情节记忆，走 facade 方法
                    const memory = this.memory.getRandomMemory(5);
                    if (memory) {
                        context += `\n- 可参考的历史记忆: "${memory.text.substring(0, 100)}..."`;
                    }
                } catch (e) {
                    // 忽略记忆检索失败，不影响主动消息生成
                }
            }
        }

        return context;
    }

    /**
     * 挑一条「我们之间的故事」用于主动分享，并记账（recallCount / lastRecalledAt）。
     * 叙事层关闭或池子为空时返回 null，调用方退回情节记忆 —— 关闭态安全。
     *
     * 防复读账（B6-α④）：旧写法是「随机重掷最多 4 次，撞上最近讲过的就再掷」，
     * 池子小的时候四次基本都掷回同一条，最后走「允许重复」的兜底分支，
     * 而那条兜底**连账都不记**（recallCount 不涨、去重集合不加）。
     * 现在一次挑完：先按冷却窗排除，全在冷却期就退回最久没提的那批，
     * 无论哪条出来都照样 markRecalled —— 她说过几次，库里的数字就是几次。
     */
    _pickStoryForSharing(excludeRecentN = 5) {
        if (!this._narrativeEnabled() || !this.narrativeRetriever || !this.narrativeStore) return null;

        let story = null;
        try {
            story = this.narrativeRetriever.getRandomStory(excludeRecentN, {
                excludeIds: this._recentlyRecalledStoryIds(),
            });
        } catch (e) {
            console.error(`[Narrative] getRandomStory failed: ${e.message}`);
            return null;
        }
        if (!story) return null;

        try {
            this.narrativeStore.markRecalled(story.id);
            this.narrativeStore.scheduleSave();
        } catch (e) {
            console.error(`[Narrative] markRecalled failed: ${e.message}`);
        }
        return story;
    }

    /**
     * 正在「提过之后不再重复提」冷却窗内的故事 id 集合。
     *
     * 数据源是叙事库里**已落盘**的 lastRecalledAt（不是内存集合）：
     * 重启后她依然记得哪件事前几天刚说过（旧实现的 _recentStoryIds 一重启就失忆）。
     */
    _recentlyRecalledStoryIds(now = Date.now()) {
        const windowMs = config.narrative.recallCooldownMs;
        const ids = new Set();
        for (const n of this.narrativeStore?.narratives || []) {
            if (Number.isFinite(n.lastRecalledAt) && now - n.lastRecalledAt < windowMs) ids.add(n.id);
        }
        return ids;
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

    /**
     * 主动消息的结局回灌到她自己的情绪里（REQ-02 / B6-α③）。
     *
     * 为什么该有这一条：`docs/proactive-consistency/DIAGNOSIS.md` 当年写的是
     * 「主动消息不反馈情绪，保持简单，不闭环」，但那留下的是一句假话 ——
     * 她可以连续主动找他四回，自己心里一点波澜都没有；他不在的时候那些消息
     * 烂在队列里，她也毫无感觉。真人递出去的心意是要有回音的：
     *   · 被接住（他回到应用、消息真的送到了）→ 按类型各加一点（见 proactiveTypes.emotionFeedback）；
     *   · 落了空（TTL 超时被丢弃）→ 失落。自发类才有这一份，早安/任务提醒过期只是时间过了。
     *
     * 失落不是惩罚用户，而是让「被冷落」自己长出行为：P 掉到情绪闸门的 suppress/block
     * 档，她下一次主动搭话的意愿随之下降 —— 不需要再写一条「冷落规则」。
     *
     * @param {'delivered'|'expired'} kind 消息结局
     * @param {{reason?:string}} message 队列里的消息项（只读 reason）
     * @returns {object|null} 实际生效的增量（未启用/无该项时 null）
     */
    recordProactiveOutcome(kind, message = {}) {
        const cfg = config.emotion.proactiveFeedback;
        if (!cfg?.enabled) return null;
        const reason = message?.reason;
        if (!reason) return null;

        const type = getProactiveType(reason);
        if (!type) return null;

        let feedback = null;
        if (kind === 'delivered') {
            feedback = type.emotionFeedback ?? null;
        } else if (kind === 'expired') {
            // 只有「她主动递出去的心意」落空才失落；定时问候与任务提醒不属于此类
            if (!type.spontaneous) return null;
            feedback = PROACTIVE_EXPIRY_FEEDBACK;
        } else {
            return null;
        }
        if (!feedback) return null;

        const { delta } = normalizeDelta(feedback, config.emotion.totalAxisCap);
        const before = this.emotionEngine.state.P ?? 0;
        const after = this.emotionEngine.applyDelta(delta, cfg.inertia);
        console.log(
            `[Proactive] 情绪回灌 ${kind} (${reason}) ` +
            `P ${before.toFixed(3)}→${(after?.P ?? before).toFixed(3)}`
        );
        return delta;
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
        return this._saveState();
    }

    /**
     * 完全重置：清对话历史 + 好感度 + 性格 + 情绪 + 任务 + 长期记忆
     * （设置页「完全重置」的语义）。
     *
     * 与 clearHistory() 的区别就在「要不要抹掉整段关系」。affinityEngine.reset()
     * 与 memory.clearMemory() 各自会落盘，这里最后再补一次 _saveState() 把
     * history 一并收尾，保证多份数据同批落盘。
     *
     * 清理范围（11 类；proactive/lifeLog/triggerRegistry 仅在容器已装配时生效）：
     *   1. history        → data/state.json（保留 system prompt）
     *   2. affinityEngine → data/affinity_state.json（好感度/账本/增益）
     *   3. personalityDrift → data/personality_state.json（性格回预设）
     *   4. emotionEngine  → data/emotion_state.json（情绪回初值）
     *   5. userEmotionEngine → data/user_emotion_state.json（用户情绪时间线，REQ-01）
     *   6. narrative      → data/narrative.json（共同经历叙事，REQ-03）
     *   7. TaskManager    → data/tasks.json（任务全清）
     *   8. memory         → data/memory.json（情节+事实）
     *   9. proactiveEngine→ data/proactive_state.json（配额/冷却/队列/复读样本，保留配置）
     *  10. lifeSimulator  → data/life_log.json（生活日志）
     *  11. triggerRegistry→ data/trigger_state.json（事件队列/冷却/去重，REQ-04）
     *
     * 容错策略：各引擎独立重置，任一失败只记录并继续，最后把失败的引擎名回传，
     * 避免「某个引擎抛错导致后续引擎全部没重置」的半重置状态。落盘失败同样进 failed
     * （旧实现只收集 throw，而 `_saveState` 从不 throw —— 写盘失败被吞成成功）。
     * （真正的事务回滚需要跨文件快照，成本过高；这里保证「尽力全部重置」并把
     *   失败面如实暴露给调用方与日志，好过静默留下半重置。）
     *
     * @returns {Promise<{ reset: string[], failed: { step: string, message: string }[] }>}
     */
    async resetAll() {
        // ① 先排空在途对话：resetAll 若与一轮生成并发，那一轮的 _finalize 会在清空之后
        //    把 history/好感度/记忆重新写回去，用户拿到「重置成功」但数据只脏了一轮。
        // ② 再递增世代号，作废那些**不在队列上**的后台副作用（setImmediate 收尾、
        //    记忆嵌入、事实/叙事抽取、用户情绪摄入）。
        await this._chatQueue.catch(() => { /* 队列内的错误已由 chat()/chatStream() 兜底 */ });
        this._stateGeneration++;

        /**
         * ③ 清空之前先落一份快照（B5-12）：「完全重置」在以前是不可逆的 ——
         * 手滑一次就抹掉几个月甚至几年的对话、记忆与关系，而 UI 上只有一句确认。
         * 先 flush 再快照，否则去抖里未落盘的数据（最近几轮）不会出现在快照里，
         * 而那恰恰是最可能被误删、也最想找回的部分。
         */
        let snapshot = null;
        try {
            this._saveState();
            this.affinityEngine._saveState();
            this.emotionEngine._saveState();
            this.personalityDrift._saveState();
            this.memory?.flush?.();
            this.flushNarratives?.();
            this.flushUserEmotion?.();
            snapshot = createSnapshot('pre-reset', new Date());
        } catch (e) {
            // 快照失败绝不阻断重置（用户已经明确要求清空），但必须如实报出来
            console.error(`[Reset] 重置前快照失败（仍可继续重置，但这次不可回滚）: ${e.message}`);
        }

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
            // 2026-10 审计 B0-5 补齐这两类：此前「完全重置」不清它们，于是
            // 重置后仍会投递按旧关系生成的滞留主动消息（最多 5 条），且当日配额
            // 已烧完 —— 主动关怀要到零点才恢复；生活日志也留着上一段关系的痕迹。
            ['proactive', () => this.proactiveEngine?.resetRuntimeState?.()],
            ['lifeLog', () => this.proactiveEngine?.lifeSimulator?.resetLog?.()],
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
        // 写失败必须进 failed：否则会出现「接口说重置成功、磁盘还是旧数据」。
        try {
            if (!this._saveState()) {
                failed.push({ step: 'state', message: 'state.json 落盘失败（未持久化）' });
            }
        } catch (e) {
            failed.push({ step: 'state', message: e?.message || String(e) });
            console.error(`[AiGirlfriend] resetAll: final _saveState failed: ${e?.message || e}`);
        }

        return {
            reset,
            failed,
            // 快照目录回给调用方（设置页要能告诉用户「万一后悔，在这里」）；
            // 失败时是 null，界面据此显示「本次重置不可回滚」而不是假装有个快照。
            snapshot: snapshot?.dir ?? null,
            snapshotFiles: snapshot?.files?.length ?? 0,
        };
    }

    /**
     * 重置叙事层（「完全重置」的一步）：清空叙事池与轮次计数，作废在途抽取，立即落盘。
     * 与记忆层独立：叙事清空不影响 MemoryStore，反之亦然。
     */
    _resetNarratives() {
        this._narrativeGeneration++;
        this._turnCount = 0;
        if (this.narrativeStore) {
            this.narrativeStore.clear();
            this.narrativeStore._saveNow();
        }
    }

    getSystemPrompt() {
        return this.systemPrompt;
    }

    /**
     * 更新人设 prompt。
     *
     * 旧实现是 `this.history = [{role:'system', content:newPrompt}]` —— 一次改人设
     * 等于把整段对话清空（而且不落盘，重启后旧历史又带着默认人设复活）。
     * 现在只**就地替换** history[0]，对话内容一条不动，并立即持久化。
     *
     * @returns {{saved:boolean, historyCount:number, promptLength:number}}
     */
    updateSystemPrompt(newPrompt) {
        if (typeof newPrompt !== 'string' || !newPrompt.trim()) {
            throw Object.assign(new Error('system_prompt 必须是非空字符串'), { status: 400 });
        }
        if (newPrompt.length > SYSTEM_PROMPT_MAX) {
            throw Object.assign(
                new Error(`system_prompt 过长（${newPrompt.length} 字符，上限 ${SYSTEM_PROMPT_MAX}）`),
                { status: 400 }
            );
        }
        this.systemPrompt = newPrompt;
        if (this.history.length > 0 && this.history[0]?.role === 'system') {
            this.history[0].content = newPrompt;
        } else {
            this.history.unshift({ role: 'system', content: newPrompt });
        }
        return {
            saved: this._saveState(),
            historyCount: this.history.filter(m => m.role !== 'system').length,
            promptLength: newPrompt.length,
        };
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

        // 空值语义（与 routes/configRoutes.js + utils/configValidation.js 同一套口径）：
        //   undefined = 没带这个字段，不动；null = 显式清空；'' 对主 Key 表示「未提供」，
        //   因为前端 useBootstrap 每次挂载都会把 localStorage 的空值序列化成 ''，
        //   把 '' 当成清空会在一个没存 Key 的浏览器里抹掉 AI_GIRLFRIEND_API_KEY 的兜底值。
        if (cfg.apiKey === null) {
            if (this.apiKey !== null) { this.apiKey = null; changed = true; }
        } else if (cfg.apiKey && cfg.apiKey !== this.apiKey) {
            this.apiKey = cfg.apiKey;
            changed = true;
        }
        if (cfg.baseUrl === null || cfg.baseUrl === '') {
            if (this.baseUrl !== DEFAULT_BASE_URL) { this.baseUrl = DEFAULT_BASE_URL; changed = true; }
        } else if (cfg.baseUrl && cfg.baseUrl !== this.baseUrl) {
            this.baseUrl = cfg.baseUrl;
            changed = true;
        }
        if (cfg.modelName === null || cfg.modelName === '') {
            if (this.modelName !== DEFAULT_MODEL_NAME) { this.modelName = DEFAULT_MODEL_NAME; changed = true; }
        } else if (cfg.modelName && cfg.modelName !== this.modelName) {
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

        let clientOk = true;
        if (changed) {
            if (this.apiKey) clientOk = this.initOpenAI();
            if (this.memory) {
                this.memory.updateConfig({
                    apiKey: this.apiKey,
                    baseUrl: this.baseUrl,
                    embeddingApiKey: this.embeddingApiKey,
                    embeddingBaseUrl: this.embeddingBaseUrl,
                    embeddingModelName: this.embeddingModelName
                });
            }
            // 初始化失败也绝不落盘那份坏配置：旧写法先 _saveState() 再建客户端，
            // 于是一次填错的 Base URL 会跟着重启一起活过来，每轮都失败。
            if (clientOk) this._saveState();
            else {
                console.error(`[Config] 拒绝保存：${this._configError}`);
                return {
                    modelName: this.modelName,
                    baseUrl: this.baseUrl,
                    configured: false,
                    configError: this._configError,
                };
            }
            console.log(`[Config] Updated: model=${this.modelName}, baseUrl=${this.baseUrl}`);
        } else if (paramsChanged || memoryParamsChanged || companionParamsChanged) {
            // 只改了开关/高级参数（没动连接配置）也必须落盘：旧实现这里不写盘，
            // 于是用户关掉的子系统在下次重启后全部弹回默认「开」（审计 CORE-10 / D-7.4）。
            this._saveState();
        }

        return {
            modelName: this.modelName,
            baseUrl: this.baseUrl,
            configured: clientOk && (!this.apiKey || !!this.openai),
            configError: clientOk ? null : this._configError,
        };
    }

    updateState(updates) {
        if (typeof updates.affinity === 'number') {
            this.affinityEngine.setAffinity(updates.affinity);
        }
        if (updates.nickname !== undefined) {
            this.nickname = updates.nickname;
        }
        const state = this.getState();
        // 把落盘结果随状态一起回给调用方：路由据此决定是 200 还是带 persisted:false
        state.persisted = this._saveState();
        return state;
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
        const { enabled: _staticEnabled, ...registryConfig } = config.triggerRegistry;
        return {
            userEmotionEnabled: config.userEmotion.enabled,
            narrativeEnabled: config.narrative.enabled,
            // 事件层运行时开关（可由 POST /config 热更新，重启后从 state.json 恢复）
            triggerEnabled: isEventLayerEnabled(),
            // 事件层配置块。**剔除其中的静态 enabled 默认值**：它和上面的 triggerEnabled
            // 同时下发会出现一个响应里两个真相（前端读到哪个都可能错，审计 CORE-10/HTTP-19）
            triggerRegistry: registryConfig,
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
                await this._applyNarrativeOps(ops, generation);
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
    async _applyNarrativeOps(ops, generation = this._narrativeGeneration) {
        /** 每条 add/update 都要 await 嵌入，清空可能落在任意两次等待之间 */
        const stale = () => generation !== this._narrativeGeneration;

        // delete
        for (const id of ops.delete) {
            this.narrativeStore.removeNarrative(id);
        }

        // update
        for (const upd of ops.update) {
            if (stale()) return;
            const norm = NarrativeExtractor.normalizeUpdate(upd);
            if (!norm) continue;
            const updated = this.narrativeStore.updateNarrative(norm.id, norm);
            // 摘要变更后重算嵌入，保证语义检索用最新文本
            if (updated && norm.summary && this.memory?.embedding) {
                try {
                    const emb = await this.memory.embedding.embed(`${updated.title} ${updated.summary}`);
                    if (stale()) return;
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
            if (stale()) return;
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
            if (stale()) return;
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
        if (ok) this.narrativeStore.scheduleSave();
        return ok;
    }

    /**
     * 记录「她已经就某条约定追问过一次」（REQ-04 → REQ-05 的闭环，审计 CORE-03/CORE-19）。
     *
     * `followupCount` 是 promiseFollowupTrigger 的上限判定依据，同时也是它 dedupeKey 的
     * 一部分：不自增的话，一条约定最多只会被追问一次（第 2 次起 dedupeKey 不变、被去重表拦掉），
     * 而 maxFollowups=3 的判定永远为假。
     * @returns {number|null} 自增后的次数；叙事不存在时返回 null
     */
    recordNarrativeFollowup(narrativeId) {
        if (!this.narrativeStore || !narrativeId) return null;
        const narrative = (this.narrativeStore.narratives || []).find((n) => n.id === narrativeId);
        if (!narrative) return null;
        narrative.followupCount = (Number.isFinite(narrative.followupCount) ? narrative.followupCount : 0) + 1;
        narrative.lastFollowupAt = Date.now();
        this.narrativeStore.scheduleSave();
        console.log(`[Narrative] 约定「${narrative.title}」已追问 ${narrative.followupCount} 次`);
        return narrative.followupCount;
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
        // 关闭态安全（B9-1）：叙事层关掉后不再发里程碑事件。
        // 旧实现没有这道判定，关着叙事仍会为每条纪念日/约定发 NARRATIVE_MILESTONE，
        // 进而产出 anniversary_recall / promise_followup 主动消息 —— 等于引用一个
        // 已被用户关闭的功能的素材（审计 CORE-10）。
        if (!this._narrativeEnabled()) return;

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

    /**
     * 发布关系阶段跃迁事件（REQ-06 / B6-α②）。
     *
     * 上下游分工：本方法只把**事实**发出去（跨过了哪条线、朝哪个方向、新阶段解锁了什么），
     * 「要不要专门说一句」由 stageTransitionTrigger 判定（当前只有向上），
     * 「能不能说」再交给 ProactiveEngine.trigger() 的全部闸门。
     * 事件层关闭时 _emitEvent 自己就是空操作，这里不额外判开关。
     */
    _emitStageAdvanced(stageBefore, stageAfter, affinity) {
        this._emitEvent(TRIGGER_EVENTS.STAGE_ADVANCED, {
            fromStage: stageBefore.stage,
            fromLabel: stageBefore.label,
            toStage: stageAfter.stage,
            toLabel: stageAfter.label,
            direction: RELATIONSHIP_STAGES.indexOf(stageAfter) > RELATIONSHIP_STAGES.indexOf(stageBefore)
                ? 'up' : 'down',
            affinity,
            unlocks: stageAfter.unlocks || [],
            ts: Date.now(),
        });
        console.log(`[Chat] 关系跃迁 ${stageBefore.label} → ${stageAfter.label}（好感度 ${affinity}）`);
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
