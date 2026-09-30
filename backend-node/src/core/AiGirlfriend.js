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
import PersonalityDrift from './PersonalityDrift.js';
import AffinityEngine from './AffinityEngine.js';
import { PERSONA_SYSTEM_PROMPT, buildSystemContext } from './prompts/systemPrompt.js';
import { buildRelationshipContext } from './prompts/relationshipContext.js';
import { buildProactivePrompt, buildProactiveDirective, buildProactivePersonaDirective } from './prompts/proactivePrompts.js';
import { buildTaskContextText, buildTaskActionInstruction, buildTaskNudgeText, pickNudgeTasks } from './prompts/taskPrompt.js';
import { executeTaskAction } from './taskActions.js';
import { dataPath, readJson, writeJson } from '../utils/jsonStore.js';
import { config } from '../config.js';
import { createStreamFilter, splitDelta, extractReasoning } from './streamFilter.js';

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
            embeddingModelName: this.embeddingModelName
        });

        this.emotionEngine = new EmotionEngine();
        this.personalityDrift = new PersonalityDrift();
        console.log(`[AiGirlfriend] Emotion: ${this.emotionEngine.getEmotionLabel()}, Personality: ${this.personalityDrift.getDominantTraits().join(', ')}`);

        this.openai = null;
        this._chatQueue = Promise.resolve();
        if (this.apiKey) {
            this.initOpenAI();
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
    _applyChatParams({ maxPromptHistory, temperature, maxTokens, reasoningEffort } = {}) {
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
        if (setNumber('temperature', temperature, 0, 2)) changed = true;
        // maxTokens: 0 是合法值，语义为「不传 max_tokens」
        if (setNumber('maxTokens', maxTokens, 0, 1_000_000)) changed = true;

        if (reasoningEffort !== undefined && reasoningEffort !== null) {
            const next = ['low', 'medium', 'high'].includes(reasoningEffort) ? reasoningEffort : '';
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
            temperature: config.chat.temperature,
            maxTokens: config.chat.maxTokens,
            reasoningEffort: config.chat.reasoningEffort
        };
    }

    /**
     * 构造发送给 LLM 的消息：system prompt + 最近 N 条历史。
     * 完整历史仍保留在 this.history 并落盘，这里只裁剪 prompt 以加快生成。
     * 条数 N 即 config.chat.maxPromptHistory（设置页「高级选项」可改）。
     */
    _buildPromptMessages() {
        // history 里的 assistant 消息可能带 thought（内心独白），只对前端有意义，
        // 这里统一剥成 { role, content }，避免多余字段打进 LLM 请求。
        const toPromptMsg = (m) => ({ role: m.role, content: m.content });
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
     */
    _persistAfterReply(userInput, replyText) {
        // 快照要在当前 tick 取，避免后台执行时读到已被后续对话改动的状态
        const snapshot = this.emotionEngine.getSnapshot();
        setImmediate(() => {
            if (this.memory) {
                this.memory
                    .addMemory(`User: ${userInput}\nXiao Ai: ${replyText}`, { emotionSnapshot: snapshot })
                    .catch((e) => console.error(`[Chat] addMemory failed: ${e.message}`));
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

        // ========== Layer 4: 情感染色记忆检索 ==========
        let contextStr = "";
        if (this.memory) {
            const context = await this.memory.getRelevantContext(userInput, this.emotionEngine.state);
            if (context) {
                contextStr = `\n[Relevant Memories]:\n${context}\n`;
                console.log(`Found context: ${context.substring(0, 100)}...`);
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
        const { replyText, affinityChange, emotionDelta, innerThought, modelReasoning, taskAction } = parsed;

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
        this._persistAfterReply(userInput, replyText);

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
            } else if (parsed.innerThought || parsed.modelReasoning) {
                // 正文为空（模型只输出了独白/CoT/元数据）时，_parseReplyText 的正则剥离
                // 分支被 hints 短路，标签原文会残留在 replyText 里直接下发到气泡——补一刀
                parsed.replyText = parsed.replyText
                    .replace(/<monologue>[\s\S]*?<\/monologue>/g, "")
                    .replace(/<think>[\s\S]*?<\/think>/g, "")
                    .trim();
            }
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
        let replyText = raw;
        let emotion = "default";
        let affinityChange = 0;
        let emotionDelta = null;
        let innerThought = null;
        let modelReasoning = null;
        let metadataJson = null;
        let taskAction = null;

        // ---- 人设内心独白 <monologue> ----
        let monologue = (hints.monologue || "").trim();
        if (!monologue) {
            const m = raw.match(/<monologue>(.*?)<\/monologue>/s);
            if (m) {
                monologue = m[1].trim();
                replyText = replyText.replace(m[0], "").trim();
            }
        }

        // ---- 模型 CoT（正文里的 <think>）----
        let cot = (hints.cot || "").trim();
        if (!cot) {
            const t = raw.match(/<think>(.*?)<\/think>/s);
            if (t) {
                cot = t[1].trim();
                replyText = replyText.replace(t[0], "").trim();
            }
        }

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
        if (hints.metadata) {
            metadataJson = hints.metadata;
            // 正文里可能残留标签片段，一并清掉（含未闭合的情况）
            replyText = replyText
                .replace(/<metadata>[\s\S]*?<\/metadata>/s, "")
                .replace(/<metadata>[\s\S]*$/s, "")
                .trim();
        } else {
            const match = replyText.match(/<metadata>\s*({.*?})\s*<\/metadata>/s)
                || raw.match(/<metadata>\s*({.*?})\s*<\/metadata>/s);
            if (match) {
                replyText = replyText.replace(match[0], "").trim();
                metadataJson = match[1];
            } else {
                // 未闭合的 <metadata>（生成被 max_tokens 截断在 metadata 中间）：
                // 流式路径会把残片收进 metadata hint、不进气泡；非流式这里对齐同一行为，
                // 否则截断的 JSON 原文会直接展示给用户
                const unclosed = replyText.match(/<metadata>\s*([\s\S]*)$/s)
                    || raw.match(/<metadata>\s*([\s\S]*)$/s);
                if (unclosed) {
                    metadataJson = unclosed[1];
                    replyText = replyText.replace(/<metadata>[\s\S]*$/s, "").trim();
                }
            }
        }

        if (metadataJson) {
            try {
                const normalized = metadataJson.replace(/:\s*\+([0-9.]+)/g, ': $1');
                const metadata = JSON.parse(normalized);
                emotion = metadata.emotion || "default";
                affinityChange = metadata.affinity_change || 0;
                emotionDelta = metadata.emotion_delta || null;
                // 任务意图：老模型不输出这个字段时恒为 null，下游行为完全不变（向后兼容）
                taskAction = metadata.task_action ?? null;
            } catch (e) {
                console.error(`Metadata parse error: ${e}. Raw: ${metadataJson}`);
            }
        }

        return { replyText, emotion, affinityChange, emotionDelta, innerThought, modelReasoning, taskAction };
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
            // 主动消息直接进气泡，CoT 与独白标签一并清掉（万一模型带了出来）
            let reply = content
                .replace(/<think>[\s\S]*?<\/think>/gs, "")
                .replace(/<monologue>[\s\S]*?<\/monologue>/gs, "")
                .trim();
            let emotion = "default";

            const metadataRegex = /<metadata>\s*({.*?})\s*<\/metadata>/s;
            const match = content.match(metadataRegex);
            if (match) {
                reply = reply.replace(match[0], "").trim();
                try {
                    let metadataJson = match[1];
                    metadataJson = metadataJson.replace(/:\s*\+([0-9]+)/g, ': $1');
                    const metadata = JSON.parse(metadataJson);
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
                const memories = this.memory.memories;
                if (memories && memories.length > 0) {
                    const oldMemories = memories.slice(0, Math.max(1, memories.length - 5));
                    const randomMemory = oldMemories[Math.floor(Math.random() * oldMemories.length)];
                    if (randomMemory) {
                        context += `\n- 可参考的历史记忆: "${randomMemory.text.substring(0, 100)}..."`;
                    }
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
     * 完全重置：清对话历史 + 好感度 + 长期记忆（设置页「完全重置」的语义）。
     *
     * 与 clearHistory() 的区别就在「要不要抹掉整段关系」。affinityEngine.reset()
     * 与 memory.clearMemory() 各自会落盘，这里最后再补一次 _saveState() 把
     * history 一并收尾，保证三份数据同批落盘。
     */
    resetAll() {
        this.history = [{ role: "system", content: this.systemPrompt }];
        this.affinityEngine.reset();
        this.personalityDrift.reset();
        if (this.memory) {
            this.memory.clearMemory();
        }
        this._saveState();
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
            memoryCount: this.memory ? this.memory.memories.length : 0,
            // 平铺情绪标签：前端刷新后 syncState 直接回填主徽章，
            // 不用等下一条消息的 chat 响应才校正
            emotion: this.emotionEngine ? this.emotionEngine.getEmotionLabel() : null,
            emotionalState: this.emotionEngine ? this.emotionEngine.getFullState() : null,
            // 平铺阶段元数据 + recentChangeReason / decaying / dailyCapReached，
            // 前端 /state 与 /chat 响应共用同一份字段（前端零阈值）。
            ...this.affinityEngine.getMeta()
        };
    }

    updateConfig(config) {
        let changed = false;

        if (config.apiKey && config.apiKey !== this.apiKey) {
            this.apiKey = config.apiKey;
            changed = true;
        }
        if (config.baseUrl && config.baseUrl !== this.baseUrl) {
            this.baseUrl = config.baseUrl;
            changed = true;
        }
        if (config.modelName && config.modelName !== this.modelName) {
            this.modelName = config.modelName;
            changed = true;
        }
        // 嵌入配置允许「清空回退」：前端把输入框清空会送来空串，
        // 这里归一化成 null，Memory 层随即回退到「使用主 Key」的语义
        if (config.embeddingApiKey !== undefined) {
            const nextKey = config.embeddingApiKey === '' ? null : config.embeddingApiKey;
            if (nextKey !== this.embeddingApiKey) {
                this.embeddingApiKey = nextKey;
                changed = true;
            }
        }
        if (config.embeddingBaseUrl !== undefined) {
            const nextUrl = config.embeddingBaseUrl === '' ? null : config.embeddingBaseUrl;
            if (nextUrl !== this.embeddingBaseUrl) {
                this.embeddingBaseUrl = nextUrl;
                changed = true;
            }
        }
        if (config.embeddingModelName !== undefined) {
            const nextModel = config.embeddingModelName === '' ? null : config.embeddingModelName;
            if (nextModel !== this.embeddingModelName) {
                this.embeddingModelName = nextModel;
                changed = true;
            }
        }

        // 高级选项（上下文条数 / 温度 / 最大输出 / 思考强度）：写运行时 config.chat，
        // 单独记 changed，不并入上面的连接类变更（改这些不需要重建 OpenAI 客户端）。
        const paramsChanged = this._applyChatParams({
            maxPromptHistory: config.maxPromptHistory,
            temperature: config.temperature,
            maxTokens: config.maxTokens,
            reasoningEffort: config.reasoningEffort
        });
        if (paramsChanged) {
            const p = this.getChatParams();
            console.log(
                `[Config] Chat params: history=${p.maxPromptHistory}, temperature=${p.temperature}, ` +
                `maxTokens=${p.maxTokens > 0 ? p.maxTokens : 'auto'}, reasoningEffort=${p.reasoningEffort || 'off'}`
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

    getMemories() {
        if (!this.memory) return [];
        return this.memory.memories.map(m => ({
            id: m.id,
            text: m.text,
            timestamp: m.timestamp
        }));
    }

    clearMemoriesOnly() {
        if (this.memory) {
            this.memory.clearMemory();
        }
    }
}

export default AiGirlfriend;
