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
import TaskManager from './TaskManager.js';
import EmotionEngine from './EmotionEngine.js';
import PersonalityDrift from './PersonalityDrift.js';
import { validateAffinityChange } from './affinityRules.js';
import { PERSONA_SYSTEM_PROMPT, buildSystemContext } from './prompts/systemPrompt.js';
import { buildRelationshipContext } from './prompts/relationshipContext.js';
import { buildProactivePrompt, buildProactiveDirective, buildProactivePersonaDirective } from './prompts/proactivePrompts.js';
import { dataPath, readJson, writeJson } from '../utils/jsonStore.js';

dotenv.config();

const STATE_FILE = 'state.json';
const MAX_HISTORY = 200;

class AiGirlfriend {
    constructor(config = {}) {
        this.statePath = dataPath(STATE_FILE);
        this.systemPrompt = PERSONA_SYSTEM_PROMPT;

        this.apiKey = null;
        this.baseUrl = "https://api.openai.com/v1";
        this.modelName = "gpt-3.5-turbo";
        this.embeddingApiKey = null;
        this.embeddingBaseUrl = null;
        this.embeddingModelName = null;

        this.affinity = 35;
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

        if (typeof data.affinity === 'number') {
            this.affinity = data.affinity;
            console.log(`[State] Loaded affinity: ${this.affinity}`);
        }

        if (data.nickname) {
            this.nickname = data.nickname;
            console.log(`[State] Loaded nickname: ${this.nickname}`);
        }
    }

    _saveState() {
        const ok = writeJson(STATE_FILE, {
            affinity: this.affinity,
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
                baseURL: this.baseUrl
            });
        } catch (e) {
            console.error(`Error initializing OpenAI: ${e}`);
        }
    }

    // ==================== 对话主流程 ====================

    async chat(userInput) {
        return this._chatQueue = this._chatQueue.then(() => this._doChat(userInput)).catch(e => {
            console.error(`[Chat] Queue error: ${e.message}`);
            this._chatQueue = Promise.resolve();
            return { reply: "发生了点小意外", token_usage: {}, emotion: this.emotionEngine.getEmotionLabel(), affinity: this.affinity };
        });
    }

    async _doChat(userInput) {
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

        // ========== Layer 5: Ghosting 检测（优先于基准更新，避免 nudge 消解冷暴力） ==========
        if (this.emotionEngine.shouldGhost()) {
            console.log(`[Chat] Ghosting triggered: P=${this.emotionEngine.state.P.toFixed(2)}`);
            this.emotionEngine.decay(0.05);
            return {
                reply: null,
                token_usage: {},
                emotion: "冷漠",
                affinity: this.affinity,
                special_action: "ghosting"
            };
        }

        // ========== Layer 0: 亲和度驱动情感基准 ==========
        this.emotionEngine.updateBaselineForAffinity(this.affinity);

        // ========== 性格漂移：每日统计更新 ==========
        const todayStr = new Date().toDateString();
        const todayMsgCount = this.history.filter(m => m.role === 'user' && new Date(m.timestamp || Date.now()).toDateString() === todayStr).length;
        this.personalityDrift.updateDailyStats(todayMsgCount + 1);

        // ========== Layer 4: 情感染色记忆检索 ==========
        let contextStr = "";
        if (this.memory) {
            const context = await this.memory.getRelevantContext(userInput, this.emotionEngine.state);
            if (context) {
                contextStr = `\n[Relevant Memories]:\n${context}\n`;
                console.log(`Found context: ${context.substring(0, 100)}...`);
            }
        }

        // ========== 构建消息 ==========
        const messagesToSend = [...this.history];

        const pendingTasks = TaskManager.getPendingTasks();
        const taskSummary = TaskManager.getSummary();
        let taskText = `用户当前有 ${taskSummary.pending} 条待办任务。`;
        if (pendingTasks.length > 0) {
            taskText += " 待办: " + pendingTasks.slice(0, 3).map(t => t.title).join(', ');
        }

        const consolidatedSystemInfo = buildSystemContext({
            nickname: this.nickname,
            taskText,
            contextStr,
            relationshipContext: buildRelationshipContext(this.emotionEngine.getRelationshipContext(this.affinity)),
            emotionPrompt: this.emotionEngine.getPromptInjection(),
            personalityPrompt: this.personalityDrift.getPromptInjection(),
            styleGuide: this.emotionEngine.getStyleGuide(),
        });
        messagesToSend.push({ role: "system", content: consolidatedSystemInfo });
        messagesToSend.push({ role: "user", content: userInput });

        try {
            const completion = await this.openai.chat.completions.create({
                model: this.modelName,
                messages: messagesToSend,
                temperature: 0.75
            });

            const { replyText, emotion, affinityChange, emotionDelta, innerThought } =
                this._parseCompletion(completion, userInput);

            // 关键词分析总是生效，LLM delta 叠加混合
            const autoDelta = this.emotionEngine.analyzeInput(userInput, this.affinity);
            this.emotionEngine.applyDelta(autoDelta);
            if (emotionDelta) {
                this.emotionEngine.applyDelta(emotionDelta);
            }

            this.emotionEngine.decay(0.03);

            const stage = this.emotionEngine.relationshipStage || 'stranger';
            const validatedChange = validateAffinityChange(affinityChange, userInput, replyText, this.affinity, stage);
            this.affinity = Math.max(0, Math.min(100, this.affinity + validatedChange));

            const sentiment = emotionDelta?.P || (affinityChange > 0 ? 0.5 : affinityChange < 0 ? -0.5 : 0);
            this.personalityDrift.recordInteraction(sentiment, affinityChange < -3);

            this.history.push({ role: "user", content: userInput });
            this.history.push({ role: "assistant", content: replyText });

            // 裁剪历史：保留最近 MAX_HISTORY 条消息（含 system prompt）
            while (this.history.length > MAX_HISTORY) {
                this.history.splice(1, 2); // 跳过 [0]=system prompt，成对删除
            }

            if (this.memory) {
                this.memory.addMemory(
                    `User: ${userInput}\nXiao Ai: ${replyText}`,
                    { emotionSnapshot: this.emotionEngine.getSnapshot() }
                );
            }

            this._saveState();

            return {
                reply: replyText,
                token_usage: completion.usage,
                emotion: this.emotionEngine.getEmotionLabel(),
                affinity: this.affinity,
                emotionalState: this.emotionEngine.getFullState(),
                innerThought,
            };

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
     * 解析 LLM 输出：剥离 <think> 内心独白与 <metadata> 元数据。
     */
    _parseCompletion(completion, userInput) {
        const fullContent = completion.choices[0].message.content;
        let replyText = fullContent;
        let emotion = "default";
        let affinityChange = 0;
        let emotionDelta = null;
        let innerThought = null;

        const thinkRegex = /<think>(.*?)<\/think>/s;
        const thinkMatch = fullContent.match(thinkRegex);
        if (thinkMatch) {
            innerThought = thinkMatch[1].trim();
            console.log(`\n[Inner Monologue]: ${innerThought}\n`);
            replyText = fullContent.replace(thinkMatch[0], "").trim();
        }

        const metadataRegex = /<metadata>\s*({.*?})\s*<\/metadata>/s;
        const match = replyText.match(metadataRegex) || fullContent.match(metadataRegex);

        if (match) {
            replyText = replyText.replace(match[0], "").trim();

            try {
                let metadataJson = match[1];
                metadataJson = metadataJson.replace(/:\s*\+([0-9.]+)/g, ': $1');

                const metadata = JSON.parse(metadataJson);
                emotion = metadata.emotion || "default";
                affinityChange = metadata.affinity_change || 0;
                emotionDelta = metadata.emotion_delta || null;
            } catch (e) {
                console.error(`Metadata parse error: ${e}. Raw match: ${match[1]}`);
            }
        }

        return { replyText, emotion, affinityChange, emotionDelta, innerThought };
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
            ...this.history.slice(-10),
            { role: "system", content: buildProactiveDirective(reason, this.affinity, contextInfo) },
            { role: "system", content: buildProactivePersonaDirective(scenarioPrompt, this.affinity) }
        ];

        try {
            const completion = await this.openai.chat.completions.create({
                model: this.modelName,
                messages: messages,
                temperature: 0.85
            });

            const content = completion.choices[0].message.content;
            let reply = content;
            let emotion = "default";

            const metadataRegex = /<metadata>\s*({.*?})\s*<\/metadata>/s;
            const match = content.match(metadataRegex);
            if (match) {
                reply = content.replace(match[0], "").trim();
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

    // ==================== 访问器与配置 ====================

    getHistory() {
        return this.history.filter(msg => msg.role === 'user' || msg.role === 'assistant');
    }

    clearHistory() {
        this.history = [{ role: "system", content: this.systemPrompt }];
        this.affinity = 35;
        this._saveState();
        if (this.memory) {
            this.memory.clearMemory();
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
            memoryCount: this.memory ? this.memory.memories.length : 0,
            emotionalState: this.emotionEngine ? this.emotionEngine.getFullState() : null
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
        if (config.embeddingApiKey !== undefined && config.embeddingApiKey !== this.embeddingApiKey) {
            this.embeddingApiKey = config.embeddingApiKey;
            changed = true;
        }
        if (config.embeddingBaseUrl !== undefined && config.embeddingBaseUrl !== this.embeddingBaseUrl) {
            this.embeddingBaseUrl = config.embeddingBaseUrl;
            changed = true;
        }
        if (config.embeddingModelName !== undefined && config.embeddingModelName !== this.embeddingModelName) {
            this.embeddingModelName = config.embeddingModelName;
            changed = true;
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
            this.affinity = Math.max(0, Math.min(100, updates.affinity));
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
