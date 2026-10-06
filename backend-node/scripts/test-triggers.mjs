/**
 * REQ-04 事件触发源测试（T04）。
 *
 * 覆盖（对应 T04 硬性验收标准）：
 *   【集成护栏 · 重点】加载**真实 container**，断言触发源已注册、user_emotion_turn 有订阅者
 *                      —— 这条正是为防 D-1 复发（生产装配空转），必须断言真实装配，不自造迷你场景。
 *   【端到端】情绪强转折 → 事件 → 被消费 → 产出候选 → 走 ProactiveEngine.trigger() 全闸门 → 入队
 *   【全闸门不被绕过】P=-0.9（情绪 block 档）时事件触发仍被情绪闸门拦下，且未调 LLM
 *   【enabled=false】端到端链路整体静默，与改造前一致
 *   触发源纯函数单测：emotionTurnTrigger / anniversaryTrigger / promiseFollowupTrigger
 *
 * 数据保护：与既有测试同一套备份/还原策略（trigger_state / proactive_state 字节级还原）。
 * 真实 container 会读 data/*.json 并在 stop() 时回写 → 测试末尾还原。
 */
import fs from 'node:fs';
import { dataPath } from '../src/utils/jsonStore.js';

import { createHarness } from './lib/testKit.mjs';

// 断言外壳统一走 scripts/lib/testKit.mjs（B5-2）：expect 是「本套件应执行的断言条数」，
// 少跑了（某节被注释、中途 return）就算失败 —— 旧写法只数失败数，跳过整节照样绿。
const t = createHarness('triggers', { expect: 42 });
const check = t.check;
// 默认按失败处理：只有 t.finish() 真的跑到才会被改写（异常穿透时也不会误报全绿）
let exitCode = 1;

// ---- 真实数据备份 ----
const stateUrls = [
    dataPath('trigger_state.json'),
    dataPath('proactive_state.json'),
];
function snapshot(url) {
    try { return { existed: true, bytes: fs.readFileSync(url) }; }
    catch (e) { if (e.code === 'ENOENT') return { existed: false, bytes: null }; throw e; }
}
function restore(url, snap) {
    if (snap.existed) fs.writeFileSync(url, snap.bytes);
    else { try { fs.unlinkSync(url); } catch { /* 本来就没有 */ } }
}
const snaps = stateUrls.map(snapshot);

try {
    const { TRIGGER_EVENTS, TRIGGER_DEFS, TRIGGER_THRESHOLDS } = await import('../src/core/triggerEvents.js');
    const { default: EventBus } = await import('../src/core/EventBus.js');
    const { default: TriggerRegistry, setEventLayerEnabled } = await import('../src/core/TriggerRegistry.js');
    const { default: ProactiveEngine } = await import('../src/core/ProactiveEngine.js');
    const { emotionTurnTrigger, evaluate: evalEmotion } = await import('../src/core/triggers/emotionTurnTrigger.js');
    const { anniversaryTrigger, evaluate: evalAnniversary } = await import('../src/core/triggers/anniversaryTrigger.js');
    const { promiseFollowupTrigger, evaluate: evalPromise } = await import('../src/core/triggers/promiseFollowupTrigger.js');

    // ============================================================
    console.log('A. 【集成护栏】真实 container 装配：触发源已注册 + 事件有订阅者');
    // ============================================================
    {
        const container = await import('../src/services/container.js');
        const { triggerRegistry, eventBus, proactiveEngine } = container;

        check('container 导出 triggerRegistry', !!triggerRegistry);
        check('container 导出 eventBus', !!eventBus);

        // 关键断言 1：触发源数量 > 0（D-1 的直接防线）
        const triggerCount = triggerRegistry.triggers.size;
        console.log(`      → triggerRegistry.triggers.size = ${triggerCount}, ids = [${[...triggerRegistry.triggers.keys()].join(', ')}]`);
        check('【D-1 护栏】真实 container 注册了触发源（size > 0）', triggerCount > 0, `size=${triggerCount}`);
        check('注册了 emotion_turn', triggerRegistry.triggers.has('emotion_turn'));
        check('注册了 anniversary', triggerRegistry.triggers.has('anniversary'));
        check('注册了 promise_followup', triggerRegistry.triggers.has('promise_followup'));

        // 关键断言 2：user_emotion_turn 在 eventBus 上有订阅者
        const subCount = eventBus.listenerCount(TRIGGER_EVENTS.USER_EMOTION_TURN);
        const narrativeSubCount = eventBus.listenerCount(TRIGGER_EVENTS.NARRATIVE_MILESTONE);
        console.log(`      → eventBus.listenerCount('${TRIGGER_EVENTS.USER_EMOTION_TURN}') = ${subCount}, listenerCount('narrative_milestone') = ${narrativeSubCount}`);
        check('【D-1 护栏】user_emotion_turn 有订阅者', subCount > 0, `count=${subCount}`);
        check('【D-1 护栏】narrative_milestone 有订阅者', narrativeSubCount > 0, `count=${narrativeSubCount}`);

        // 关键断言 3：真实 container 里 emit 能派发到触发源（不再空转）
        const before = triggerRegistry.getStatus().queueSize;
        eventBus.emit(TRIGGER_EVENTS.USER_EMOTION_TURN, {
            valence: -0.8, arousal: 0.5, intensity: 0.9, label: '愤怒',
            turned: true, trend: { declining: true, slope: -0.4 }, ts: Date.now(),
        });
        const after = triggerRegistry.getStatus().queueSize;
        console.log(`      → emit 后事件队列: ${before} → ${after}`);
        check('【D-1 护栏】真实容器 emit 后事件成功入队（不再空转）', after > before,
            `before=${before} after=${after}`);

        // 清理：停掉引擎与定时器，避免影响后续用例
        proactiveEngine.stop();
    }

    // ============================================================
    console.log('B. 触发源纯函数单测');
    // ============================================================
    {
        // —— emotionTurnTrigger ——
        const negTurn = {
            valence: -0.6, arousal: 0.3, intensity: 0.7, label: '低落',
            turned: true, trend: { avgValence: -0.4, slope: -0.3, declining: true }, ts: 1000,
        };
        check('情绪：强负向转折命中', evalEmotion(negTurn, { now: 1000 }) !== null);
        check('情绪：未转折不命中', evalEmotion({ ...negTurn, turned: false }, { now: 1000 }) === null);
        check('情绪：转正不命中（只共情转负）',
            evalEmotion({ ...negTurn, valence: 0.5, trend: {} }, { now: 1000 }) === null);
        check('情绪：弱转折不命中（强度+趋势都不够）',
            evalEmotion({ ...negTurn, intensity: 0.1, trend: { declining: false, slope: 0 } }, { now: 1000 }) === null);
        check('情绪：弱强度但趋势下滑仍命中（趋势兜底）',
            evalEmotion({ ...negTurn, intensity: 0.1, trend: { declining: true, slope: -0.3 } }, { now: 1000 }) !== null);
        const emo = evalEmotion(negTurn, { now: 1000 });
        check('情绪：候选含 dedupeKey', typeof emo?.dedupeKey === 'string' && emo.dedupeKey.length > 0);
        check('情绪：阈值来自 triggerEvents（非硬编码）',
            TRIGGER_THRESHOLDS.emotion.negativeValenceMax < 0
            && evalEmotion({ ...negTurn, valence: TRIGGER_THRESHOLDS.emotion.negativeValenceMax + 0.05 }, { now: 1000 }) === null);

        // —— anniversaryTrigger ——
        const ann = {
            narrativeId: 'n_1', type: 'anniversary', title: '第一次说晚安',
            occurredAt: 1735689600000, anniversary: true, daysUntil: 1,
        };
        check('纪念日：临近命中', evalAnniversary(ann, { now: 1000 }) !== null);
        check('纪念日：今天命中（daysUntil=0）', evalAnniversary({ ...ann, daysUntil: 0 }, { now: 1000 }) !== null);
        check('纪念日：超出窗口不命中',
            evalAnniversary({ ...ann, daysUntil: TRIGGER_THRESHOLDS.anniversary.announceWithinDays + 5 }, { now: 1000 }) === null);
        check('纪念日：非 anniversary 类型不命中',
            evalAnniversary({ ...ann, type: 'promise', anniversary: false }, { now: 1000 }) === null);
        check('纪念日：已过去太久不命中', evalAnniversary({ ...ann, daysUntil: -5 }, { now: 1000 }) === null);

        // —— promiseFollowupTrigger ——
        const now = 100 * 24 * 60 * 60 * 1000; // 一个较大的 now
        const promise = {
            narrativeId: 'p_1', type: 'promise', title: '一起去看海', summary: '说好下个月去',
            occurredAt: now - TRIGGER_THRESHOLDS.promise.followupAfterMs - 1000,
            followupCount: 0,
        };
        check('约定：进入跟进窗命中', evalPromise(promise, { now }) !== null);
        check('约定：太早（未到时机）不命中',
            evalPromise({ ...promise, occurredAt: now - 1000 }, { now }) === null);
        check('约定：太老不命中',
            evalPromise({ ...promise, occurredAt: now - TRIGGER_THRESHOLDS.promise.followupMaxAgeMs - 1000 }, { now }) === null);
        check('约定：跟进次数用尽不命中',
            evalPromise({ ...promise, followupCount: TRIGGER_THRESHOLDS.promise.maxFollowups }, { now }) === null);
        check('约定：非 promise 类型不命中',
            evalPromise({ ...promise, type: 'anniversary' }, { now }) === null);
        check('约定：候选 dedupeKey 随 followupCount 变化',
            evalPromise({ ...promise, followupCount: 0 }, { now }).dedupeKey
            !== evalPromise({ ...promise, followupCount: 1 }, { now }).dedupeKey);

        // 触发源元数据与 triggerEvents 一致
        check('emotionTurnTrigger 元数据与 TRIGGER_DEFS 一致',
            emotionTurnTrigger.id === TRIGGER_DEFS.EMOTION_TURN.id
            && emotionTurnTrigger.targetType === TRIGGER_DEFS.EMOTION_TURN.targetType);
        check('anniversaryTrigger 订阅 narrative_milestone',
            anniversaryTrigger.events.includes(TRIGGER_EVENTS.NARRATIVE_MILESTONE));
        check('promiseFollowupTrigger 订阅 narrative_milestone',
            promiseFollowupTrigger.events.includes(TRIGGER_EVENTS.NARRATIVE_MILESTONE));
    }

    // ============================================================
    console.log('C. 端到端：情绪强转折 → 事件 → 消费 → 走 trigger() 全闸门 → 入队');
    // ============================================================
    {
        const bus = new EventBus();
        const registry = new TriggerRegistry({ bus });
        registry.reset();
        registry.register(emotionTurnTrigger);
        registry.attach(bus);

        function makeMock({ P = 0.3, affinity = 35 } = {}) {
            return {
                affinity,
                emotionEngine: { state: { P, A: 0.1, D: 0 } },
                callCount: 0,
                generateProactiveMessage: async () => {
                    return { reply: `我在这里，${Math.random().toString(36).slice(2, 6)}`, emotion: '温柔' };
                },
                recordProactiveMessage: () => {},
            };
        }

        setEventLayerEnabled(true);
        const engine = new ProactiveEngine(makeMock({ P: 0.3 }), registry);
        engine.stop();
        engine.messageQueue = [];
        engine.config.enabledTypes = ['emotion_resonance'];
        engine.config.customDailyLimit = 20;
        engine.dailyMessageCount = 0;
        engine.lastTriggerByType = {};
        engine.lastSpontaneousAt = 0;
        engine.aiGirlfriend.affinity = 35;

        // 发布强负向转折事件（模拟 AiGirlfriend._persistAfterReply 的发布）
        bus.emit(TRIGGER_EVENTS.USER_EMOTION_TURN, {
            valence: -0.7, arousal: 0.4, intensity: 0.8, label: '低落',
            turned: true, trend: { declining: true, slope: -0.4 }, ts: Date.now(),
        });
        check('事件已入队（触发源命中）', registry.getStatus().queueSize === 1,
            `size=${registry.getStatus().queueSize}`);

        // 消费 → 走 trigger() 全闸门
        const ok = await engine.consumeEventQueue();
        check('consumeEventQueue 返回 true（端到端打通）', ok === true);
        check('消息入队且 reason=emotion_resonance',
            engine.messageQueue.length === 1 && engine.messageQueue[0].reason === 'emotion_resonance',
            `queue=${JSON.stringify(engine.messageQueue.map(m => m.reason))}`);
        check('事件队列已清空', registry.getStatus().queueSize === 0);

        engine.stop();
    }

    // ============================================================
    console.log('D. 全闸门不被绕过：P=-0.9（情绪 block 档）事件触发被拦、未调 LLM');
    // ============================================================
    {
        const bus = new EventBus();
        const registry = new TriggerRegistry({ bus });
        registry.reset();
        registry.register(emotionTurnTrigger);
        registry.attach(bus);

        let llmCalls = 0;
        const mock = {
            affinity: 35,
            emotionEngine: { state: { P: -0.9, A: 0.1, D: 0 } }, // 情绪 block 档
            generateProactiveMessage: async () => { llmCalls++; return { reply: 'x', emotion: 'x' }; },
            recordProactiveMessage: () => {},
        };

        setEventLayerEnabled(true);
        const engine = new ProactiveEngine(mock, registry);
        engine.stop();
        engine.messageQueue = [];
        engine.config.enabledTypes = ['emotion_resonance'];
        engine.config.customDailyLimit = 20;
        engine.dailyMessageCount = 0;
        engine.lastTriggerByType = {};
        engine.lastSpontaneousAt = 0;

        bus.emit(TRIGGER_EVENTS.USER_EMOTION_TURN, {
            valence: -0.8, arousal: 0.5, intensity: 0.9, label: '愤怒',
            turned: true, trend: { declining: true, slope: -0.5 }, ts: Date.now(),
        });
        check('事件已入队（触发源先命中）', registry.getStatus().queueSize === 1);

        const ok = await engine.consumeEventQueue();
        check('情绪 block 档 → 事件触发被闸门拦下（consumeEventQueue=false）', ok === false);
        check('被拦时未入队', engine.messageQueue.length === 0);
        check('被拦时未调 LLM（闸门在生成前拦截）', llmCalls === 0, `calls=${llmCalls}`);

        engine.stop();
    }

    // ============================================================
    console.log('E. enabled=false：端到端链路整体静默');
    // ============================================================
    {
        const bus = new EventBus();
        const registry = new TriggerRegistry({ bus });
        registry.reset();
        registry.register(emotionTurnTrigger);
        registry.attach(bus);

        let llmCalls = 0;
        const mock = {
            affinity: 35,
            emotionEngine: { state: { P: 0.3, A: 0.1, D: 0 } },
            generateProactiveMessage: async () => { llmCalls++; return { reply: 'x', emotion: 'x' }; },
            recordProactiveMessage: () => {},
        };

        setEventLayerEnabled(false); // 关闭事件层
        const engine = new ProactiveEngine(mock, registry);
        engine.stop();
        engine.messageQueue = [];
        engine.config.enabledTypes = ['emotion_resonance'];
        engine.config.customDailyLimit = 20;
        engine.dailyMessageCount = 0;
        engine.lastSpontaneousAt = 0;

        // 即使事件入了队，消费也必须短路
        bus.emit(TRIGGER_EVENTS.USER_EMOTION_TURN, {
            valence: -0.8, arousal: 0.5, intensity: 0.9, label: '愤怒',
            turned: true, trend: { declining: true, slope: -0.5 }, ts: Date.now(),
        });
        const queued = registry.getStatus().queueSize;

        const ok = await engine.consumeEventQueue();
        check('enabled=false → consumeEventQueue=false（静默）', ok === false);
        check('enabled=false → 未入队', engine.messageQueue.length === 0);
        check('enabled=false → 未调 LLM', llmCalls === 0, `calls=${llmCalls}`);
        check('enabled=false → 事件队列未被消费（无副作用）',
            registry.getStatus().queueSize === queued, `queued=${queued}`);

        setEventLayerEnabled(true); // 恢复
        engine.stop();
    }

    console.log('');
    exitCode = t.finish();
} finally {
    stateUrls.forEach((url, i) => restore(url, snaps[i]));
}

// 备份/还原完成后才退出：失败时立刻 exit 会跳过 finally，把用户数据留在污染状态
process.exit(exitCode);
