/**
 * 关系阶段定义 —— 全项目唯一事实源。
 *
 * 阈值按用户心智模型标定（2026-09-28 重构）：
 *   默认好感度 35 → 朋友；70~80 → 挚友；100 → 亲密恋人。
 *
 * EmotionEngine / relationshipContext / affinityRules / proactivePrompts
 * 都必须从这里取阶段，禁止各自再写一套阈值。
 */

export const RELATIONSHIP_STAGES = [
    { min: 0,  max: 15,  stage: 'stranger',     label: '陌生/疏离',  shortLabel: '陌生' },
    { min: 16, max: 34,  stage: 'acquaintance', label: '初识/熟悉',  shortLabel: '初识' },
    { min: 35, max: 59,  stage: 'friend',       label: '朋友',       shortLabel: '朋友' },
    { min: 60, max: 84,  stage: 'close',        label: '挚友/暧昧',  shortLabel: '挚友' },
    { min: 85, max: 100, stage: 'lover',        label: '亲密/恋人',  shortLabel: '恋人' },
];

/**
 * 好感度 → 阶段条目 { min, max, stage, label, shortLabel }
 * @param {number} affinity 0-100
 */
export function getStageForAffinity(affinity) {
    const a = Math.max(0, Math.min(100, affinity));
    return RELATIONSHIP_STAGES.find(t => a >= t.min && a <= t.max) || RELATIONSHIP_STAGES[0];
}
