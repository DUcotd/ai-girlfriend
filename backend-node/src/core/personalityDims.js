/**
 * 小爱性格的 7 维元数据——全项目唯一真源。
 *
 * 数组顺序同时决定 API、提示词和前端展示顺序，其他模块不得重复维护维度顺序。
 */
export const PERSONALITY_DIMS = [
    {
        key: 'independence',
        label: '独立性',
        low: '黏人、想时刻在一起',
        high: '独立、有自己的空间',
        shiftUp: '更独立了',
        shiftDown: '更黏人了',
        order: 1,
    },
    {
        key: 'willfulness',
        label: '任性度',
        low: '听话、很少反驳',
        high: '有主见、爱使小性子',
        shiftUp: '更有主见了',
        shiftDown: '更听话了',
        order: 2,
    },
    {
        key: 'sensitivity',
        label: '敏感度',
        low: '钝感、不容易多想',
        high: '敏感、容易受伤',
        shiftUp: '更敏感了',
        shiftDown: '更钝感了',
        order: 3,
    },
    {
        key: 'security',
        label: '安全感',
        low: '患得患失、怕被冷落',
        high: '笃定安心、不焦虑',
        shiftUp: '更安心了',
        shiftDown: '更不安了',
        order: 4,
    },
    {
        key: 'affection',
        label: '表达欲',
        low: '内敛、感情藏心里',
        high: '主动表达、热情外放',
        shiftUp: '更爱表达了',
        shiftDown: '更内敛了',
        order: 5,
    },
    {
        key: 'playfulness',
        label: '俏皮度',
        low: '认真稳重、很少开玩笑',
        high: '调皮、爱开玩笑、鬼灵精怪',
        shiftUp: '更俏皮了',
        shiftDown: '更稳重了',
        order: 6,
    },
    {
        key: 'trust',
        label: '信任度',
        low: '戒备、保持距离',
        high: '信任、愿意托付',
        shiftUp: '更信任你了',
        shiftDown: '更有戒备了',
        order: 7,
    },
];

/** 固定顺序的维度 key。 */
export const DIM_KEYS = PERSONALITY_DIMS.map((dimension) => dimension.key);

/** 维度中文名索引。 */
export const DIM_LABELS = Object.fromEntries(
    PERSONALITY_DIMS.map((dimension) => [dimension.key, dimension.label]),
);

/** 默认预设「温柔」的性格值，也是坏存档的兜底值。 */
export const DEFAULT_TRAITS = {
    independence: 50,
    willfulness: 30,
    sensitivity: 55,
    security: 65,
    affection: 60,
    playfulness: 45,
    trust: 60,
};

/**
 * 判断字符串是否是合法性格维度。
 * @param {unknown} key 待判断值
 * @returns {boolean}
 */
export function isDimKey(key) {
    return typeof key === 'string' && DIM_KEYS.includes(key);
}

/**
 * 创建覆盖全部维度的新对象。
 * @param {number} fill 每个维度的初始值
 * @returns {Record<string, number>}
 */
export function emptyTraits(fill = 50) {
    const value = Number.isFinite(fill) ? fill : 50;
    return Object.fromEntries(DIM_KEYS.map((key) => [key, value]));
}
