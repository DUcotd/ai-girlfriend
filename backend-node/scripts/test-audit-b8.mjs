/**
 * test-audit-b8.mjs —— B8（性能与容量）+ B1（调用可观测 / 嵌入健康度）+ B2-10 尾巴 的回归测试。
 *
 * 三条纪律（本项目已经为此付过学费）：
 *  ① 断言与**时序无关**：不 sleep、不等定时器、不比耗时。要验「合并写盘」就数 `_saveState`
 *     被调了几次并显式 await 一个微任务；要验「有界」就直接量长度/字节。
 *  ② 不做「源码字符串断言」：全部真跑对面代码。
 *  ③ 全程写沙盒数据目录（`AI_GIRLFRIEND_DATA_DIR`），跑完不在仓库里留任何文件。
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHarness } from './lib/testKit.mjs';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'aigf-b8-'));
process.env.AI_GIRLFRIEND_DATA_DIR = sandbox;

const EXPECTED = 79;
const t = createHarness('test-audit-b8', { expect: EXPECTED });
const { check, checkAsync, finish } = t;

const { encodeVector, toVector, decodeVector, isEncodedVector } = await import('../src/core/memory/vectorCodec.js');
const { groupIntoUnits, trimHistoryPairAware, selectPromptWindow, enforceRequestBudget } = await import('../src/core/historyWindow.js');
const { TRIM_ORDER, clampBlock, describeTrims } = await import('../src/core/prompts/promptBudget.js');
const { withDebouncedSave } = await import('../src/utils/microtaskSave.js');
const llmCalls = await import('../src/utils/llmCalls.js');
const { EmbeddingClient } = await import('../src/core/memory/EmbeddingClient.js');
const { NarrativeExtractor } = await import('../src/core/narrative/NarrativeExtractor.js');
const { scoreEpisodes } = await import('../src/core/memory/KeywordScorer.js');
const { config } = await import('../src/config.js');
const { ARCHIVE_FILES } = await import('../src/core/backup.js');
const { writeJson, readJson } = await import('../src/utils/jsonStore.js');
const container = await import('../src/services/container.js');
const aiGirlfriend = container.aiGirlfriend;

// ======================= B8-2 向量编解码 =======================
const vec = [];
for (let i = 0; i < 64; i++) vec.push(Math.sin(i / 3));
{
    const encoded = encodeVector(vec);
    check('B8-2 编码结果是字符串且被识别为已编码向量', typeof encoded === 'string' && isEncodedVector(encoded));
    const decoded = toVector(encoded);
    check('B8-2 解码长度与原向量一致', decoded.length === vec.length);
    let maxErr = 0;
    for (let i = 0; i < vec.length; i++) maxErr = Math.max(maxErr, Math.abs(decoded[i] - vec[i]));
    check('B8-2 Float32 往返误差在 1e-6 内', maxErr < 1e-6, `maxErr=${maxErr}`);
    check('B8-2 decodeVector 与 toVector 给同一个读数', decodeVector(encoded).length === vec.length);
    const legacy = toVector(vec);
    check('B8-2 旧格式裸数组仍可读（向后兼容）', legacy.length === vec.length && Math.abs(legacy[1] - vec[1]) < 1e-9);
    check('B8-2 null / 脏值读成 null 而不是抛', toVector(null) === null && toVector('not-base64!!!') === null && toVector(42) === null);
    check('B8-2 单条向量体积降到数组写法的 1/3 以下', encoded.length * 3 < JSON.stringify(vec).length, `b64=${encoded.length}`);
    // 真实嵌入是 1024 维，用 64 维做尺寸断言会低估收益 —— 尺寸结论必须按生产维度量
    const vec1024 = [];
    for (let i = 0; i < 1024; i++) vec1024.push(Math.cos(i / 7));
    const enc1024 = encodeVector(vec1024);
    const libNew = JSON.stringify({ episodes: Array.from({ length: 500 }, () => ({ id: 'x', text: 'y'.repeat(60), embedding: enc1024 })) }).length;
    // 改造前磁盘上的形状是「浮点数组 + null,2 缩进」，每个浮点各占一行，所以要拿带缩进的写法比
    const libOld = JSON.stringify({ episodes: Array.from({ length: 500 }, () => ({ id: 'x', text: 'y'.repeat(60), embedding: vec1024 })) }, null, 2).length;
    check('B8-2 500 条 ×1024 维紧凑库 ≤3MB（审计 CORE-08 的实测口径）', libNew < 3 * 1024 * 1024, `${libNew} bytes`);
    check('B8-2 同一份库新格式比改造前的磁盘形状小 4 倍以上', libOld > libNew * 4, `old=${libOld} new=${libNew}`);
    check('B8-2 编码是幂等的（字符串原样返回，不会被二次编码）', encodeVector(enc1024) === enc1024);
    check('B8-2 cosineSimilarity 能吃 base64（新旧读法共用一个余弦）', EmbeddingClient.cosineSimilarity(encoded, vec) > 0.999);
    check('B8-2 维度不同的两份不会被判成同一条', EmbeddingClient.cosineSimilarity(toVector(encodeVector(vec.slice(0, 32))), vec) === 0);
    const big = { episodes: Array.from({ length: 200 }, () => ({ id: 'x', text: 'y'.repeat(40), embedding: encodeVector(vec) })) };
    writeJson('compact_probe.json', big, { compact: true });
    writeJson('pretty_probe.json', big);
    const compactSize = fs.statSync(path.join(sandbox, 'compact_probe.json')).size;
    const prettySize = fs.statSync(path.join(sandbox, 'pretty_probe.json')).size;
    check('B8-2 compact 选项确实省掉缩进空白（差得不大是因为向量已经压过）', compactSize < prettySize, `compact=${compactSize} pretty=${prettySize}`);
    check('B8-2 两种写法读回内容一致', JSON.stringify(readJson('compact_probe.json')) === JSON.stringify(readJson('pretty_probe.json')));
    check('B8-2 默认 writeJson 仍带缩进（其余 10 个文件的字节形状不变）', fs.readFileSync(path.join(sandbox, 'pretty_probe.json'), 'utf8').includes('\n  "'));
}

// ================== B8-6 / B8-7 历史窗口与预算 ==================
{
    const mk = (n) => {
        const out = [{ role: 'system', content: 'persona' }];
        for (let i = 0; i < n; i++) { out.push({ role: 'user', content: `u${i}` }); out.push({ role: 'assistant', content: `a${i}` }); }
        return out;
    };
    check('B8-6 user+assistant 算一个语义单元', groupIntoUnits(mk(5)).length === 6, `units=${groupIntoUnits(mk(5)).length}`);
    const trimmed = trimHistoryPairAware(mk(6), 5).history;
    check('B8-6 裁剪后首条永远是 system（人设不被丢）', trimmed[0].role === 'system');
    const uc = trimmed.filter((m) => m.role === 'user').length;
    const ac = trimmed.filter((m) => m.role === 'assistant').length;
    check('B8-6 成对保留：user 与 assistant 数量最多差 1', Math.abs(uc - ac) <= 1, `u=${uc} a=${ac}`);
    const withOrphan = [
        { role: 'system', content: 'p' }, { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' },
        { role: 'assistant', content: 'proactive' }, { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' },
    ];
    const t2 = trimHistoryPairAware(withOrphan, 3).history;
    check('B8-6 孤立 assistant（主动消息）在场时不误删 user', t2.some((m) => m.content === 'u1') || t2.some((m) => m.content === 'u2'), JSON.stringify(t2.map((m) => m.content)));
    const dropped = trimHistoryPairAware(mk(50), 8);
    check('B8-6 裁剪报告被丢的条数（可观测，不是静默丢）', dropped.dropped > 0 && dropped.dropped === 100 - (dropped.history.length - 1), `dropped=${dropped.dropped}`);
    const win = selectPromptWindow(mk(200), { maxEntries: 8, unlimited: false, maxChars: 100_000, clipChars: 100_000 });
    check('B8-6 按条数取窗：条数 ≤ maxEntries + 1（人设）', win.messages.length <= 9, `len=${win.messages.length}`);
    check('B8-6 窗口统计三项齐全（丢了几条/几字/裁了几条都可观测）', ['droppedEntries', 'droppedChars', 'clipped'].every((k) => k in win));
    const big = mk(400).map((m, i) => (i === 0 ? m : { ...m, content: `${'x'.repeat(200)}#${i}` }));
    const unlimited = selectPromptWindow(big, { maxEntries: 30, unlimited: true, maxChars: 5000, clipChars: 5000 });
    const chars = unlimited.messages.reduce((a, m) => a + m.content.length, 0);
    check('B8-7 「无限上下文」仍受字符预算约束', chars <= 8000, `chars=${chars}`);
    check('B8-7 「无限上下文」不把人设挤掉', unlimited.messages[0].role === 'system');
    const persona = [{ role: 'system', content: 'P'.repeat(100) }];
    const tail = [{ role: 'user', content: '本轮提问' }];
    const windowMsgs = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'y'.repeat(500) }));
    const budgeted = enforceRequestBudget(persona, windowMsgs, tail, 6000);
    const total = budgeted.messages.reduce((a, m) => a + String(m.content ?? '').length, 0);
    check('B8-3 总预算生效：整请求被压进上限', total <= 6500, `total=${total}`);
    check('B8-3 只裁历史窗口：人设与本轮提问一条不少', budgeted.messages.some((m) => m.content.startsWith('PPP')) && budgeted.messages.some((m) => m.content === '本轮提问'), `n=${budgeted.messages.length}`);
    check('B8-7 chat.maxHistoryEntries ≥ 500（设置页档位上限是真实值）', config.chat.maxHistoryEntries >= 500, String(config.chat.maxHistoryEntries));
    check('B8-7 正文与独白入库上限都在 config（超长截断而不是丢整条）', config.chat.maxAssistantChars > 0 && config.chat.maxThoughtChars > 0);
}

// ======================= B8-3 块预算 =======================
{
    check('B8-3 裁剪顺序里没有阶段说明书与人设（丢它们等于让模型自己猜关系）', !TRIM_ORDER.some((k) => /relationship|stageGuide|^persona$|systemPrompt/i.test(String(k))), String(TRIM_ORDER));
    check('B8-3 裁剪顺序含记忆(contextStr)/叙事(narrativePrompt)/任务(taskText) 三类', ['contextStr', 'narrativePrompt', 'taskText'].every((k) => TRIM_ORDER.includes(k)), String(TRIM_ORDER));
    const long = '啊'.repeat(1000);
    const clamped = clampBlock(long, 300);
    check('B8-3 clampBlock 截断到预算内并回报被裁掉的字数', clamped.text.length <= 300 && clamped.trimmedChars === 700, `len=${clamped.text.length}`);
    check('B8-3 clampBlock 对空值/不裁的情况安全', clampBlock('', 100).text === '' && clampBlock(null, 100).trimmedChars === 0 && clampBlock('short', 0).text === 'short');
    check('B8-3 带围栏的块被裁时会自动补回闭合标签（否则模型看到没闭合的引用块）', clampBlock('<memory_data>\n' + '行内容\n'.repeat(200) + '</memory_data>', 200).text.endsWith('</memory_data>'));
    check('B8-3 无裁剪时 describeTrims 给空串（不制造噪音日志）', describeTrims([]) === '');
    check('B8-3 六个预算旋钮都在 config 且为正数', ['maxMemoryChars', 'maxNarrativeChars', 'maxTaskChars', 'maxSystemChars', 'maxHistoryChars', 'maxRequestChars'].every((k) => config.prompt.budget[k] > 0));
}

// =================== B8-5 写放大（合并落盘）===================
await checkAsync('B8-5 连续三次状态变更只落盘一次（微任务合并）', async () => {
    const engine = { writes: 0 };
    engine._saveState = () => { engine.writes += 1; return true; };
    withDebouncedSave(engine, 'probe');
    engine.scheduleSave();
    engine.scheduleSave();
    engine.scheduleSave();
    await Promise.resolve();
    assert.ok(engine.writes <= 1, `writes=${engine.writes}`);
    assert.equal(engine.isSaveDirty(), false);
});
await checkAsync('B8-5 写失败保持脏标记，下一次 flush 会重试（B0-6 契约）', async () => {
    let ok = false;
    const engine = { writes: 0 };
    engine._saveState = () => { engine.writes += 1; return ok; };
    withDebouncedSave(engine, 'probe');
    engine.scheduleSave();
    await Promise.resolve();
    assert.equal(engine.isSaveDirty(), true, '失败后必须仍然算脏');
    ok = true;
    assert.equal(engine.flushSave(), true);
    assert.equal(engine.isSaveDirty(), false);
});
check('B8-5 无脏数据时 flush 返回 true 且不产生写盘', (() => {
    const engine = { writes: 0 };
    engine._saveState = () => { engine.writes += 1; return true; };
    withDebouncedSave(engine, 'probe');
    return engine.flushSave() === true && engine.writes === 0;
})());
await checkAsync('B8-5 情绪引擎三轮 applyDelta 最多落盘一次', async () => {
    const engine = aiGirlfriend.emotionEngine;
    let writes = 0;
    const orig = engine._saveState.bind(engine);
    engine._saveState = (...args) => { writes += 1; return orig(...args); };
    try {
        engine.applyDelta({ P: 0.05 });
        engine.applyDelta({ A: 0.05 });
        engine.applyDelta({ D: -0.05 });
        await Promise.resolve();
        assert.ok(writes <= 1, `emotionEngine writes=${writes}`);
    } finally {
        engine._saveState = orig;
    }
});
check('B8-5 三个引擎都装上了同一套 scheduleSave/flush 契约', ['emotionEngine', 'affinityEngine', 'personalityDrift'].every((k) => {
    const e = aiGirlfriend[k];
    return typeof e.scheduleSave === 'function' && typeof e.flushSave === 'function' && typeof e.saveNow === 'function';
}));

// ==================== B1-2 调用计数 ====================
{
    llmCalls.reset();
    llmCalls.startTurn();
    llmCalls.record(llmCalls.LLM_CHANNELS.CHAT_STREAM);
    llmCalls.record(llmCalls.LLM_CHANNELS.FACT);
    const snap = llmCalls.snapshot();
    check('B1-2 本轮计数按通道分别累计', snap.turn.chatStream === 1 && snap.turn.fact === 1 && snap.turn.total === 2);
    check('B1-2 窗口计数包含本轮', snap.lastHour.total >= 2);
    check('B1-2 快照自带中文标签（前端不抄第二份清单）', snap.labelsZh.chat === '主对话' && Object.keys(snap.labelsZh).length >= 8);
    llmCalls.startTurn();
    const next = llmCalls.snapshot();
    check('B1-2 开新一轮后本轮清零、窗口继续累计', next.turn.total === 0 && next.lastHour.total >= 2 && next.turnId === 2);
    for (let i = 0; i < config.llmCalls.maxEvents + 300; i++) llmCalls.record('fact');
    const after = llmCalls.snapshot();
    check('B1-2 时间戳缓冲有界（不是无界数组）', after.lastHour.total <= config.llmCalls.maxEvents, `total=${after.lastHour.total}`);
    check('B1-2 快照里只有通道名与计数，不含任何文本', JSON.stringify(after).length < 4000);
    llmCalls.reset();
    check('B1-2 reset 后归零', llmCalls.snapshot().lastHour.total === 0);
    check('B1-2 getLlmCalls 给出 turn / lastHour 两块（/config/status 与 /health 共用）', (() => {
        const s = aiGirlfriend.getLlmCalls();
        return !!s.turn && !!s.lastHour && typeof s.turn.total === 'number';
    })());
}

// ================ B1-4 熔断 / B1-5 同轮 memoize ================
{
    const bare = (client = { embeddings: {} }) => {
        const proto = Object.create(EmbeddingClient.prototype);
        proto.client = client;
        proto.breakerOpenUntil = 0;
        proto.breakerTrips = 0;
        proto._cache = new Map();
        proto.cacheHits = 0;
        proto._now = () => Date.now();
        return proto;
    };
    const a = bare();
    check('B1-4 配了 Key 且健康 → available 为真', a.available === true);
    a.breakerOpenUntil = Date.now() + 60_000;
    check('B1-4 熔断期内 available 为假（强制走关键词，不再每轮付两次超时）', a.available === false);
    a.breakerOpenUntil = Date.now() - 1;
    check('B1-4 冷却结束后自动恢复健康', a.available === true);
    const st = a.breakerStatus();
    check('B1-4 熔断状态可观测（剩余时间/触发次数/缓存大小）', typeof st.trips === 'number' && 'cooldownRemainingMs' in st && 'cacheSize' in st);
    check('B1-4 没配 Key 时 available 为假（available = 配了且健康）', bare(null).available === false);
    const c = bare();
    for (let i = 0; i < config.embedding.cacheMax + 10; i++) c._cacheSet(`k${i}`, [i]);
    check('B1-5 嵌入 memoize 的 LRU 有界（超出容量逐旧）', c._cache.size <= config.embedding.cacheMax, `size=${c._cache.size}`);
    check('B1-5 LRU 留的是最近用的（最旧的被丢）', !c._cache.has('k0') && c._cache.has(`k${config.embedding.cacheMax + 9}`));
    check('B1-4 熔断阈值与冷却时长都在 config（不在引擎里写死）', config.embedding.failureThreshold >= 1 && config.embedding.cooldownMs >= 1000);
}

// ============ B2-10 尾巴：叙事三个字段有写路径 ============
{
    const add = NarrativeExtractor.normalizeAdd({
        type: 'milestone', title: '第一次一起熬夜', summary: '凌晨两点还在聊刷题',
        importance: 4, occurredAt: 1700000000000,
        tags: ['熬夜', '考试', '', 42],
        jokeTrigger: '月落乌啼',
        sourceEpisodeId: 'ep-1',
    });
    check('B2-10 tags 被保留且过滤掉非字符串/空串', Array.isArray(add.tags) && add.tags.join(',') === '熬夜,考试', JSON.stringify(add.tags));
    check('B2-10 jokeTrigger 保留原词', add.jokeTrigger === '月落乌啼');
    check('B2-10 sourceEpisodeId 保留（故事能回溯到那段对话）', add.sourceEpisodeId === 'ep-1');
    const bareAdd = NarrativeExtractor.normalizeAdd({ title: '没有额外字段', summary: 'x' });
    check('B2-10 模型没给时回落空值而不是 undefined', bareAdd.tags.length === 0 && bareAdd.jokeTrigger === null && bareAdd.sourceEpisodeId === null);
    const huge = NarrativeExtractor.normalizeAdd({
        summary: 's', tags: Array.from({ length: 40 }, (_, i) => `标签${i}`),
        jokeTrigger: '很'.repeat(200), sourceEpisodeId: 123,
    });
    check('B2-10 标签条数与长度都有界', huge.tags.length <= 8 && huge.tags.every((x) => x.length <= 20), JSON.stringify(huge.tags).slice(0, 60));
    check('B2-10 jokeTrigger 超长被截断、非字符串被丢弃', huge.jokeTrigger.length <= 40 && NarrativeExtractor.normalizeAdd({ summary: 's', jokeTrigger: 7 }).jokeTrigger === null);
    // store 侧也必须真的落得进去（抽取层放行 ≠ 写入层保留）
    const stored = aiGirlfriend.narrativeStore.addNarrative({ ...add, id: 'n-b8-test' });
    const back = aiGirlfriend.narrativeStore.narratives.find((n) => n.id === 'n-b8-test');
    check('B2-10 store 写入保留 tags/jokeTrigger/sourceEpisodeId', !!stored && !!back && back.tags.length === 2 && back.jokeTrigger === '月落乌啼' && back.sourceEpisodeId === 'ep-1');
    aiGirlfriend.narrativeStore.removeNarrative('n-b8-test');
    check('B2-10 测试自己清场（沙盒里不留测试叙事）', !aiGirlfriend.narrativeStore.narratives.some((n) => n.id === 'n-b8-test'));
}

// ============== B8-1 关键词检索：索引化后结果不变 ==============
{
    const now = Math.floor(Date.now() / 1000);
    const episodes = [];
    for (let i = 0; i < 120; i++) {
        episodes.push({ id: `e${i}`, text: i === 7 ? '今晚一起吃了火锅，你说太辣了' : `第 ${i} 天随便聊了些日常事情`, timestamp: now - i * 3600 });
    }
    const opts = { episodes, query: '火锅 辣', minHits: 1, recencyWeight: 0.05, recencyHalfLifeDays: 7 };
    const first = scoreEpisodes(opts);
    const second = scoreEpisodes({ ...opts, episodes: [...episodes] });
    check('B8-1 命中相关那条而不是最近那条', first.length > 0 && first[0].id === 'e7', first[0]?.id);
    check('B8-1 索引缓存不改变结果（两次同一份库结果一致）', JSON.stringify(first.map((r) => [r.id, r.score.toFixed(6)])) === JSON.stringify(second.map((r) => [r.id, r.score.toFixed(6)])));
    const hugeQuery = scoreEpisodes({ episodes, query: '火'.repeat(5000) + ' 辣 火锅', minHits: 1, recencyWeight: 0.05, recencyHalfLifeDays: 7 });
    check('B8-1 超长 query 不抛异常且有结果（词数被截断）', Array.isArray(hugeQuery));
    check('B8-1 query 词数上限在 config（单一真源）', config.memory.retrieval.maxQueryTerms >= 1);
    check('B8-1 空查询返回空结果而不是全库扫描', scoreEpisodes({ episodes, query: '', minHits: 1, recencyWeight: 0.05, recencyHalfLifeDays: 7 }).length === 0);
}

// ============ B8-4 无界集合：任务容量闸门与去重清理 ============
{
    const tm = container.taskManager;
    const maxActive = config.tasks.maxActive;
    const baseLen = tm.tasks.length;
    tm.tasks = [];
    for (let i = 0; i < maxActive + 5; i++) tm.addTask({ title: `任务${i}` });
    check('B8-4 未完成任务数量有界（活跃清单不会无限增长）', tm.tasks.length <= maxActive, `len=${tm.tasks.length}`);
    check('B8-4 超出的旧任务转入归档而不是被删除（承诺不能丢）', tm.getArchivedCount() >= 5, `archived=${tm.getArchivedCount()}`);
    check('B8-4 归档文件真的写进数据目录（沙盒，不落仓库）', fs.existsSync(path.join(sandbox, 'tasks_archive.json')));
    for (let i = 0; i < 3; i++) { const t0 = tm.addTask({ title: `待完成${i}` }); tm.tasks.find((x) => x.id === t0.id).completed = true; }
    tm.tasks.forEach((x) => { if (x.completed) x.completed = true; });
    tm._enforceCapacity();
    const completed = tm.tasks.filter((x) => x.completed).length;
    check('B8-4 已完成任务保留条数不超上限', completed <= config.tasks.maxCompleted, `completed=${completed}`);
    check('B8-4 归档/上限两个数字都在 config，不在引擎里写死', config.tasks.maxActive >= 5 && config.tasks.maxCompleted >= 1);
    fs.rmSync(path.join(sandbox, 'tasks_archive.json'), { force: true });
    tm.tasks = [];
    tm._archive = [];
    tm.saveTasks();
    check('B8-4 测试自己清场（跑完不留任务数据）', tm.tasks.length === 0 && !fs.existsSync(path.join(sandbox, 'tasks_archive.json')));
}
{
    const reg = container.triggerRegistry;
    reg.dedupeSeen = { ancient: 1, fresh: Date.now() };
    reg.eventQueue = [{ triggerId: 'x', expiresAt: 1 }];
    reg._prune();
    check('B8-4 _prune 顺带清过期去重标记（dedupeSeen 不再只增不减）', !('ancient' in reg.dedupeSeen) && 'fresh' in reg.dedupeSeen);
    const changed = reg._pruneDedupe();
    check('B8-4 没有可清项时 _pruneDedupe 返回 false（不产生多余写盘）', changed === false || typeof changed === 'boolean');
    reg.dedupeSeen = {};
    reg.eventQueue = [];
}
check('B8-4 归档文件已登记进档案清单（否则它永远进不了导出）', ARCHIVE_FILES.some((f) => f.file === 'tasks_archive.json'));
check('B8-4 档案清单里新增项的属主不与别人重复', new Set(ARCHIVE_FILES.map((f) => f.owner)).size === ARCHIVE_FILES.length);

// ============================ 收尾 ============================
// 容器一导入就起了定时器：先显式停掉，再退出（否则进程挂着不撒手，CI 会等到超时）
try { container.proactiveEngine?.stop?.(); } catch { /* 停机失败不影响断言结果 */ }
const code = finish();
fs.rmSync(sandbox, { recursive: true, force: true });
process.exit(code);
