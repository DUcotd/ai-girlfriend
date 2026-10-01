/**
 * 主动消息类型目录 —— 全项目唯一事实源（2026-09-29 重构）。
 *
 * 重构前同一张表散落在三处，改一个参数要同步改三个文件：
 *   1. ProactiveEngine.baseTriggerCooldowns   （冷却时间）
 *   2. ProactiveEngine.getMessagePriority     （队列优先级）
 *   3. routes/configRoutes.js PROACTIVE_TYPES （给前端设置页的 label/description）
 * 现在只在这里定义一次；ProactiveEngine 与路由都从这里派生。
 *
 * 字段含义：
 *   label        —— 英文短名（对外 API 契约，历史字段，勿改字面量）
 *   labelZh      —— 中文标题（设置页展示）
 *   description  —— 英文说明（对外 API 契约，历史字段，勿改字面量）
 *   schedule     —— 中文「什么时候会发」说明（设置页展示，比 description 更具体）
 *   icon         —— 设置页卡片图标（emoji，纯展示）
 *   group        —— 归属分组 id，见 PROACTIVE_GROUPS
 *   priority     —— 队列优先级，越大越先送达
 *   baseCooldown —— 基础冷却毫秒（frequencyLevel 会按倍率缩放，fixedCooldown 除外）
 *   fixedCooldown—— true 表示冷却不随频率档位缩放（定时问候专属）
 *   window       —— 允许触发的时间窗（当天分钟数，闭区间）；无此字段表示全天可触发
 *   dailyOnce    —— true 表示每天最多发一次（配合 window 做「定时问候」）
 *   ttl          —— 队列存活毫秒：超时未送达即丢弃并退还当日配额
 *   quietExempt  —— true 表示深夜免打扰时段仍可发送
 *   quotaExempt  —— true 表示**不计入每日主动消息配额**（也不退还配额）
 *   minAffinity  —— 触发所需最低好感度；缺省 = 不限。陌生/疏离阶段(0-15)不该主动搭话，
 *                   自发类一律 16（初识解锁），memory_share 50（原 _runCheck 硬编码搬入）
 *   spontaneous  —— true 表示「她自发的社交消息」：受全局自发间隔（SPONTANEOUS_GAP）与
 *                   情绪闸门约束；定时问候/任务提醒不属于此类
 *   defaultEnabled —— 首次运行（未落盘）时的默认勾选状态
 */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** 设置页的类型分组（展示用） */
export const PROACTIVE_GROUPS = [
    { id: 'greeting', label: '每日问候', description: '固定时间的早晚问候' },
    { id: 'care', label: '关心互动', description: '想念、情绪关怀与回忆' },
    { id: 'daily', label: '日常分享', description: '随机闲聊与她的生活动态' },
    { id: 'task', label: '任务提醒', description: '待办到期前的提醒' },
];

/** 分组展示顺序（设置页按此渲染，未列出的分组排在最后） */
export const PROACTIVE_GROUP_ORDER = PROACTIVE_GROUPS.map(g => g.id);

export const PROACTIVE_TYPES = [
    {
        id: 'morning_greeting',
        label: 'Good morning',
        labelZh: '早安问候',
        description: 'Sent at 8 AM',
        schedule: '每天 07:30 – 09:30',
        icon: '🌅',
        group: 'greeting',
        priority: 80,
        baseCooldown: 24 * HOUR,
        fixedCooldown: true,
        window: { from: 7 * 60 + 30, to: 9 * 60 + 30 },
        dailyOnce: true,
        ttl: 2 * HOUR,
        quietExempt: true,
        defaultEnabled: true,
    },
    {
        id: 'night_greeting',
        label: 'Good night',
        labelZh: '晚安问候',
        description: 'Sent at 10 PM',
        schedule: '每天 21:30 – 23:30',
        icon: '🌙',
        group: 'greeting',
        priority: 80,
        baseCooldown: 24 * HOUR,
        fixedCooldown: true,
        window: { from: 21 * 60 + 30, to: 23 * 60 + 30 },
        dailyOnce: true,
        ttl: 90 * MIN,
        quietExempt: true,
        defaultEnabled: true,
    },
    {
        id: 'task_reminder',
        label: 'Task reminder',
        labelZh: '任务提醒',
        description: '15 min before deadline',
        schedule: '待办到期前 15 分钟',
        icon: '📝',
        group: 'task',
        priority: 100,
        // 30min → 5min：去重已交给 Task.reminderState（按「任务 × 提醒类型」记账），
        // 这里的冷却只剩「防同一时刻连发多条」的刷屏作用。
        baseCooldown: 5 * MIN,
        ttl: 15 * MIN,
        quietExempt: true,
        // 用户自己设的提醒不该被「今天主动消息发够了」吃掉（D6）。
        // 与之配套的两处改动在 ProactiveEngine：trigger() 不 ++、_pruneQueue() 不退配额。
        quotaExempt: true,
        defaultEnabled: true,
    },
    {
        id: 'miss_you',
        label: 'Missing you',
        labelZh: '想念消息',
        description: 'Sent when inactive for a while',
        schedule: '你超过 2 小时没出现时（初识后解锁）',
        icon: '💕',
        group: 'care',
        priority: 50,
        baseCooldown: 3 * HOUR,
        ttl: 60 * MIN,
        minAffinity: 16,
        spontaneous: true,
        defaultEnabled: true,
    },
    {
        id: 'mood_check',
        label: 'Mood check',
        labelZh: '情绪关怀',
        description: 'Check in during afternoon/evening',
        schedule: '每天 14:00 – 21:00（初识后解锁）',
        icon: '💝',
        group: 'care',
        priority: 60,
        baseCooldown: 4 * HOUR,
        window: { from: 14 * 60, to: 21 * 60 },
        ttl: 90 * MIN,
        minAffinity: 16,
        spontaneous: true,
        defaultEnabled: true,
    },
    {
        id: 'memory_share',
        label: 'Memory share',
        labelZh: '回忆分享',
        description: 'Share a past memory',
        schedule: '好感度 ≥ 50 后偶尔提起',
        icon: '💭',
        group: 'care',
        priority: 40,
        baseCooldown: 6 * HOUR,
        ttl: 2 * HOUR,
        // 原 _runCheck 里的 `(affinity ?? 0) >= 50` 硬编码，统一搬进类型表
        minAffinity: 50,
        spontaneous: true,
        defaultEnabled: true,
    },
    {
        id: 'random_chat',
        label: 'Random chat',
        labelZh: '随机闲聊',
        description: 'Spontaneous chat',
        schedule: '随时，每 30 分钟评估一次（初识后解锁）',
        icon: '✨',
        group: 'daily',
        priority: 30,
        baseCooldown: 2 * HOUR,
        ttl: 45 * MIN,
        minAffinity: 16,
        spontaneous: true,
        defaultEnabled: true,
    },
    {
        id: 'life_update',
        label: 'Life update',
        labelZh: '生活分享',
        description: 'What I was doing while you were away',
        schedule: '你离开一段时间又回来时（初识后解锁）',
        icon: '🌸',
        group: 'daily',
        priority: 20,
        baseCooldown: 30 * MIN,
        ttl: 45 * MIN,
        minAffinity: 16,
        spontaneous: true,
        defaultEnabled: true,
    },
    // ==================== 事件驱动类型（REQ-04，仅追加，旧 8 类一字未动） ====================
    // 这些类型由 TriggerRegistry 的事件触发源命中后，经 ProactiveEngine.consumeEventQueue()
    // → trigger() 全闸门触达。eventDriven=true 标记其来源为事件层（供前端/状态区分）。
    // 均为 spontaneous：同样受情绪闸门、自发全局间隔、相似度去重约束（保守，不破坏现有经济模型）。
    {
        id: 'emotion_resonance',
        label: 'Emotion resonance',
        labelZh: '情绪共振',
        description: 'Reach out right after an emotional turn',
        schedule: '当察觉到你情绪显著转负时（事件驱动）',
        icon: '💗',
        group: 'care',
        priority: 75,
        baseCooldown: 30 * MIN,
        ttl: 20 * MIN,
        minAffinity: 16,
        spontaneous: true,
        eventDriven: true,
        defaultEnabled: true,
    },
    {
        id: 'anniversary_recall',
        label: 'Anniversary recall',
        labelZh: '纪念日回顾',
        description: 'Recall a shared anniversary that is coming up',
        schedule: '临近共同纪念日时（事件驱动，好感度 ≥ 50）',
        icon: '🎂',
        group: 'care',
        priority: 58,
        baseCooldown: 6 * HOUR,
        ttl: 2 * HOUR,
        minAffinity: 50,
        spontaneous: true,
        eventDriven: true,
        defaultEnabled: true,
    },
    {
        id: 'promise_followup',
        label: 'Promise follow-up',
        labelZh: '约定跟进',
        description: 'Gently follow up on a promise you made together',
        schedule: '约定的跟进时机到来时（事件驱动，好感度 ≥ 16）',
        icon: '🤙',
        group: 'care',
        priority: 62,
        baseCooldown: 2 * HOUR,
        ttl: 60 * MIN,
        minAffinity: 16,
        spontaneous: true,
        eventDriven: true,
        defaultEnabled: true,
    },
];

/** 全部类型 id（校验 enabledTypes 用） */
export const PROACTIVE_TYPE_IDS = PROACTIVE_TYPES.map(t => t.id);

/** 首次运行的默认勾选集合 */
export const DEFAULT_ENABLED_TYPES = PROACTIVE_TYPES
    .filter(t => t.defaultEnabled)
    .map(t => t.id);

/** 单个类型的兜底默认值（未知 reason 时使用） */
export const FALLBACK_TYPE = {
    id: 'random_chat',
    label: 'Random chat',
    labelZh: '随机闲聊',
    description: 'Spontaneous chat',
    schedule: '随时',
    icon: '✨',
    group: 'daily',
    priority: 20,
    baseCooldown: 2 * HOUR,
    ttl: 60 * MIN,
    quietExempt: false,
    // 未知 reason 一律按「占配额」处理（保守方向：宁可少发，不可超发）
    quotaExempt: false,
    // 未知 reason 按随机闲聊的保守口径：同样吃 minAffinity / 自发间隔 / 情绪闸门
    minAffinity: 16,
    spontaneous: true,
    defaultEnabled: true,
};

/** 按 id 取类型定义，未知 id 返回 null */
export function getProactiveType(id) {
    return PROACTIVE_TYPES.find(t => t.id === id) || null;
}

/**
 * 类型定义 → 对外 API 形状（设置页消费）。
 * 与重构前的 { id, label, description } 完全兼容，只做字段追加。
 */
export function toPublicTypeInfo(type) {
    return {
        id: type.id,
        label: type.label,
        labelZh: type.labelZh,
        description: type.description,
        schedule: type.schedule,
        icon: type.icon,
        group: type.group,
        defaultEnabled: !!type.defaultEnabled,
    };
}
