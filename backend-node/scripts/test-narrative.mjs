/**
 * 共同经历叙事层回归测试（REQ-03，单进程自包含）。
 *
 * ⚠️ 本机沙箱 child_process.spawn 会被 EBUSY 拦死，因此**禁止 spawn 子进程**：
 * 全部用例在同一进程内用 Node 内置 assert + 计数器跑完，失败时 process.exitCode=1。
 * 由 package.json 的 `npm test` 串联执行。
 *
 * 覆盖：三层节流（三条件全满足才抽）/ 事件类型归一化 / 抽取解析 / 事件去重 /
 *      cap 淘汰 / 注入段生成与长度限制 / LLM 失败降级 / 落盘重载一致 /
 *      getUpcomingAnniversaries / getRandomStory / reset。
 */
import assert from 'assert';
import fs from 'fs';
import { config } from '../src/config.js';
import NarrativeStore, { capNarratives, normalizeNarrative } from '../src/core/narrative/NarrativeStore.js';
import NarrativeExtractor, { parseNarrativeOps } from '../src/core/narrative/NarrativeExtractor.js';
import NarrativeRetriever, { daysUntilAnniversary, parseMonthDay } from '../src/core/narrative/NarrativeRetriever.js';
import {
    NARRATIVE_TYPES, NARRATIVE_TYPE_LABELS, normalizeNarrativeType, hasNarrativeSignal,
} from '../src/core/narrative/narrativeTypes.js';
import { buildNarrativeContext } from '../src/core/prompts/narrativePrompt.js';
import { buildSystemContext } from '../src/core/prompts/systemPrompt.js';
import { dataPath } from '../src/utils/jsonStore.js';

let passed = 0;
let failed = 0;
function check(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  OK   ${name}`);
    } catch (e) {
        failed++;
        process.exitCode = 1;
        console.error(`  FAIL ${name}\n       ${e.message}`);
    }
}

async function checkAsync(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  OK   ${name}`);
    } catch (e) {
        failed++;
        process.exitCode = 1;
        console.error(`  FAIL ${name}\n       ${e.message}`);
    }
}

const DB_FILE = 'narrative.json';
const dbFilePath = dataPath(DB_FILE);

/** 删除测试落盘文件；失败（非 ENOENT）降级为覆写空 schema。 */
function forceUnlink(p) {
    try {
        fs.unlinkSync(p);
        return true;
    } catch (e) {
        if (e.code === 'ENOENT') return true;
        console.error(`[test] unlink 失败(${e.code ?? e.message})，降级为覆写空状态: ${p}`);
        try {
            fs.writeFileSync(p, JSON.stringify({ version: 1, narratives: [], stats: {} }));
            return true;
        } catch {
            return false;
        }
    }
}

/** 干净 store：先移除落盘，避免上一用例污染。 */
function freshStore() {
    forceUnlink(dbFilePath);
    return new NarrativeStore();
}

/** 造一条合法叙事字段。 */
function makeStory(over = {}) {
    return {
        type: 'shared_event',
        title: '一起看雪',
        summary: '小爱和用户第一次一起看雪。',
        importance: 3,
        occurredAt: Date.now(),
        ...over,
    };
}

// ==================== 1. 事件类型（唯一事实源） ====================
console.log('事件类型:');
check('枚举含全部 6 类且元数据齐全', () => {
    assert.strictEqual(NARRATIVE_TYPE_LABELS.length, 6);
    for (const label of NARRATIVE_TYPE_LABELS) {
        const meta = NARRATIVE_TYPES[label];
        assert.ok(meta, `${label} 缺元数据`);
        assert.ok(typeof meta.labelZh === 'string' && meta.labelZh);
        assert.ok(typeof meta.extractHint === 'string' && meta.extractHint);
        assert.ok(Number.isFinite(meta.importanceBase));
        assert.strictEqual(typeof meta.recurring, 'boolean');
    }
});
check('normalizeNarrativeType：非法回退默认', () => {
    assert.strictEqual(normalizeNarrativeType('foo'), 'shared_event');
    assert.strictEqual(normalizeNarrativeType(null), 'shared_event');
    assert.strictEqual(normalizeNarrativeType('promise'), 'promise');
});
check('hasNarrativeSignal：命中关键信号词', () => {
    assert.strictEqual(hasNarrativeSignal('这是我们第一次说晚安'), true);
    assert.strictEqual(hasNarrativeSignal('答应你要早点睡'), true);
    assert.strictEqual(hasNarrativeSignal('今天天气不错'), false);
    assert.strictEqual(hasNarrativeSignal(''), false);
});

// ==================== 2. 抽取解析（容错） ====================
console.log('抽取解析:');
check('parseNarrativeOps：标准 JSON', () => {
    const ops = parseNarrativeOps('{"add":[{"type":"promise","title":"陪复习","summary":"答应陪他复习","importance":4}],"update":[],"delete":[]}');
    assert.strictEqual(ops.add.length, 1);
    assert.strictEqual(ops.add[0].title, '陪复习');
});
check('parseNarrativeOps：剥代码栅栏', () => {
    const ops = parseNarrativeOps('```json\n{"add":[{"title":"x","summary":"y"}]}\n```');
    assert.strictEqual(ops.add.length, 1);
});
check('parseNarrativeOps：脏文本截取首尾大括号', () => {
    const ops = parseNarrativeOps('好的，结果如下：{"add":[{"title":"x","summary":"y"}],"update":[],"delete":["n_1"]} 完毕');
    assert.strictEqual(ops.add.length, 1);
    assert.deepStrictEqual(ops.delete, ['n_1']);
});
check('parseNarrativeOps：非法/空输入 → 空 ops', () => {
    assert.deepStrictEqual(parseNarrativeOps(''), { add: [], update: [], delete: [] });
    assert.deepStrictEqual(parseNarrativeOps('not json'), { add: [], update: [], delete: [] });
    assert.deepStrictEqual(parseNarrativeOps(null), { add: [], update: [], delete: [] });
});
check('parseNarrativeOps：过滤无 summary/title 的 add', () => {
    const ops = parseNarrativeOps('{"add":[{"type":"promise"},{"title":"ok","summary":"s"}]}');
    assert.strictEqual(ops.add.length, 1);
});

// ==================== 3. 三层节流 ====================
console.log('三层节流:');
check('轮次不满足 → 不抽（turn-gate）', () => {
    const store = freshStore();
    const ex = new NarrativeExtractor({ getClient: () => ({ client: {}, model: 'm' }), store });
    const r = ex.shouldExtract(3, { text: '第一次', affinityDelta: 0 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'turn-gate');
});
check('轮次满足但无信号 → 不抽（no-signal）', () => {
    const store = freshStore();
    const ex = new NarrativeExtractor({ getClient: () => ({ client: {}, model: 'm' }), store });
    const r = ex.shouldExtract(config.narrative.extractEveryNTurns, { text: '今天天气不错' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no-signal');
});
check('时间窗未到 → 不抽（interval-gate）', () => {
    const store = freshStore();
    store.setStats({ lastExtractAt: Date.now() }); // 刚刚抽过
    const ex = new NarrativeExtractor({ getClient: () => ({ client: {}, model: 'm' }), store });
    const r = ex.shouldExtract(config.narrative.extractEveryNTurns, { text: '第一次说晚安' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'interval-gate');
});
check('三条件全满足 → 通过（ok）', () => {
    const store = freshStore();
    store.setStats({ lastExtractAt: Date.now() - config.narrative.minIntervalMs - 1 });
    const ex = new NarrativeExtractor({ getClient: () => ({ client: {}, model: 'm' }), store });
    const r = ex.shouldExtract(config.narrative.extractEveryNTurns, { text: '第一次说晚安' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.signal, 'keyword');
});
check('结构化信号：好感度跃迁', () => {
    const store = freshStore();
    store.setStats({ lastExtractAt: 0 });
    const ex = new NarrativeExtractor({ getClient: () => ({ client: {}, model: 'm' }), store });
    const r = ex.shouldExtract(config.narrative.extractEveryNTurns,
        { text: '普通聊天', affinityDelta: config.narrative.affinityJumpThreshold });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.signal, 'affinity-jump');
});
check('结构化信号：用户情绪转折', () => {
    const store = freshStore();
    const ex = new NarrativeExtractor({ getClient: () => ({ client: {}, model: 'm' }), store });
    const r = ex.shouldExtract(config.narrative.extractEveryNTurns, { text: '普通', userEmotionTurned: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.signal, 'user-emotion-turn');
});

// ==================== 4. maybeExtract：节流未过不调 LLM ====================
await checkAsync('节流未过 → maybeExtract 不调 LLM（getClient 从不被调用）', async () => {
    const store = freshStore();
    // 轮次不满足
    const ex = new NarrativeExtractor({ getClient: () => { throw new Error('LLM 不应被调用'); }, store });
    const r = await ex.maybeExtract('你好', '你好呀', { turnCount: 1 });
    assert.strictEqual(r.extracted, false);
    assert.deepStrictEqual(r.ops, { add: [], update: [], delete: [] });
});
await checkAsync('LLM 返回空内容 → 容错为空 ops（不抛错）', async () => {
    const store = freshStore();
    store.setStats({ lastExtractAt: Date.now() - config.narrative.minIntervalMs - 1 });
    const fakeClient = { chat: { completions: { create: async () => ({ choices: [{ message: { content: '' } }] }) } } };
    const ex = new NarrativeExtractor({ getClient: () => ({ client: fakeClient, model: 'm' }), store });
    const r = await ex.maybeExtract('第一次一起看雪', '嗯！', { turnCount: config.narrative.extractEveryNTurns });
    assert.strictEqual(r.extracted, true);
    assert.strictEqual(r.ops.add.length, 0);
});
await checkAsync('LLM 抛错 → 向上抛（由调用队列兜底）', async () => {
    const store = freshStore();
    let threw = false;
    const fakeClient = { chat: { completions: { create: async () => { throw new Error('network down'); } } } };
    const ex = new NarrativeExtractor({ getClient: () => ({ client: fakeClient, model: 'm' }), store });
    try {
        await ex.maybeExtract('第一次', '好的', { turnCount: config.narrative.extractEveryNTurns });
    } catch {
        threw = true;
    }
    assert.strictEqual(threw, true);
});

// ==================== 5. Store 写入 / 去重 / cap ====================
console.log('Store 写入 / cap:');
check('addNarrative：合法写入', () => {
    const store = freshStore();
    const n = store.addNarrative(makeStory());
    assert.ok(n && n.id);
    assert.strictEqual(store.narratives.length, 1);
    assert.deepStrictEqual(n.participants, ['user', 'xiaoi']);
});
check('addNarrative：无内容丢弃返回 null', () => {
    const store = freshStore();
    assert.strictEqual(store.addNarrative({ type: 'promise' }), null);
    assert.strictEqual(store.narratives.length, 0);
});
check('normalizeNarrative：title 截断到 20 字', () => {
    const n = normalizeNarrative({ title: 'x'.repeat(50), summary: 's' });
    assert.strictEqual(n.title.length, 20);
});
check('capNarratives：超上限丢重要度最低', () => {
    const list = [
        { id: 'a', importance: 5, occurredAt: 100 },
        { id: 'b', importance: 1, occurredAt: 200 },
        { id: 'c', importance: 3, occurredAt: 300 },
    ];
    const capped = capNarratives(list, 2);
    assert.strictEqual(capped.length, 2);
    assert.ok(!capped.find((n) => n.id === 'b'), 'important=1 的应被淘汰');
});
check('capNarratives：同分丢最旧', () => {
    const list = [
        { id: 'old', importance: 3, occurredAt: 100 },
        { id: 'new', importance: 3, occurredAt: 900 },
    ];
    const capped = capNarratives(list, 1);
    assert.strictEqual(capped[0].id, 'new');
});
check('addNarrative 自动 cap 生效', () => {
    const store = freshStore();
    const max = config.narrative.maxNarratives;
    for (let i = 0; i < max + 12; i++) {
        store.addNarrative(makeStory({ title: `事件${i}`, summary: `第${i}次经历`, importance: 3 }));
    }
    assert.strictEqual(store.narratives.length, max);
});

// ==================== 6. 更新 / 删除 / markRecalled ====================
console.log('更新 / 删除:');
check('updateNarrative：按 id 更新字段', () => {
    const store = freshStore();
    const n = store.addNarrative(makeStory());
    const updated = store.updateNarrative(n.id, { summary: '改后的摘要', importance: 5 });
    assert.strictEqual(updated.summary, '改后的摘要');
    assert.strictEqual(updated.importance, 5);
    assert.ok(updated.updatedAt >= n.updatedAt);
});
check('updateNarrative：id 不存在返回 null', () => {
    const store = freshStore();
    assert.strictEqual(store.updateNarrative('nope', { summary: 'x' }), null);
});
check('removeNarrative：命中返回 true，未命中 false', () => {
    const store = freshStore();
    const n = store.addNarrative(makeStory());
    assert.strictEqual(store.removeNarrative(n.id), true);
    assert.strictEqual(store.removeNarrative('nope'), false);
    assert.strictEqual(store.narratives.length, 0);
});
check('markRecalled：累加 recallCount 与时间', () => {
    const store = freshStore();
    const n = store.addNarrative(makeStory());
    const r1 = store.markRecalled(n.id, 111);
    assert.strictEqual(r1.recallCount, 1);
    assert.strictEqual(r1.lastRecalledAt, 111);
    store.markRecalled(n.id, 222);
    assert.strictEqual(store.getById(n.id).recallCount, 2);
});

// ==================== 7. 注入段生成与长度限制 ====================
console.log('注入段:');
check('无叙事 → 空串', () => {
    assert.strictEqual(buildNarrativeContext([]), '');
    assert.strictEqual(buildNarrativeContext(null), '');
});
check('正常叙事 → 含表头与条目', () => {
    const seg = buildNarrativeContext([makeStory({ type: 'promise', title: '陪复习', summary: '答应陪他复习' })]);
    assert.ok(seg.includes('【我们的故事'));
    assert.ok(seg.includes('约定'));
    assert.ok(seg.includes('陪复习'));
});
check('注入段整体长度受 injectMaxChars 约束', () => {
    const many = [];
    for (let i = 0; i < 20; i++) {
        many.push(makeStory({ title: `很长的事件标题第${i}号`, summary: '这是一段相当长的摘要'.repeat(3) }));
    }
    const seg = buildNarrativeContext(many);
    // 表头+条目+footer 整体不应显著超过上限（单条本身可略超，故留一个条目余量）
    assert.ok(seg.length <= config.narrative.injectMaxChars + config.narrative.injectEntryMaxChars + 50,
        `seg.length=${seg.length}`);
});
check('单条条目截断（injectEntryMaxChars）', () => {
    const seg = buildNarrativeContext([makeStory({ title: '超长标题', summary: 'x'.repeat(500) })]);
    const line = seg.split('\n').find((l) => l.startsWith('- ['));
    assert.ok(line.length <= config.narrative.injectEntryMaxChars + 1, `line=${line.length}`);
});
check('全空叙事对象 → 空串', () => {
    assert.strictEqual(buildNarrativeContext([{ title: '', summary: '' }]), '');
});

// ==================== 8. systemPrompt 注入段落 ====================
console.log('systemPrompt 集成:');
check('narrativePrompt 缺省 = 不注入（行为不变）', () => {
    const base = buildSystemContext({ nickname: 'u', taskText: '', contextStr: '', relationshipContext: '', emotionPrompt: '', personalityPrompt: '', styleGuide: { guide: 'g' } });
    const withNarrative = buildSystemContext({ nickname: 'u', taskText: '', contextStr: '', relationshipContext: '', emotionPrompt: '', personalityPrompt: '', styleGuide: { guide: 'g' }, narrativePrompt: '【我们的故事 - 测试]' });
    assert.ok(!base.includes('【我们的故事'));
    assert.ok(withNarrative.includes('【我们的故事 - 测试]'));
});

// ==================== 9. 落盘重载一致 ====================
console.log('落盘重载:');
check('flush 后重载读回叙事与 stats', () => {
    const store = freshStore();
    store.addNarrative(makeStory({ title: '纪念日', type: 'anniversary', recurring: { isAnniversary: true, anniversaryDate: '10-01', anniversaryType: 'yearly' } }));
    store.setStats({ lastExtractTurn: 5, lastExtractAt: 12345 });
    store.scheduleSave(); // 标记 dirty
    store.flush();        // 立即落盘（去抖兜底）
    const store2 = new NarrativeStore();
    assert.strictEqual(store2.narratives.length, 1);
    assert.strictEqual(store2.narratives[0].title, '纪念日');
    assert.deepStrictEqual(store2.narratives[0].recurring, { isAnniversary: true, anniversaryDate: '10-01', anniversaryType: 'yearly' });
    assert.strictEqual(store2.stats.lastExtractTurn, 5);
    assert.strictEqual(store2.stats.lastExtractAt, 12345);
});
check('落盘 schema 含 version/narratives/stats/lastUpdated', () => {
    const store = freshStore();
    store.addNarrative(makeStory());
    store._saveNow();
    const raw = JSON.parse(fs.readFileSync(dbFilePath, 'utf-8'));
    assert.strictEqual(raw.version, 1);
    assert.ok(Array.isArray(raw.narratives));
    assert.ok(raw.stats && typeof raw.stats === 'object');
    assert.ok(typeof raw.lastUpdated === 'string');
});
check('reset（clear + 落盘）后重载为空', () => {
    const store = freshStore();
    store.addNarrative(makeStory());
    store.clear();
    store._saveNow();
    const store2 = new NarrativeStore();
    assert.strictEqual(store2.narratives.length, 0);
    assert.strictEqual(store2.stats.lastExtractTurn, 0);
});

// ==================== 10. 纪念日查询 ====================
console.log('纪念日:');
check('parseMonthDay：合法/非法', () => {
    assert.deepStrictEqual(parseMonthDay('10-01'), { month: 10, day: 1 });
    assert.strictEqual(parseMonthDay('13-01'), null);
    assert.strictEqual(parseMonthDay('bad'), null);
    assert.strictEqual(parseMonthDay(''), null);
});
check('daysUntilAnniversary：未来日期为正', () => {
    const now = new Date(2026, 0, 1); // 2026-01-01
    const days = daysUntilAnniversary(
        { recurring: { isAnniversary: true, anniversaryDate: '01-05', anniversaryType: 'yearly' } }, now);
    assert.strictEqual(days, 4);
});
check('daysUntilAnniversary：once 类型返回 null', () => {
    const days = daysUntilAnniversary(
        { recurring: { isAnniversary: true, anniversaryDate: '01-05', anniversaryType: 'once' } }, new Date());
    assert.strictEqual(days, null);
});
check('getUpcomingAnniversaries：窗口内排序命中', () => {
    const store = freshStore();
    const now = new Date(2026, 5, 10); // 2026-06-10
    store.addNarrative(makeStory({
        type: 'anniversary', title: '认识纪念日',
        recurring: { isAnniversary: true, anniversaryDate: '06-13', anniversaryType: 'yearly' },
    }));
    store.addNarrative(makeStory({
        type: 'anniversary', title: '很久以后',
        recurring: { isAnniversary: true, anniversaryDate: '12-01', anniversaryType: 'yearly' },
    }));
    const retriever = new NarrativeRetriever({ store, embedding: null });
    const upcoming = retriever.getUpcomingAnniversaries(now, 7);
    assert.strictEqual(upcoming.length, 1);
    assert.strictEqual(upcoming[0].narrative.title, '认识纪念日');
    assert.strictEqual(upcoming[0].daysUntil, 3);
});

// ==================== 11. 检索与随机故事 ====================
await checkAsync('getRelevantNarratives：无嵌入走关键词', async () => {
    const store = freshStore();
    store.addNarrative(makeStory({ title: '一起看雪', summary: '我们第一次一起看雪' }));
    store.addNarrative(makeStory({ title: '讨论代码', summary: '聊到深夜的编程话题' }));
    const retriever = new NarrativeRetriever({ store, embedding: null });
    const hits = await retriever.getRelevantNarratives('看雪', 3);
    assert.ok(hits.length >= 1);
    assert.strictEqual(hits[0].title, '一起看雪');
});
await checkAsync('getRelevantNarratives：空池返回空数组', async () => {
    const store = freshStore();
    const retriever = new NarrativeRetriever({ store, embedding: null });
    assert.deepStrictEqual(await retriever.getRelevantNarratives('任意'), []);
});
check('getRandomStory：优先 recallCount 最低', () => {
    const store = freshStore();
    const a = store.addNarrative(makeStory({ title: 'A', summary: 'sA' }));
    store.addNarrative(makeStory({ title: 'B', summary: 'sB' }));
    store.markRecalled(a.id, 1);
    const retriever = new NarrativeRetriever({ store, embedding: null });
    const pick = retriever.getRandomStory(0);
    assert.ok(pick);
    assert.notStrictEqual(pick.id, a.id);
});
check('getRandomStory：空池返回 null', () => {
    const store = freshStore();
    const retriever = new NarrativeRetriever({ store, embedding: null });
    assert.strictEqual(retriever.getRandomStory(), null);
});

// ==================== 12. getAll / publicNarrative ====================
console.log('导出:');
check('getAll：剥离 embedding 且按重要度排序', () => {
    const store = freshStore();
    store.addNarrative(makeStory({ title: '低', importance: 2, embedding: [1, 2, 3] }));
    store.addNarrative(makeStory({ title: '高', importance: 5 }));
    const all = store.getAll();
    assert.strictEqual(all.narratives[0].title, '高');
    assert.strictEqual(all.narratives[0].embedding, undefined);
    assert.strictEqual(all.stats.total, 2);
});

// ==================== 汇总 ====================
// 清理测试落盘，不污染真实数据
forceUnlink(dbFilePath);

const TOTAL = passed + failed;
if (failed > 0) {
    console.error(`\n${passed}/${TOTAL} 通过，${failed} 项失败`);
} else {
    console.log(`\n全部 ${passed} 项通过`);
}
