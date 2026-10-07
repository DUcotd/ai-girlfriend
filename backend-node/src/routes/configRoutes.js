/**
 * 配置相关路由：/config、/config/status、/config/proactive
 */
import { Router } from 'express';
import { aiGirlfriend, proactiveEngine, updateVoiceEngine } from '../services/container.js';
import { PROACTIVE_TYPES, PROACTIVE_GROUPS, toPublicTypeInfo, PROACTIVE_TYPE_IDS } from '../core/proactiveTypes.js';
import { FREQUENCY_LEVELS } from '../core/ProactiveEngine.js';
import { configFieldRules, proactiveFieldRules, validateConfigBody } from '../utils/configValidation.js';
import { failWith } from '../middleware/validate.js';
import { ERROR_CODES } from '../utils/errorCodes.js';
import { REASONING_EFFORTS } from '../config.js';

const router = Router();

// 主动消息类型目录：真源在 core/proactiveTypes.js（引擎与前端共用同一份定义），
// 路由只做裁剪，不再自己维护一张表。
const PROACTIVE_TYPE_INFOS = PROACTIVE_TYPES.map(toPublicTypeInfo);

/** 校验失败统一响应：errors 逐条给原因，界面与排障脚本都能直接显示给用户 */
function reject(res, errors) {
    // `status: 'invalid_config'` 是历史字段（脚本与旧界面在读），保留；
    // 新契约看 error_code —— 两者同值，前端从此不需要匹配中文文案（B7-①）
    return failWith(res, 400, errors[0], ERROR_CODES.INVALID_CONFIG, {
        status: 'invalid_config',
        errors,
    });
}

router.post('/config', (req, res) => {
    // ⚠️ 这里只接受 snake_case：前端 syncConfig 已把 camelCase 转成这套名字。
    // 未知字段不再静默忽略（HTTP-11），而是在响应 warnings 里点名 —— 字段名写错
    // 是最难查的一类失效：界面显示「已保存」，配置其实一个字都没进去。
    const { errors, warnings, values } = validateConfigBody(
        req.body, configFieldRules(REASONING_EFFORTS)
    );
    if (errors.length) return reject(res, errors);

    const result = aiGirlfriend.updateConfig({
        apiKey: values.api_key,
        baseUrl: values.base_url,
        modelName: values.model_name,
        embeddingApiKey: values.embedding_api_key,
        embeddingBaseUrl: values.embedding_base_url,
        embeddingModelName: values.embedding_model_name,
        maxPromptHistory: values.max_prompt_history,
        unlimitedContext: values.unlimited_context,
        temperature: values.temperature,
        maxTokens: values.max_tokens,
        reasoningEffort: values.reasoning_effort,
        memoryFactsEnabled: values.memory_facts_enabled,
        memoryRetrievalMode: values.memory_retrieval_mode,
        userEmotionEnabled: values.user_emotion_enabled,
        narrativeEnabled: values.narrative_enabled,
        triggerEnabled: values.trigger_enabled,
    });

    // Key 在但客户端没建起来 = 这份配置每轮都会失败，必须在保存这一刻告诉用户
    if (result.configured === false) {
        return reject(res, [
            result.configError || '客户端初始化失败，请检查 API Key 与 Base URL',
        ]);
    }

    // 语音（TTS/ASR）独立配置：只用专属 TTS Key，绝不回退主 Key——
    // 未配置时语音引擎保持未启用态（云端朗读/录音转写返回 400 提示，前端回退浏览器本地语音）。
    // null / 空串都表示清除，引擎回到未配置态。
    if (values.tts_api_key !== undefined) {
        updateVoiceEngine({ apiKey: values.tts_api_key === '' ? null : values.tts_api_key });
    }
    res.json({
        status: "updated",
        current_model: result.modelName || aiGirlfriend.modelName,
        base_url: aiGirlfriend.baseUrl || null,
        ...(warnings.length ? { warnings } : {}),
    });
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
    const { errors, values } = validateConfigBody(
        req.body, proactiveFieldRules(FREQUENCY_LEVELS)
    );
    if (errors.length) return reject(res, errors);

    // 未知类型 id 以前是被 _applyConfig 静默过滤的：设置页拿不到目录时（版本不同步）
    // 用户点保存会把整份勾选悄悄改掉。现在明确拒绝，让前后端的类型目录必须对齐。
    if (Array.isArray(values.enabledTypes)) {
        const unknown = values.enabledTypes.filter((t) => !PROACTIVE_TYPE_IDS.includes(t));
        if (unknown.length) {
            return reject(res, [`未知的主动消息类型：${unknown.join(', ')}（请刷新设置页重新勾选）`]);
        }
    }
    const newConfig = proactiveEngine.updateConfig({
        enabled: values.enabled,
        frequencyLevel: values.frequencyLevel,
        customDailyLimit: values.customDailyLimit,
        enabledTypes: values.enabledTypes,
    });
    res.json({ status: "updated", config: newConfig });
});

export default router;
