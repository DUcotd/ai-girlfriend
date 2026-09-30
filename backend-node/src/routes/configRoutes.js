/**
 * 配置相关路由：/config、/config/status、/config/proactive
 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { aiGirlfriend, proactiveEngine, updateVoiceEngine } from '../services/container.js';
import { PROACTIVE_TYPES, PROACTIVE_GROUPS, toPublicTypeInfo } from '../core/proactiveTypes.js';

const router = Router();

// 主动消息类型目录：真源在 core/proactiveTypes.js（引擎与前端共用同一份定义），
// 路由只做裁剪，不再自己维护一张表。
const PROACTIVE_TYPE_INFOS = PROACTIVE_TYPES.map(toPublicTypeInfo);

router.post('/config', (req, res) => {
    // ⚠️ 这里只解构 snake_case：前端 syncConfig 已把 camelCase 转成这套名字，
    // 直接发 camelCase 会被静默忽略（字段收不到、界面看起来「没生效」）。
    const {
        api_key, base_url, model_name, tts_api_key,
        embedding_api_key, embedding_base_url, embedding_model_name,
        // 高级选项（设置页 → 通用 → 高级选项）
        max_prompt_history, temperature, max_tokens, reasoning_effort,
    } = req.body;
    const result = aiGirlfriend.updateConfig({
        apiKey: api_key,
        baseUrl: base_url,
        modelName: model_name,
        embeddingApiKey: embedding_api_key,
        embeddingBaseUrl: embedding_base_url,
        embeddingModelName: embedding_model_name,
        maxPromptHistory: max_prompt_history,
        temperature,
        maxTokens: max_tokens,
        reasoningEffort: reasoning_effort
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
        baseUrl: aiGirlfriend.baseUrl || null,
        // 高级选项当前生效值（前端设置页从 localStorage 回显，这里供排查/核对用）
        chat: aiGirlfriend.getChatParams()
    });
});

router.get('/config/proactive', (req, res) => {
    res.json({
        config: proactiveEngine.getConfig(),
        availableTypes: PROACTIVE_TYPE_INFOS,
        // 新增：设置页按分组渲染类型列表，分组定义同样来自唯一事实源
        groups: PROACTIVE_GROUPS,
    });
});

router.post('/config/proactive', (req, res) => {
    const { enabled, frequencyLevel, customDailyLimit, enabledTypes } = req.body;
    const newConfig = proactiveEngine.updateConfig({ enabled, frequencyLevel, customDailyLimit, enabledTypes });
    res.json({ status: "updated", config: newConfig });
});

export default router;
