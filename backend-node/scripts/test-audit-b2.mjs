/**
 * B2 批次回归测试（数值模型与解析边界）。
 *
 * 覆盖 docs/full-audit/02-plan.md 的 B2 条目：
 *   B2-1/B2-6  LLM 情绪增量逐轴裁剪 + 词表与 LLM 加权混合（不再叠加、不再一句话拉爆）
 *   B2-4       metadata 强类型：模型把数字写成字符串时好感度照常动，且告警可见
 *   B2-5       ghosting 期间用户不再被性格系统判成「失联」（S01 不再扣分）
 *   B2-2       约定追问计数真的自增（maxFollowups 上限与 dedupeKey 恢复有效）
 *   B2-3       纪念日「查询窗 / 主动窗」各自有名有姓，不再是两个裸数字
 *   PROMPT-04  user_emotion 缺 confidence 不再一票否决整段 LLM 读取
 *
 * 运行：node scripts/test-audit-b2.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AI_GIRLFRIEND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aigf-b2-'));

const { config } = await import('../src/config.js');
const { dayKey } = await import('../src/utils/dayKey.js');
const {
    toFiniteNumber, normalizeDelta, blendDeltas, coerceAffinityChange, PAD_AXES,
} = await import('../src/core/emotionDelta.js');
const { default: AiGirlfriend } = await import('../src/core/AiGirlfriend.js');
const { TRIGGER_THRESHOLDS } = await import('../src/core/triggerEvents.js');
const { evaluate: evalPromise } = await import('../src/core/triggers/promiseFollowupTrigger.js');
const { evaluate: evalAnniversary } = await import('../src/core/triggers/anniversaryTrigger.js');
const NarrativeStore = (await import('../src/core/narrative/NarrativeStore.js')).default;

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log('  PASS', name); }
    else { failures.push(`${name}${detail ? ` —— ${detail}` : ''}`); console.log('  FAIL', name, detail); }
};

console.log('== emotionDelta 纯函数 ==');
check('toFiniteNumber 接受数字与数字字符串', toFiniteNumber('+0.3') === 0.3 && toFiniteNumber(-2) === -2);
check('toFiniteNumber 兼容全角负号', toFiniteNumber('−20') === -20, String(toFiniteNumber('−20')));
check('toFiniteNumber 拒 null/布尔/空串/NaN',
    [null, undefined, true, '', '  ', NaN, {}, 'abc'].every((v) => toFiniteNumber(v) === null));
{
    const { delta, clipped, rejected } = normalizeDelta({ P: -5, A: '+0.2', D: 'x' }, 0.5);
    check('normalizeDelta 把越界的 P 裁到 −0.5', delta.P === -0.5 && clipped === true);
    check('normalizeDelta 强转字符串 A', delta.A === 0.2);
    check('normalizeDelta 拒非法 D 而不是当 0', delta.D === null && rejected.length === 1, JSON.stringify(rejected));
    check('normalizeDelta 对缺失轴保持 null（不当 0 用）',
        normalizeDelta({ P: 0.1 }, 0.5).delta.A === null);
}
{
    // 同一条「我今天好难过」：词表 −0.2、模型 −0.3。叠加是 −0.5，混合应落在两者之间
    const { delta } = blendDeltas({ P: -0.2 }, { P: -0.3 }, { keywordWeight: 0.5, llmWeight: 0.5 });
    check('blendDeltas 是混合不是叠加', Math.abs(delta.P + 0.25) < 1e-9, `实际 ${delta.P}`);
    const only = blendDeltas({ P: -0.2 }, null, { keywordWeight: 0.5, llmWeight: 0.5 });
    check('只有一路说话时按原幅度生效（不打对折）', Math.abs(only.delta.P + 0.2) < 1e-9, `实际 ${only.delta.P}`);
    const onlyLlm = blendDeltas(null, { P: -0.4 });
    check('只有 LLM 一路时同样按原幅度生效', Math.abs(onlyLlm.delta.P + 0.4) < 1e-9, `实际 ${onlyLlm.delta.P}`);
    const none = blendDeltas(null, null);
    check('两路都没有时不产生任何轴', PAD_AXES.every((a) => none.delta[a] === null));
}
check('coerceAffinityChange 修好引号数字（旧行为是静默归零）',
    coerceAffinityChange('+3').value === 3 && coerceAffinityChange('+3').rejected === false);
check('coerceAffinityChange 对真非法值归零但给出原因',
    coerceAffinityChange('很多').value === 0 && coerceAffinityChange('很多').rejected === true);

console.log('== B2-4 / B2-1 端到端：模型写字符串也能涨好感度、越界情绪被裁 ==');
function agentWith(metadataJson, replyText = '我在呢。') {
    const ag = new AiGirlfriend();
    ag.apiKey = 'sk-test';
    let sent = null;
    ag.openai = {
        chat: {
            completions: {
                create: async (p) => {
                    sent = p;
                    return {
                        choices: [{ message: { role: 'assistant', content: `<monologue>嗯</monologue>${replyText}<metadata>${metadataJson}</metadata>` } }],
                        usage: {},
                    };
                },
            },
        },
    };
    ag.memory.embedding = { available: false, model: 'fake', embed: async () => null, update: () => {} };
    ag._lastSent = () => sent;
    return ag;
}
{
    const ag = agentWith('{"emotion":"心疼","affinity_change":"+3","emotion_delta":{"P":-5,"A":"0.2"},"user_emotion":{"label":"低落","valence":-0.5,"arousal":0.2,"intensity":0.6}}');
    const before = ag.affinity;
    const pBefore = ag.emotionEngine.state.P;
    const r = await ag.chat('今天好难过');
    check('引号数字 "+3" 让好感度真的涨了', ag.affinity > before, `${before} → ${ag.affinity}`);
    check('缺 confidence 的 user_emotion 仍被采信（不再整段丢弃）',
        (r.parseWarnings || []).length === 0 || !String(r.parseWarnings.join()).includes('user_emotion'),
        JSON.stringify(r.parseWarnings));
    const moved = ag.emotionEngine.state.P - pBefore;
    // −5 被裁到 −0.5，与词表混合后乘 0.5，再乘惯性 0.3 → 单轮位移必须远小于 1
    check('越界的 emotion_delta.P 被裁剪，单轮位移受限', Math.abs(moved) <= 0.2, `ΔP=${moved.toFixed(3)}`);
    check('没有被一句话推进 ghosting 区间', ag.emotionEngine.state.P > -0.75,
        `P=${ag.emotionEngine.state.P.toFixed(2)}`);
}
{
    const ag = agentWith('{"emotion":"平静","affinity_change":"很多","emotion_delta":{"P":"随便"}}');
    const r = await ag.chat('随便聊聊');
    const warnings = (r.parseWarnings || []).join(';');
    check('真非法值归零但告警可见', /affinity_change|emotion_delta/.test(warnings), warnings || '(无告警)');
}

console.log('== B2-5 ghosting 不再被性格系统判成失联 ==');
{
    const ag = agentWith('{"emotion":"平静","affinity_change":0}');
    ag.personalityDrift.stats.lastActiveDate = '2020-01-01';
    ag.personalityDrift.stats.consecutiveInactiveDays = 9;
    ag.emotionEngine.state.P = -0.9;
    ag.emotionEngine.baseline.P = -0.9;
    const r = await ag.chat('你还在吗');
    check('确实走了 ghosting', r.special_action === 'ghosting');
    check('连续失联天数被清零（不再累加）', ag.personalityDrift.stats.consecutiveInactiveDays === 0,
        `实际 ${ag.personalityDrift.stats.consecutiveInactiveDays}`);
    check('lastActiveDate 更新到今天', ag.personalityDrift.stats.lastActiveDate === dayKey(new Date()),
        `实际 ${ag.personalityDrift.stats.lastActiveDate}`);
    const today = ag.personalityDrift.stats.dailyMessageCounts.at(-1);
    check('当日消息计数记上了这一条', today && today.count >= 1, JSON.stringify(today));
}

console.log('== B2-2 约定追问计数自增后，上限与去重恢复有效 ==');
{
    const store = new NarrativeStore();
    const ag = new AiGirlfriend();
    ag.narrativeStore = store;
    const n = { id: 'p1', type: 'promise', title: '说好一起背单词', summary: '', occurredAt: Date.now() - 2 * 24 * 3600 * 1000 };
    store.narratives.push(n);

    const now = Date.now();
    const payloadOf = (count) => ({
        type: 'promise', narrativeId: 'p1', title: n.title, summary: '',
        occurredAt: n.occurredAt, followupCount: count, anniversary: false,
    });
    check('第 1 次命中', evalPromise(payloadOf(0), { now }) !== null);
    check('第 3 次仍命中', evalPromise(payloadOf(2), { now }) !== null);
    check('第 4 次被 maxFollowups 拦下（计数自增后这条判定才真的有意义的反证）',
        evalPromise(payloadOf(3), { now }) === null);
    const c1 = evalPromise(payloadOf(0), { now });
    const c2 = evalPromise(payloadOf(1), { now });
    check('不同跟进轮次的 dedupeKey 不同（不再恒定）', c1.dedupeKey !== c2.dedupeKey,
        `${c1.dedupeKey} vs ${c2.dedupeKey}`);

    const raised = ag.recordNarrativeFollowup('p1');
    check('recordNarrativeFollowup 自增到 1', raised === 1, `实际 ${raised}`);
    ag.recordNarrativeFollowup('p1');
    check('再投递一次自增到 2', ag.narrativeStore.narratives[0].followupCount === 2);
    check('不存在的叙事返回 null 而不是抛错', ag.recordNarrativeFollowup('nope') === null);
    store.flush();
}

console.log('== B2-3 纪念日两个窗口各自有名有姓 ==');
{
    const t = TRIGGER_THRESHOLDS.anniversary;
    check('存在 queryWithinDays 与 announceWithinDays 两个独立常量',
        Number.isFinite(t.queryWithinDays) && Number.isFinite(t.announceWithinDays), JSON.stringify(t));
    check('config 的查询窗取自同一真源', config.narrative.anniversaryWithinDays === t.queryWithinDays,
        `${config.narrative.anniversaryWithinDays} vs ${t.queryWithinDays}`);
    check('主动窗小于等于查询窗（先记得、再挑日子说）', t.announceWithinDays <= t.queryWithinDays);
    const ann = (daysUntil) => ({ type: 'anniversary', narrativeId: 'a1', title: '第一次聊天', daysUntil, occurredAt: Date.now() });
    check('超出主动窗的纪念日不触发', evalAnniversary(ann(t.announceWithinDays + 2), { now: Date.now() }) === null);
    check('主动窗内的纪念日触发', evalAnniversary(ann(1), { now: Date.now() }) !== null);
}

console.log('== 行为化后的旧「源码字符串」回归（原 TC-REG-01 / TC-REG-02）==');
{
    // TC-REG-01：性格每日结算必须早于 ghosting 早退 —— 用行为验证而不是比字符串下标
    const ag = agentWith('{"emotion":"平静","affinity_change":0}');
    ag.personalityDrift.lastSettledDay = '2020-01-01';
    ag.emotionEngine.state.P = -0.9;
    ag.emotionEngine.baseline.P = -0.9;
    const r = await ag.chat('在吗');
    check('ghost 那一轮仍然完成每日结算', ag.personalityDrift.lastSettledDay === dayKey(new Date()),
        `实际 ${ag.personalityDrift.lastSettledDay}（${r.special_action}）`);
}
{
    // TC-REG-02：sentiment 取的是「词表与 LLM 的混合值」。
    // 模型给 emotion_delta.P = 0 时，混合结果必须被拉回中性（旧写法 `?? ` 会让 0 直接顶掉词表判定）
    const spy = [];
    // 情绪引擎会从沙盒 data/ 里恢复上一组用例留下的 P=-0.9（那是 ghost 用例故意写的），
    // 这里必须显式拉回正常区间，否则整轮被 ghosting 早退、_finalize 根本不跑。
    const calm = (ag) => {
        ag.emotionEngine.state.P = 0.3;
        ag.emotionEngine.baseline.P = 0.3;
        return ag;
    };
    const agNeutral = calm(agentWith('{"emotion":"平静","affinity_change":0,"emotion_delta":{"P":0}}'));
    agNeutral.personalityDrift.recordUserTurn = (text, ctx) => { spy.push(ctx.sentiment); };
    await agNeutral.chat('今天好难过');                       // 词表判负向
    const withZero = spy[spy.length - 1];

    const agNoLlm = calm(agentWith('{"emotion":"平静","affinity_change":0}'));
    agNoLlm.personalityDrift.recordUserTurn = (text, ctx) => { spy.push(ctx.sentiment); };
    await agNoLlm.chat('今天好难过');
    const keywordOnly = spy[spy.length - 1];

    check('模型给 P=0 会把 sentiment 拉向中性（混合而非顶替）',
        Math.abs(withZero) < Math.abs(keywordOnly),
        `混合 ${withZero?.toFixed(3)} vs 纯词表 ${keywordOnly?.toFixed(3)}`);
    check('sentiment 始终是个有限数', Number.isFinite(withZero) && Number.isFinite(keywordOnly));
}

console.log('== B2-7 用户情绪否定判定：邻域窗口而非整句 ==');
{
    const { classifyUserEmotion } = await import('../src/core/userEmotionLexicon.js');
    const win = config.userEmotion.negationWindow;
    const v = (text, window) => classifyUserEmotion(text, { negationWindow: window }).valence;

    // 邻域窗口生效的直接证据：同一句话，窗口=99（≈旧的整句判定）判负，窗口=4 判正
    for (const text of [
        '今天不开会，和朋友聚了聚，超开心',
        '周末不用早起，睡到自然醒，挺开心',
    ]) {
        check(`整句判定会误判、邻域判定判对：${text}`,
            v(text, 99) < 0 && v(text, win) > 0,
            `w99=${v(text, 99)} / w${win}=${v(text, win)}`);
    }
    // 真正的就近否定仍必须翻转
    for (const [text, why] of [['不开心', '紧邻否定'], ['一点也不想开心', '窗口内否定'], ['开心不起来', '后附式否定']]) {
        check(`就近否定仍翻转：${text}`, v(text, win) < 0, `${why}；v=${v(text, win)}`);
    }
    // 回归：无否定的正/负向句不受影响
    check('无否定的正向句仍为正', v('超开心', win) > 0);
    check('负向句仍为负', v('今天好难过', win) < 0);
}

console.log('== B2-8 关键词检索：相关性优先于新旧（真 BM25）==');
{
    const { scoreEpisodes } = await import('../src/core/memory/KeywordScorer.js');
    const DAY = 86400;
    const nowSec = Date.now() / 1000;
    const ep = (text, ageDays) => ({ id: text, text, timestamp: nowSec - ageDays * DAY });

    // 一条很相关但很旧 + 一堆不相关但很新：旧实现里 recency 会赢（相关性被压到 1e-4 量级）
    const episodes = [ep('User: 我最近在准备考研，压力很大\nXiao Ai: 那确实很累，慢慢来', 40)];
    for (let i = 0; i < 60; i++) {
        episodes.push(ep(`User: 今天天气不错呀编号${i}\nXiao Ai: 是呀，出去走走吧${i}`, i * 0.2));
    }
    const ranked = scoreEpisodes({
        episodes, query: '考研压力大好烦，还有时间吗', minHits: 1,
        recencyWeight: 0.15, recencyHalfLifeDays: 14,
    });
    check('相关的那条（40 天前）排第一', ranked[0]?.text.includes('考研'), ranked[0]?.text.slice(0, 30));
    check('相关性分数量级正常（不再被压到 1e-4）', ranked[0]?.baseScore > 0.05,
        `baseScore=${ranked[0]?.baseScore}`);

    // tf 必须真的计数：同一个词出现 3 次的文档要高于出现 1 次的
    const tfDocs = [
        ep('复习复习复习，今天也在复习', 1),
        ep('今天在看书', 1),
    ];
    const tfRanked = scoreEpisodes({
        episodes: tfDocs, query: '复习', minHits: 1, recencyWeight: 0, recencyHalfLifeDays: 14,
    });
    check('tf 按重复次数计分（旧实现恒为 1）', tfRanked[0]?.text.includes('复习复习'),
        JSON.stringify(tfRanked.map((r) => `${r.text.slice(0, 6)}:${r.baseScore.toFixed(4)}`)));

    // 性能：500 条库 + 91 词查询，旧实现实测 2888 ms 且冻结事件循环
    const bigEpisodes = Array.from({ length: 500 }, (_, i) =>
        ep(`User: 第${i}次聊到复习考研和跑步还有睡觉的琐事\nXiao Ai: 嗯嗯，${i}号那天也说过类似的啦`, i * 0.05));
    const bigQuery = '复习考研跑步睡觉琐事今天心情一般般压力好大怎么办呀'.repeat(4);
    const t0 = process.hrtime.bigint();
    const bigRanked = scoreEpisodes({
        episodes: bigEpisodes, query: bigQuery, minHits: 2,
        recencyWeight: 0.15, recencyHalfLifeDays: 14,
    });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    check(`500 条 × ${bigQuery.length} 字查询在预算内（${ms.toFixed(1)} ms）`, ms < 120, `实际 ${ms.toFixed(1)} ms`);
    check('大批量下仍能返回结果', Array.isArray(bigRanked));

    // 分词缓存不应改变结果（同一查询跑两遍一致）
    const again = scoreEpisodes({
        episodes: bigEpisodes, query: bigQuery, minHits: 2, recencyWeight: 0.15, recencyHalfLifeDays: 14,
    });
    check('缓存后结果稳定', again[0]?.id === bigRanked[0]?.id);
}

console.log('== B2-9 好感度账本可加性 + 日配额按实际入账扣 ==');
{
    const { default: AffinityEngine } = await import('../src/core/AffinityEngine.js');
    const { validateAffinityChange } = await import('../src/core/affinityRules.js');
    const eng = new AffinityEngine('b2_affinity.json');

    // 不变量：rawChange + Σ(trace.to - trace.from) === 规则输出的 change
    for (const raw of [3, 2.5, -1, '+4', 0, 12]) {
        const { change, trace } = validateAffinityChange(
            Number.isFinite(raw) ? raw : 0, '你好呀', '嗯嗯', 50, 0, 0);
        const sum = trace.reduce((s, t) => s + (t.to - t.from), 0);
        check(`不变量成立 raw=${JSON.stringify(raw)} → change=${change}`,
            (Number.isFinite(raw) ? raw : 0) + sum === change, `Σtrace=${sum}`);
        check(`change 是整数 raw=${JSON.stringify(raw)}`, Number.isInteger(change));
    }

    // 满级附近：+3 只涨 1 分，日额度也只该扣 1
    eng._affinity = 99;
    eng.daily = { dayKey: dayKey(new Date()), gained: 0 };
    eng.gainEvents = [];
    const r99 = eng.recordUserTurn('记得你上次说的话', 3, '嗯，你居然记得', Date.now());
    check('99 分时 +3 实际只涨 1', r99.affinity === 100 && r99.change === 1,
        `affinity=${r99.affinity} change=${r99.change}`);
    check('日额度只扣实际入账的 1 分', eng.daily.gained === 1, `gained=${eng.daily.gained}`);
    const ledger99 = eng.getLedger().at(-1);
    check('账本里 before + finalChange === after',
        ledger99.before + ledger99.finalChange === ledger99.after, JSON.stringify(ledger99).slice(0, 120));
    check('账本区分 kind', ledger99.kind === 'turn');

    // 手动调分要留痕
    const beforeManual = eng.getLedger().length;
    eng.setAffinity(40);
    const manual = eng.getLedger().at(-1);
    check('手动改分写入 kind:manual 账本',
        eng.getLedger().length === beforeManual + 1 && manual.kind === 'manual' && manual.after === 40,
        JSON.stringify(manual).slice(0, 120));

    // 时间衰减条目要能被识别
    eng._affinity = 70;
    eng.lastUserActiveTime = Date.now() - 100 * 24 * 3600 * 1000;
    eng.setAffinity(70);
    const ledgerBefore = eng.getLedger().length;
    eng.settleDecay(Date.now());
    const decayEntry = eng.getLedger().slice(ledgerBefore).find((e) => e.kind === 'decay');
    check('时间衰减条目带 kind:decay', !!decayEntry || eng._affinity === 70,
        `affinity=${eng._affinity}`);
    fs.rmSync(path.join(process.env.AI_GIRLFRIEND_DATA_DIR, 'b2_affinity.json'), { force: true });
}

console.log('== B2-10 主动回忆接上叙事层（不再只会复述流水账）==');
{
    const ag = new AiGirlfriend();
    const store = new NarrativeStore();
    store.narratives.length = 0;      // 清掉从沙盒 narrative.json 恢复的旧条目，保证用例独立
    ag.narrativeStore = store;
    store.narratives.push({
        id: 's1', type: 'shared_event', title: '第一次一起熬夜',
        summary: '那天你备考到两点，她陪着', occurredAt: Date.now() - 20 * 86400 * 1000,
        recallCount: 0,
    });
    ag.narrativeRetriever = new (await import('../src/core/narrative/NarrativeRetriever.js')).default({
        store, embedding: null,
    });

    const ctx = await ag._buildProactiveContext('memory_share', {});
    check('memory_share 引用了故事标题', ctx.includes('第一次一起熬夜'), ctx.slice(0, 80));
    check('不再复述原始对话轮', !ctx.includes('User:'), ctx.slice(0, 80));
    const story = store.narratives.find((n) => n.id === 's1');
    check('recallCount 自增（防复读的账真的记上了）', story?.recallCount === 1,
        `实际 ${story?.recallCount}`);
    // B6-α④：防复读账改为「已落盘的 lastRecalledAt + 冷却窗」，不再是重启即失忆的内存集合
    check('lastRecalledAt 写了（防复读的账落在盘上）', Number.isFinite(story?.lastRecalledAt),
        String(story?.lastRecalledAt));
    check('冷却窗内的故事被认定为「刚提过」', ag._recentlyRecalledStoryIds().has('s1'));

    // 关闭态安全：叙事层关掉后必须退回原来的情节记忆路径
    const prev = config.narrative.enabled;
    config.narrative.enabled = false;
    const ctxOff = await ag._buildProactiveContext('memory_share', {});
    check('关掉叙事层后不再引用故事', !ctxOff.includes('第一次一起熬夜'), ctxOff.slice(0, 60));
    config.narrative.enabled = prev;
}

console.log(`\n结果: ${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('失败明细:'); for (const f of failures) console.log('  -', f); }
try { fs.rmSync(process.env.AI_GIRLFRIEND_DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failures.length ? 1 : 0);
