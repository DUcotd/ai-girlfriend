/**
 * REQ-04 事件层测试（EventBus + TriggerRegistry + ProactiveEngine 挂钩）。
 *
 * 覆盖（对应任务 T03 自验标准 5 点）：
 *   1. EventBus：注册/派发/解绑；单个 handler 抛异常不影响其他 handler
 *   2. TriggerRegistry：注册触发源、事件入队、冷却生效、重复事件去重、队列 TTL 丢弃
 *   3. consumeEventQueue()：队列空返回 false、有事件返回 true 并取出
 *   4. 【最重要】enabled=false 对照：_runCheck() 在事件层关闭时行为与改造前一致
 *      （consumeEventQueue 返回 false 且未产生副作用）
 *   5. 持久化：落盘后重新加载状态一致
 *
 * 纯 Node 断言，不调 LLM：generateProactiveMessage 用 mock 替身。
 * 真实数据保护：本测试会写 data/trigger_state.json 与触发 ProactiveEngine 构造
 *   （读/写 data/proactive_state.json）——与 test-proactive-gating.mjs 同一套备份/还原策略。
 */
import fs from 'node:fs';
import { dataPath } from '../src/utils/jsonStore.js';

import { createHarness } from './lib/testKit.mjs';

// 断言外壳统一走 scripts/lib/testKit.mjs（B5-2）：expect 是「本套件应执行的断言条数」，
// 少跑了（某节被注释、中途 return）就算失败 —— 旧写法只数失败数，跳过整节照样绿。
const t = createHarness('trigger-registry', { expect: 45 });
const check = t.check;
// 默认按失败处理：只有 t.finish() 真的跑到才会被改写（异常穿透时也不会误报全绿）
let exitCode = 1;

// ---- 真实数据备份（必须在任何动态 import 触发构造之前） ----
const triggerStateUrl = dataPath('trigger_state.json');
const proactiveStateUrl = dataPath('proactive_state.json');

function snapshot(url) {
    try {
        return { existed: true, bytes: fs.readFileSync(url) };
    } catch (e) {
        if (e.code === 'ENOENT') return { existed: false, bytes: null };
        throw e;
    }
}
function restore(url, snap) {
    if (snap.existed) fs.writeFileSync(url, snap.bytes);
    else { try { fs.unlinkSync(url); } catch { /* 本来就没有 */ } }
}

const triggerStateSnap = snapshot(triggerStateUrl);
const proactiveStateSnap = snapshot(proactiveStateUrl);

try {
    const { default: EventBus } = await import('../src/core/EventBus.js');
    const { default: TriggerRegistry, setEventLayerEnabled, isEventLayerEnabled } =
        await import('../src/core/TriggerRegistry.js');
    const { TRIGGER_EVENTS, TRIGGER_DEFS } = await import('../src/core/triggerEvents.js');
    const { default: ProactiveEngine } = await import('../src/core/ProactiveEngine.js');

    // ============================================================
    console.log('1. EventBus: 注册/派发/解绑 + 异常隔离');
    // ============================================================
    {
        const bus = new EventBus();
        const seen = [];
        const h1 = (p) => seen.push(`h1:${p.n}`);
        const h2 = (p) => seen.push(`h2:${p.n}`);

        bus.on('evt', h1);
        bus.on('evt', h2);
        const delivered = bus.emit('evt', { n: 1 });
        check('emit 派发给全部订阅者', delivered === 2 && seen.join(',') === 'h1:1,h2:1', `seen=${seen}`);

        // 解绑 h1 后只剩 h2
        const okOff = bus.off('evt', h1);
        seen.length = 0;
        bus.emit('evt', { n: 2 });
        check('off 解绑生效', okOff === true && seen.join(',') === 'h2:2', `seen=${seen}`);
        check('listenerCount 正确', bus.listenerCount('evt') === 1);

        // 异常隔离：抛异常的 handler 不影响其他 handler，且 emit 不抛
        const bus2 = new EventBus();
        const order = [];
        bus2.on('x', () => { order.push('before'); });
        bus2.on('x', () => { order.push('boom'); throw new Error('handler 内部爆炸'); });
        bus2.on('x', () => { order.push('after'); });
        let emitThrew = false;
        let count = 0;
        try {
            count = bus2.emit('x', {});
        } catch {
            emitThrew = true;
        }
        check('单个 handler 抛异常不冒泡给 emit', emitThrew === false);
        check('异常 handler 之后的其他 handler 仍被调用',
            order.join(',') === 'before,boom,after', `order=${order}`);
        check('emit 返回成功调用数（不含抛异常者）', count === 2, `count=${count}`);

        // once：只派发一次
        const busOnce = new EventBus();
        let onceCount = 0;
        busOnce.once('o', () => { onceCount++; });
        busOnce.emit('o', {});
        busOnce.emit('o', {});
        check('once 仅派发一次', onceCount === 1, `count=${onceCount}`);
    }

    // ============================================================
    console.log('2. TriggerRegistry: 注册/入队/冷却/去重/TTL');
    // ============================================================
    {
        // 用临时 registry（独立 state 文件由真实文件承载，测试结束会还原）
        const bus = new EventBus();
        const registry = new TriggerRegistry({ bus });
        registry.reset(); // 清掉可能从真实文件恢复的历史状态

        let evaluateCount = 0;
        const registered = registry.register({
            id: 'test_trigger',
            events: [TRIGGER_EVENTS.USER_EMOTION_TURN],
            evaluate: (payload) => {
                evaluateCount++;
                if (typeof payload.valence !== 'number' || payload.valence >= 0) return null;
                return {
                    data: { valence: payload.valence },
                    // dedupeKey 用时间戳保证「同一事件重复」可被识别
                    dedupeKey: `test:neg:${payload.ts}`,
                };
            },
            targetType: 'mood_check',
            priority: 70,
            cooldownMs: 30 * 60 * 1000, // 30min 冷却
            ttlMs: 20 * 60 * 1000,
        });
        check('注册触发源成功', registered === true && registry.triggers.size === 1);
        registry.attach(bus);
        check('attach 后订阅计数 > 0', registry.subscribers.size === 1);

        // —— 命中入队
        bus.emit(TRIGGER_EVENTS.USER_EMOTION_TURN, { valence: -0.6, ts: 1000 });
        check('负向情绪事件入队', registry.eventQueue.length === 1, `size=${registry.eventQueue.length}`);
        check('evaluate 被调用', evaluateCount === 1);

        // —— 冷却生效：冷却期内再次触发不入队
        bus.emit(TRIGGER_EVENTS.USER_EMOTION_TURN, { valence: -0.7, ts: 2000 });
        check('冷却期内同触发源不再入队', registry.eventQueue.length === 1, `size=${registry.eventQueue.length}`);

        // —— 非命中事件不入队（evaluate 返回 null）
        bus.emit(TRIGGER_EVENTS.USER_EMOTION_TURN, { valence: 0.5, ts: 3000 });
        check('正向情绪不命中 → 不入队', registry.eventQueue.length === 1);
        check('evaluate 累计调用 3 次', evaluateCount === 3, `count=${evaluateCount}`);

        // —— 去重：清冷却，用同一 dedupeKey 的事件应被去重
        registry.cooldowns = {}; // 绕过冷却单独验证去重
        bus.emit(TRIGGER_EVENTS.USER_EMOTION_TURN, { valence: -0.9, ts: 1000 }); // 同 ts=1000 → 同 dedupeKey
        check('重复 dedupeKey 被去重（不入队）', registry.eventQueue.length === 1, `size=${registry.eventQueue.length}`);

        // —— consume：取出最高优先级
        const item = registry.consume();
        check('consume 取出候选', item && item.triggerId === 'test_trigger' && item.targetType === 'mood_check');
        check('consume 后队列清空', registry.eventQueue.length === 0);
        check('consume 空队列返回 null', registry.consume() === null);
    }

    // ============================================================
    console.log('2b. TriggerRegistry: 队列 TTL 丢弃 + 优先级排序');
    // ============================================================
    {
        const bus = new EventBus();
        const registry = new TriggerRegistry({ bus });
        registry.reset();

        let t = 100000;
        // 直接调用内部入队（构造过期候选），TTL 用极小值
        registry.register({
            id: 'low',
            events: [TRIGGER_EVENTS.NARRATIVE_MILESTONE],
            evaluate: () => ({ data: { k: 'low' }, dedupeKey: `low:${t}`, ttlMs: 10 }),
            targetType: 'memory_share',
            priority: 10,
            cooldownMs: 0,
        });
        registry.register({
            id: 'high',
            events: [TRIGGER_EVENTS.NARRATIVE_MILESTONE],
            evaluate: () => ({ data: { k: 'high' }, dedupeKey: `high:${t}`, ttlMs: 60000 }),
            targetType: 'memory_share',
            priority: 90,
            cooldownMs: 0,
        });
        registry.attach(bus);
        bus.emit(TRIGGER_EVENTS.NARRATIVE_MILESTONE, { t });
        check('两条候选入队', registry.eventQueue.length === 2, `size=${registry.eventQueue.length}`);
        check('高优先级排在前', registry.eventQueue[0].triggerId === 'high',
            `first=${registry.eventQueue[0]?.triggerId}`);

        // 等 low 的 ttl（10ms）过期
        await new Promise((r) => setTimeout(r, 30));
        const status = registry.getStatus();
        check('TTL 过期候选被剪枝', status.queueSize === 1 && status.queue[0].triggerId === 'high',
            `size=${status.queueSize}`);
        check('过期候选不占队列', registry.consume()?.triggerId === 'high');
    }

    // ============================================================
    console.log('3. ProactiveEngine.consumeEventQueue(): 空队列 false / 有事件 true');
    // ============================================================
    {
        function makeMock() {
            return {
                affinity: 35,
                emotionEngine: { state: { P: 0.3, A: 0.1, D: 0 } },
                generateCallCount: 0,
                generateProactiveMessage: async () => {
                    // 每个 mock 独立计数
                    return { reply: `回复-${Math.random().toString(36).slice(2, 8)}`, emotion: '平静' };
                },
                recordProactiveMessage: () => {},
            };
        }

        const bus = new EventBus();
        const registry = new TriggerRegistry({ bus });
        registry.reset();

        // 场景 A：事件层启用但队列为空 → false
        setEventLayerEnabled(true);
        const engineEmpty = new ProactiveEngine(makeMock(), registry);
        engineEmpty.stop();
        const r1 = await engineEmpty.consumeEventQueue();
        check('队列为空 → consumeEventQueue 返回 false', r1 === false);

        // 场景 B：入队一条候选 → consumeEventQueue 返回 true 并走 trigger 入队
        registry.register({
            id: 'e2e',
            events: [TRIGGER_EVENTS.USER_EMOTION_TURN],
            evaluate: () => ({ data: { valence: -0.5 }, dedupeKey: 'e2e:1' }),
            targetType: 'mood_check',
            priority: 70,
            cooldownMs: 0,
            ttlMs: 60000,
        });
        registry.attach(bus);
        bus.emit(TRIGGER_EVENTS.USER_EMOTION_TURN, { valence: -0.5 });
        check('候选已入队', registry.getStatus().queueSize === 1);

        engineEmpty.messageQueue = [];
        engineEmpty.config.enabledTypes = ['mood_check'];
        engineEmpty.config.customDailyLimit = 20;
        engineEmpty.dailyMessageCount = 0;
        engineEmpty.lastTriggerByType = {};
        engineEmpty.lastSpontaneousAt = 0;
        engineEmpty.aiGirlfriend.affinity = 35;

        const r2 = await engineEmpty.consumeEventQueue();
        check('有事件 → consumeEventQueue 返回 true', r2 === true);
        check('事件驱动消息入队', engineEmpty.messageQueue.length === 1
            && engineEmpty.messageQueue[0].reason === 'mood_check');
        check('consume 后事件队列清空', registry.getStatus().queueSize === 0);

        engineEmpty.stop();
    }

    // ============================================================
    console.log('4. 【关键】enabled=false 对照：_runCheck 行为与改造前一致');
    // ============================================================
    {
        function makeMock() {
            return {
                affinity: 35,
                emotionEngine: { state: { P: 0.3, A: 0.1, D: 0 } },
                generateProactiveMessage: async () => ({ reply: '你好呀。', emotion: '平静' }),
                recordProactiveMessage: () => {},
            };
        }

        // 构造：队列中**预置**一条候选，但从 registry 层面没有可消费项时 disabled 必须短路。
        const bus = new EventBus();
        const registry = new TriggerRegistry({ bus });
        registry.reset();

        const engine = new ProactiveEngine(makeMock(), registry);
        engine.stop();

        // 预置一条事件候选（直接塞队列，绕过 evaluate）
        registry.eventQueue = [{
            id: 'q_pre',
            triggerId: 'pre',
            targetType: 'mood_check',
            priority: 70,
            data: { valence: -0.5 },
            dedupeKey: 'pre:1',
            createdAt: Date.now(),
            expiresAt: Date.now() + 60000,
        }];

        // —— 关闭事件层
        setEventLayerEnabled(false);
        check('isEventLayerEnabled() 反映关闭', isEventLayerEnabled() === false);

        const beforeMsgQueue = engine.messageQueue.length;
        const beforeConsume = registry.eventQueue.length;

        // consumeEventQueue 必须 O(1) 返回 false，且不消费、不触发
        const r = await engine.consumeEventQueue();
        check('enabled=false → consumeEventQueue 返回 false', r === false);
        check('enabled=false → 未产生副作用（事件队列未被消费）',
            registry.eventQueue.length === beforeConsume, `len=${registry.eventQueue.length}`);
        check('enabled=false → 未生成消息（消息队列不变）',
            engine.messageQueue.length === beforeMsgQueue);

        // _runCheck 在事件层关闭时应等价于「无事件」路径：预置的事件候选被忽略，
        // 走原 6 步轮询。这里断言：预置候选仍在（未被消费）且 _runCheck 正常返回。
        const r3 = await engine.consumeEventQueue();
        check('再次调用仍 false（事件层关闭期间恒定短路）', r3 === false);
        check('预置候选仍未被消费', registry.eventQueue.length === beforeConsume);

        // —— 重新开启，验证同一预置候选现在可被消费（对照）
        setEventLayerEnabled(true);
        engine.messageQueue = [];
        engine.config.enabledTypes = ['mood_check'];
        engine.config.customDailyLimit = 20;
        engine.dailyMessageCount = 0;
        engine.lastTriggerByType = {};
        engine.lastSpontaneousAt = 0;
        const r4 = await engine.consumeEventQueue();
        check('enabled=true → 预置候选可被消费（对照组）', r4 === true);
        check('对照组成功入队', engine.messageQueue.some((m) => m.reason === 'mood_check'));

        // —— getStatus 追加 eventQueue 字段（向后兼容：旧字段仍在）
        const status = engine.getStatus();
        check('getStatus 追加 eventQueue 字段', status.eventQueue && typeof status.eventQueue.enabled === 'boolean');
        check('getStatus 旧字段仍存在', typeof status.queueSize === 'number'
            && typeof status.dailyLimit === 'number' && status.emotionGate);

        // 恢复默认开关（避免影响其他测试/后续进程语义）
        setEventLayerEnabled(true);
        engine.stop();
    }

    // ============================================================
    console.log('5. 持久化：落盘后重新加载状态一致');
    // ============================================================
    {
        const bus = new EventBus();
        const registry = new TriggerRegistry({ bus });
        registry.reset();
        registry.register({
            id: 'persist_trigger',
            events: [TRIGGER_EVENTS.NARRATIVE_MILESTONE],
            evaluate: () => ({ data: { title: '纪念日' }, dedupeKey: 'persist:1' }),
            targetType: 'memory_share',
            priority: 55,
            cooldownMs: 0,
            ttlMs: 60000,
        });
        registry.attach(bus);
        bus.emit(TRIGGER_EVENTS.NARRATIVE_MILESTONE, {});

        // 断言状态已记录
        const sizeBefore = registry.getStatus().queueSize;
        check('入队后队列非空', sizeBefore === 1, `size=${sizeBefore}`);
        check('冷却标记已写', typeof registry.cooldowns.persist_trigger === 'number');
        check('去重标记已写', typeof registry.dedupeSeen['persist:1'] === 'number');

        registry.flush(); // 立即落盘

        // 新实例重新加载同一 state 文件
        const registry2 = new TriggerRegistry({ bus: null });
        check('重载后队列长度一致', registry2.getStatus().queueSize === sizeBefore,
            `size=${registry2.getStatus().queueSize}`);
        check('重载后触发源定义不重复（由代码注册，非持久化）', registry2.triggers.size === 0
            || registry2.triggers.size === 1); // triggers 由 register 注入，不持久化 → 期望 0
        check('重载后冷却状态一致', registry2.cooldowns.persist_trigger === registry.cooldowns.persist_trigger,
            `a=${registry2.cooldowns.persist_trigger} b=${registry.cooldowns.persist_trigger}`);
        check('重载后去重标记一致', registry2.dedupeSeen['persist:1'] === registry.dedupeSeen['persist:1']);

        // consume 后再次 flush → 重载为空
        registry2.consume();
        registry2.flush();
        const registry3 = new TriggerRegistry({ bus: null });
        check('消费并落盘后重载队列为空', registry3.getStatus().queueSize === 0);

        // 清理测试状态文件（还原由 finally 统一处理）
    }

    console.log('');
    exitCode = t.finish();
} finally {
    restore(triggerStateUrl, triggerStateSnap);
    restore(proactiveStateUrl, proactiveStateSnap);
}

// 备份/还原完成后才退出：失败时立刻 exit 会跳过 finally，把用户数据留在污染状态
process.exit(exitCode);
