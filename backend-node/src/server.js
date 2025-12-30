import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import AiGirlfriend from './core/AiGirlfriend.js';
import VoiceEngine from './core/Voice.js';
import TaskManager from './core/TaskManager.js';
import ProactiveEngine from './core/ProactiveEngine.js';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8000;

// Middleware
app.use(cors({
    origin: '*', // For dev simplicity
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['*']
}));
app.use(express.json());

// Static files for audio
const staticDir = path.join(process.cwd(), 'static');
if (!fs.existsSync(staticDir)) {
    fs.mkdirSync(staticDir, { recursive: true });
}
app.use('/static', express.static(staticDir));

// Multer for file uploads
const upload = multer({ dest: 'temp_uploads/' });
if (!fs.existsSync('temp_uploads')) {
    fs.mkdirSync('temp_uploads');
}

// Global Instances
let aiGirlfriend = new AiGirlfriend();
let voiceEngine = new VoiceEngine();
let proactiveEngine = new ProactiveEngine(aiGirlfriend);

// Routes

app.get('/', (req, res) => {
    res.json({ message: "AI Girlfriend Node Backend is Running 💖" });
});

app.post('/config', (req, res) => {
    try {
        console.log("[Config] Received updated configuration:", Object.keys(req.body));
        const { api_key, base_url, model_name, tts_api_key, embedding_api_key, embedding_base_url, embedding_model_name } = req.body;

        // If key changes, re-init
        if (api_key || base_url || model_name || embedding_api_key || embedding_base_url || embedding_model_name) {
            aiGirlfriend = new AiGirlfriend({
                apiKey: api_key,
                baseUrl: base_url,
                modelName: model_name,
                embeddingApiKey: embedding_api_key,
                embeddingBaseUrl: embedding_base_url,
                embeddingModelName: embedding_model_name
            });

            // Re-init engines with new AI instance
            const ttsKey = tts_api_key || api_key;
            voiceEngine = new VoiceEngine({ apiKey: ttsKey });
            if (proactiveEngine) proactiveEngine.stop();
            proactiveEngine = new ProactiveEngine(aiGirlfriend);
        }

        res.json({ status: "updated", current_model: aiGirlfriend.modelName });
    } catch (e) {
        console.error("[Config Error]", e);
        res.status(500).json({ detail: e.message });
    }
});

// 获取配置状态（不暴露敏感信息）
app.get('/config/status', (req, res) => {
    try {
        const hasApiKey = !!aiGirlfriend.apiKey;
        const hasEmbeddingKey = !!aiGirlfriend.embeddingApiKey;

        res.json({
            isConfigured: hasApiKey,
            hasEmbeddingConfig: hasEmbeddingKey,
            currentModel: aiGirlfriend.modelName || null,
            baseUrl: aiGirlfriend.baseUrl || null
        });
    } catch (e) {
        console.error("[Config Status Error]", e);
        res.status(500).json({ detail: e.message });
    }
});

app.get('/chat/proactive', (req, res) => {
    try {
        if (!proactiveEngine) {
            return res.status(503).json({ detail: "ProactiveEngine not ready" });
        }
        const message = proactiveEngine.consumeMessage();
        if (message) {
            res.json(message);
        } else {
            res.status(204).end(); // No Content
        }
    } catch (e) {
        console.error("[Proactive Route Error]", e);
        res.status(500).end();
    }
});

app.post('/chat', async (req, res) => {
    try {
        const { message } = req.body;
        if (!aiGirlfriend.apiKey) {
            return res.status(400).json({ detail: "API Key not configured" });
        }

        // 通知 ProactiveEngine 用户活跃
        if (proactiveEngine) {
            proactiveEngine.notifyUserActive();
        }

        const result = await aiGirlfriend.chat(message);

        res.json({
            reply: result.reply || "",
            token_usage: result.token_usage || {},
            context_count: aiGirlfriend.history.length,
            emotion: result.emotion || "default",
            affinity: result.affinity ?? 35
        });
    } catch (e) {
        res.status(500).json({ detail: e.message });
    }
});

// 获取主动消息队列状态（不消费）
app.get('/chat/proactive/status', (req, res) => {
    try {
        if (!proactiveEngine) {
            return res.status(503).json({ detail: "ProactiveEngine not ready" });
        }
        res.json({
            queue: proactiveEngine.peekQueue(),
            engine: proactiveEngine.getStatus()
        });
    } catch (e) {
        console.error("[Proactive Status Error]", e);
        res.status(500).end();
    }
});

// 获取主动消息配置
app.get('/config/proactive', (req, res) => {
    try {
        if (!proactiveEngine) {
            return res.status(503).json({ detail: "ProactiveEngine not ready" });
        }
        res.json({
            config: proactiveEngine.getConfig(),
            availableTypes: [
                { id: 'morning_greeting', label: '早安问候 ☀️', description: '每天早上 8 点发送' },
                { id: 'night_greeting', label: '晚安祝福 🌙', description: '每天晚上 10 点发送' },
                { id: 'task_reminder', label: '任务提醒 📝', description: '任务截止前 15 分钟提醒' },
                { id: 'miss_you', label: '想念消息 💕', description: '长时间未活跃时发送' },
                { id: 'mood_check', label: '情绪关怀 💝', description: '下午和晚间询问状态' },
                { id: 'memory_share', label: '回忆分享 💭', description: '高好感度时分享回忆' },
                { id: 'random_chat', label: '随机闲聊 ✨', description: '偶尔随机发起聊天' },
                { id: 'life_update', label: '生活分享 🌸', description: '用户回来时分享刚才在做什么' }
            ]
        });
    } catch (e) {
        console.error("[Proactive Config GET Error]", e);
        res.status(500).json({ detail: e.message });
    }
});

// ==================== 生活模拟 API ====================

// 获取当前活动状态
app.get('/life/current', (req, res) => {
    try {
        if (!proactiveEngine || !proactiveEngine.lifeSimulator) {
            return res.status(503).json({ detail: "LifeSimulator not ready" });
        }
        res.json(proactiveEngine.lifeSimulator.getCurrentActivity());
    } catch (e) {
        console.error("[Life Current Error]", e);
        res.status(500).json({ detail: e.message });
    }
});

// 获取活动历史
app.get('/life/history', (req, res) => {
    try {
        if (!proactiveEngine || !proactiveEngine.lifeSimulator) {
            return res.status(503).json({ detail: "LifeSimulator not ready" });
        }
        const hours = parseInt(req.query.hours) || 6;
        res.json(proactiveEngine.lifeSimulator.getActivityHistory(hours));
    } catch (e) {
        console.error("[Life History Error]", e);
        res.status(500).json({ detail: e.message });
    }
});

// ==================== 生活模拟 API 结束 ====================


// 更新主动消息配置
app.post('/config/proactive', (req, res) => {
    try {
        if (!proactiveEngine) {
            return res.status(503).json({ detail: "ProactiveEngine not ready" });
        }
        const { enabled, frequencyLevel, customDailyLimit, enabledTypes } = req.body;
        const newConfig = proactiveEngine.updateConfig({
            enabled,
            frequencyLevel,
            customDailyLimit,
            enabledTypes
        });
        res.json({ status: "updated", config: newConfig });
    } catch (e) {
        console.error("[Proactive Config POST Error]", e);
        res.status(500).json({ detail: e.message });
    }
});

// 手动触发主动消息（用于测试）
app.post('/chat/proactive/trigger', async (req, res) => {
    try {
        if (!proactiveEngine) {
            return res.status(503).json({ detail: "ProactiveEngine not ready" });
        }
        const { reason = 'random_chat', data = {} } = req.body;
        await proactiveEngine.trigger(reason, data);
        res.json({
            status: "triggered",
            reason,
            queueSize: proactiveEngine.messageQueue.length
        });
    } catch (e) {
        console.error("[Proactive Trigger Error]", e);
        res.status(500).json({ detail: e.message });
    }
});

app.get('/tasks', (req, res) => {
    res.json(TaskManager.getTasks());
});

app.post('/tasks', (req, res) => {
    const task = TaskManager.addTask(req.body);
    res.json(task);
});

app.put('/tasks/:id', (req, res) => {
    const task = TaskManager.updateTask(req.params.id, req.body);
    if (task) {
        res.json(task);
    } else {
        res.status(404).json({ error: "Task not found" });
    }
});

app.delete('/tasks/:id', (req, res) => {
    const task = TaskManager.deleteTask(req.params.id);
    if (task) {
        res.json(task);
    } else {
        res.status(404).json({ error: "Task not found" });
    }
});

app.get('/tasks/summary', (req, res) => {
    res.json(TaskManager.getSummary());
});

app.get('/tasks/due', (req, res) => {
    res.json(TaskManager.getDueSoonTasks());
});

app.get('/history', (req, res) => {
    res.json(aiGirlfriend.getHistory());
});

app.delete('/history', (req, res) => {
    aiGirlfriend.clearHistory();
    res.json({ status: "cleared" });
});

app.get('/system_prompt', (req, res) => {
    res.json({ system_prompt: aiGirlfriend.getSystemPrompt() });
});

app.post('/system_prompt', (req, res) => {
    const { system_prompt } = req.body;
    if (system_prompt) {
        aiGirlfriend.updateSystemPrompt(system_prompt);
        res.json({ status: "updated", system_prompt: system_prompt });
    } else {
        res.status(400).json({ detail: "system_prompt is required" });
    }
});

// 获取所有记忆
app.get('/memories', (req, res) => {
    res.json(aiGirlfriend.getMemories());
});

// 清除记忆（保留聊天历史）
app.delete('/memories', (req, res) => {
    aiGirlfriend.clearMemoriesOnly();
    res.json({ status: "memories_cleared" });
});

// 获取当前状态
app.get('/state', (req, res) => {
    res.json(aiGirlfriend.getState());
});

// 更新状态（好感度、称呼等）
app.post('/state', (req, res) => {
    const { affinity, nickname } = req.body;
    const newState = aiGirlfriend.updateState({ affinity, nickname });
    res.json({ status: "updated", ...newState });
});

app.post('/audio/speak', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) return res.status(400).json({ detail: "Text is required" });

        const filename = await voiceEngine.textToSpeech(text);
        res.json({ audio_url: `/static/audio/${filename}` });
    } catch (e) {
        res.status(500).json({ detail: e.message });
    }
});

app.post('/audio/transcribe', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ detail: "File is required" });
        }

        const tempPath = req.file.path;
        const text = await voiceEngine.speechToText(tempPath);

        // Cleanup
        fs.unlinkSync(tempPath);

        res.json({ text });
    } catch (e) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ detail: e.message });
    }
});

// Start
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
