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

app.use(cors({
    origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['*']
}));
app.use(express.json());

const staticDir = path.join(process.cwd(), 'static');
if (!fs.existsSync(staticDir)) {
    fs.mkdirSync(staticDir, { recursive: true });
}
app.use('/static', express.static(staticDir));

const upload = multer({ dest: 'temp_uploads/', limits: { fileSize: 10 * 1024 * 1024 } });
if (!fs.existsSync('temp_uploads')) {
    fs.mkdirSync('temp_uploads');
}

let aiGirlfriend = new AiGirlfriend();
let voiceEngine = new VoiceEngine();
let proactiveEngine = new ProactiveEngine(aiGirlfriend);

app.get('/', (req, res) => {
    res.json({ message: "AI Girlfriend Node Backend is Running" });
});

app.post('/config', (req, res) => {
    try {
        const { api_key, base_url, model_name, tts_api_key, embedding_api_key, embedding_base_url, embedding_model_name } = req.body;
        if (api_key || base_url || model_name || embedding_api_key || embedding_base_url || embedding_model_name) {
            aiGirlfriend = new AiGirlfriend({
                apiKey: api_key,
                baseUrl: base_url,
                modelName: model_name,
                embeddingApiKey: embedding_api_key,
                embeddingBaseUrl: embedding_base_url,
                embeddingModelName: embedding_model_name
            });
            const ttsKey = tts_api_key || api_key;
            voiceEngine = new VoiceEngine({ apiKey: ttsKey });
            if (proactiveEngine) proactiveEngine.stop();
            proactiveEngine = new ProactiveEngine(aiGirlfriend);
        }
        res.json({ status: "updated", current_model: aiGirlfriend.modelName });
    } catch (e) {
        console.error("[Config Error]", e.message || e);
        res.status(500).json({ detail: "Internal server error" });
    }
});

app.get('/config/status', (req, res) => {
    try {
        res.json({
            isConfigured: !!aiGirlfriend.apiKey,
            hasEmbeddingConfig: !!aiGirlfriend.embeddingApiKey,
            currentModel: aiGirlfriend.modelName || null,
            baseUrl: aiGirlfriend.baseUrl || null
        });
    } catch (e) {
        console.error("[Config Status Error]", e.message || e);
        res.status(500).json({ detail: "Internal server error" });
    }
});

app.get('/chat/proactive', (req, res) => {
    try {
        if (!proactiveEngine) return res.status(503).json({ detail: "ProactiveEngine not ready" });
        const message = proactiveEngine.consumeMessage();
        if (message) res.json(message);
        else res.status(204).end();
    } catch (e) {
        console.error("[Proactive Route Error]", e.message || e);
        res.status(500).json({ detail: "Internal server error" });
    }
});

app.post('/chat', async (req, res) => {
    try {
        const { message } = req.body;
        if (!aiGirlfriend.apiKey) return res.status(400).json({ detail: "API Key not configured" });
        if (proactiveEngine) proactiveEngine.notifyUserActive();
        const result = await aiGirlfriend.chat(message);
        res.json({
            reply: result.reply || "",
            token_usage: result.token_usage || {},
            context_count: aiGirlfriend.history.length,
            emotion: result.emotion || "\u5E73\u9759",
            affinity: result.affinity ?? 35,
            emotionalState: result.emotionalState || null
        });
    } catch (e) {
        console.error("[Chat Error]", e.message || e);
        res.status(500).json({ detail: "Internal server error" });
    }
});

app.get('/chat/proactive/status', (req, res) => {
    try {
        if (!proactiveEngine) return res.status(503).json({ detail: "ProactiveEngine not ready" });
        res.json({ queue: proactiveEngine.peekQueue(), engine: proactiveEngine.getStatus() });
    } catch (e) {
        console.error("[Proactive Status Error]", e.message || e);
        res.status(500).json({ detail: "Internal server error" });
    }
});

app.get('/config/proactive', (req, res) => {
    try {
        if (!proactiveEngine) return res.status(503).json({ detail: "ProactiveEngine not ready" });
        res.json({
            config: proactiveEngine.getConfig(),
            availableTypes: [
                { id: 'morning_greeting', label: 'Good morning', description: 'Sent at 8 AM' },
                { id: 'night_greeting', label: 'Good night', description: 'Sent at 10 PM' },
                { id: 'task_reminder', label: 'Task reminder', description: '15 min before deadline' },
                { id: 'miss_you', label: 'Missing you', description: 'Sent when inactive for a while' },
                { id: 'mood_check', label: 'Mood check', description: 'Check in during afternoon/evening' },
                { id: 'memory_share', label: 'Memory share', description: 'Share a past memory' },
                { id: 'random_chat', label: 'Random chat', description: 'Spontaneous chat' },
                { id: 'life_update', label: 'Life update', description: 'What I was doing while you were away' }
            ]
        });
    } catch (e) {
        console.error("[Proactive Config GET Error]", e.message || e);
        res.status(500).json({ detail: "Internal server error" });
    }
});

app.get('/life/current', (req, res) => {
    try {
        if (!proactiveEngine || !proactiveEngine.lifeSimulator) return res.status(503).json({ detail: "LifeSimulator not ready" });
        res.json(proactiveEngine.lifeSimulator.getCurrentActivity());
    } catch (e) {
        console.error("[Life Current Error]", e.message || e);
        res.status(500).json({ detail: "Internal server error" });
    }
});

app.get('/life/history', (req, res) => {
    try {
        if (!proactiveEngine || !proactiveEngine.lifeSimulator) return res.status(503).json({ detail: "LifeSimulator not ready" });
        const hours = parseInt(req.query.hours) || 6;
        res.json(proactiveEngine.lifeSimulator.getActivityHistory(hours));
    } catch (e) {
        console.error("[Life History Error]", e.message || e);
        res.status(500).json({ detail: "Internal server error" });
    }
});

app.post('/config/proactive', (req, res) => {
    try {
        if (!proactiveEngine) return res.status(503).json({ detail: "ProactiveEngine not ready" });
        const { enabled, frequencyLevel, customDailyLimit, enabledTypes } = req.body;
        const newConfig = proactiveEngine.updateConfig({ enabled, frequencyLevel, customDailyLimit, enabledTypes });
        res.json({ status: "updated", config: newConfig });
    } catch (e) {
        console.error("[Proactive Config POST Error]", e.message || e);
        res.status(500).json({ detail: "Internal server error" });
    }
});

app.post('/chat/proactive/trigger', async (req, res) => {
    try {
        if (!proactiveEngine) return res.status(503).json({ detail: "ProactiveEngine not ready" });
        const { reason = 'random_chat', data = {} } = req.body;
        await proactiveEngine.trigger(reason, data);
        res.json({ status: "triggered", reason, queueSize: proactiveEngine.messageQueue.length });
    } catch (e) {
        console.error("[Proactive Trigger Error]", e.message || e);
        res.status(500).json({ detail: "Internal server error" });
    }
});

app.get('/tasks', (req, res) => { res.json(TaskManager.getTasks()); });
app.post('/tasks', (req, res) => { const task = TaskManager.addTask(req.body); res.json(task); });
app.put('/tasks/:id', (req, res) => {
    const task = TaskManager.updateTask(req.params.id, req.body);
    task ? res.json(task) : res.status(404).json({ error: "Task not found" });
});
app.delete('/tasks/:id', (req, res) => {
    const task = TaskManager.deleteTask(req.params.id);
    task ? res.json(task) : res.status(404).json({ error: "Task not found" });
});
app.get('/tasks/summary', (req, res) => { res.json(TaskManager.getSummary()); });
app.get('/tasks/due', (req, res) => { res.json(TaskManager.getDueSoonTasks()); });

app.get('/history', (req, res) => { res.json(aiGirlfriend.getHistory()); });
app.delete('/history', (req, res) => { aiGirlfriend.clearHistory(); res.json({ status: "cleared" }); });

app.get('/system_prompt', (req, res) => { res.json({ system_prompt: aiGirlfriend.getSystemPrompt() }); });
app.post('/system_prompt', (req, res) => {
    const { system_prompt } = req.body;
    if (system_prompt) { aiGirlfriend.updateSystemPrompt(system_prompt); res.json({ status: "updated", system_prompt }); }
    else res.status(400).json({ detail: "system_prompt is required" });
});

app.get('/memories', (req, res) => { res.json(aiGirlfriend.getMemories()); });
app.delete('/memories', (req, res) => { aiGirlfriend.clearMemoriesOnly(); res.json({ status: "memories_cleared" }); });

app.get('/state', (req, res) => { res.json(aiGirlfriend.getState()); });
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
        console.error("[TTS Error]", e.message || e);
        res.status(500).json({ detail: "Internal server error" });
    }
});

app.post('/audio/transcribe', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ detail: "File is required" });
        const tempPath = req.file.path;
        const text = await voiceEngine.speechToText(tempPath);
        fs.unlinkSync(tempPath);
        res.json({ text });
    } catch (e) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        console.error("[Transcribe Error]", e.message || e);
        res.status(500).json({ detail: "Internal server error" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
