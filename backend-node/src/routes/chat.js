/**
 * 聊天相关路由：/chat、/chat/proactive*
 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { fail } from '../middleware/validate.js';
import { aiGirlfriend, proactiveEngine, triggerRegistry } from '../services/container.js';
import { config } from '../config.js';
import { PROACTIVE_TYPE_IDS } from '../core/proactiveTypes.js';

const router = Router();

/**
 * 截断「思考」字段。二者语义不同，别混用：
 *   inner_thought   —— 小爱的人设内心独白（我们 prompt 要求的 <monologue>）
 *   model_reasoning —— 推理模型自己的 CoT（reasoning_content），普通模型恒为 null
 */
function thinkingField(text) {
    if (!text) return null;
    const max = config.chat.thinkingMaxChars;
    return text.length > max ? text.slice(0, max) + ' …(truncated)' : text;
}

/**
 * 组装好感度相关字段（trace + 阶段元数据 + 衰减/日上限提示）。
 *
 * ⚠️ /chat 与 /chat/stream 的 done 是两处**独立手写**的 object 字面量，
 * 必须共用这个 helper，否则会出现「流式有元数据、非流式没有」的不一致。
 * result.affinityMeta 缺失时（ghosting / 兜底路径）回退到引擎实时快照。
 */
function affinityPayload(result) {
    const meta = result.affinityMeta || aiGirlfriend.affinityEngine.getMeta();
    return {
        affinityTrace: result.affinityTrace || [],
        stage: meta.stage,
        stageLabel: meta.stageLabel,
        stageShortLabel: meta.stageShortLabel,
        nextStage: meta.nextStage,
        nextStageLabel: meta.nextStageLabel,
        pointsToNextStage: meta.pointsToNextStage,
        stageProgress: meta.stageProgress,
        recentChange: meta.recentChange,
        recentChangeReason: meta.recentChangeReason,
        decaying: meta.decaying,
        dailyCapReached: meta.dailyCapReached,
    };
}

/**
 * 组装任务动作结果字段。
 *
 * 与 affinityPayload 同一手法：/chat 与 /chat/stream 的 done 是两处**独立手写**的
 * object 字面量，必须共用这个 helper，否则「流式有、非流式没有」的老毛病会重现。
 * 老模型不输出 task_action（或走 ghosting/兜底路径）时恒为 null，前端行为完全不变。
 */
function taskPayload(result) {
    return { taskResult: result.taskResult ?? null };
}

/**
 * 模型输出不合规时的原因（emotion_delta 越界被裁剪、affinity_change 是无法识别的值…）。
 * 以前这些情况全被静默归零，用户只会看到「好感度怎么一动不动」。
 */
function warningsPayload(result) {
    return { parse_warnings: result.parseWarnings || [] };
}

router.post('/chat', asyncHandler(async (req, res) => {
    const { message } = req.body;
    if (!aiGirlfriend.apiKey) return res.status(400).json({ detail: "API Key not configured" });
    if (fail(res, typeof message !== 'string' || message.length > config.chat.maxMessageLength,
        `message is required and must be under ${config.chat.maxMessageLength} characters`)) return;

    proactiveEngine.notifyUserActive();
    const result = await aiGirlfriend.chat(message);
    res.json({
        reply: result.reply || "",
        token_usage: result.token_usage || {},
        context_count: aiGirlfriend.history.length,
        emotion: result.emotion || "平静",
        affinity: result.affinity ?? 35,
        ...affinityPayload(result),
        emotionalState: result.emotionalState || null,
        // 与 /chat/stream 的 done 保持同构：前端回退到非流式后仍靠它识别 ghosting
        special_action: result.special_action || null,
        inner_thought: thinkingField(result.innerThought),
        model_reasoning: thinkingField(result.modelReasoning),
        ...taskPayload(result),
        ...warningsPayload(result),
    });
}));

/**
 * 流式对话（SSE）。
 *
 * 事件序列：
 *   {type:'delta', text}  逐段正文，收到即可渲染
 *   {type:'done', ...}    完整结果与情绪/好感度等元数据
 *   {type:'error', detail}
 *
 * 前端应优先用它；不可用时回退到 /chat（非流式，行为不变）。
 */
router.post('/chat/stream', (req, res) => {
    const { message } = req.body;

    if (!aiGirlfriend.apiKey) {
        return res.status(400).json({ detail: "API Key not configured" });
    }
    if (typeof message !== 'string' || message.length > config.chat.maxMessageLength) {
        return res.status(400).json({
            detail: `message is required and must be under ${config.chat.maxMessageLength} characters`
        });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 禁止 Nginx 缓冲，否则流式会变成一次性返回
    res.flushHeaders?.();

    // 客户端断开 → abort 上游 LLM 请求。
    // 旧实现只置一个 closed 标志停止转发，生成照旧跑完、_finalize 照旧结算：
    // 用户白等的那段时间照样花钱，而且关系分数被一条没人看到的回复改掉。
    const controller = new AbortController();
    const send = (payload) => {
        if (res.writableEnded) return;
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    res.on('close', () => controller.abort());

    // notifyUserActive 在 flushHeaders 之后：它一抛错就会变成 ERR_HTTP_HEADERS_SENT
    // 且流永久挂起（/chat 里同一调用有 asyncHandler 兜底，这里必须自己包）
    try {
        proactiveEngine.notifyUserActive();
    } catch (e) {
        console.error(`[Chat/Stream] notifyUserActive failed: ${e.message}`);
    }

    aiGirlfriend
        .chatStream(message, (text) => send({ type: 'delta', text }), { signal: controller.signal })
        .then((result) => {
            if (res.writableEnded) return;
            send({
                type: 'done',
                reply: result.reply || "",
                emotion: result.emotion || "平静",
                affinity: result.affinity ?? 35,
                ...affinityPayload(result),
                emotionalState: result.emotionalState || null,
                special_action: result.special_action || null,
                context_count: aiGirlfriend.history.length,
                inner_thought: thinkingField(result.innerThought),
                model_reasoning: thinkingField(result.modelReasoning),
                ...taskPayload(result),
                ...warningsPayload(result),
                ...(result.aborted ? { aborted: true } : {}),
            });
            res.end();
        })
        .catch((e) => {
            console.error(`[Chat/Stream] Error: ${e.message}`);
            if (res.writableEnded) return;
            send({ type: 'error', detail: '生成失败，请重试' });
            res.end();
        });
});

router.get('/chat/proactive', (req, res) => {
    const message = proactiveEngine.consumeMessage();
    if (message) res.json(message);
    else res.status(204).end();
});

/**
 * 主动消息运行时状态。
 * 顶层既有 { queue, engine } 契约**保持不变**（前端 getProactiveStatus 依赖它）；
 * 追加 triggerRegistry 事件层快照（REQ-04）——engine.eventQueue 是裁剪视图，
 * 这里附带完整 registry.getStatus()（含 cooldowns / nextEligible / triggers），供排查用。
 * 事件层未装配时回落降级结构，调用方无需 null 判断。
 */
router.get('/chat/proactive/status', (req, res) => {
    let registryStatus = { enabled: false, queueSize: 0, queue: [], cooldowns: {}, nextEligible: {}, triggers: [] };
    try {
        if (triggerRegistry && typeof triggerRegistry.getStatus === 'function') {
            registryStatus = triggerRegistry.getStatus();
        }
    } catch (e) {
        console.error(`[Chat] triggerRegistry.getStatus failed: ${e.message || e}`);
    }
    res.json({
        queue: proactiveEngine.peekQueue(),
        engine: proactiveEngine.getStatus(),
        triggerRegistry: registryStatus,
    });
});

router.post('/chat/proactive/trigger', asyncHandler(async (req, res) => {
    const { reason = 'random_chat', data = {} } = req.body;
    // reason 白名单：未知值会按 FALLBACK_TYPE 生成却按原始字符串记账，重启后被静默丢弃
    const safeReason = typeof reason === 'string' && PROACTIVE_TYPE_IDS.includes(reason)
        ? reason
        : 'random_chat';
    const ok = await proactiveEngine.trigger(safeReason, data && typeof data === 'object' ? data : {});
    // trigger() 在 LLM 挂/队列满/同类在途时返回 false：失败必须让前端知道，
    // 而不是回 200 让用户对着一个永远不会出现的消息等
    if (!ok) {
        return res.status(503).json({
            status: "failed",
            reason: safeReason,
            detail: "触发失败：总开关已关闭、同类消息生成中或队列已满，请稍后再试",
        });
    }
    res.json({ status: "triggered", reason: safeReason, queueSize: proactiveEngine.messageQueue.length });
}));

export default router;
