/**
 * 聊天相关路由：/chat、/chat/proactive*
 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { fail } from '../middleware/validate.js';
import { aiGirlfriend, proactiveEngine } from '../services/container.js';
import { config } from '../config.js';

const router = Router();

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
        emotionalState: result.emotionalState || null
    });
}));

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
