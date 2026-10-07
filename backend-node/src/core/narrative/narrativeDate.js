/**
 * narrativeDate —— 共同经历「发生日期」的唯一解析口径（最后一轮打磨，F-1）。
 *
 * 这里为什么会存在：抽取 prompt 第 9 条要求模型「给出 occurredAt，格式 YYYY-MM-DD」，
 * 而抽取层写的是 `Number.isFinite(add.occurredAt) ? add.occurredAt : Date.now()` ——
 * 日期字符串永远不是有限数，于是**每一句「我们是 2025 年 3 月认识的」都被静默换成「今天」**，
 * 纪念日、`formatDate` 注入的日期、`daysUntilAnniversary` 全按抽取当天起步。
 * B4 修的是「让模型说日期」，这一格修的是「让人听得懂模型说的日期」。
 *
 * 三条设计约束：
 * ① **本地日历优先**：`2025-03-08` 必须解析成本地 3 月 8 日 00:00。
 *    直接用 `new Date('2025-03-08')` 会按 UTC 零点算，在 UTC- 时区回退成前一天 ——
 *    纪念日的「今天/明天」判定错一天就是当天下不了台的错。
 * ② **宁可标"大概"，不要假装有精确日期**：解析不出来才回落 now，
 *    并把来源透出成 `source`，让上层与界面能说清「这个日期是她记得的，还是她猜的」。
 * ③ **纯函数**：不读文件、不 import config，时间从参数注入，便于逐格断言。
 */

/** 来源标记：界面与 prompt 用它区分「她记得日子」与「她只知道是最近」。 */
export const DATE_SOURCE = {
    /** 明确写出的年/月/日（ISO、YYYY-MM-DD、2025年3月8日、3月8日…） */
    stated: 'stated',
    /** 由「今天 / 三天前 / 下个月」这类相对说法推出 */
    relative: 'relative',
    /** 只给了月和日 → 年份按「不超过今天」的最近一年补 */
    monthDay: 'month-day',
    /** 解析失败，回落成抽取当天 */
    fallback: 'fallback',
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** 未来上界：约定/计划可以是明天、明年，但不许是「公元前」和「三百年后」这种幻觉 */
const MAX_FUTURE_DAYS = 366 * 20;
/** 过去上界：100 年，超过即判定为编造 */
const MAX_PAST_DAYS = 366 * 100;

const CN_NUM = {
    零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
    十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18, 十九: 19, 二十: 20,
};

/** 「三」「12」「十二」→ 数字；解析不出来返回 NaN。 */
function toNumber(raw) {
    if (raw === undefined || raw === null || raw === '') return NaN;
    if (/^\d+$/.test(raw)) return Number(raw);
    if (Object.prototype.hasOwnProperty.call(CN_NUM, raw)) return CN_NUM[raw];
    // 「二十一」「二十三」这类组合中文数字
    const tens = /^十([一二三四五六七八九])?$/.exec(raw);
    if (tens) return 10 + (tens[1] ? CN_NUM[tens[1]] : 0);
    const compound = /^([一二三四五六七八九])十([一二三四五六七八九])?$/.exec(raw);
    if (compound) return CN_NUM[compound[1]] * 10 + (compound[2] ? CN_NUM[compound[2]] : 0);
    return NaN;
}

function startOfDay(localDate) {
    return new Date(localDate.getFullYear(), localDate.getMonth(), localDate.getDate()).getTime();
}

/** 把「年 / 月 / 日」按本地日历拼成 ms；缺日按 1 号。非法（2 月 30 日之外的怪值）由调用方复核。 */
function compose(year, month, day = 1) {
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
    const d = Number.isFinite(day) ? day : 1;
    if (d < 1 || d > 31) return null;
    const probe = new Date(year, month - 1, d);
    // Date 会把 2 月 30 日顺延成 3 月 1 日 —— 那是模型编造的日子，不接受
    if (probe.getMonth() !== month - 1 || probe.getDate() !== d) return null;
    return { ms: probe.getTime(), year, month, day: d };
}

/**
 * 解析一个「发生日期」。
 *
 * @param {unknown} value LLM 给的原值（字符串 / 数字 / 空）
 * @param {{now?:number}} [opts] now：基准时间（ms），默认 Date.now()
 * @returns {{occurredAt:number|null, source:string}}
 */
export function normalizeNarrativeDate(value, { now = Date.now() } = {}) {
    const base = Number.isFinite(now) ? now : Date.now();
    const accept = (ms, source) => {
        if (!Number.isFinite(ms)) return { occurredAt: null, source: DATE_SOURCE.fallback };
        const days = (ms - base) / DAY_MS;
        if (days > MAX_FUTURE_DAYS || days < -MAX_PAST_DAYS) {
            return { occurredAt: null, source: DATE_SOURCE.fallback };
        }
        return { occurredAt: ms, source };
    };

    // ---- 数字：模型偶尔直接给 epoch ----
    if (typeof value === 'number' && Number.isFinite(value)) {
        // 1e11 ms ≈ 1973 年，真实 ms 一定大于它；秒级时间戳（1.7e9）落在这条以下。
        // 小于 1e9（=2001-09 之前）的一律当垃圾：模型写的「7」「0」是缺省值不是日期，
        // 把它升位成 ms 会得出 1970 年，看起来合法、实际上纯属编造。
        if (value < 1e9) return { occurredAt: null, source: DATE_SOURCE.fallback };
        const ms = value >= 1e11 ? value : value * 1000;
        return accept(ms, DATE_SOURCE.stated);
    }

    if (typeof value !== 'string') return { occurredAt: null, source: DATE_SOURCE.fallback };
    const text = value.trim();
    if (!text) return { occurredAt: null, source: DATE_SOURCE.fallback };

    const today = new Date(base);

    // ---- 相对说法（先于绝对日期判：「3天后」里的数字不该被当成 3 号）----
    const nowCn = { y: today.getFullYear(), m: today.getMonth() + 1, d: today.getDate() };
    if (/今天|今日/.test(text)) return accept(startOfDay(new Date(nowCn.y, nowCn.m - 1, nowCn.d)), DATE_SOURCE.relative);
    if (/明天|明日/.test(text)) return accept(startOfDay(new Date(nowCn.y, nowCn.m - 1, nowCn.d + 1)), DATE_SOURCE.relative);
    if (/后天/.test(text)) return accept(startOfDay(new Date(nowCn.y, nowCn.m - 1, nowCn.d + 2)), DATE_SOURCE.relative);
    if (/昨天|昨日/.test(text)) return accept(startOfDay(new Date(nowCn.y, nowCn.m - 1, nowCn.d - 1)), DATE_SOURCE.relative);
    if (/前天/.test(text)) return accept(startOfDay(new Date(nowCn.y, nowCn.m - 1, nowCn.d - 2)), DATE_SOURCE.relative);
    // 只有「年/月」跨度的说法：日子沿用今天（「去年我们去了海边」→ 去年今天，够准；
    // 再细就只能问用户，而她追问「是哪天来着」本身就是拟人化的一部分，不是这里该编的）
    const yearWord = { 去年: -1, 前年: -2, 明年: 1, 后年: 2 }[text.match(/去年|前年|明年|后年/)?.[0] ?? ''];
    if (yearWord !== undefined) {
        return accept(startOfDay(new Date(nowCn.y + yearWord, nowCn.m - 1, nowCn.d)), DATE_SOURCE.relative);
    }
    const monthWord = { 上个月: -1, 上月: -1, 下个月: 1, 下月: 1 }[(text.match(/上个月|上月|下个月|下月/) || [])[0] ?? ''];
    if (monthWord !== undefined) {
        return accept(startOfDay(new Date(nowCn.y, nowCn.m - 1 + monthWord, nowCn.d)), DATE_SOURCE.relative);
    }
    // 相对量：「三天前 / 12天前 / 两周前 / 3个月前 / 一年后」。单位与前后方向必须成对出现才算数。
    const rel = /([零一二两三四五六七八九十百\d]+)\s*(?:个)?([天周月年])(前|后)/.exec(text);
    if (rel) {
        const n = toNumber(rel[1]);
        if (Number.isFinite(n) && n >= 0) {
            const sign = rel[3] === '前' ? -1 : 1;
            const anchor = new Date(nowCn.y, nowCn.m - 1, nowCn.d);
            if (rel[2] === '天') anchor.setDate(anchor.getDate() + sign * n);
            else if (rel[2] === '周') anchor.setDate(anchor.getDate() + sign * n * 7);
            else if (rel[2] === '月') anchor.setMonth(anchor.getMonth() + sign * n);
            else anchor.setFullYear(anchor.getFullYear() + sign * n);
            return accept(startOfDay(anchor), DATE_SOURCE.relative);
        }
    }

    // ---- 带年份：2025-03-08 / 2025/3/8 / 2025年3月8日 / 2025-03 ----
    const ymd = text.match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
    if (ymd) {
        const c = compose(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
        if (c) {
            // 带时分（ISO datetime）时按它给的时刻，否则按本地 00:00
            const hm = text.match(/[T ](\d{1,2}):(\d{2})/);
            const ms = hm ? new Date(c.year, c.month - 1, c.day, Number(hm[1]), Number(hm[2])).getTime() : c.ms;
            return accept(ms, DATE_SOURCE.stated);
        }
    }
    const ym = text.match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*月?$/);
    if (ym) {
        const c = compose(Number(ym[1]), Number(ym[2]), 1);
        if (c) return accept(c.ms, DATE_SOURCE.stated);
    }

    // ---- 只有年月日里的「月日」：2025年3月8日 已上面覆盖，这里接 3月8日 / 3-8 / 03-08 ----
    const md = text.match(/^(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*[日号]?$/)
        || text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
    if (md) {
        const month = Number(md[1]);
        const day = Number(md[2]);
        // 今年的 MM-DD 若还在未来，说明说的是去年（「3月8日认识的」在 10 月讲 → 今年的 3-8 已经过去，没问题；
        // 反过来 12 月说「1月2日」→ 那是今年还没到的日子，更可能是**去年**）
        for (const year of [nowCn.y, nowCn.y - 1]) {
            const c = compose(year, month, day);
            if (!c) continue;
            if (c.ms <= base + DAY_MS) return accept(c.ms, DATE_SOURCE.monthDay);
        }
        const c = compose(nowCn.y, month, day);
        if (c) return accept(c.ms, DATE_SOURCE.monthDay);
    }

    // ---- 兜底：英文月名 / 「2025年3月」这类 Date 认得的写法 ----
    // 但**先拒绝「年月日三件套齐全却非法」**（2025-02-30）：Date 会把它顺延成 3 月 2 日，
    // 于是模型编的日子被静默洗成了一个看起来合法的日期 —— 纪念日宁可不知道，也不能记错。
    if (/\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}/.test(text)) {
        return { occurredAt: null, source: DATE_SOURCE.fallback };
    }
    if (/\d{4}/.test(text) && text.length >= 8) {
        const parsed = Date.parse(text);
        if (Number.isFinite(parsed)) return accept(parsed, DATE_SOURCE.stated);
    }

    return { occurredAt: null, source: DATE_SOURCE.fallback };
}

/**
 * 归一化「这条叙事的日期到底可不可信」。
 * 供 store 落盘与界面展示共用，避免「来源标记」在两处各写一套。
 * @param {unknown} value
 * @param {{now?:number}} [opts]
 * @returns {{occurredAt:number, source:string}} 一定返回可用时间戳（解析失败回落 now）
 */
export function resolveNarrativeDate(value, opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const r = normalizeNarrativeDate(value, { now });
    if (r.occurredAt === null) return { occurredAt: now, source: DATE_SOURCE.fallback };
    return { occurredAt: r.occurredAt, source: r.source };
}

export { DAY_MS };
