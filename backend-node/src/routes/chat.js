/**
 * 聊天相关路由：/chat、/chat/proactive*
 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { fail } from '../middleware/validate.js';
import { aiGirlfriend, proactiveEngine } from '../services/container.js';
import { config } from '../config.js';

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
        emotionalState: result.emotionalState || null,
        inner_thought: thinkingField(result.innerThought),
        model_reasoning: thinkingField(result.modelReasoning),
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

    const send = (payload) => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    let closed = false;
    res.on('close', () => { closed = true; });

    proactiveEngine.notifyUserActive();

    aiGirlfriend
        .chatStream(message, (text) => {
            if (!closed) send({ type: 'delta', text });
        })
        .then((result) => {
            if (closed) return;
            send({
                type: 'done',
                reply: result.reply || "",
                emotion: result.emotion || "平静",
                affinity: result.affinity ?? 35,
                emotionalState: result.emotionalState || null,
                special_action: result.special_action || null,
                context_count: aiGirlfriend.history.length,
                inner_thought: thinkingField(result.innerThought),
                model_reasoning: thinkingField(result.modelReasoning),
            });
            res.end();
        })
        .catch((e) => {
            console.error(`[Chat/Stream] Error: ${e.message}`);
            if (closed) return;
            send({ type: 'error', detail: e.message || 'stream failed' });
            res.end();
        });
});

router.get('/chat/proactive', (req, res) => {
    const message = proactiveEngine.consumeMessage();
    if (message) res.json(message);
    else res.status(204).end();
});

router.get('/chat/proactive/status', (req, res) => {
    res.json({ queue: proactiveEngine.peekQueue(), engine: proactiveEngine.getStatus() });
});

router.post('/chat/proactive/trigger', asyncHandler(async (req, res) => {
    const { reason = 'random_chat', data = {} } = req.body;
    await proactiveEngine.trigger(reason, data);
    res.json({ status: "triggered", reason, queueSize: proactiveEngine.messageQueue.length });
}));

export default router;
