/**
 * 配置相关路由：/config、/config/status、/config/proactive
 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { aiGirlfriend, proactiveEngine, updateVoiceEngine } from '../services/container.js';

const router = Router();

// 主动消息类型目录（供前端设置页渲染）
const PROACTIVE_TYPES = [
    { id: 'morning_greeting', label: 'Good morning', description: 'Sent at 8 AM' },
    { id: 'night_greeting', label: 'Good night', description: 'Sent at 10 PM' },
    { id: 'task_reminder', label: 'Task reminder', description: '15 min before deadline' },
    { id: 'miss_you', label: 'Missing you', description: 'Sent when inactive for a while' },
    { id: 'mood_check', label: 'Mood check', description: 'Check in during afternoon/evening' },
    { id: 'memory_share', label: 'Memory share', description: 'Share a past memory' },
    { id: 'random_chat', label: 'Random chat', description: 'Spontaneous chat' },
    { id: 'life_update', label: 'Life update', description: 'What I was doing while you were away' }
];

router.post('/config', (req, res) => {
    const { api_key, base_url, model_name, tts_api_key, embedding_api_key, embedding_base_url, embedding_model_name } = req.body;
    const result = aiGirlfriend.updateConfig({
        apiKey: api_key,
        baseUrl: base_url,
        modelName: model_name,
        embeddingApiKey: embedding_api_key,
        embeddingBaseUrl: embedding_base_url,
        embeddingModelName: embedding_model_name
    });
    if (tts_api_key || api_key) {
        updateVoiceEngine({ apiKey: tts_api_key || api_key });
    }
    res.json({ status: "updated", current_model: result.modelName || aiGirlfriend.modelName });
});

router.get('/config/status', (req, res) => {
    res.json({
        isConfigured: !!aiGirlfriend.apiKey,
        hasEmbeddingConfig: !!aiGirlfriend.embeddingApiKey,
        currentModel: aiGirlfriend.modelName || null,
        baseUrl: aiGirlfriend.baseUrl || null
    });
});

router.get('/config/proactive', (req, res) => {
    res.json({
        config: proactiveEngine.getConfig(),
        availableTypes: PROACTIVE_TYPES
    });
});

router.post('/config/proactive', (req, res) => {
    const { enabled, frequencyLevel, customDailyLimit, enabledTypes } = req.body;
    const newConfig = proactiveEngine.updateConfig({ enabled, frequencyLevel, customDailyLimit, enabledTypes });
    res.json({ status: "updated", config: newConfig });
});

export default router;
