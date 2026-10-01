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
        max_prompt_history, unlimited_context, temperature, max_tokens, reasoning_effort,
        // 记忆选项（设置页 → 记忆）
        memory_facts_enabled, memory_retrieval_mode,
        // 陪伴感增强开关（REQ-01/03/04）：snake_case，与既有字段命名风格一致。
        // 缺省（undefined）时 AiGirlfriend.updateConfig 不动对应开关，保持向后兼容。
        user_emotion_enabled, narrative_enabled, trigger_enabled,
    } = req.body;
    const result = aiGirlfriend.updateConfig({
        apiKey: api_key,
        baseUrl: base_url,
        modelName: model_name,
        embeddingApiKey: embedding_api_key,
        embeddingBaseUrl: embedding_base_url,
        embeddingModelName: embedding_model_name,
        maxPromptHistory: max_prompt_history,
        unlimitedContext: unlimited_context,
        temperature,
        maxTokens: max_tokens,
        reasoningEffort: reasoning_effort,
        memoryFactsEnabled: memory_facts_enabled,
        memoryRetrievalMode: memory_retrieval_mode,
        userEmotionEnabled: user_emotion_enabled,
        narrativeEnabled: narrative_enabled,
        triggerEnabled: trigger_enabled,
    });
    // 语音（TTS/ASR）独立配置：只用专属 TTS Key，绝不回退主 Key——
    // 未配置时语音引擎保持未启用态（云端朗读/录音转写返回 400 提示，前端回退浏览器本地语音）。
    // 显式传空串 = 清除 Key，引擎回到未配置态
    if (tts_api_key !== undefined) {
        updateVoiceEngine({ apiKey: tts_api_key === '' ? null : tts_api_key });
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
        chat: aiGirlfriend.getChatParams(),
        // 记忆系统当前生效值：实际检索模式（auto 解析后）+ 事实提取开关
        memory: aiGirlfriend.getMemoryStatus(),
        // 陪伴感增强子系统开关（REQ-01 用户情绪 / REQ-03 叙事 / REQ-04 事件层）
        companion: aiGirlfriend.getCompanionStatus(),
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
