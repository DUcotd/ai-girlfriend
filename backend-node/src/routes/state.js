/**
 * 状态与数据路由：/history、/reset、/memories、/state、/system_prompt、/affinity/ledger
 *
 * ⚠️ 存在两条语义极易混淆、必须分开对待的破坏性路径：
 *   - DELETE /history —— 「新对话」：只清对话记录，**保留**好感度与长期记忆。
 *   - POST   /reset   —— 「完全重置」：清对话记录 + 好感度 + 长期记忆。
 * 两者曾共用 DELETE /history（实现是后者语义），导致「新对话」误清好感度，
 * 已拆分。改动任一语义前请先确认对应入口 UI 文案。
 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { fail } from '../middleware/validate.js';
import { aiGirlfriend } from '../services/container.js';

const router = Router();

router.get('/history', (req, res) => {
    res.json(aiGirlfriend.getHistory());
});

/**
 * 「新对话」：只清对话记录，保留好感度与长期记忆（入口：ChatToolbar「新对话」）。
 */
router.delete('/history', (req, res) => {
    aiGirlfriend.clearHistory();
    res.json({ status: "cleared" });
});

/**
 * 「完全重置」：清对话记录 + 好感度 + 长期记忆（入口：设置页「完全重置小爱」）。
 * 不要把这个端点接到「新对话」上——那会让用户丢整段关系。
 */
router.post('/reset', (req, res) => {
    aiGirlfriend.resetAll();
    res.json({ status: "reset" });
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
