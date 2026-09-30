/** 性格状态路由：全部挂在根路径，body 使用 camelCase。 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { fail } from '../middleware/validate.js';
import { aiGirlfriend } from '../services/container.js';
import { isDimKey } from '../core/personalityDims.js';
import { PRESET_IDS } from '../core/personalityPresets.js';

const router = Router();

/** 获取完整公开性格状态。 */
router.get('/personality', (req, res) => {
    res.json(aiGirlfriend.personalityDrift.getPublicState());
});

/** 按 preset → traits → flags 的固定顺序更新性格。 */
router.post('/personality', asyncHandler(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const engine = aiGirlfriend.personalityDrift;
    const traits = body.traits && typeof body.traits === 'object' && !Array.isArray(body.traits)
        ? body.traits
        : {};
    const unknownDim = Object.keys(traits).find((key) => !isDimKey(key));

    // 先完整校验再执行，避免部分合法 payload 在后续字段报错时留下半次更新。
    if (body.presetId !== undefined
        && fail(res, !PRESET_IDS.includes(body.presetId), `unknown presetId: ${body.presetId}`)) return;
    if (body.traits !== undefined
        && fail(res, Boolean(unknownDim), `unknown personality dim: ${unknownDim}`)) return;

    if (body.presetId !== undefined) {
        engine.applyPreset(body.presetId);
    }

    if (body.traits !== undefined) {
        engine.applyManual(traits);
    }

    engine.setFlags({
        ...(typeof body.driftEnabled === 'boolean' ? { driftEnabled: body.driftEnabled } : {}),
        ...(typeof body.baselineAdaptEnabled === 'boolean'
            ? { baselineAdaptEnabled: body.baselineAdaptEnabled }
            : {}),
    });
    res.json(engine.getPublicState());
}));

/** 获取时间升序的性格变化账本。 */
router.get('/personality/ledger', (req, res) => {
    res.json(aiGirlfriend.personalityDrift.getLedger());
});

/** 仅重置性格，不影响好感度、记忆或聊天记录。 */
router.post('/personality/reset', asyncHandler(async (req, res) => {
    const engine = aiGirlfriend.personalityDrift;
    engine.reset();
    res.json({ status: 'reset', ...engine.getPublicState(), ledger: engine.getLedger() });
}));

export default router;
