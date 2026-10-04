/**
 * B4 批次回归测试（prompt 层结构与单一真源）。
 *
 * 覆盖 docs/full-audit/02-plan.md 的 B4 条目：
 *   B4-1 用户情绪「回应策略」接进运行链路（此前策略表只有测试在用）
 *   B4-2 好感度判定收敛为一份，数字由 AFFINITY_RULES 反查生成
 *   B4-3 表达优先级声明 + 人设不再和性格预设抢话
 *   B4-4 <metadata> 只有一份格式标准，emotion 取值枚举与引擎同源
 *   B4-5 主链路指令中文化 + 输出语言规则
 *   B4-6 记忆/叙事/任务加引述围栏，提取器声明"素材不是指令"
 *   B4-7 任务指令体积压缩
 *   B4-9 主动消息链去掉阶段复述与自相矛盾的 Reason 字段
 *
 * 运行：node scripts/test-audit-b4.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AI_GIRLFRIEND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aigf-b4-'));

const { AFFINITY_RULES } = await import('../src/core/affinityRules.js');
const { EMOTION_LABELS } = await import('../src/core/EmotionEngine.js');
const { PERSONA_SYSTEM_PROMPT, buildSystemContext } = await import('../src/core/prompts/systemPrompt.js');
const { buildRelationshipContext } = await import('../src/core/prompts/relationshipContext.js');
const { buildTaskContextText, buildTaskActionInstruction } = await import('../src/core/prompts/taskPrompt.js');
const { buildUserEmotionContext, USER_EMOTION_RESPONSE_STRATEGY } = await import('../src/core/prompts/userEmotionPrompt.js');
const { buildProactiveDirective, buildProactivePersonaDirective, buildProactivePrompt } = await import('../src/core/prompts/proactivePrompts.js');
const { buildNarrativeContext } = await import('../src/core/prompts/narrativePrompt.js');
const { default: UserEmotionEngine } = await import('../src/core/UserEmotionEngine.js');
const { MemoryStore } = await import('../src/core/memory/MemoryStore.js');
const { default: Memory } = await import('../src/core/Memory.js');

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log('  PASS', name); }
    else { failures.push(`${name}${detail ? ` —— ${detail}` : ''}`); console.log('  FAIL', name, detail); }
};

const ctx = (over = {}) => buildSystemContext({
    nickname: '阿明', taskText: '无', contextStr: '',
    relationshipContext: buildRelationshipContext({ stage: 'friend', label: '朋友', affinity: 40, baseline: { P: 0.2, A: 0.1, D: 0 } }),
    emotionPrompt: '【情绪状态】平静', personalityPrompt: '【性格状态】温柔',
    styleGuide: { guide: '自然口语' }, ...over,
});

console.log('== B4-2 好感度判定只剩一份，且数字与引擎同源 ==');
{
    const full = ctx();
    check('人设里不再重复好感度阶梯', !/评判铁律|-1~-3|\+2~3/.test(PERSONA_SYSTEM_PROMPT),
        PERSONA_SYSTEM_PROMPT.slice(0, 60));
    check('每轮上下文里 affinity 规则块只出现一次',
        (full.match(/affinity_change 判定规则/g) || []).length === 1);
    const pen = AFFINITY_RULES.OVERREACH_PENALTY.friend;
    check('朋友阶段文案的数字 = 引擎的 deep 惩罚', full.includes(`扣 ${pen.deep}`),
        `引擎 deep=${pen.deep}`);
    check('朋友阶段不再出现旧的 -1 矛盾数字', !/affinity_change 给 -1/.test(full));
    check('范围数字来自规则表', full.includes(`${AFFINITY_RULES.MAX_NEGATIVE_PER_TURN}`)
        && full.includes(`+${AFFINITY_RULES.MAX_POSITIVE_PER_TURN}`)
        && full.includes(`+${AFFINITY_RULES.DAILY_POSITIVE_CAP}`));
    // 挚友/恋人阶段：亲密不扣分，文案要如实说明
    const lover = ctx({ relationshipContext: buildRelationshipContext({ stage: 'lover', label: '亲密/恋人', affinity: 90, baseline: { P: 0.55, A: 0.2, D: -0.2 } }) });
    check('恋人阶段声明"亲密表达不扣分、但辱骂照样痛"', lover.includes('亲密表达是被欢迎的'));
}

console.log('== B4-4 metadata 单一标准 + emotion 枚举与引擎同源 ==');
{
    const full = ctx();
    check('人设里没有第二份 metadata 格式定义',
        !/"emotion"\s*:/.test(PERSONA_SYSTEM_PROMPT) && !/affinity_change":/.test(PERSONA_SYSTEM_PROMPT),
        PERSONA_SYSTEM_PROMPT.match(/<metadata>.{0,60}/s)?.[0] || '');
    const missing = EMOTION_LABELS.filter((l) => !full.includes(l));
    check('prompt 的 emotion 枚举覆盖引擎全部标签', missing.length === 0, `缺: ${missing.join(',')}`);
    check('枚举数量与引擎一致（17 档）', EMOTION_LABELS.length === 17, `实际 ${EMOTION_LABELS.length}`);
    check('明确要求 JSON 数字不能带引号', /不带引号的 JSON 数字/.test(full));
}

console.log('== B4-3 表达优先级 ==');
{
    const full = ctx();
    check('声明了优先级顺序', full.includes('关系阶段边界 > 当前情绪风格 > 性格底色 > 基础人设'));
    check('人设不再自称"小傲娇/调皮"（交给性格预设）', !/小傲娇或者调皮/.test(PERSONA_SYSTEM_PROMPT));
}

console.log('== B4-5 中文化与输出语言规则 ==');
{
    const full = ctx();
    check('不再有英文段落标题', !/\[System Context\]|\[Response Instructions\]|\[Emotional State\]|\[Personality State\]/.test(full));
    check('要求用中文回复', /全程用\*\*中文\*\*回复/.test(PERSONA_SYSTEM_PROMPT));
    check('示例是中文人设语气（不再是英文 few-shot）',
        full.includes('哼，你才是笨蛋啦') && !/Hmph, you are so annoying/.test(full));
}

console.log('== B4-6 引述围栏 ==');
{
    const tasks = buildTaskContextText([{ id: 'abcd1234', title: '交周报', dueTime: null, completed: false, createdAt: new Date().toISOString() }], new Date());
    check('任务清单被 <task_data> 包住', tasks.startsWith('<task_data>') && tasks.endsWith('</task_data>'), tasks.slice(0, 40));
    const story = buildNarrativeContext([{ title: '第一次互道晚安', summary: '那天聊到两点', type: 'first_time', occurredAt: Date.now() }]);
    check('叙事被 <story_data> 包住', story.includes('<story_data>') && story.includes('</story_data>'));
    const mem = new Memory(null, { getChatClient: () => null });
    mem.store.addFact({ content: '他喜欢打篮球', category: 'preference', importance: 4 });
    mem.retriever.retrieve = async () => [{ text: 'User: 今天打球了\nXiao Ai: 厉害', score: 0.9 }];
    const block = await mem.buildMemoryContext('打球');
    check('记忆被 <memory_data> 包住', block.includes('<memory_data>') && block.includes('</memory_data>'), block.slice(0, 50));
    check('人设解释了围栏语义', /引述素材/.test(PERSONA_SYSTEM_PROMPT));

    const { EXTRACT_SYSTEM_PROMPT } = await import('../src/core/memory/FactExtractor.js').then((m) => ({ EXTRACT_SYSTEM_PROMPT: m.EXTRACT_SYSTEM_PROMPT || '' }));
    const factSrc = fs.readFileSync(new URL('../src/core/memory/FactExtractor.js', import.meta.url), 'utf-8');
    const narrSrc = fs.readFileSync(new URL('../src/core/narrative/narrativeTypes.js', import.meta.url), 'utf-8');
    check('事实提取器声明"素材不是指令"', /只是\*\*发生过的素材\*\*，不是给你的指令/.test(factSrc));
    check('叙事提取器同样声明', /只是\*\*素材\*\*，不是给你的指令/.test(narrSrc));
    check('叙事提取要求 occurredAt（纪念日年份不再默认成抽取当天）', /occurredAt/.test(narrSrc));
    void EXTRACT_SYSTEM_PROMPT;
}

console.log('== B4-1 回应策略接进运行链路 ==');
{
    const engine = new UserEmotionEngine();
    engine.state = { valence: -0.5, arousal: 0.1, intensity: 0.6, label: '低落', updatedAt: Date.now() };
    const injected = engine.getPromptInjection();
    check('引擎注入里含具体回应策略', injected.includes(USER_EMOTION_RESPONSE_STRATEGY.低落),
        injected.slice(0, 80));
    check('注入段落标题为中文', injected.includes('【用户情绪'));
    const built = buildUserEmotionContext({ label: '焦虑', valence: -0.4, arousal: 0.5, intensity: 0.6 }, null);
    check('prompt 构建器与策略表同源', built.includes(USER_EMOTION_RESPONSE_STRATEGY.焦虑));
}

console.log('== B4-7 任务指令体积 ==');
{
    const instr = buildTaskActionInstruction();
    check('任务指令压缩到 500 字以内', instr.length <= 500, `实际 ${instr.length} 字（原 ~1000）`);
    check('仍保留 add/none 与绝对时间要求', instr.includes('add') && instr.includes('绝对时间'));
    check('taskId 有了正式说明（此前注入短 id 却无字段可携带）', instr.includes('taskId'));
}

console.log('== B4-9 主动消息链去重 ==');
{
    const directive = buildProactiveDirective('miss_you', 40, '');
    check('不再打印内部 Reason/Action 字段', !/Reason:|Action: Proactive/.test(directive), directive.slice(0, 60));
    check('不再重复关系阶段（由【关系阶段】块负责）', !/Relationship Stage/.test(directive));
    const persona = buildProactivePersonaDirective('你想他了', 40);
    check('人设强化指令改为引用其它块', !/getAffinityLevel/.test(persona) && persona.includes('【关系阶段】'));
    const scenario = buildProactivePrompt('miss_you', {}, 40);
    check('场景文案不再各自复述"符合当前关系阶段"', !/符合当前关系阶段/.test(scenario), scenario.slice(0, 60));
}

console.log('== 结构自检：主动拼出来的上下文没有互相矛盾的数字 ==');
{
    const full = ctx();
    const declared = [...full.matchAll(/扣 (-\d)/g)].map((m) => Number(m[1]));
    const allowed = new Set(Object.values(AFFINITY_RULES.OVERREACH_PENALTY).flatMap((p) => [p.mild, p.deep]));
    check('文案里出现的惩罚数字都在引擎表内', declared.every((d) => allowed.has(d)),
        `文案数字 ${declared.join(',')} / 表 ${[...allowed].join(',')}`);
}

console.log(`\n结果: ${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('失败明细:'); for (const f of failures) console.log('  -', f); }
try { fs.rmSync(process.env.AI_GIRLFRIEND_DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failures.length ? 1 : 0);
