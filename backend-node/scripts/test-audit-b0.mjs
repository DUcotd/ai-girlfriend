/**
 * B0 批次回归测试（数据安全与状态一致性）。
 *
 * 覆盖 docs/full-audit/02-plan.md 的 B0 条目：
 *   B0-1  改人设不清历史、且落盘
 *   B0-3  数据目录可用 AI_GIRLFRIEND_DATA_DIR 重定向（本文件全程用临时目录）
 *   B0-4  ghosting 不再丢用户消息、不再刷新闲置计时
 *   B0-5  resetAll 覆盖主动消息运行时状态与生活日志
 *   B0-6  jsonStore 落盘失败可见 + 无 .tmp 残留
 *   B0-7  resetAll 与在途对话串行、后台收尾按世代作废
 *   B0-11 队列在一次失败后仍保持互斥
 *   B0-12 记忆/叙事写入的世代号覆盖
 *   附带  EmotionEngine 抗损坏状态文件、ProactiveEngine/LifeSimulator 重置
 *
 * 运行：node scripts/test-audit-b0.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

// ⚠️ 必须在 import 任何 src/ 模块之前设置：jsonStore 在模块加载时就解析数据目录
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aigf-b0-'));
process.env.AI_GIRLFRIEND_DATA_DIR = TMP_DIR;

const { dataDir, writeJson, readJson } = await import('../src/utils/jsonStore.js');
const { config } = await import('../src/config.js');
const { default: AiGirlfriend } = await import('../src/core/AiGirlfriend.js');
const { default: Memory } = await import('../src/core/Memory.js');
const { default: EmotionEngine } = await import('../src/core/EmotionEngine.js');
const { default: ProactiveEngine } = await import('../src/core/ProactiveEngine.js');

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log('  PASS', name); }
    else { failures.push(name + (detail ? ` —— ${detail}` : '')); console.log('  FAIL', name, detail); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 造一个假 LLM 客户端：记录调用次数，可配置为抛错 */
function fakeClient(replyText, { throwOn = null, delayMs = 0 } = {}) {
    const state = { calls: 0, concurrent: 0, maxConcurrent: 0 };
    const create = async () => {
        state.calls++;
        state.concurrent++;
        state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
        try {
            if (delayMs) await sleep(delayMs);
            if (throwOn !== null && state.calls <= throwOn) throw new Error('模拟上游失败');
            return {
                choices: [{ message: { role: 'assistant', content: replyText } }],
                usage: { total_tokens: 1 },
            };
        } finally {
            state.concurrent--;
        }
    };
    return { state, client: { chat: { completions: { create } } } };
}

const REPLY = '<monologue>嗯</monologue>我在。<metadata>{"emotion":"平静","affinity_change":1,"emotion_delta":{"P":0.1,"A":0,"D":0}}</metadata>';

function freshAgent() {
    const ag = new AiGirlfriend();
    ag.apiKey = 'sk-test';
    const f = fakeClient(REPLY);
    ag.openai = f.client;
    // 嵌入通道换成假件，确保测试不碰网络
    ag.memory.embedding = { available: false, model: 'fake', embed: async () => null, update: () => {} };
    // 关掉事实提取：它复用同一个客户端，会把「后台调用」也算进并发度里，
    // 让互斥断言变成测不准（这本身就说明调用计数需要按通道分开，见 B1-2）。
    config.memory.facts.enabled = false;
    return { ag, f };
}

console.log('== B0-3 数据目录重定向 ==');
check('dataPath 落在临时目录', dataDir() === TMP_DIR, `实际 ${dataDir()}`);

console.log('== B0-6 jsonStore 原子写与残留 ==');
check('writeJson 成功返回 true', writeJson('b0_probe.json', { a: 1 }) === true);
check('readJson 回读一致', readJson('b0_probe.json', null)?.a === 1);
const leftovers = fs.readdirSync(TMP_DIR).filter((f) => f.endsWith('.tmp'));
check('无 .tmp 残留', leftovers.length === 0, leftovers.join(','));
check('缺失文件返回 fallback', readJson('nope.json', { fb: true }).fb === true);

console.log('== B0-1 改人设不清历史、且落盘 ==');
{
    const { ag } = freshAgent();
    ag.history = [{ role: 'system', content: ag.systemPrompt }];   // 用例之间互不干扰
    ag.history.push({ role: 'user', content: '第一句' });
    ag.history.push({ role: 'assistant', content: '第一答' });
    const r = ag.updateSystemPrompt('新的人设内容');
    check('对话条数不变', ag.getHistory().length === 2, `实际 ${ag.getHistory().length}`);
    check('history[0] 已是新人设', ag.history[0].content === '新的人设内容');
    check('落盘成功', r.saved === true);
    const saved = readJson('state.json', null);
    check('state.json 持久化了新人设', saved?.system_prompt === '新的人设内容');
    check('state.json 未写入任何 Key', !JSON.stringify(saved).includes('sk-test'));
    let threw = 0;
    try { ag.updateSystemPrompt(0); } catch { threw++; }
    try { ag.updateSystemPrompt('   '); } catch { threw++; }
    try { ag.updateSystemPrompt('x'.repeat(9000)); } catch { threw++; }
    check('非字符串/空白/超长都被拒', threw === 3, `只拒了 ${threw} 个`);
}

console.log('== B0-4 ghosting 记录用户消息且不刷新闲置计时 ==');
{
    const { ag, f } = freshAgent();
    ag.emotionEngine.state.P = -0.9;
    ag.emotionEngine.baseline.P = -0.9;
    const activeBefore = ag.affinityEngine.lastUserActiveTime;
    const result = await ag.chat('你还在吗');
    check('返回 ghosting 标记', result.special_action === 'ghosting');
    check('本轮零 LLM 调用', f.state.calls === 0, `调了 ${f.state.calls} 次`);
    check('用户消息进了历史', ag.getHistory().some((m) => m.content === '你还在吗'));
    check('闲置计时未被刷新', ag.affinityEngine.lastUserActiveTime === activeBefore);
    check('emotion 用真实标签而非硬编码冷漠', result.emotion === ag.emotionEngine.getEmotionLabel(), result.emotion);
    // 情绪回正后，模型上下文里必须能看到被忽略的那条
    ag.emotionEngine.state.P = 0.3;
    let sent = null;
    const orig = ag.openai.chat.completions.create;
    ag.openai.chat.completions.create = async (p) => { sent = JSON.stringify(p.messages); return orig(p); };
    await ag.chat('我刚才说什么了');
    check('被忽略的消息出现在后续 prompt 里', String(sent).includes('你还在吗'));
}

console.log('== B0-11 一次失败之后队列仍保持互斥 ==');
{
    const { ag } = freshAgent();
    const slow = fakeClient(REPLY, { delayMs: 40 });
    ag.openai = slow.client;
    // 让第一轮在 _prepare 就抛错（这是队列 catch 的真实触发点）
    const origPrepare = ag._prepare.bind(ag);
    let prepareCalls = 0;
    ag._prepare = async (u) => {
        if (++prepareCalls === 1) throw new Error('模拟 _prepare 失败');
        return origPrepare(u);
    };
    const r1 = await ag.chat('一');
    check('失败轮返回兜底文案', String(r1.reply).includes('小意外'), JSON.stringify(r1.reply));
    // AiGirlfriend 构造时会从 state.json 恢复历史（前面的用例写过盘），
    // 所以这里断言增量而不是绝对条数。
    const usersBefore = ag.getHistory().filter((m) => m.role === 'user').length;
    // 关键：A 失败后，B 与 C 必须仍然串行（旧实现会把队列重置成空 Promise，
    // 于是 C 与仍在生成的 B 并发跑，此后永久失去互斥）
    const b = ag.chat('二');
    await sleep(5);
    const c = ag.chat('三');
    await Promise.all([b, c]);
    check('失败之后并发度仍为 1', slow.state.maxConcurrent === 1, `最大并发 ${slow.state.maxConcurrent}`);
    check('二/三 都进了历史', ag.getHistory().filter((m) => m.role === 'user').length === usersBefore + 2,
        `增量 ${ag.getHistory().filter((m) => m.role === 'user').length - usersBefore}`);
}

console.log('== B0-12 记忆写入的世代号覆盖 ==');
{
    const mem = new Memory(null, { getChatClient: () => null });
    mem.embedding = {
        available: true, model: 'fake',
        embed: async () => { await sleep(30); return [0.1, 0.2]; },
    };
    const p = mem.recordTurn('用户说的话', '小爱的回复', {});
    mem.clearMemory();          // 在嵌入 await 期间清空
    await p;
    await sleep(50);
    check('清空之后在途情节写入被作废（不复活）', mem.store.episodes.length === 0, `实际 ${mem.store.episodes.length} 条`);
}

console.log('== B0-5 / B0-7 resetAll：范围完整 + 与在途对话串行 ==');
{
    const { ag } = freshAgent();
    const stubProactive = {
        resetRuntimeState() { this._called = true; return true; },
        lifeSimulator: { resetLog() { this._called = true; return true; } },
        _called: false,
    };
    ag.attachProactiveEngine(stubProactive);
    ag.attachTriggerRegistry({ reset() { ag._registryReset = true; } });
    ag.history.push({ role: 'user', content: '要清掉的' });
    ag.affinityEngine._affinity = 88;

    const result = await ag.resetAll();
    check('reset 列表含 proactive', result.reset.includes('proactive'), JSON.stringify(result.reset));
    check('reset 列表含 lifeLog', result.reset.includes('lifeLog'));
    // 原 TC-REG-03 是「在源码里找 this.personalityDrift.reset()」，改成行为断言
    ag.personalityDrift.applyPreset('tsundere');
    await ag.resetAll();
    check('性格真的回到默认预设', ag.personalityDrift.presetId === 'gentle',
        `实际 ${ag.personalityDrift.presetId}`);
    check('reset 列表含 personality', result.reset.includes('personality'));
    check('proactive.resetRuntimeState 被调用', stubProactive._called === true);
    check('lifeSimulator.resetLog 被调用', stubProactive.lifeSimulator._called === true);
    check('无失败项', result.failed.length === 0, JSON.stringify(result.failed));
    check('历史已清空', ag.getHistory().length === 0);
    check('好感度回默认档', ag.affinity === 35, `实际 ${ag.affinity}`);

    // 在途后台收尾必须在 reset 之后作废
    const before = ag.memory.store.episodes.length;
    ag._persistAfterReply('重置前那一轮的用户话', '重置前那一轮的回复');
    await ag.resetAll();
    await sleep(120);
    check('reset 之后后台收尾不再写回记忆',
        ag.memory.store.episodes.length === before,
        `重置前 ${before}，重置后 ${ag.memory.store.episodes.length}`);
}

console.log('== EmotionEngine 抗损坏状态文件 ==');
{
    writeJson('emotion_state.json', { state: { P: '0.3', A: null, D: 0.5 }, baseline: {}, lastUpdated: '' });
    const emo = new EmotionEngine();
    check('字符串 P 被强转为数字', typeof emo.state.P === 'number' && emo.state.P === 0.3);
    check('非法 A 回落默认值', emo.state.A === 0.1, `实际 ${emo.state.A}`);
    let injection = '';
    let threw = false;
    try { injection = emo.getPromptInjection(); } catch { threw = true; }
    check('getPromptInjection 不再抛错', !threw && typeof injection === 'string');
    fs.unlinkSync(path.join(TMP_DIR, 'emotion_state.json'));
}

console.log('== B1-3 服务端 Key 兜底（env 可读、绝不落盘）==');
{
    process.env.AI_GIRLFRIEND_API_KEY = 'sk-from-env';
    const ag = new AiGirlfriend();
    check('env 里的 Key 被读到', ag.apiKey === 'sk-from-env', `实际 ${ag.apiKey}`);
    check('有 Key 时客户端已初始化', !!ag.openai);
    ag.updateState({ nickname: '小测' });
    const saved = JSON.stringify(readJson('state.json', null));
    check('Key 不写进 state.json', !saved.includes('sk-from-env'), saved.slice(0, 120));
    delete process.env.AI_GIRLFRIEND_API_KEY;
}

console.log('== ProactiveEngine.resetRuntimeState 保留配置 ==');
{
    const stubAG = { affinity: 40, emotionEngine: { getFullState: () => ({ P: 0, A: 0, D: 0 }), shouldGhost: () => false }, lifeSimulator: null };
    const engine = new ProactiveEngine(stubAG, null);
    engine.config.enabled = true;
    engine.dailyMessageCount = 7;
    engine.sentDays = { morning_greeting: '2026-10-01' };
    engine.lastTriggerByType = { random_chat: Date.now() };
    engine.recentSentTexts = ['旧措辞'];
    engine.messageQueue.push({ text: '按旧关系生成的滞留消息', reason: 'miss_you', expiresAt: Date.now() + 60000 });
    const ok = engine.resetRuntimeState();
    check('落盘成功', ok === true);
    check('队列已清空', engine.messageQueue.length === 0);
    check('当日配额归零', engine.dailyMessageCount === 0);
    check('sentDays 清空', Object.keys(engine.sentDays).length === 0);
    check('冷却清空', Object.keys(engine.lastTriggerByType).length === 0);
    check('复读样本清空', engine.recentSentTexts.length === 0);
    check('用户配置保留', engine.config.enabled === true && Array.isArray(engine.config.enabledTypes));
    const saved = readJson('proactive_state.json', null);
    check('重置后的状态已落盘', saved?.dailyMessageCount === 0 && saved?.config?.enabled === true);
    engine.stop();
}

console.log(`\n结果: ${pass} passed, ${failures.length} failed`);
if (failures.length > 0) {
    console.log('失败明细:');
    for (const f of failures) console.log('  -', f);
}
try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failures.length > 0 ? 1 : 0);
