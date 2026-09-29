/**
 * 状态与数据路由：/history、/memories、/state、/system_prompt、/affinity/ledger
 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { fail } from '../middleware/validate.js';
import { aiGirlfriend } from '../services/container.js';

const router = Router();

router.get('/history', (req, res) => {
    res.json(aiGirlfriend.getHistory());
});

router.delete('/history', (req, res) => {
    aiGirlfriend.clearHistory();
    res.json({ status: "cleared" });
});

router.get('/system_prompt', (req, res) => {
    res.json({ system_prompt: aiGirlfriend.getSystemPrompt() });
});

router.post('/system_prompt', (req, res) => {
    const { system_prompt } = req.body;
    if (fail(res, !system_prompt, 'system_prompt is required')) return;
    aiGirlfriend.updateSystemPrompt(system_prompt);
    res.json({ status: "updated", system_prompt });
});

router.get('/memories', (req, res) => {
    res.json(aiGirlfriend.getMemories());
});

router.delete('/memories', (req, res) => {
    aiGirlfriend.clearMemoriesOnly();
    res.json({ status: "memories_cleared" });
});

router.get('/state', (req, res) => {
    res.json(aiGirlfriend.getState());
});

router.post('/state', (req, res) => {
    const { affinity, nickname } = req.body;
    const newState = aiGirlfriend.updateState({ affinity, nickname });
    res.json({ status: "updated", ...newState });
});

/**
 * 好感度变更账本（时间升序，≤200 条）。
 * ⚠️ 挂根路径（app.js 已 app.use('/', stateRoutes)），没有 /api 前缀。
 */
router.get('/affinity/ledger', (req, res) => {
    res.json(aiGirlfriend.affinityEngine.getLedger());
});

export default router;
