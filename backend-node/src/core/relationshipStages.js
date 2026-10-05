/**
 * 关系阶段定义 —— 全项目唯一事实源。
 *
 * 阈值按用户心智模型标定（2026-09-28 重构）：
 *   默认好感度 35 → 朋友；70~80 → 挚友；100 → 亲密恋人。
 *
 * EmotionEngine / relationshipContext / affinityRules / proactivePrompts
 * 都必须从这里取阶段，禁止各自再写一套阈值。
 *
 * 2026-09-30 重构：新增 getStageIndex / getNextStage / buildStageMeta，
 * 让前端可以直接消费后端下发的阶段元数据（零阈值），阈值数组本身不动。
 *
 * unlocks（REQ-06）：这个阶段**新解锁**的行为，机器可读的一份表述。
 * 关系跃迁的仪式感（她说「我们现在可以……」）与每轮的关系说明书都从这里取，
 * 不再各自写一遍 —— 措辞只有一处，不会出现「prompt 说可以、跃迁说不可以」。
 */

export const RELATIONSHIP_STAGES = [
    {
        min: 0, max: 15, stage: 'stranger', label: '陌生/疏离', shortLabel: '陌生',
        unlocks: [],
    },
    {
        min: 16, max: 34, stage: 'acquaintance', label: '初识/熟悉', shortLabel: '初识',
        unlocks: ['可以叫他的昵称', '可以聊各自的日常'],
    },
    {
        min: 35, max: 59, stage: 'friend', label: '朋友', shortLabel: '朋友',
        unlocks: ['可以记住并主动提起他随口说过的事', '可以分享自己的小秘密和小情绪', '可以玩笑式地互怼'],
    },
    {
        min: 60, max: 84, stage: 'close', label: '挚友/暧昧', shortLabel: '挚友',
        unlocks: ['可以说"最喜欢你了"这类暧昧的话', '可以主动说想他、会吃醋', '因为他的一句话开心或失落'],
    },
    {
        min: 85, max: 100, stage: 'lover', label: '亲密/恋人', shortLabel: '恋人',
        unlocks: ['可以用恋人式称呼（亲爱的、宝贝）', '可以大方说爱他、规划两个人的未来'],
    },
];

/**
 * 好感度 → 阶段条目 { min, max, stage, label, shortLabel }
 * @param {number} affinity 0-100
 */
export function getStageForAffinity(affinity) {
    const a = Math.max(0, Math.min(100, affinity));
    return RELATIONSHIP_STAGES.find(t => a >= t.min && a <= t.max) || RELATIONSHIP_STAGES[0];
}

/**
 * 阶段在数组中的下标（0-4）。未知输入按 getStageForAffinity 的兜底返回 0。
 * @param {number} affinity
 * @returns {number}
 */
export function getStageIndex(affinity) {
    const stage = getStageForAffinity(affinity);
    const idx = RELATIONSHIP_STAGES.findIndex(t => t.stage === stage.stage);
    return idx < 0 ? 0 : idx;
}

/**
 * 下一阶段条目；已是 lover 返回 null。
 * @param {number} affinity
 * @returns {{ min:number, max:number, stage:string, label:string, shortLabel:string } | null}
 */
export function getNextStage(affinity) {
    return RELATIONSHIP_STAGES[getStageIndex(affinity) + 1] || null;
}

/**
 * 下发给前端的阶段元数据（前端据此零阈值渲染，PRD P0-a）。
 *   stageProgress      = (affinity - stage.min) / (stage.max - stage.min)，clamp [0,1]
 *   pointsToNextStage  = max(0, next.min - affinity)；lover 阶段为 0
 * @param {number} affinity
 * @returns {{
 *   stage: string, stageLabel: string, stageShortLabel: string,
 *   nextStage: string | null, nextStageLabel: string | null,
 *   pointsToNextStage: number, stageProgress: number
 * }}
 */
export function buildStageMeta(affinity) {
    const a = Math.max(0, Math.min(100, affinity));
    const stage = getStageForAffinity(a);
    const next = getNextStage(a);
    const span = stage.max - stage.min;
    const stageProgress = span > 0 ? Math.max(0, Math.min(1, (a - stage.min) / span)) : 1;
    const pointsToNextStage = next ? Math.max(0, next.min - a) : 0;

    return {
        stage: stage.stage,
        stageLabel: stage.label,
        stageShortLabel: stage.shortLabel,
        nextStage: next ? next.stage : null,
        nextStageLabel: next ? next.label : null,
        pointsToNextStage,
        stageProgress,
    };
}
