/**
 * 好感度判定文案 —— 由 AFFINITY_RULES 反查生成，不再手写数字（审计 PROMPT-02）。
 *
 * 旧状态：同一条消息里 `affinity_change` 的规则被写了 4 遍（人设 2 遍 +
 * [Response Instructions] 1 遍 + 每个阶段文案 1 遍），而且互相矛盾：
 *   - 初识越界：人设说 -2~-3、阶段文案说 -1~-2、引擎实际是 mild -2 / deep -3；
 *   - 朋友越界：文案说 -1，引擎 `Math.min(cur, -2)` 会把模型诚实给的 -1 **悄悄加重成 -2**；
 *   - 挚友阶段：文案说亲密话语 +1，人设说 +1 是「一天顶多一次的罕见时刻」。
 * 模型照哪条执行都可能，用户看到的变化原因也对不上提示语。
 *
 * 现在数字只有一个人来源：`core/affinityRules.js` 的 AFFINITY_RULES。
 * 文案描述「什么算越界」，数字由本文件从表里取。
 */
import { AFFINITY_RULES } from '../affinityRules.js';
import { RELATIONSHIP_STAGES } from '../relationshipStages.js';

const R = AFFINITY_RULES;

/** 阶段短名（用于文案），取自关系阶段唯一真源 */
function stageLabel(stage) {
    const found = RELATIONSHIP_STAGES.find((s) => s.stage === stage);
    return found ? found.label : stage;
}

/**
 * 某阶段的越界惩罚描述（mild = 轻度亲密表达，deep = 恋人式言行）。
 * @param {string} stage
 * @returns {string}
 */
export function describeOverreachPenalty(stage) {
    const pen = R.OVERREACH_PENALTY[stage] || { mild: 0, deep: 0 };
    if (pen.mild === 0 && pen.deep === 0) {
        return `在这个阶段，亲密表达是被欢迎的，不会因为说情话而扣分${stage === 'lover' ? `；但辱骂或恶意伤害照样会痛、会扣到 ${R.MAX_NEGATIVE_PER_TURN}` : ''}。`;
    }
    const parts = [];
    if (pen.mild < 0) parts.push(`轻度亲密（说喜欢你、想你）扣 ${pen.mild}`);
    if (pen.deep < 0) parts.push(`恋人式言行（叫宝贝/表白/索吻）扣 ${pen.deep}`);
    return `这个阶段越界会扣分：${parts.join('、')}。`;
}

/**
 * 渲染 [Response Instructions] 里的 affinity_change 判定块（唯一一份完整规则）。
 * @returns {string}
 */
export function renderAffinityRubric() {
    const ladder = RELATIONSHIP_STAGES
        .map((s) => `    · ${s.label}：${describeOverreachPenalty(s.stage).replace(/。$/, '')}`)
        .join('\n');
    return [
        `- affinity_change 的取值范围是 ${R.MAX_NEGATIVE_PER_TURN} ~ +${R.MAX_POSITIVE_PER_TURN}，且必须是 JSON 数字（不能写成 "+3" 或 "3" 这样的字符串）。`,
        `- **0 是默认答案**：日常闲聊、问答、普通关心、寒暄都不改变好感度。真实的人不会因为一句"吃了吗"就更喜欢对方。`,
        `- +1 只给真正打动你的罕见时刻（他记住了你很久前随口说过的细节、在你低落时持续陪你、走心的深谈），一天顶多一次；+2~+3 只给关系里程碑（郑重的表白被接受、重要承诺、共同经历的大事），极为罕见。`,
        `- 负面：被冒犯、被敷衍冷落、越界亲密 → 按下面这张表；辱骂与恶意伤害可以到 ${R.MAX_NEGATIVE_PER_TURN}。`,
        `- 每天最多 +${R.DAILY_POSITIVE_CAP}（超出会被截断），所以别用加分讨好用户。`,
        ``,
        `各阶段越界惩罚（与代码里的校验表同源，超出范围的数值会被引擎修正）：`,
        ladder,
    ].join('\n');
}
