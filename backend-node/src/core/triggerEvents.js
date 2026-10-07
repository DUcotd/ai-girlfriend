/**
 * triggerEvents.js - REQ-04 事件层的**唯一事实源**。
 *
 * 收敛内容（对照 docs/companion-upgrade/02-architecture.md REQ-04 2.4.3）：
 *   1. TRIGGER_EVENTS          —— 事件名枚举（禁止在别处硬编码事件名字面量）
 *   2. TRIGGER_EVENT_SCHEMAS   —— 每种事件的 payload 契约（供发布方与触发源对齐）
 *   3. TRIGGER_DEFS            —— 触发源元数据（id / 订阅事件 / 目标 type / 优先级 / 冷却 / TTL）
 *   4. TRIGGER_REGISTRY_CONFIG —— TriggerRegistry 配置常量块（唯一事实源）
 *
 * 为什么配置常量放这里而不是 config.js：
 *   本次（T03）为规避与其他并行任务改 config.js 的文件冲突，
 *   TriggerRegistry 相关常量统一收敛到本文件并导出；后续 T05 做 config 收口时，
 *   只需从本文件 re-export，不必再改散落的魔法数字。
 *
 * 注意：本文件保持**纯常量/纯函数**，不 import 任何运行时单例，可被测试直接引用。
 */

const SEC = 1000;
const MIN = 60 * SEC;

/**
 * 事件名枚举 —— 全项目事件名的唯一来源。
 * 发布方（AiGirlfriend 等）与订阅方（TriggerRegistry）都必须引用这里的常量。
 */
export const TRIGGER_EVENTS = Object.freeze({
    /** 用户情绪显著转折（valence 由正转负 / intensity 突增），由 UserEmotionEngine 产出 */
    USER_EMOTION_TURN: 'user_emotion_turn',
    /** 叙事里程碑（纪念日 / 约定到期），由 Narrative 层产出（REQ-03 / REQ-05 地基） */
    NARRATIVE_MILESTONE: 'narrative_milestone',
    /**
     * 关系阶段跃迁（REQ-06）：好感度跨过了一条阶段线，由 AiGirlfriend._finalize 发布。
     * 与 NARRATIVE_MILESTONE 的区别是成因 —— 那条是「事情发生了」，这条是「我们变了」。
     */
    STAGE_ADVANCED: 'stage_advanced',
    /** 话题开启（预留，P1 扩展点） */
    TOPIC_OPEN: 'topic_open',
    /** 话题关闭（预留，P1 扩展点） */
    TOPIC_CLOSE: 'topic_close',
});

/** 全部合法事件名的数组形式（校验/遍历用） */
export const TRIGGER_EVENT_NAMES = Object.values(TRIGGER_EVENTS);

/**
 * 事件 payload 契约。
 * 这里只声明**字段名与类型**（供文档化与触发源防御式读取），不做运行时校验器——
 * 发布方是内部模块，契约由类型定义约束即可；多一层校验反而增加 I16 的同步开销。
 * 见 docs/companion-upgrade/02-architecture.md REQ-04 2.4.4「事件 payload 契约」。
 */
export const TRIGGER_EVENT_SCHEMAS = Object.freeze({
    [TRIGGER_EVENTS.USER_EMOTION_TURN]: Object.freeze({
        // 只列关键字段；触发源读取时一律做 typeof 防御，缺失即返回 null
        valence: 'number',     // 当前效价 (PAD 的 P)，范围约 [-1, 1]
        arousal: 'number',     // 当前唤醒度 (PAD 的 A)
        intensity: 'number',   // 情绪强度，范围约 [0, 1]
        label: 'string',       // 中文情绪标签（如「低落」）
        turned: 'boolean',     // 本轮是否判定为「显著转折」
        trend: 'object',       // { avgValence, slope, declining }
        ts: 'number',          // 事件时间戳（毫秒）
    }),
    [TRIGGER_EVENTS.NARRATIVE_MILESTONE]: Object.freeze({
        narrativeId: 'string', // 叙事条目标识
        type: 'string',        // 里程碑类型（如 'anniversary' / 'promise'）
        title: 'string',       // 标题（如「第一次说晚安」）
        occurredAt: 'number',  // 原始事件发生时间（毫秒）
        anniversary: 'boolean',// 是否为周年类里程碑
        // F-5：发布方（AiGirlfriend._publishNarrativeMilestones）发的是 **daysUntil**
        // （还有 daysAgo 只作为兼容别名被 anniversaryTrigger 读）。规格表以前只写 daysAgo，
        // 于是「供发布方与触发源对齐」这句话对不上任何一侧 —— 两个字段都留，注明谁是正主。
        daysUntil: 'number',   // 距纪念日还有几天（0=今天，负=已过）
        daysAgo: 'number',     // 兼容别名：daysUntil 的相反数，消费端两者都认
    }),
    // topic_open / topic_close 为预留事件，payload 暂不定形（P1 扩展）
    [TRIGGER_EVENTS.TOPIC_OPEN]: Object.freeze({}),
    [TRIGGER_EVENTS.TOPIC_CLOSE]: Object.freeze({}),
    [TRIGGER_EVENTS.STAGE_ADVANCED]: Object.freeze({
        fromStage: 'string',   // 跨过之前的阶段名
        fromLabel: 'string',   // 中文标签（陌生/初识/朋友/挚友/恋人）
        toStage: 'string',     // 跨过之后的阶段名
        toLabel: 'string',
        direction: 'string',   // 'up' | 'down'（好感度下降也会跨阶段）
        affinity: 'number',    // 结算后的好感度 0-100
        unlocks: 'array',      // 新阶段解锁的行为（relationshipStages.js 唯一事实源）
        ts: 'number',
    }),
});

/**
 * 触发源元数据 —— 本期实现 3 个（REQ-04 表 2.4.1），扩展点留给 P1。
 *
 * 字段含义（与 TriggerRegistry.register(triggerDef) 的契约一致）：
 *   id          —— 触发源唯一标识
 *   events      —— 订阅的事件名数组（取自 TRIGGER_EVENTS）
 *   targetType  —— 目标 ProactiveEngine type（命中后走 trigger(targetType, data)）
 *   priority    —— 队列优先级，越大越先被 consume（默认值，触发源可在入队时覆盖）
 *   cooldownMs  —— 该触发源的冷却毫秒（冷却期内不再入队）
 *   ttlMs       —— 入队候选的存活毫秒（超时丢弃，不占任何配额）
 *   description —— 中文说明（文档/日志用）
 *
 * 注意：这里的 evaluate（判定函数）**不在本文件实现**——evaluate 依赖具体业务状态，
 * 由 ProactiveEngine.consumeEventQueue() 作为回调注入（见 TriggerRegistry.register）。
 * 本文件只提供「元数据的唯一事实源」，避免把业务判定逻辑耦合进常量文件。
 */
export const TRIGGER_DEFS = Object.freeze({
    /** 用户情绪显著转负 → 触发共情关怀（目标 emotion_resonance 事件驱动类型） */
    EMOTION_TURN: Object.freeze({
        id: 'emotion_turn',
        events: [TRIGGER_EVENTS.USER_EMOTION_TURN],
        targetType: 'emotion_resonance',
        priority: 70,
        cooldownMs: 30 * MIN,
        ttlMs: 20 * MIN,
        description: '用户情绪显著转负 → 共情关怀',
    }),
    /** 共同经历纪念日 → 主动回顾（目标 anniversary_recall 事件驱动类型） */
    ANNIVERSARY: Object.freeze({
        id: 'anniversary',
        events: [TRIGGER_EVENTS.NARRATIVE_MILESTONE],
        targetType: 'anniversary_recall',
        priority: 55,
        cooldownMs: 6 * 60 * MIN,
        ttlMs: 2 * 60 * MIN,
        description: '共同经历纪念日 → 主动回顾',
    }),
    /** 约定类事件到期 → 追问闭环（REQ-05 地基，目标 promise_followup 事件驱动类型） */
    PROMISE_FOLLOWUP: Object.freeze({
        id: 'promise_followup',
        events: [TRIGGER_EVENTS.NARRATIVE_MILESTONE],
        targetType: 'promise_followup',
        priority: 65,
        cooldownMs: 60 * MIN,
        ttlMs: 60 * MIN,
        description: '约定类事件到期 → 追问闭环',
    }),
    /**
     * 关系阶段向上跃迁 → 仪式感确认（REQ-06）。
     *
     * 为什么 TTL 给到 12 h（其余事件类都是 20~60 min）：跃迁是**低频且不过时**的消息，
     * 他半夜睡了，第二天回来她再说「我想了很久，我们好像不一样了」依然成立；
     * 而情绪关怀拖两小时就已经不合时宜了。冷却同量级，防止好感度在阶段线上
     * 来回抖动时她把同一句话反复说。
     */
    STAGE_ADVANCED: Object.freeze({
        id: 'stage_advanced',
        events: [TRIGGER_EVENTS.STAGE_ADVANCED],
        targetType: 'stage_transition',
        priority: 72,
        cooldownMs: 12 * 60 * MIN,
        ttlMs: 12 * 60 * MIN,
        description: '关系跨过新阶段 → 仪式感确认',
    }),
});

/** 全部触发源定义数组（装配时遍历注册） */
export const TRIGGER_DEF_LIST = Object.values(TRIGGER_DEFS);

/**
 * 触发源判定阈值 —— 唯一事实源（禁止在触发源文件里硬编码魔法数字）。
 *
 * 为什么放这里而非 config.js：T03 已把 TriggerRegistry 相关常量收敛到本文件；
 * T04 沿用同一约定，避免改 config.js 造成的跨任务文件冲突（T05 统一收口时再 re-export）。
 */
export const TRIGGER_THRESHOLDS = Object.freeze({
    /** —— emotionTurnTrigger —— */
    emotion: Object.freeze({
        // valence 低于此值才算「负向转折」（结合 turned 标志一起判定）
        negativeValenceMax: -0.3,
        // 趋势下滑（trend.declining）或斜率低于此值时，即使规模不大也放行
        decliningSlopeMax: -0.15,
        // 情绪强度下限：太弱的转折不打扰（0~1）
        minIntensity: 0.4,
    }),
    /** —— anniversaryTrigger —— */
    anniversary: Object.freeze({
        // 查询窗：未来多少天内的纪念日会被 `_publishNarrativeMilestones` 挑出来发成事件
        queryWithinDays: 7,
        // 主动窗：落在提前几天内才真的生成主动消息。
        // 与查询窗**故意不同**（一个决定"她记得"，一个决定"她今天说不说"），
        // 所以必须各自有名有姓；旧写法是两处各写一个裸数字（7 与 3），
        // 改 env 里的 7 完全不影响实际触发（审计 CORE-04）。
        announceWithinDays: 3,
    }),
    /** —— promiseFollowupTrigger —— */
    promise: Object.freeze({
        // 约定类事件在「发生/被记录」后多久进入跟进窗（毫秒）
        followupAfterMs: 24 * 60 * MIN,
        // 超过此年龄的约定不再跟进（避免翻出陈年旧账）
        followupMaxAgeMs: 30 * 24 * 60 * MIN,
        // 单条约定最多跟进几次（防刷屏，配合触发源冷却）
        maxFollowups: 3,
    }),
});


/**
 * TriggerRegistry 配置常量块 —— 唯一事实源。
 *
 * enabled 默认值：从环境变量读取，支持运行时切换（setEventLayerEnabled）。
 *   - TRIGGER_REGISTRY_ENABLED 未设置       → 默认 true（事件层可用，但策略上先观察）
 *   - TRIGGER_REGISTRY_ENABLED='false'      → 默认 false（一键回退纯轮询，零行为变更）
 * 见 docs/companion-upgrade/02-architecture.md REQ-04 2.4.2 高风险点专项缓解策略 2/3。
 */
export const TRIGGER_REGISTRY_CONFIG = Object.freeze({
    /** 事件层总开关（运行时可覆盖，见 setEventLayerEnabled） */
    enabled: process.env.TRIGGER_REGISTRY_ENABLED !== 'false',
    /** 事件队列上限：超出丢优先级最低（同级丢最旧） */
    maxQueueSize: 20,
    /** 去重标记保留窗：dedupeSeen 中超过此年龄的键可被清理，防无限增长 */
    dedupeRetentionMs: 24 * 60 * 60 * SEC,
    /** 持久化去抖间隔：队列/冷却变更合并写盘，禁止每轮全量重写（对照 MemoryStore） */
    flushDebounceMs: 1000,
    /** 状态版本号（写入 data/trigger_state.json，供未来 schema 迁移判断） */
    stateVersion: 1,
});

/** 状态文件名（TriggerRegistry 落盘；唯一事实源） */
export const TRIGGER_STATE_FILE = 'trigger_state.json';

/**
 * 运行时覆盖事件层开关。
 * TriggerRegistry 模块级持有当前值，本文件只提供常量默认值；
 * setter 由 TriggerRegistry 导出，避免多处写同一状态。
 * 此处保留说明性常量，供调用方判断默认策略。
 */
export const TRIGGER_ENABLED_ENV_KEY = 'TRIGGER_REGISTRY_ENABLED';
