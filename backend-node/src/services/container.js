/**
 * 服务容器 - 集中创建并持有所有单例服务。
 * 路由层从这里取服务，不再各自实例化。
 *
 * REQ-04 事件层装配顺序（侵入点 I18，必须严格遵守）：
 *   EventBus → TriggerRegistry → (触发源注册) → ProactiveEngine(registry)
 * 顺序错会导致「事件发布出去但无人订阅」——事件层静默失效。
 */
import AiGirlfriend from '../core/AiGirlfriend.js';
import VoiceEngine from '../core/Voice.js';
import ProactiveEngine from '../core/ProactiveEngine.js';
import { EventBus } from '../core/EventBus.js';
import TriggerRegistry from '../core/TriggerRegistry.js';
import { emotionTurnTrigger } from '../core/triggers/emotionTurnTrigger.js';
import { anniversaryTrigger } from '../core/triggers/anniversaryTrigger.js';
import { promiseFollowupTrigger } from '../core/triggers/promiseFollowupTrigger.js';
import { stageTransitionTrigger } from '../core/triggers/stageTransitionTrigger.js';
import { migrateLegacyData } from '../utils/jsonStore.js';

// 先迁移旧版散落数据（<repo>/memory_db → backend-node/data），再初始化各服务
migrateLegacyData();

export const aiGirlfriend = new AiGirlfriend();
export const voiceEngine = { current: new VoiceEngine({}) };

export function updateVoiceEngine({ apiKey }) {
    voiceEngine.current.stop?.();
    voiceEngine.current = new VoiceEngine({ apiKey });
}

// ==================== REQ-04 事件层装配 ====================
// ① 事件总线（进程内同步发布订阅，承载情绪转折/叙事里程碑等业务事件）
export const eventBus = new EventBus();

// ② 触发源注册表（触发源元数据唯一事实源为 triggerEvents.js 的 TRIGGER_DEFS）
export const triggerRegistry = new TriggerRegistry({ bus: eventBus });

// ③ 【D-1 修复点】注册 4 个事件触发源：emotion_turn / anniversary / promise_followup /
//    stage_advanced（REQ-06 关系跃迁仪式感）。
//    没有这一步，registry 的 subscribers 为空 → 事件层在生产装配下空转。
//    evaluate 由各触发源模块导出（纯函数），元数据取自 triggerEvents.js。
triggerRegistry.register(emotionTurnTrigger);
triggerRegistry.register(anniversaryTrigger);
triggerRegistry.register(promiseFollowupTrigger);
triggerRegistry.register(stageTransitionTrigger);

// ④ 订阅总线：把注册好的触发源挂到 eventBus 上（emit 时才会真正派发到触发源）
triggerRegistry.attach(eventBus);

// ⑤ 事件发布方接入：AiGirlfriend 持有 eventBus，在后台路径发布业务事件（I16）
if (typeof aiGirlfriend.attachEventBus === 'function') {
    aiGirlfriend.attachEventBus(eventBus);
} else {
    // 降级兼容：旧版 AiGirlfriend 无 attachEventBus 时直接注入字段（发布路径自带可选链）
    aiGirlfriend.eventBus = eventBus;
}

// ⑤·b 反向注入 registry 引用：供 AiGirlfriend.resetAll() 一并清空事件层状态
//     （事件队列/冷却/去重标记，落 data/trigger_state.json）。未注入时 resetAll 跳过该步。
if (typeof aiGirlfriend.attachTriggerRegistry === 'function') {
    aiGirlfriend.attachTriggerRegistry(triggerRegistry);
}

// ⑥ ProactiveEngine 接收 registry（null 时事件层整体降级 no-op，向后兼容）
export const proactiveEngine = new ProactiveEngine(aiGirlfriend, triggerRegistry);

// ⑦ 反向注入 proactiveEngine 引用：让 AiGirlfriend.resetAll() 能清掉主动消息的
//    当日配额/冷却/滞留队列与 LifeSimulator 日志（它挂在 proactiveEngine 上）。
//    未注入时 resetAll 自动跳过这两步，行为同改造前。
if (typeof aiGirlfriend.attachProactiveEngine === 'function') {
    aiGirlfriend.attachProactiveEngine(proactiveEngine);
}

/** 优雅停机：清理所有后台定时器，并把记忆/用户情绪/叙事/事件队列去抖中的待写数据立即落盘 */
export function shutdownServices() {
    proactiveEngine.stop();
    voiceEngine.current.stop?.();
    try {
        aiGirlfriend.memory?.flush();
    } catch (e) {
        console.error(`[Container] Memory flush on shutdown failed: ${e.message}`);
    }
    // 关系叙事层去抖中的待写数据立即落盘（REQ-03，与 memory flush 并列）
    try {
        aiGirlfriend.flushNarratives?.();
    } catch (e) {
        console.error(`[Container] Narrative flush on shutdown failed: ${e.message}`);
    }
    // 用户情绪时间线去抖中的待写数据立即落盘（REQ-01，与 memory/narrative flush 并列）
    try {
        aiGirlfriend.flushUserEmotion?.();
    } catch (e) {
        console.error(`[Container] UserEmotion flush on shutdown failed: ${e.message}`);
    }
    // 事件队列 + 冷却/去重标记落盘（跨重启恢复）
    try {
        triggerRegistry.flush();
    } catch (e) {
        console.error(`[Container] TriggerRegistry flush on shutdown failed: ${e.message}`);
    }
}
