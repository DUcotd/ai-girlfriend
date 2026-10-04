/**
 * B9 批次回归测试（开关与配置持久化）。
 *
 * 覆盖 docs/full-audit/02-plan.md 的 B9 条目与审计 CORE-10 的三条「关不干净」：
 *   B9-1  四个入口加真 enabled 判定（emit / _onEvent / 里程碑发布 / 用户情绪摄入）
 *   B9-2  开关与高级参数持久化，重启不弹回默认「开」
 *   B9-4  关闭时冻结并清空事件队列，重开不倒灌历史候选
 *   HTTP-19  /config/status 的 companion 不再同时下发运行时值与静态默认值
 *
 * 运行：node scripts/test-audit-b9.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AI_GIRLFRIEND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aigf-b9-'));

const { config } = await import('../src/config.js');
const DATA = process.env.AI_GIRLFRIEND_DATA_DIR;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mtime = (name) => {
    try { return fs.statSync(path.join(DATA, name)).mtimeMs; } catch { return 0; }
};

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log('  PASS', name); }
    else { failures.push(`${name}${detail ? ` —— ${detail}` : ''}`); console.log('  FAIL', name, detail); }
};

const REPLY = '<monologue>嗯</monologue>我在。<metadata>{"emotion":"心疼","affinity_change":1,"emotion_delta":{"P":-0.2,"A":0,"D":0},"user_emotion":{"label":"低落","valence":-0.5,"arousal":0.2,"intensity":0.6,"confidence":0.8}}</metadata>';

const { default: AiGirlfriend } = await import('../src/core/AiGirlfriend.js');
const { setEventLayerEnabled, isEventLayerEnabled } = await import('../src/core/TriggerRegistry.js');
const NarrativeStore = (await import('../src/core/narrative/NarrativeStore.js')).default;

function makeAgent({ withBus = false } = {}) {
    const ag = new AiGirlfriend();
    ag.apiKey = 'sk-test';
    ag.openai = {
        chat: { completions: { create: async () => ({ choices: [{ message: { role: 'assistant', content: REPLY } }], usage: {} }) } },
    };
    ag.memory.embedding = { available: false, model: 'fake', embed: async () => null, update: () => {} };
    const emitted = [];
    if (withBus) {
        ag.attachEventBus({ emit: (event, payload) => { emitted.push({ event, payload }); } });
    }
    ag._emitted = emitted;
    return ag;
}

console.log('== B9-1 用户情绪通道关掉后：不分析、不落盘、不发事件 ==');
{
    const ag = makeAgent({ withBus: true });
    config.userEmotion.enabled = false;
    const before = mtime('user_emotion_state.json');
    let analyzed = 0;
    ag.userEmotionEngine.analyze = (...a) => { analyzed++; return ag.userEmotionEngine.constructor.prototype.analyze.apply(ag.userEmotionEngine, a); };
    let ingested = 0;
    const origIngest = ag.userEmotionEngine.ingestTurn.bind(ag.userEmotionEngine);
    ag.userEmotionEngine.ingestTurn = (...a) => { ingested++; return origIngest(...a); };

    await ag.chat('今天好难过');
    await sleep(400);

    check('关闭时不再 ingestTurn', ingested === 0, `实际调用 ${ingested} 次`);
    check('关闭时不再做无谓的 analyze 预热', analyzed === 0, `实际调用 ${analyzed} 次`);
    check('关闭时不写 user_emotion_state.json', mtime('user_emotion_state.json') === before,
        `${before} → ${mtime('user_emotion_state.json')}`);
    check('关闭时不发 user_emotion_turn 事件',
        !ag._emitted.some((e) => /USER_EMOTION_TURN|user_emotion/i.test(e.event)),
        JSON.stringify(ag._emitted.map((e) => e.event)));

    // 打开后必须恢复正常（证明不是把功能整段删掉了）
    config.userEmotion.enabled = true;
    await ag.chat('今天好难过');
    await sleep(400);
    check('打开后 ingestTurn 恢复工作', ingested > 0, `实际 ${ingested} 次`);
}

console.log('== B9-1 叙事层关掉后：不再发里程碑事件 ==');
{
    const ag = makeAgent({ withBus: true });
    const store = new NarrativeStore();
    store.narratives.length = 0;
    store.narratives.push({
        id: 'n1', type: 'promise', title: '说好一起背单词', summary: '',
        occurredAt: Date.now() - 2 * 86400e3, recurring: null, recallCount: 0,
    });
    ag.narrativeStore = store;

    config.narrative.enabled = true;
    ag._publishNarrativeMilestones();
    const onCount = ag._emitted.length;
    check('打开时会发里程碑', onCount > 0, `emit ${onCount} 条`);

    ag._emitted.length = 0;
    config.narrative.enabled = false;
    ag._publishNarrativeMilestones();
    check('关掉后不再发里程碑（不再引用已关闭功能的素材）', ag._emitted.length === 0,
        JSON.stringify(ag._emitted.map((e) => e.event)));
    config.narrative.enabled = true;
}

console.log('== B9-1/B9-4 事件层关掉后：不发布、不入队、清空积压、不写盘 ==');
{
    const { EventBus } = await import('../src/core/EventBus.js');
    const { default: TriggerRegistry } = await import('../src/core/TriggerRegistry.js');
    const { emotionTurnTrigger } = await import('../src/core/triggers/emotionTurnTrigger.js');

    const bus = new EventBus();
    const registry = new TriggerRegistry({ bus });
    registry.register(emotionTurnTrigger);
    registry.attach(bus);

    setEventLayerEnabled(true);
    bus.emit('user_emotion_turn', { turned: true, valence: -0.6, intensity: 0.7, trend: { declining: true }, ts: Date.now() });
    check('打开时事件会入队', registry.getStatus().queueSize > 0,
        `queue=${registry.getStatus().queueSize}`);
    // 先让上面那次入队的去抖写盘落地，再开始测关闭态（否则测到的是上一条 pending 写）
    await sleep((registry.config?.flushDebounceMs ?? 1000) + 400);

    setEventLayerEnabled(false);
    bus.emit('user_emotion_turn', { turned: true, valence: -0.8, intensity: 0.9, trend: { declining: true }, ts: Date.now() });
    check('关闭时队列为空（旧候选被清掉，重开不倒灌）', registry.getStatus().queueSize === 0,
        `queue=${registry.getStatus().queueSize}`);
    // 关闭的那一瞬间允许写一次（把清空结果持久化），之后的派发必须零副作用
    await sleep((registry.config?.flushDebounceMs ?? 1000) + 400);
    const settled = mtime('trigger_state.json');
    bus.emit('user_emotion_turn', { turned: true, valence: -0.9, intensity: 0.95, trend: { declining: true }, ts: Date.now() });
    await sleep((registry.config?.flushDebounceMs ?? 1000) + 400);
    check('关闭状态下持续派发不再写 trigger_state.json', mtime('trigger_state.json') === settled,
        `${settled} → ${mtime('trigger_state.json')}`);

    // 编排层的发布入口也要判开关
    const ag = makeAgent({ withBus: true });
    setEventLayerEnabled(false);
    ag._emitEvent('user_emotion_turn', { turned: true });
    check('关闭时 _emitEvent 不向总线发布', ag._emitted.length === 0, JSON.stringify(ag._emitted));
    setEventLayerEnabled(true);
    ag._emitEvent('user_emotion_turn', { turned: true });
    check('打开时 _emitEvent 恢复发布', ag._emitted.length === 1);
}

console.log('== B9-2 开关与高级参数持久化（重启不弹回）==');
{
    const ag = makeAgent();
    ag.updateConfig({ userEmotionEnabled: false, narrativeEnabled: false, triggerEnabled: false, temperature: 0.31 });
    const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf-8'));
    check('只改开关也会落盘', saved.toggles && saved.toggles.userEmotionEnabled === false,
        JSON.stringify(saved.toggles));
    check('高级参数一起持久化', saved.chatParams && saved.chatParams.temperature === 0.31,
        JSON.stringify(saved.chatParams));
    check('state.json 里没有任何 Key', !JSON.stringify(saved).includes('sk-test'));

    // 模拟重启：新建实例应从 state.json 恢复
    config.userEmotion.enabled = true;
    config.narrative.enabled = true;
    setEventLayerEnabled(true);
    const reboot = new AiGirlfriend();
    check('重启后 userEmotion 仍是关', config.userEmotion.enabled === false);
    check('重启后 narrative 仍是关', config.narrative.enabled === false);
    check('重启后事件层仍是关', isEventLayerEnabled() === false);
    check('重启后 temperature 保持', config.chat.temperature === 0.31, `实际 ${config.chat.temperature}`);

    // 复原，避免影响后续断言
    ag.updateConfig({ userEmotionEnabled: true, narrativeEnabled: true, triggerEnabled: true });
    config.userEmotion.enabled = true;
    config.narrative.enabled = true;
    setEventLayerEnabled(true);
    void reboot;
}

console.log('== HTTP-19 companion 状态只有一个真相 ==');
{
    const ag = makeAgent();
    const status = ag.getCompanionStatus();
    check('companion 不再下发静态 triggerRegistry.enabled',
        status.triggerRegistry && !('enabled' in status.triggerRegistry),
        JSON.stringify(Object.keys(status.triggerRegistry || {})));
    check('triggerEnabled 是运行时值', typeof status.triggerEnabled === 'boolean');
    setEventLayerEnabled(false);
    check('关掉后 triggerEnabled 如实反映', ag.getCompanionStatus().triggerEnabled === false);
    setEventLayerEnabled(true);
}

console.log(`\n结果: ${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('失败明细:'); for (const f of failures) console.log('  -', f); }
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failures.length ? 1 : 0);
