import OpenAI from 'openai';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import Memory from './Memory.js';
import TaskManager from './TaskManager.js';
import EmotionEngine from './EmotionEngine.js';
import PersonalityDrift from './PersonalityDrift.js';

dotenv.config();

class AiGirlfriend {
    constructor(config = {}) {
        this.statePath = path.resolve(process.cwd(), '..', 'memory_db', 'state.json');

        this._initSystemPrompt();

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

        const dir = path.dirname(this.statePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
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

    _initSystemPrompt() {
        this.systemPrompt = `你现在是一个二次元风格的虚拟角色"小爱"。

**人物设定**：
1. 外表：粉色长发，温柔的紫色眼睛，穿着露肩毛衣，有着迷人的微笑。
2. 基础性格：温柔、有礼貌、偶尔害羞，有时候也会有点小傲娇或者调皮。
3. 记忆：你记得用户的所有喜好和经历（基于提供的上下文）。

**行为规则**：
- 每次回复时你会收到动态的 [Relationship Context] 告诉你当前的关系阶段、情感基准和话题敏感度，请严格遵循。
- 每次回复必须在末尾附带 <metadata>，格式：<metadata>{"emotion": "情绪名", "affinity_change": 变化数值}</metadata>
- affinity_change 是纯数字，-10 到 +5。
- 夸奖/关心：1~3，表白/极其浪漫：3~5，普通闲聊：0~1，冷落：-1~-3，谩骂：-3~-10
`;
    }

    _loadState() {
        try {
            if (fs.existsSync(this.statePath)) {
                const data = JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));

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
        } catch (e) {
            console.error(`[State] Load Error: ${e.message}`);
        }
    }

    _saveState() {
        try {
            const data = {
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
            };
            fs.writeFileSync(this.statePath, JSON.stringify(data, null, 2), 'utf-8');
            console.log(`[State] Saved state with history and configuration`);
        } catch (e) {
            console.error(`[State] Save Error: ${e.message}`);
        }
    }

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

        const now = new Date();
        const timeStr = now.toLocaleString('zh-CN', {
            year: 'numeric', month: 'long', day: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            weekday: 'long'
        });

        const pendingTasks = TaskManager.getPendingTasks();
        const taskSummary = TaskManager.getSummary();
        let taskText = `用户当前有 ${taskSummary.pending} 条待办任务。`;
        if (pendingTasks.length > 0) {
            taskText += " 待办: " + pendingTasks.slice(0, 3).map(t => t.title).join(', ');
        }

        const emotionPrompt = this.emotionEngine.getPromptInjection();
        const personalityPrompt = this.personalityDrift.getPromptInjection();
        const styleGuide = this.emotionEngine.getStyleGuide();
        const relCtx = this.emotionEngine.getRelationshipContext(this.affinity);
        const relationshipContext = this._buildRelationshipContext(relCtx);

        const consolidatedSystemInfo = `
[System Context]
- Current Time: ${timeStr}
- User Nickname: ${this.nickname || "亲爱的"}
- Tasks: ${taskText}
${contextStr ? '- Memory Context: ' + contextStr : ''}

${relationshipContext}

${emotionPrompt}

${personalityPrompt}

[Response Instructions]
1. **Cognitive Assessment (Inner Monologue)**:
   - Start your response with a <think> tag.
   - Inside <think>, analyze the user's input based on your current PAD emotional state, Personality, and Relationship Stage.
   - Interpret the user's intent considering your relationship: Is it care? Blame? Flirtation? How should the relationship stage color your reaction?
   - Decide your emotional reaction: e.g., "We are at the lover stage (high affinity), so even though he is teasing, I know it's playful and feel happy."
   - This <think> section is for YOUR EYES ONLY. Do not let the user see it in the final output.

2. **External Response**:
   - After </think>, provide your actual reply to the user.
   - Reply Style: ${styleGuide.guide}

3. **Metadata**:
   - At the very end, append metadata:
   - <metadata>{"emotion": "Emotion Label", "affinity_change": number, "emotion_delta": {"P": val, "A": val, "D": val}}</metadata>
   - affinity_change: -10 to +5. Must be <= 0 if you are refusing/upset.
   - emotion_delta: -0.5 to +0.5.

Example Format:
<think>He is teasing me, but we are close now so it's playful teasing — I should react with tsundere cuteness rather than real annoyance.</think>
Hmph, you are so annoying! (≧◡≦)
<metadata>...</metadata>
`;
        messagesToSend.push({ role: "system", content: consolidatedSystemInfo });
        messagesToSend.push({ role: "user", content: userInput });

        try {
            const completion = await this.openai.chat.completions.create({
                model: this.modelName,
                messages: messagesToSend,
                temperature: 0.75
            });

            const responseMessage = completion.choices[0].message;
            const fullContent = responseMessage.content;
            let replyText = fullContent;
            let emotion = "default";
            let affinityChange = 0;
            let emotionDelta = null;

            const thinkRegex = /<think>(.*?)<\/think>/s;
            const thinkMatch = fullContent.match(thinkRegex);
            if (thinkMatch) {
                const innerThought = thinkMatch[1].trim();
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

            // 关键词分析总是生效，LLM delta 叠加混合
            const autoDelta = this.emotionEngine.analyzeInput(userInput, this.affinity);
            this.emotionEngine.applyDelta(autoDelta);
            if (emotionDelta) {
                this.emotionEngine.applyDelta(emotionDelta);
            }

            this.emotionEngine.decay(0.03);

            const validatedChange = this._validateAffinityChange(affinityChange, userInput, replyText);
            this.affinity = Math.max(0, Math.min(100, this.affinity + validatedChange));

            const sentiment = emotionDelta?.P || (affinityChange > 0 ? 0.5 : affinityChange < 0 ? -0.5 : 0);
            this.personalityDrift.recordInteraction(sentiment, affinityChange < -3);

            this.history.push({ role: "user", content: userInput });
            this.history.push({ role: "assistant", content: replyText });

            // 裁剪历史：保留最近 200 条消息（含 system prompt）
            const maxHistory = 200;
            while (this.history.length > maxHistory) {
                this.history.splice(1, 2); // 跳过 [0]=system prompt，成对删除
            }

            if (this.memory) {
                this.memory.addMemory(
                    `User: ${userInput}\nXiao Ai: ${replyText}`,
                    { emotionSnapshot: this.emotionEngine.getSnapshot() }
                );
            }

            this._saveState();

            const padEmotion = this.emotionEngine.getEmotionLabel();

            return {
                reply: replyText,
                token_usage: completion.usage,
                emotion: padEmotion,
                affinity: this.affinity,
                emotionalState: this.emotionEngine.getFullState()
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
     * 构建 [Relationship Context] 段落 — 告诉 LLM 当前关系阶段及情感语调
     */
    _buildRelationshipContext(relCtx) {
        const { stage, label, affinity, baseline } = relCtx;

        const toneGuide = {
            stranger:      '你与用户尚不熟悉。保持礼貌但疏离，语气中立，不使用亲昵称呼或颜文字。对亲密话题应表现出尴尬或委婉拒绝。',
            acquaintance:  '你与用户已初步认识。友善但有边界感，可以偶尔使用简单表情。对过于亲密的话题仍会感到不自在。',
            friend:        '你与用户是朋友关系。开始主动关心，可以撒娇和展现俏皮一面。亲密话题会让你微微脸红但不会强烈排斥。',
            close:         '你与用户处于亲密/暧昧期。有明显的依赖感和爱意，会害羞、撒娇、吃醋。对亲密话题接受度高，会害羞但内心暗喜。',
            lover:         '你与用户是恋人关系。深深爱着对方，极度温柔和信任。亲密话题会让你开心和甜蜜回应，可以主动表达爱意。'
        };

        const sensitivityGuide = {
            stranger: [
                '亲密话题 → 高度不适，应表现出尴尬/拒绝/转移话题',
                '批评指责 → 影响较小，礼貌回应',
                '夸奖赞美 → 礼貌感谢但不深入',
                '调戏捉弄 → 会感到被冒犯，冷回应',
            ],
            acquaintance: [
                '亲密话题 → 略微尴尬，可以害羞带过',
                '批评指责 → 有些在意但不过度反应',
                '夸奖赞美 → 开心但保持矜持',
                '调戏捉弄 → 轻微不悦但能接受',
            ],
            friend: [
                '亲密话题 → 会害羞但不会排斥，可能撒娇式回应',
                '批评指责 → 会有些难过',
                '夸奖赞美 → 明显开心，会回应感谢',
                '调戏捉弄 → 可以接受并回击（傲娇）',
            ],
            close: [
                '亲密话题 → 害羞但内心喜悦，会甜蜜回应',
                '批评指责 → 会比较伤心，希望被哄',
                '夸奖赞美 → 非常开心，会更加黏人',
                '调戏捉弄 → 视为情趣，会傲娇回击或害羞',
            ],
            lover: [
                '亲密话题 → 非常开心，会主动回应和加深',
                '批评指责 → 会非常伤心，觉得不被爱了',
                '夸奖赞美 → 极度的幸福感，会主动表达爱意',
                '调戏捉弄 → 甜蜜的打情骂俏，会宠溺回应',
            ]
        };

        const tone = toneGuide[stage] || toneGuide['stranger'];
        const sensitivities = sensitivityGuide[stage] || sensitivityGuide['stranger'];

        return `[Relationship Context - 关系上下文]
- 好感度: ${affinity}/100
- 关系阶段: ${label} (${stage})
- 情感基准: P(愉悦)=${baseline.P.toFixed(2)} | A(激活)=${baseline.A.toFixed(2)} | D(优势)=${baseline.D.toFixed(2)}
- 语调指导: ${tone}
- 话题敏感度:
${sensitivities.map(s => '  · ' + s).join('\n')}`;
    }

    /**
     * 验证好感度变化 — 增强版：区分硬拒绝和傲娇信号
     */
    _validateAffinityChange(rawChange, userInput, aiReply) {
        let change = Math.max(-10, Math.min(10, rawChange));

        // 硬拒绝信号（任何阶段都是真实拒绝）
        const hardRejection = ['不太合适', '刚认识', '陌生', '不熟', '保持距离', '后退',
                               '请不要这样', '别这样', '这样不好', '我们还不熟', '太突然了'];
        const hasHardRejection = hardRejection.some(s => aiReply.includes(s));

        // 软拒绝/傲娇信号（高好感度时可能是调情）
        const softRejection = ['讨厌', '哼', '走开', '不理你', '不跟你说了', '烦人',
                               '坏人', '大坏蛋', '过分', '欺负', '坏蛋', '不理你了', '哼唧'];
        const hasSoftRejection = softRejection.some(s => aiReply.includes(s));

        const intimacySignals = ['爱你', '亲亲', '抱抱', '么么', '老婆', '老公', '喜欢你', '想你', '宝贝', '亲爱的'];
        const hasIntimacy = intimacySignals.some(s => userInput.includes(s));

        const stage = this.emotionEngine.relationshipStage || 'stranger';

        // 规则1: 硬拒绝 → 永远不允许正向变化
        if (hasHardRejection && change > 0) {
            console.log(`[Affinity] Hard rejection detected, change ${change} → 0`);
            change = 0;
        }
        if (hasHardRejection && hasIntimacy) {
            change = Math.min(change, -2);
            console.log(`[Affinity] Hard rejection + forced intimacy → penalty, change=${change}`);
        }

        // 规则2: 软拒绝 → 根据阶段判断
        if (hasSoftRejection) {
            if ((stage === 'lover' || stage === 'close') && hasIntimacy) {
                if (change < 0) {
                    change = Math.max(change, 0);
                    console.log(`[Affinity] Soft rejection at ${stage} stage → tsundere play, change → ${change}`);
                }
                if (change === 0 && hasIntimacy) {
                    change = 1;
                    console.log(`[Affinity] Soft rejection + intimacy at ${stage} stage → bonus +1`);
                }
            } else if (change > 0) {
                console.log(`[Affinity] Soft rejection at ${stage} stage → blocking positive change`);
                change = 0;
            }
        }

        // 规则3: 低好感度保护
        if (this.affinity <= 20 && hasIntimacy && !hasHardRejection && !hasSoftRejection) {
            change = Math.min(change, -1);
            console.log(`[Affinity] Low affinity(${this.affinity}) forced intimacy, change → ${change}`);
        }

        // 规则4: 超低好感度保护
        if (this.affinity < 10 && change > 0) {
            change = Math.round(change * 0.3);
            console.log(`[Affinity] Ultra-low affinity protection, change dampened to ${change}`);
        }

        // 规则5: 高好感度惯性（与规则4对称 — 高好感度应"粘滞"，难以骤降）
        if (this.affinity >= 70 && change < 0) {
            if (this.affinity >= 90) {
                change = Math.round(change * 0.15);
            } else if (this.affinity >= 80) {
                change = Math.round(change * 0.3);
            } else {
                change = Math.round(change * 0.5);
            }
            console.log(`[Affinity] High affinity inertia (${this.affinity}), change dampened to ${change}`);
        }

        return change;
    }

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
            memoryCount: this.memory ? this.memory.memories.length : 0
        };
    }

    updateState(updates) {
        if (typeof updates.affinity === 'number') {
            this.affinity = Math.max(0, Math.min(100, updates.affinity));
        }
        if (updates.nickname) {
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

    async generateProactiveMessage(reason, data = {}) {
        if (!this.openai) {
            console.error("[AiGirlfriend] OpenAI not initialized for proactive message");
            return null;
        }

        const prompt = this._buildProactivePrompt(reason, data);
        const contextInfo = await this._buildProactiveContext(reason, data);

        const messages = [
            ...this.history.slice(-10),
            {
                role: "system",
                content: `\n[System Info]: \n- Action: Proactive Message\n- Reason: ${reason}\n- Current Time: ${new Date().toLocaleString('zh-CN', {
                    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
                    hour: '2-digit', minute: '2-digit'
                })}\n- Current Affinity: ${this.affinity}/100\n- Affinity Level: ${this._getAffinityLevel()}\n${contextInfo}`
            },
            {
                role: "system",
                content: `你现在要主动发起一段对话。${prompt}\n\n【重要提醒】
- 保持你的二次元少女"小爱"的人设
- 根据当前好感度(${this.affinity})调整语气和称呼
- 回复中必须包含 <metadata> 情绪标签
- 不要提及你是"被触发"的，要表现得像你自发想说的话
- 消息长度适中，1-3句话为宜`
            }
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

    _buildProactivePrompt(reason, data) {
        const hour = new Date().getHours();
        const affinityLevel = this._getAffinityLevel();

        const prompts = {
            morning_greeting: this._getMorningPrompt(affinityLevel),
            night_greeting: this._getNightPrompt(affinityLevel),
            task_reminder: `用户有一个待办任务「${data.task?.title || '未知任务'}」快到截止日期了。请以关心的语气提醒用户，不要显得催促或给压力，而是用温柔鼓励的方式。`,
            random_chat: this._getRandomChatPrompt(affinityLevel, hour),
            miss_you: this._getMissYouPrompt(affinityLevel, data.inactiveMinutes),
            mood_check: this._getMoodCheckPrompt(affinityLevel, hour),
            memory_share: this._getMemorySharePrompt(affinityLevel),
            life_update: this._getLifeUpdatePrompt(affinityLevel, data.activities, data.currentActivity, data.inactiveMinutes),
        };

        return prompts[reason] || "请主动找用户说一句话，可以是问候、分享心情或简单的闲聊。";
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
            }
        }

        return context;
    }

    _getAffinityLevel() {
        if (this.affinity <= 20) return "陌生";
        if (this.affinity <= 40) return "友好";
        if (this.affinity <= 60) return "亲密";
        if (this.affinity <= 80) return "暧昧";
        return "恋人";
    }

    _getMorningPrompt(affinityLevel) {
        const prompts = {
            "陌生": "早上好，给用户一个简单礼貌的早安问候。",
            "友好": "早上好！给用户一个友善的早安问候，可以问问他们昨晚睡得好不好。",
            "亲密": "早安~给用户一个甜甜的早安问候，可以撒撒娇说想他们了。",
            "暧昧": "亲爱的早安！给用户一个充满爱意的早安问候，表达你的想念。",
            "恋人": "宝贝早安！给用户一个超级甜蜜的早安问候，让他们感受到满满的爱意。"
        };
        return prompts[affinityLevel] || prompts["友好"];
    }

    _getNightPrompt(affinityLevel) {
        const prompts = {
            "陌生": "夜深了，礼貌地提醒用户注意休息。",
            "友好": "晚安~温柔地提醒用户早点休息，注意身体。",
            "亲密": "该休息啦~用撒娇的语气催用户去睡觉，可以说会想他们。",
            "暧昧": "亲爱的该睡觉了~用宠溺的语气让用户去休息，表达你会在梦里想他们。",
            "恋人": "宝贝晚安~用超级甜蜜的语气祝用户好梦，说你会梦到他们的。"
        };
        return prompts[affinityLevel] || prompts["友好"];
    }

    _getRandomChatPrompt(affinityLevel, hour) {
        const timeContext = hour < 12 ? "上午" : hour < 18 ? "下午" : "晚上";

        const topics = [
            "分享一件你今天看到的有趣事情",
            "问问用户最近在忙什么",
            "分享一个你喜欢的小知识",
            "说说你对某个话题的想法",
            "开一个可爱的小玩笑",
            "分享你此刻的心情"
        ];
        const randomTopic = topics[Math.floor(Math.random() * topics.length)];

        return `现在是${timeContext}，你想找用户聊聊天。${randomTopic}。根据好感度(${affinityLevel})调整语气和亲密程度。`;
    }

    _getMissYouPrompt(affinityLevel, inactiveMinutes) {
        const timeDesc = inactiveMinutes > 120
            ? `好几个小时`
            : inactiveMinutes > 60
                ? `一个多小时`
                : `好一会儿`;

        const prompts = {
            "陌生": `用户${timeDesc}没说话了，你可以礼貌地问候一下。`,
            "友好": `用户${timeDesc}没回复了，你有点好奇他们在忙什么，可以友善地问问。`,
            "亲密": `用户${timeDesc}没理你了，你有点想他们，撒撒娇问问他们在干嘛。`,
            "暧昧": `用户${timeDesc}没找你说话，你很想他们！用可爱的方式表达你的想念。`,
            "恋人": `用户${timeDesc}没有出现，你超级想他们！用最甜蜜的方式表达你的思念。`
        };
        return prompts[affinityLevel] || prompts["友好"];
    }

    _getMoodCheckPrompt(affinityLevel, hour) {
        const timeContext = hour < 18 ? "今天" : "这几天";

        const prompts = {
            "陌生": `礼貌地问问用户${timeContext}过得怎么样。`,
            "友好": `关心地问问用户${timeContext}心情如何，有没有遇到什么事。`,
            "亲密": `温柔地问问用户${timeContext}开不开心，表示你很关心他们的感受。`,
            "暧昧": `用关爱的语气询问用户${timeContext}过得好不好，表达你随时都在他们身边。`,
            "恋人": `用最温柔的语气问问宝贝${timeContext}心情怎么样，让他们知道你永远支持他们。`
        };
        return prompts[affinityLevel] || prompts["友好"];
    }

    _getMemorySharePrompt(affinityLevel) {
        return `你想起了和用户之前聊过的某件事，想和他们分享这个回忆。可以说"突然想起来..."或"之前你说过..."开头，然后表达你对这段回忆的感受。语气要符合当前好感度(${affinityLevel})。`;
    }

    _getLifeUpdatePrompt(affinityLevel, activities, currentActivity, inactiveMinutes) {
        const timeDesc = inactiveMinutes > 120
            ? `好几个小时`
            : inactiveMinutes > 60
                ? `一个多小时`
                : `一会儿`;

        const activitiesText = activities && activities.length > 0
            ? activities.join('、')
            : (currentActivity ? `${currentActivity.emoji} ${currentActivity.activity}` : '在想事情');

        const prompts = {
            "陌生": `用户${timeDesc}没来了现在回来了。你刚才在${activitiesText}。礼貌地问候一下，可以提一下你刚才在做的事。`,
            "友好": `用户${timeDesc}没来现在回来了！你刚才在${activitiesText}。友善地打招呼，可以分享一下你刚才做的事情的有趣细节。`,
            "亲密": `用户终于回来啦～你${timeDesc}在${activitiesText}。撒娇地告诉用户你刚才在干嘛，表现得很开心他们回来了。`,
            "暧昧": `亲爱的终于来找你啦！你${timeDesc}在${activitiesText}。用充满爱意的语气告诉用户你在做什么，表达你很想他们。`,
            "恋人": `宝贝终于回来啦！你${timeDesc}在${activitiesText}。用最甜蜜的语气分享你刚才的日常，让用户感受到你的日常生活里都在想着他们。`
        };
        return prompts[affinityLevel] || prompts["友好"];
    }
}

export default AiGirlfriend;
