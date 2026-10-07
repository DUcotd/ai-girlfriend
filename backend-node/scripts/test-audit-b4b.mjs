/**
 * test-audit-b4b.mjs —— 身份卡单一真源（B4-8 后半 / PROMPT-08）。
 *
 * 测的是**渲染出来的 prompt 文本**，不是源码字符串：
 * 把真实的人设段与主动消息指令跑一遍，再数字数与出现次数 ——
 * 「同一个外观描述出现在三个文件里」这种问题只有从输出才看得出来。
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'aigf-b4b-'));
process.env.AI_GIRLFRIEND_DATA_DIR = sandbox;

const { createHarness } = await import('./lib/testKit.mjs');
const t = createHarness('test-audit-b4b', { expect: 11 });
const { check, finish } = t;

const { IDENTITY, renderIdentityBlock } = await import('../src/core/prompts/identityCard.js');
const { PERSONA_SYSTEM_PROMPT } = await import('../src/core/prompts/systemPrompt.js');
const { buildProactivePersonaDirective } = await import('../src/core/prompts/proactivePrompts.js');

check('B4-8 身份卡有名字、自称、对用户称呼与外观四项', ['小爱', '我', '你', '银白色'].every((v) => Object.values(IDENTITY).some((x) => String(x).includes(v))));
check('B4-8 不可谈判边界至少三条且都是字符串', Array.isArray(IDENTITY.hardBoundaries) && IDENTITY.hardBoundaries.length >= 3 && IDENTITY.hardBoundaries.every((b) => typeof b === 'string' && b.length > 10));
check('B4-8 边界里写明「不假装真人」与「不因要求改身份」', IDENTITY.hardBoundaries.some((b) => b.includes('真人')) && IDENTITY.hardBoundaries.some((b) => b.includes('名字')));
check('B4-8 身份卡是 frozen（改不动，防止某个链路顺手把她重写一遍）', Object.isFrozen(IDENTITY) && Object.isFrozen(IDENTITY.hardBoundaries));

const block = renderIdentityBlock();
check('B4-8 renderIdentityBlock 含名字/自称/外表/边界四段', ['名字：', '自称：', '外表：', '不可谈判边界：'].every((k) => block.includes(k)));

// 关键不变量：整条主对话人设里，外观描述**只出现一次**
const appearancesInPersona = PERSONA_SYSTEM_PROMPT.split(IDENTITY.appearance).length - 1;
check('B4-8 人设段里外观描述只出现 1 次（单一真源，不是第二份抄写）', appearancesInPersona === 1, `count=${appearancesInPersona}`);
check('B4-8 人设段确实是从身份卡渲染出来的（逐字包含，不是又抄一遍）', PERSONA_SYSTEM_PROMPT.includes(block));

const proactiveDirective = buildProactivePersonaDirective('想跟他说句话', 50);
check('B4-8 主动消息指令不再复述外观（阶段与身份各归各位）', !proactiveDirective.includes(IDENTITY.appearance));
check('B4-8 主动消息指令把身份指向人设而不是自己定义', proactiveDirective.includes('以人设为准'));
check('B4-8 名字不再被反复强调（人设段里最多 3 次）', PERSONA_SYSTEM_PROMPT.split(IDENTITY.name).length - 1 <= 3, `count=${PERSONA_SYSTEM_PROMPT.split(IDENTITY.name).length - 1}`);
check('B4-8 主动消息链不重新定义「她是谁」（外观只在人设段出现一次）', (PERSONA_SYSTEM_PROMPT + proactiveDirective).split(IDENTITY.appearance).length - 1 === 1);

const code = finish();
fs.rmSync(sandbox, { recursive: true, force: true });
process.exit(code);
