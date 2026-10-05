/**
 * B6-α 批次回归测试（拟人化接线：情绪共振 / 关系跃迁 / 主动消息情绪回灌 / 防复读账）。
 *
 * 覆盖 docs/full-audit/02-plan.md 的 B6-α 四项：
 *   ① REQ-02 情绪共振：他的情绪改变她自己的 PAD（阶段调制），关闭态逐轴等同改造前
 *   ② REQ-06 跃迁仪式感：tierChanged 接上事件层 → stage_transition 主动消息
 *   ③ 主动消息情绪回灌：被接住 / 落了空两种结局都改变她的情绪
 *   ④ 防复读账：从落盘的 lastRecalledAt 派生，重启也拦得住复读
 *   ⑤ 顺带修的历史坑：新增的默认开启类型永远进不了老用户的 enabledTypes
 *
 * 运行：node scripts/test-audit-b6.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AI_GIRLFRIEND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aigf-b6-'));

const { config } = await import('../src/config.js');
const DATA = process.env.AI_GIRLFRIEND_DATA_DIR;

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log('  PASS', name); }
    else { failures.push(`${name}${detail ? ` —— ${detail}` : ''}`); console.log('  FAIL', name, detail); }
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const num = (v) => (typeof v === 'number' && Number.isFinite(v));

/** 模型这一轮判读「他很难过」，并给出她自己的 emotion_delta */
const REPLY_SAD = '<monologue>他听起来很难过</monologue>我在呢。<metadata>' +
    '{"emotion":"心疼","affinity_change":1,"emotion_delta":{"P":-0.2,"A":0,"D":0},' +
    '"user_emotion":{"label":"低落","valence":-0.5,"arousal":0.2,"intensity":0.6,"confidence":0.9}}' +
    '</metadata>';

const { default: AiGirlfriend } = await import('../src/core/AiGirlfriend.js');
const { computeResonanceDelta, combineWithResonance, RESONANCE_STAGE_FACTOR } =
    await import('../src/core/emotionResonance.js');
const { blendDeltas } = await import('../src/core/emotionDelta.js');
const { TRIGGER_EVENTS, TRIGGER_DEFS, TRIGGER_DEF_LIST, TRIGGER_EVENT_NAMES, TRIGGER_EVENT_SCHEMAS } =
    await import('../src/core/triggerEvents.js');
const { stageTransitionTrigger, evaluate: evaluateStage } =
    await import('../src/core/triggers/stageTransitionTrigger.js');
const { getProactiveType, PROACTIVE_TYPE_IDS, DEFAULT_ENABLED_TYPES, PROACTIVE_EXPIRY_FEEDBACK } =
    await import('../src/core/proactiveTypes.js');
const { RELATIONSHIP_STAGES } = await import('../src/core/relationshipStages.js');
const NarrativeStore = (await import('../src/core/narrative/NarrativeStore.js')).default;
const NarrativeRetriever = (await import('../src/core/narrative/NarrativeRetriever.js')).default;

function makeAgent({ reply = REPLY_SAD, withBus = false } = {}) {
    const ag = new AiGirlfriend();
    ag.apiKey = 'sk-test';
    ag.openai = {
        chat: {
            completions: {
                create: async () => ({
                    choices: [{ message: { role: 'assistant', content: reply } }],
                    usage: {},
                }),
            },
        },
    };
    ag.memory.embedding = { available: false, model: 'fake', embed: async () => null, update: () => {} };
    const emitted = [];
    if (withBus) {
        ag.attachEventBus({ emit: (event, payload) => { emitted.push({ event, payload }); } });
    }
    ag._emitted = emitted;
    return ag;
}

/** 共振项的基准输入：他明显低落 */
const SAD_USER = { valence: -0.6, arousal: 0.3, intensity: 0.8 };
const rcfg = () => ({ ...config.emotion.resonance });

// ======================================================================
console.log('== B6-α① 共振纯函数：阶段调制 + 逐轴裁剪 ==');
{
    check('陌生阶段系数严格为 0', RESONANCE_STAGE_FACTOR.stranger === 0);
    check('阶段系数随关系递增',
        RESONANCE_STAGE_FACTOR.acquaintance < RESONANCE_STAGE_FACTOR.friend
        && RESONANCE_STAGE_FACTOR.friend < RESONANCE_STAGE_FACTOR.close
        && RESONANCE_STAGE_FACTOR.close < RESONANCE_STAGE_FACTOR.lover);

    const off = computeResonanceDelta(SAD_USER, 'lover', { ...rcfg(), enabled: false });
    check('关闭态：不产生任何共振增量', off === null, JSON.stringify(off));

    const r = computeResonanceDelta(SAD_USER, 'lover', rcfg());
    check('恋人阶段接住他的低落：P 同向为负', num(r?.P) && r.P < 0, JSON.stringify(r));
    check('担心让她的唤醒升高（不是跟着一起瘫）', num(r?.A) && r.A > 0, JSON.stringify(r));
    check('他低落时她放低姿态：D 下移', num(r?.D) && r.D < 0, JSON.stringify(r));

    const warm = computeResonanceDelta(
        { valence: 0.7, arousal: 0.4, intensity: 0.8 }, 'lover', rcfg()
    );
    check('他开心她也跟着亮起来', num(warm?.P) && warm.P > 0, JSON.stringify(warm));
    check('开心不额外触发「担心」那一项唤醒',
        num(warm?.A) && warm.A < r.A, `开心 ${warm?.A} vs 低落 ${r.A}`);

    const weak = computeResonanceDelta(
        { valence: -0.9, arousal: 0.5, intensity: config.emotion.resonance.minIntensity - 0.01 },
        'lover', rcfg()
    );
    check('强度低于线不共振（中性噪声不传染）', weak === null, JSON.stringify(weak));

    const stranger = computeResonanceDelta(SAD_USER, 'stranger', rcfg());
    check('陌生阶段：他的情绪与她无关', stranger === null, JSON.stringify(stranger));

    const clampCfg = { ...rcfg(), strength: 5, axisCap: { P: 0.2, A: 0.15, D: 0.15 } };
    const clipped = computeResonanceDelta(SAD_USER, 'lover', clampCfg);
    check('共振项自己也不能越过单轴上限',
        Math.abs(clipped.P) <= 0.2 + 1e-9 && Math.abs(clipped.A) <= 0.15 + 1e-9
        && Math.abs(clipped.D) <= 0.15 + 1e-9, JSON.stringify(clipped));

    const junk = [null, undefined, {}, { valence: 'x' }, { valence: NaN, arousal: 0, intensity: 1 }];
    check('脏读数一律不产生共振', junk.every((j) => computeResonanceDelta(j, 'lover', rcfg()) === null));
}

console.log('== B6-α① 叠加而非混合 + 单轮总上限 ==');
{
    const base = { P: -0.2, A: null, D: 0.1 };
    const identity = combineWithResonance(base, null, config.emotion.totalAxisCap);
    check('无共振项时逐轴原样返回（含 null 轴）',
        identity.delta.P === -0.2 && identity.delta.A === null && identity.delta.D === 0.1
        && identity.applied === false, JSON.stringify(identity));

    const sum = combineWithResonance(base, { P: -0.1, A: 0.05, D: null }, { P: 1, A: 1, D: 1 });
    check('两路都说话时相加而不是取平均',
        Math.abs(sum.delta.P + 0.3) < 1e-9 && Math.abs(sum.delta.A - 0.05) < 1e-9
        && Math.abs(sum.delta.D - 0.1) < 1e-9, JSON.stringify(sum.delta));
    check('某轴只有共振说话时不把它稀释掉', sum.applied === true && num(sum.delta.A));

    const over = combineWithResonance({ P: -0.5, A: -0.5, D: -0.5 }, { P: -0.4, A: -0.4, D: -0.4 },
        { P: 0.6, A: 0.5, D: 0.4 });
    check('叠加后仍守住单轮每轴总上限',
        Math.abs(over.delta.P) <= 0.6 && Math.abs(over.delta.A) <= 0.5 && Math.abs(over.delta.D) <= 0.4
        && over.clipped === true, JSON.stringify(over.delta));

    const nullBase = combineWithResonance({ P: null, A: null, D: null }, { P: 0.1, A: null, D: null },
        { P: 0.6, A: 0.5, D: 0.4 });
    check('原本没位移的轴不会因为共振凭空变成 0 以外的值',
        nullBase.delta.P === 0.1 && nullBase.delta.A === null && nullBase.delta.D === null,
        JSON.stringify(nullBase.delta));
}

console.log('== B6-α① 全链路：她这一轮真的被他的情绪影响 ==');
{
    const ag = makeAgent();
    config.emotion.resonance.enabled = false;
    let onOff = null;
    const origApply = ag.emotionEngine.applyDelta.bind(ag.emotionEngine);
    ag.emotionEngine.applyDelta = (d, i) => { onOff = { delta: { ...d }, inertia: i }; return origApply(d, i); };
    await ag.chat('今天好难过啊');
    await sleep(200);
    const expected = blendDeltas(
        ag.emotionEngine.analyzeInput('今天好难过啊', ag.affinity),
        { P: -0.2, A: 0, D: 0 },
        { keywordWeight: config.emotion.keywordWeight, llmWeight: config.emotion.llmWeight }
    ).delta;
    check('关闭态：applyDelta 收到的仍是原来那一份混合值',
        ['P', 'A', 'D'].every((k) => onOff.delta[k] === expected[k]),
        `实收 ${JSON.stringify(onOff.delta)} 期望 ${JSON.stringify(expected)}`);
    check('关闭态：沿用默认惯性（共振不参与时不改调用形态）',
        onOff.inertia === undefined, String(onOff.inertia));
    const pOff = ag.emotionEngine.state.P;

    const ag2 = makeAgent();
    config.emotion.resonance.enabled = true;
    let onOn = null;
    const orig2 = ag2.emotionEngine.applyDelta.bind(ag2.emotionEngine);
    ag2.emotionEngine.applyDelta = (d, i) => { onOn = { delta: { ...d }, inertia: i }; return orig2(d, i); };
    ag2.emotionEngine.state = { ...ag.emotionEngine.state };
    ag2.emotionEngine.baseline = { ...ag.emotionEngine.baseline };
    const r2 = await ag2.chat('今天好难过啊');
    await sleep(200);
    check('开启后：她的增量里多了共振项',
        onOn.delta.P < onOff.delta.P, `${onOn.delta.P} vs ${onOff.delta.P}`);
    check('开启后：本轮共振量随结果回传（供排障观测）',
        num(r2.emotionResonance?.P) && r2.emotionResonance.P < 0, JSON.stringify(r2.emotionResonance));
    check('开启后：她这一轮结束时的 P 确实更低',
        ag2.emotionEngine.state.P < pOff, `${ag2.emotionEngine.state.P} vs ${pOff}`);

    // 熟不熟决定她被牵动多少
    const ag3 = makeAgent();
    ag3.affinityEngine._affinity = 5;          // 陌生阶段
    ag3.emotionEngine.state = { ...ag.emotionEngine.state };
    const r3 = await ag3.chat('今天好难过啊');
    await sleep(200);
    check('陌生阶段她不被牵动（同一条消息）',
        r3.emotionResonance === null, JSON.stringify(r3.emotionResonance));

    config.emotion.resonance.enabled = true;
}

console.log('== B6-α① 共振与情绪时间线共用同一份读数 ==');
{
    const ag = makeAgent();
    config.emotion.resonance.enabled = true;
    let received = null;
    const origIngest = ag.userEmotionEngine.ingestTurn.bind(ag.userEmotionEngine);
    ag.userEmotionEngine.ingestTurn = (u, r, l, pre) => { received = pre; return origIngest(u, r, l, pre); };
    await ag.chat('今天好难过啊');
    await sleep(300);
    check('摄入时收到调用方算好的融合值（不是各算一遍）',
        received && num(received.valence) && received.valence < 0, JSON.stringify(received));
    check('时间线记下来的就是那份读数（两条链路一本账）',
        ag.userEmotionEngine.state.valence === received.valence,
        `${ag.userEmotionEngine.state.valence} vs ${received.valence}`);

    // 关闭共振时不该多算一次，照旧由摄入路径自己分析
    const agOff = makeAgent();
    config.emotion.resonance.enabled = false;
    let receivedOff = 'unset';
    agOff.userEmotionEngine.ingestTurn = (u, r, l, pre) => { receivedOff = pre; return { current: {}, turned: false, trend: {} }; };
    await agOff.chat('今天好难过啊');
    await sleep(300);
    check('关闭共振时不预先分析（省掉一份重复计算）', receivedOff === null, String(receivedOff));
    config.emotion.resonance.enabled = true;
}

// ======================================================================
console.log('== B6-α② 跃迁事件：契约与判定 ==');
{
    check('TRIGGER_EVENTS 有 stage_advanced',
        TRIGGER_EVENT_NAMES.includes(TRIGGER_EVENTS.STAGE_ADVANCED));
    check('每种事件都有 payload 契约',
        TRIGGER_EVENT_NAMES.every((e) => TRIGGER_EVENT_SCHEMAS[e]),
        TRIGGER_EVENT_NAMES.filter((e) => !TRIGGER_EVENT_SCHEMAS[e]).join(','));
    check('跃迁事件的每个目标类型都是已知主动消息类型',
        TRIGGER_DEF_LIST.every((d) => PROACTIVE_TYPE_IDS.includes(d.targetType)),
        TRIGGER_DEF_LIST.filter((d) => !PROACTIVE_TYPE_IDS.includes(d.targetType))
            .map((d) => `${d.id}→${d.targetType}`).join(','));

    const up = evaluateStage({
        fromStage: 'friend', toStage: 'close', fromLabel: '朋友', toLabel: '挚友/暧昧',
        direction: 'up', affinity: 61, unlocks: ['可以说"最喜欢你了"'],
    }, { now: Date.now() });
    check('向上跃迁产出候选', !!up && up.data.toStage === 'close', JSON.stringify(up));
    check('候选带了解锁项（说得出具体变化）',
        Array.isArray(up?.data.unlocks) && up.data.unlocks.length === 1);

    const down = evaluateStage({
        fromStage: 'close', toStage: 'friend', direction: 'down', affinity: 55,
    }, { now: Date.now() });
    check('向下的跃迁暂时不发主动消息（PRD §5 Q2 未拍板）', down === null, JSON.stringify(down));

    const same = evaluateStage({ fromStage: 'friend', toStage: 'friend', direction: 'up' }, {});
    check('同阶段不产出候选', same === null);

    const noUnlocks = evaluateStage({
        fromStage: 'friend', toStage: 'close', direction: 'up',
    }, { now: Date.now() });
    check('payload 没带解锁项时从阶段表兜底',
        noUnlocks?.data.unlocks.length === (RELATIONSHIP_STAGES.find(s => s.stage === 'close').unlocks.length),
        JSON.stringify(noUnlocks?.data.unlocks));

    const day = 24 * 60 * 60 * 1000;
    const a = evaluateStage({ fromStage: 'friend', toStage: 'close', direction: 'up' }, { now: 1 * day + 1000 });
    const b = evaluateStage({ fromStage: 'friend', toStage: 'close', direction: 'up' }, { now: 1 * day + 9000 });
    const c = evaluateStage({ fromStage: 'close', toStage: 'lover', direction: 'up' }, { now: 1 * day + 9000 });
    check('同一天同一条线去重', a.dedupeKey === b.dedupeKey, `${a.dedupeKey} vs ${b.dedupeKey}`);
    check('真的又跨一格时不被上一格挡掉', a.dedupeKey !== c.dedupeKey);
    check('触发源元数据与类型表一致',
        stageTransitionTrigger.targetType === 'stage_transition'
        && !!getProactiveType('stage_transition')
        && getProactiveType('stage_transition').eventDriven === true);
}

console.log('== B6-α② 全链路：跨过那条线当轮就发事件 ==');
{
    const ag = makeAgent({ withBus: true });
    ag.affinityEngine._affinity = 59;               // 朋友阶段上沿，再来 1 分就跨进挚友
    const before = ag.emotionEngine.getRelationshipContext(ag.affinity).stage;
    const res = await ag.chat('我今天好难过啊');
    await sleep(300);
    const stageEv = ag._emitted.find((e) => e.event === TRIGGER_EVENTS.STAGE_ADVANCED);
    check('好感度确实跨过了阶段线', ag.affinity >= 60 && res.affinity >= 60,
        `${before} → ${ag.affinity}`);
    check('发布了 stage_advanced 事件', !!stageEv, JSON.stringify(ag._emitted.map(e => e.event)));
    check('事件说清了从哪到哪、朝哪个方向',
        stageEv?.payload.fromStage === 'friend' && stageEv?.payload.toStage === 'close'
        && stageEv?.payload.direction === 'up', JSON.stringify(stageEv?.payload));
    check('事件带了中文标签（prompt 用得上）',
        stageEv?.payload.toLabel === '挚友/暧昧' && Array.isArray(stageEv?.payload.unlocks),
        JSON.stringify(stageEv?.payload?.toLabel));

    // 没有跨线就不该发事件
    const ag2 = makeAgent({ withBus: true });
    ag2.affinityEngine._affinity = 40;
    await ag2.chat('我今天好难过啊');
    await sleep(300);
    check('没跨过线时不发跃迁事件',
        !ag2._emitted.some((e) => e.event === TRIGGER_EVENTS.STAGE_ADVANCED));

    // 事件层关闭：跃迁照样发生，但不发任何事件（关闭态安全）。
    // 注意开关必须在构造之后再关：new AiGirlfriend() 会从 state.json 恢复
    // 用户持久化的事件层开关（B9-2），构造时关掉的会被它盖回去。
    const { setEventLayerEnabled } = await import('../src/core/TriggerRegistry.js');
    const ag3 = makeAgent({ withBus: true });
    setEventLayerEnabled(false);
    ag3.affinityEngine._affinity = 59;
    await ag3.chat('我今天好难过啊');
    await sleep(300);
    check('事件层关掉后不再发布跃迁事件',
        ag3._emitted.length === 0, JSON.stringify(ag3._emitted.map(e => e.event)));
    check('关掉事件层后这一轮照常结算（新增的发布点不会反过来拖累主链路）',
        typeof ag3.getHistory().at(-1)?.content === 'string' && num(ag3.emotionEngine.state.P),
        JSON.stringify(ag3.emotionEngine.state));
    setEventLayerEnabled(true);
}

console.log('== B6-α② 端到端：跃迁事件 → 触发源 → 全闸门 → 主动消息入队 ==');
{
    const { EventBus } = await import('../src/core/EventBus.js');
    const TriggerRegistry = (await import('../src/core/TriggerRegistry.js')).default;
    const ProactiveEngine = (await import('../src/core/ProactiveEngine.js')).default;

    const bus = new EventBus();
    const registry = new TriggerRegistry({ bus });
    registry.reset();
    registry.register(stageTransitionTrigger);
    registry.attach(bus);

    const seen = [];
    const mock = {
        affinity: 61,
        emotionEngine: { state: { P: 0.4, A: 0.15, D: -0.1 } },
        generateProactiveMessage: async (reason, data) => {
            seen.push({ reason, data });
            return { reply: `我忽然觉得我们不太一样了 ${Math.random().toString(36).slice(2, 6)}`, emotion: '害羞' };
        },
        recordProactiveMessage: () => {},
        recordProactiveOutcome: () => null,
    };
    const engine = new ProactiveEngine(mock, registry);
    engine.stop();
    engine.messageQueue = [];
    engine.config.enabledTypes = ['stage_transition'];
    engine.config.customDailyLimit = 20;
    engine.dailyMessageCount = 0;
    engine.lastTriggerByType = {};
    engine.lastSpontaneousAt = 0;

    bus.emit(TRIGGER_EVENTS.STAGE_ADVANCED, {
        fromStage: 'friend', toStage: 'close', fromLabel: '朋友', toLabel: '挚友/暧昧',
        direction: 'up', affinity: 61, unlocks: ['可以说"最喜欢你了"这类暧昧的话'], ts: Date.now(),
    });
    check('跃迁事件被触发源接住并入事件队列', registry.getStatus().queueSize === 1,
        `size=${registry.getStatus().queueSize}`);

    const ok = await engine.consumeEventQueue();
    check('端到端消费成功（走的是 trigger() 全闸门，不是旁路）', ok === true);
    check('生成的主动消息类型为 stage_transition',
        engine.messageQueue.length === 1 && engine.messageQueue[0].reason === 'stage_transition',
        JSON.stringify(engine.messageQueue.map(m => m.reason)));
    check('场景数据带着新旧阶段与解锁项一路传到生成端',
        seen[0]?.data?.toStage === 'close' && seen[0]?.data?.fromLabel === '朋友'
        && Array.isArray(seen[0]?.data?.unlocks) && seen[0].data.unlocks.length === 1,
        JSON.stringify(seen[0]?.data));
    check('事件队列已清空', registry.getStatus().queueSize === 0);

    // 同一条线再跳一次：触发源冷却（12h）+ 按天去重都该拦住，她不会反复说同一句话
    bus.emit(TRIGGER_EVENTS.STAGE_ADVANCED, {
        fromStage: 'friend', toStage: 'close', direction: 'up', affinity: 61, ts: Date.now(),
    });
    check('短时间内重复跃迁不再发第二条（冷却 + 按天去重）',
        registry.getStatus().queueSize === 0, JSON.stringify(registry.getStatus().cooldowns));

    // ghost（冷暴力）期间不发仪式感消息：情绪闸门照旧管得住新类型
    registry.cooldowns = {};
    registry.dedupeSeen = {};
    engine.aiGirlfriend.emotionEngine.state = { P: -0.9, A: 0.2, D: 0 };
    bus.emit(TRIGGER_EVENTS.STAGE_ADVANCED, {
        fromStage: 'close', toStage: 'lover', direction: 'up', affinity: 86, ts: Date.now(),
    });
    const blocked = await engine.consumeEventQueue();
    check('她在冷暴力时不会跳出来说「我们更近了」（闸门管得住新类型）',
        blocked === false, String(blocked));
    engine.stop();
}

console.log('== B6-α② 跃迁的场景 prompt：具体而不越界 ==');
{
    const { buildProactivePrompt } = await import('../src/core/prompts/proactivePrompts.js');
    const text = buildProactivePrompt('stage_transition', {
        fromLabel: '朋友', toLabel: '挚友/暧昧', unlocks: ['可以说"最喜欢你了"这类暧昧的话'],
    }, 61);
    check('说清了从哪个阶段到哪个阶段',
        text.includes('朋友') && text.includes('挚友/暧昧'), text.slice(0, 60));
    check('把解锁项写进去了（不是空泛的「我们更近了」）', text.includes('最喜欢你了'), text);
    check('要求别报阶段名与数字', text.includes('不要像宣布规则'));
    const memoryShare = buildProactivePrompt('memory_share', {}, 61);
    check('顺带修好 memory_share 那句被截断的文案',
        !memoryShare.trim().endsWith('语气要'), memoryShare);
}

// ======================================================================
console.log('== B6-α③ 主动消息结局回灌她自己的情绪 ==');
{
    const ag = makeAgent();
    config.emotion.proactiveFeedback.enabled = true;

    const p0 = ag.emotionEngine.state.P;
    const delivered = ag.recordProactiveOutcome('delivered', { reason: 'miss_you' });
    check('把「想他」说出口让她自己心里一甜', num(delivered?.P) && delivered.P > 0, JSON.stringify(delivered));
    check('真的写进了她的情绪状态', ag.emotionEngine.state.P > p0,
        `${p0} → ${ag.emotionEngine.state.P}`);

    const p1 = ag.emotionEngine.state.P;
    const expired = ag.recordProactiveOutcome('expired', { reason: 'miss_you' });
    check('递出去的心意落了空 → 失落', num(expired?.P) && expired.P < 0, JSON.stringify(expired));
    check('失落真的压低了她的 P', ag.emotionEngine.state.P < p1, `${p1} → ${ag.emotionEngine.state.P}`);

    const p2 = ag.emotionEngine.state.P;
    check('早安过期只是时间过了，不该让她失落',
        ag.recordProactiveOutcome('expired', { reason: 'morning_greeting' }) === null
        && ag.emotionEngine.state.P === p2);
    check('任务提醒是事务，收到也不额外开心',
        ag.recordProactiveOutcome('delivered', { reason: 'task_reminder' }) === null
        && ag.emotionEngine.state.P === p2);
    check('未知类型一律不回灌',
        ag.recordProactiveOutcome('delivered', { reason: 'no_such_type' }) === null);
    check('缺 reason 一律不回灌', ag.recordProactiveOutcome('delivered', {}) === null);

    // 失落会自然收敛自发消息：情绪闸门随之收紧（不需要另写冷落规则）
    const agGate = makeAgent();
    const pBeforeGate = agGate.emotionEngine.state.P;
    for (let i = 0; i < 6; i++) agGate.recordProactiveOutcome('expired', { reason: 'random_chat' });
    check('连续落空后她的情绪一路走低',
        agGate.emotionEngine.state.P < pBeforeGate,
        `${pBeforeGate} → ${agGate.emotionEngine.state.P}`);
    check('落空的位移逐次递减（惯性把每次的冲击摊薄，不会一条消息就把她打进冷暴力）',
        Math.abs(agGate.emotionEngine.state.P - pBeforeGate) < 0.5,
        JSON.stringify(agGate.emotionEngine.state));

    config.emotion.proactiveFeedback.enabled = false;
    const pOff = ag.emotionEngine.state.P;
    check('关闭态：送达/落空都不改动她的情绪',
        ag.recordProactiveOutcome('delivered', { reason: 'miss_you' }) === null
        && ag.recordProactiveOutcome('expired', { reason: 'miss_you' }) === null
        && ag.emotionEngine.state.P === pOff, `${pOff} → ${ag.emotionEngine.state.P}`);
    config.emotion.proactiveFeedback.enabled = true;

    check('落空的账只有一份事实源（写在类型表里）',
        num(PROACTIVE_EXPIRY_FEEDBACK.P) && PROACTIVE_EXPIRY_FEEDBACK.P < 0);
}

console.log('== B6-α③ ProactiveEngine 两个结局点真的接上了 ==');
{
    const calls = [];
    const fakeAg = {
        affinity: 40,
        recordProactiveOutcome: (kind, m) => { calls.push({ kind, reason: m.reason }); return null; },
    };
    const ProactiveEngine = (await import('../src/core/ProactiveEngine.js')).default;
    const engine = new ProactiveEngine(fakeAg, null);
    engine.stop();
    const now = Date.now();
    engine.messageQueue = [
        { id: 'm1', reason: 'miss_you', content: '想你了', priority: 50, timestamp: new Date().toISOString(), expiresAt: now + 60 * 60 * 1000 },
        { id: 'm2', reason: 'random_chat', content: '在看云', priority: 30, timestamp: new Date().toISOString(), expiresAt: now - 1000 },
    ];
    const got = engine.consumeMessage();
    check('被取走的消息上报 delivered', got?.id === 'm1'
        && calls.some((c) => c.kind === 'delivered' && c.reason === 'miss_you'),
        JSON.stringify(calls));
    check('过期的消息上报 expired',
        calls.some((c) => c.kind === 'expired' && c.reason === 'random_chat'), JSON.stringify(calls));

    // 回灌异常绝不能拖垮投递
    const boomAg = {
        affinity: 40,
        recordProactiveOutcome: () => { throw new Error('boom'); },
    };
    const engine2 = new ProactiveEngine(boomAg, null);
    engine2.stop();
    engine2.messageQueue = [
        { id: 'x', reason: 'miss_you', content: 'a', priority: 50, timestamp: new Date().toISOString(), expiresAt: now + 60 * 60 * 1000 },
    ];
    check('回灌抛错不影响消息投递', !!engine2.consumeMessage());
}

// ======================================================================
console.log('== B6-α④ 防复读账：冷却窗从落盘数据派生 ==');
{
    const DAY = 24 * 60 * 60 * 1000;
    /**
     * @param {boolean} seedRecalls true = 三条都在冷却窗内（各自 1/200/100 天前提过），
     *        用来单独验「全在冷却期」那条兜底分支
     */
    const buildStore = ({ seedRecalls = false } = {}) => {
        const store = new NarrativeStore();
        store.narratives.length = 0;
        const rows = seedRecalls
            ? [['s1', 3, Date.now() - 1 * DAY], ['s2', 1, Date.now() - 200 * DAY], ['s3', 0, Date.now() - 100 * DAY]]
            : [['s1', 3, Date.now() - 1 * DAY], ['s2', 1, Date.now() - 200 * DAY], ['s3', 0, undefined]];
        for (const [id, recallCount, lastRecalledAt] of rows) {
            store.narratives.push({
                id, type: 'shared_event', title: `故事${id}`, summary: '',
                occurredAt: Date.now() - 300 * DAY, recallCount, lastRecalledAt,
            });
        }
        return store;
    };

    const store = buildStore();
    const retriever = new NarrativeRetriever({ store, embedding: null });

    const p1 = retriever.getRandomStory(0, { excludeIds: new Set(['s1']) });
    check('冷却窗内的故事被排除在候选之外', p1.id !== 's1', p1.id);
    const allIn = buildStore({ seedRecalls: true });
    const p2 = new NarrativeRetriever({ store: allIn, embedding: null })
        .getRandomStory(0, { excludeIds: new Set(['s1', 's2', 's3']) });
    check('全在冷却期时退回最久没提的那条', p2.id === 's2', p2.id);
    check('空池子返回 null',
        new NarrativeRetriever({ store: { narratives: [] }, embedding: null }).getRandomStory() === null);
    check('不传 excludeIds 时行为照旧（向后兼容）', !!retriever.getRandomStory(0));

    // facade 记账：冷却窗只认「提过且还在窗内」的，从没提过的不算刚说过
    const ag = makeAgent();
    ag.narrativeStore = store;
    ag.narrativeRetriever = retriever;
    const win0 = ag._recentlyRecalledStoryIds();
    check('冷却窗只包含提过且在窗内的故事', win0.size === 1 && win0.has('s1'),
        [...win0].join(','));

    const first = ag._pickStoryForSharing(0);
    check('第一次避开刚提过的（s1 在窗内），挑提得最少的', first.id === 's3', first.id);
    const second = ag._pickStoryForSharing(0);
    check('第二次也不复读（连续三次挑出三条不同的故事）', second.id === 's2', second.id);
    check('两条都记上了 recallCount',
        store.getById(first.id).recallCount === 1 && store.getById(second.id).recallCount === 2,
        JSON.stringify(store.narratives.map(n => [n.id, n.recallCount])));
    check('两条都写了 lastRecalledAt',
        num(store.getById(first.id).lastRecalledAt) && num(store.getById(second.id).lastRecalledAt));
    const win2 = ag._recentlyRecalledStoryIds();
    check('冷却窗把新提过的两条也算进来了',
        win2.has(first.id) && win2.has(second.id) && win2.has('s1'), [...win2].join(','));
    const third = ag._pickStoryForSharing(0);
    check('三条都提过 → 允许再提最久没讲的那条（真人也会重复）', third.id === 's1', third.id);
    check('重复提起照样记账（不再是「兜底分支连账都不记」）',
        store.getById('s1').recallCount === 4, String(store.getById('s1').recallCount));

    // 重启不失忆：新实例从盘上的 lastRecalledAt 读出冷却窗
    store._saveNow();
    const fresh = new AiGirlfriend();
    fresh.narrativeStore = new NarrativeStore();
    fresh.narrativeStore.narratives.length = 0;
    fresh.narrativeStore.narratives.push({
        id: 'r1', type: 'shared_event', title: '重启前的故事', summary: '',
        occurredAt: Date.now() - 10 * DAY, recallCount: 1,
        lastRecalledAt: Date.now() - 60 * 60 * 1000,
    });
    check('重启后依然记得这件事刚才说过（旧写法是内存集合，一重启就失忆）',
        fresh._recentlyRecalledStoryIds().has('r1'));
    check('超出冷却窗的事件可以再提',
        !fresh._recentlyRecalledStoryIds(Date.now() + 40 * DAY).has('r1'));
    check('没有 lastRecalledAt 的旧条目不会被误判成刚提过',
        !fresh._recentlyRecalledStoryIds().has('never'));
}

// ======================================================================
console.log('== 新增默认开启类型能到达老用户（顺带修的历史坑）==');
{
    const ProactiveEngine = (await import('../src/core/ProactiveEngine.js')).default;
    const noop = { affinity: 40, recordProactiveOutcome: () => null };
    const stateFile = path.join(DATA, 'proactive_state.json');
    const backup = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : null;

    const write = (obj) => fs.writeFileSync(stateFile, JSON.stringify(obj), 'utf8');

    // ① 老用户：磁盘上只有最初的 8 类，且没有 knownTypeIds
    write({
        config: {
            enabled: true, frequencyLevel: 'medium', customDailyLimit: null,
            enabledTypes: ['morning_greeting', 'night_greeting', 'task_reminder',
                'miss_you', 'mood_check', 'memory_share', 'random_chat', 'life_update'],
        },
    });
    const e1 = new ProactiveEngine(noop, null);
    e1.stop();
    check('老用户拿到了事件驱动的新类型（否则触发器辛苦命中却被 canTrigger 拦死）',
        e1.getConfig().enabledTypes.includes('stage_transition')
        && e1.getConfig().enabledTypes.includes('emotion_resonance'),
        JSON.stringify(e1.getConfig().enabledTypes));
    check('canTrigger 对新类型放行', e1.canTrigger('stage_transition') === true);

    // ② 有 knownTypeIds 且用户显式关掉了新类型 → 绝不补回来
    write({
        config: {
            enabled: true, frequencyLevel: 'medium', customDailyLimit: null,
            enabledTypes: ['morning_greeting', 'memory_share'],
        },
        knownTypeIds: [...PROACTIVE_TYPE_IDS],
    });
    const e2 = new ProactiveEngine(noop, null);
    e2.stop();
    check('用户显式关掉的类型不会被「补全」回来',
        !e2.getConfig().enabledTypes.includes('stage_transition')
        && !e2.getConfig().enabledTypes.includes('miss_you'),
        JSON.stringify(e2.getConfig().enabledTypes));
    check('存盘时记录了这份配置对应的类型目录',
        JSON.parse(fs.readFileSync(stateFile, 'utf8')).knownTypeIds?.length === PROACTIVE_TYPE_IDS.length);

    // ③ 老用户 + knownTypeIds 缺省也不该动定时类
    write({ config: { enabled: true, enabledTypes: ['memory_share'] } });
    const e3 = new ProactiveEngine(noop, null);
    e3.stop();
    check('无 knownTypeIds 时只补事件驱动类，定时类保持用户的选择',
        !e3.getConfig().enabledTypes.includes('morning_greeting')
        && e3.getConfig().enabledTypes.includes('promise_followup'),
        JSON.stringify(e3.getConfig().enabledTypes));

    if (backup) fs.writeFileSync(stateFile, backup, 'utf8'); else fs.rmSync(stateFile, { force: true });
}

console.log('== 关系说明书与跃迁共用同一份解锁表述 ==');
{
    const { buildRelationshipContext } = await import('../src/core/prompts/relationshipContext.js');
    const ctx = buildRelationshipContext({
        stage: 'close', label: '挚友/暧昧', affinity: 61, baseline: { P: 0.4, A: 0.15, D: -0.1 },
    });
    const unlocks = RELATIONSHIP_STAGES.find(s => s.stage === 'close').unlocks;
    check('每轮说明书里出现了解锁项', ctx.includes('到这一层你可以新做的事') && unlocks.every(u => ctx.includes(u)),
        ctx.slice(0, 120));
    const strangerCtx = buildRelationshipContext({
        stage: 'stranger', label: '陌生/疏离', affinity: 5, baseline: { P: 0, A: 0, D: 0.1 },
    });
    check('陌生阶段没有解锁项，不硬凑一段', !strangerCtx.includes('到这一层你可以新做的事'));
    check('阶段表每条都有 unlocks 字段（新阶段不会漏）',
        RELATIONSHIP_STAGES.every(s => Array.isArray(s.unlocks)));
    check('阶段表顺序与跃迁方向判定一致',
        RELATIONSHIP_STAGES[0].stage === 'stranger' && RELATIONSHIP_STAGES.at(-1).stage === 'lover');
}

if (failures.length) {
    console.log(`\n结果: ${pass} passed, ${failures.length} failed`);
    for (const f of failures) console.log('  ·', f);
    process.exit(1);
}
console.log(`\n结果: ${pass} passed, 0 failed`);
