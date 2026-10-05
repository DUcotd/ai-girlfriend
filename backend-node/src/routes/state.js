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
import { config } from '../config.js';

const router = Router();

/** 事实内容/分类的长度守卫（审计 HTTP-18）：超限的文本会被每一轮注入 prompt，必须挡在入库前 */
function badFactText(content, category) {
    if (typeof content === 'string' && content.trim().length > config.textLimits.factContent) {
        return `content 最长 ${config.textLimits.factContent} 个字符（收到 ${content.trim().length}）`;
    }
    if (typeof category === 'string' && category.trim().length > config.textLimits.factCategory) {
        return `category 最长 ${config.textLimits.factCategory} 个字符`;
    }
    return null;
}

router.get('/history', (req, res) => {
    res.json(aiGirlfriend.getHistory());
});

/**
 * 「新对话」：只清对话记录，保留好感度与长期记忆（入口：ChatToolbar「新对话」）。
 * persisted:false 表示内存已清但没写进磁盘（重启会回滚），必须让调用方看得见。
 */
router.delete('/history', (req, res) => {
    const persisted = aiGirlfriend.clearHistory();
    res.json({ status: "cleared", persisted });
});

/**
 * 「完全重置」：清对话记录 + 好感度 + 性格 + 情绪 + 任务 + 长期记忆 + 主动消息
 * 运行时状态 + 生活日志（入口：设置页「完全重置小爱」）。
 * 不要把这个端点接到「新对话」上——那会让用户丢整段关系。
 *
 * resetAll() 现在是 async：它会先排空在途对话再清空，避免「重置被那一轮的收尾
 * 写回撤销」。各引擎独立重置、单点失败不中断，因此可能拿到部分失败信息。
 *
 * ⚠️ 部分失败回 **200 + status:'partial'**，不是 207：前端共用的 request() 对任何
 * 非 2xx 都直接 throw 且不解析响应体，用 207 会让「已经删掉一部分」被报成
 * 「重置失败」，用户于是重试或以为没发生（审计 HTTP-08 / FE-06）。
 */
router.post('/reset', asyncHandler(async (req, res) => {
    const result = await aiGirlfriend.resetAll();
    res.json({
        status: result.failed.length > 0 ? "partial" : "reset",
        ...result,
    });
}));

router.get('/system_prompt', (req, res) => {
    res.json({ system_prompt: aiGirlfriend.getSystemPrompt() });
});

/**
 * 更新人设。⚠️ 语义：只换 history[0] 的 system 条目，**不动任何对话内容**，
 * 并立即持久化（旧实现是「清空整段历史且不落盘」，等于一个没有把手的删除按钮）。
 */
router.post('/system_prompt', (req, res) => {
    const { system_prompt } = req.body;
    if (fail(res, typeof system_prompt !== 'string' || !system_prompt.trim(),
        'system_prompt is required and must be a non-empty string')) return;
    const result = aiGirlfriend.updateSystemPrompt(system_prompt);
    res.json({ status: "updated", system_prompt: aiGirlfriend.getSystemPrompt(), ...result });
});

router.get('/memories', (req, res) => {
    res.json(aiGirlfriend.getMemories());
});

/**
 * 手动添加事实记忆。
 */
router.post('/memories/facts', asyncHandler(async (req, res) => {
    const { content, importance, category } = req.body;
    if (fail(res, !content || typeof content !== 'string' || !content.trim(),
        'content is required')) return;
    if (fail(res, importance !== undefined && (typeof importance !== 'number' || importance < 1 || importance > 5),
        'importance must be a number between 1 and 5')) return;
    if (fail(res, category !== undefined && typeof category !== 'string',
        'category must be a string')) return;
    const tooLong = badFactText(content, category);
    if (fail(res, !!tooLong, tooLong)) return;
    try {
        const fact = await aiGirlfriend.addFact(content.trim(), {
            importance,
            category: category?.trim() || undefined,
        });
        res.json({ status: "added", fact });
    } catch (e) {
        if (e.code === 'DUPLICATE_FACT') {
            res.status(409).json({ detail: e.message });
            return;
        }
        throw e;
    }
}));

/**
 * 编辑事实记忆（内容 / 重要度 / 分类）。
 */
router.patch('/memories/facts/:id', asyncHandler(async (req, res) => {
    const { content, importance, category } = req.body;
    if (fail(res, content !== undefined && (typeof content !== 'string' || !content.trim()),
        'content must be a non-empty string')) return;
    if (fail(res, importance !== undefined && (typeof importance !== 'number' || importance < 1 || importance > 5),
        'importance must be a number between 1 and 5')) return;
    if (fail(res, category !== undefined && typeof category !== 'string',
        'category must be a string')) return;
    const tooLong = badFactText(content, category);
    if (fail(res, !!tooLong, tooLong)) return;
    const fact = await aiGirlfriend.updateFact(req.params.id, {
        content: content?.trim(),
        importance,
        category: category?.trim(),
    });
    if (!fact) {
        res.status(404).json({ detail: 'fact not found' });
        return;
    }
    res.json({ status: "updated", fact });
}));

/**
 * 删除单条记忆（事实或情节，按 id 查找）。
 */
router.delete('/memories/:id', (req, res) => {
    const type = aiGirlfriend.deleteMemory(req.params.id);
    if (!type) {
        res.status(404).json({ detail: 'memory not found' });
        return;
    }
    res.json({ status: "deleted", type });
});

router.delete('/memories', (req, res) => {
    aiGirlfriend.clearMemoriesOnly();
    res.json({ status: "memories_cleared" });
});

router.get('/state', (req, res) => {
    res.json(aiGirlfriend.getState());
});

/**
 * 用户情绪时间线（REQ-01，供 REQ-10 前端可选消费）。
 * 返回 { state, timelineStats, timeline }；引擎缺失时回落空结构，不报错。
 * ⚠️ 挂根路径（app.js 已 app.use('/', stateRoutes)），没有 /api 前缀。
 */
router.get('/state/user-emotion', (req, res) => {
    const engine = aiGirlfriend.userEmotionEngine;
    if (!engine) {
        res.json({ state: null, timelineStats: { count: 0, cap: 0, trend: null }, timeline: [] });
        return;
    }
    res.json({ ...engine.getState(), timeline: engine.getTimeline() });
});

router.post('/state', (req, res) => {
    const { affinity, nickname } = req.body;
    // 与 chat.js / tasks.js 同一套校验惯例：类型不对回 400，而不是静默忽略还报 updated
    if (fail(res, affinity !== undefined && typeof affinity !== 'number',
        'affinity must be a number')) return;
    if (fail(res, nickname !== undefined && typeof nickname !== 'string',
        'nickname must be a string')) return;
    // 上限数值在 config.textLimits（唯一事实源），不再这里抄一份 50
    if (fail(res, typeof nickname === 'string' && nickname.length > config.textLimits.nickname,
        `nickname 最长 ${config.textLimits.nickname} 个字符`)) return;
    if (fail(res, typeof affinity === 'number' && !Number.isFinite(affinity),
        'affinity 必须是有限数字')) return;
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

/**
 * 共同经历叙事列表（REQ-03 我们的故事）。
 * 返回 { narratives, stats }；引擎缺失时回落空结构，不报错。
 * ⚠️ 挂根路径（app.js 已 app.use('/', stateRoutes)），没有 /api 前缀。
 */
router.get('/state/narratives', (req, res) => {
    if (!aiGirlfriend.getNarratives) {
        res.json({ narratives: [], stats: { total: 0 } });
        return;
    }
    res.json(aiGirlfriend.getNarratives());
});

/**
 * 手动删除一条共同经历叙事（REQ-03，A7：用户删 episode 不级联删叙事，
 * 但提供本入口让用户主动清理某条叙事）。
 */
router.delete('/state/narratives/:id', (req, res) => {
    const ok = aiGirlfriend.deleteNarrative ? aiGirlfriend.deleteNarrative(req.params.id) : false;
    if (!ok) {
        res.status(404).json({ detail: 'narrative not found' });
        return;
    }
    res.json({ status: 'deleted' });
});

export default router;
