/**
 * 任务时间归一化与格式化（任务的唯一时间口径）。
 *
 * 为什么不用 dayjs / date-fns / chrono-node：
 *   这里要覆盖的格式很有限（ISO、`YYYY-MM-DD HH:mm`、`YYYY/MM/DD HH:mm`、带或不带时区），
 *   一个正则文件足够，不值得为它新增依赖（硬约束：本次重构不引新依赖包）。
 *   更重要的是 —— 禁止用 `new Date(str)` 兜底：
 *     ① V8 对非 ISO 字符串的解析是实现相关的，换 Node 版本可能变；
 *     ② "2026-02-31" 会被静默归一化成 3 月 3 日，错误的时间也能"解析成功"；
 *     ③ "15:00" 这种片段在不同引擎下甚至可能落到 2001 年。
 *   所以这里一律：先正则拆字段 → 校验范围 → 构造 → 反查校验（溢出检测）。
 *
 * 约定：
 *   - 内部存储一律 ISO 8601 字符串（UTC，带 Z），见 jsonStore 落盘。
 *   - 展示一律本地时区。
 *   - 无时区的输入按本机时区解释（前后端同机部署）。
 */

/** LLM 只给日期、不给时刻时补的本地时间（Q1：视为「当天结束前」）。一行可调。 */
export const DEFAULT_DATE_TIME = { hour: 23, minute: 59, second: 0 };

// `2026-10-01T15:00` / `2026-10-01 15:00:30.5Z` / `2026-10-01T15:00:00+08:00` / `...-0800`
const RE_ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?\s*(Z|z|[+-]\d{2}:?\d{2})?$/;

// `2026-10-01 15:00` / `2026/10/01 15:00`（`-` 与 `/` 允许混用）/ 纯日期 `2026-10-01`
const RE_LOCAL = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,3})?)?$/;

// 只有时刻：`15:00` / `15:00:30` → 取当天
const RE_TIME_ONLY = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/**
 * 任意输入 → Date。无法识别返回 null。
 *
 * @param {Date|number|string} value
 * @returns {Date|null}
 */
export function toDate(value) {
    if (value instanceof Date) {
        return Number.isFinite(value.getTime()) ? value : null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return new Date(value);
    }
    if (typeof value === 'string' && value.trim()) {
        const parsed = parseDueTime(value);
        if (parsed.ok) return new Date(parsed.iso);
        const epoch = Date.parse(value);
        return Number.isFinite(epoch) ? new Date(epoch) : null;
    }
    return null;
}

/**
 * 日历字段 → 本地时区 Date。越界返回 null（不做 Date 的静默归一化）。
 *
 * @returns {Date|null}
 */
function buildLocalDate(year, month, day, hour, minute, second) {
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > 31) return null;
    if (hour < 0 || hour > 23) return null;
    if (minute < 0 || minute > 59) return null;
    if (second < 0 || second > 59) return null;

    const dt = new Date(year, month - 1, day, hour, minute, second, 0);
    // 反查溢出：2026-02-31 → 3 月 3 日，必须判为非法
    if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) return null;
    if (dt.getHours() !== hour || dt.getMinutes() !== minute) return null;
    return dt;
}

/**
 * 时区偏移文本 → 分钟。`Z`/省略 → 0（省略表示「按本机时区」，由调用方决定）。
 *
 * @returns {number|null} null 表示偏移文本非法
 */
function parseOffset(text) {
    if (!text) return 0;
    if (text === 'Z' || text === 'z') return 0;
    const m = /^([+-])(\d{2}):?(\d{2})$/.exec(text);
    if (!m) return null;
    const minutes = Number(m[2]) * 60 + Number(m[3]);
    if (minutes > 14 * 60) return null;
    return (m[1] === '-' ? -1 : 1) * minutes;
}

/**
 * 把各种写法的时间归一化成 ISO 8601 字符串。
 *
 * 支持：
 *   带时区  `2026-10-01T15:00:00+08:00` / `...Z` / `...-0800`
 *   不带时区 `2026-10-01T15:00` / `2026-10-01 15:00` / `2026/10/01 15:00`（`-`/`/` 可混用）
 *   纯日期   `2026-10-01`      → 补本地 23:59（DEFAULT_DATE_TIME）
 *   纯时刻   `15:00`           → 补当天日期
 *   Date 实例 / epoch 毫秒
 *
 * 设计决策（D4）：解析失败**不算致命错误**，调用方应保留任务本身并回 reason:"bad_due_time"。
 *
 * @param {Date|number|string|null|undefined} input
 * @returns {{ok: boolean, iso?: string, error?: 'empty'|'unparseable'|'invalid'}}
 */
export function parseDueTime(input) {
    if (input === null || input === undefined) return { ok: false, error: 'empty' };
    if (typeof input === 'string' && input.trim() === '') return { ok: false, error: 'empty' };

    if (input instanceof Date) {
        return Number.isFinite(input.getTime())
            ? { ok: true, iso: input.toISOString() }
            : { ok: false, error: 'invalid' };
    }
    if (typeof input === 'number') {
        if (!Number.isFinite(input)) return { ok: false, error: 'invalid' };
        const fromNumber = new Date(input);
        return Number.isFinite(fromNumber.getTime())
            ? { ok: true, iso: fromNumber.toISOString() }
            : { ok: false, error: 'invalid' };
    }
    if (typeof input !== 'string') return { ok: false, error: 'unparseable' };

    const text = input.trim();

    // ---- ① ISO（含可选时区），也吞下 "2026-10-01 15:00" 这种空格分隔的 ISO 变体 ----
    const iso = RE_ISO.exec(text);
    if (iso) {
        const [, ys, mos, ds, hs, mis, ss, , offsetText] = iso;
        const year = Number(ys);
        const month = Number(mos);
        const day = Number(ds);
        const hour = Number(hs);
        const minute = Number(mis);
        const second = ss ? Number(ss) : 0;

        const offsetMinutes = parseOffset(offsetText);
        if (offsetMinutes === null) return { ok: false, error: 'unparseable' };

        if (offsetText) {
            // 显式时区：由 UTC 日历字段减去偏移得到真实时刻
            if (month < 1 || month > 12 || day < 1 || day > 31) return { ok: false, error: 'invalid' };
            if (hour > 23 || minute > 59 || second > 59) return { ok: false, error: 'invalid' };
            const utcMs = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000;
            const dt = new Date(utcMs);
            if (!Number.isFinite(dt.getTime())) return { ok: false, error: 'invalid' };
            const back = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
            // 反查溢出
            if (back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
                return { ok: false, error: 'invalid' };
            }
            return { ok: true, iso: dt.toISOString() };
        }
        // 无时区：YYYY-MM-DD 的 ISO 形式（仅 `-` 分隔）按 V8 语义是 UTC，
        // 但用户/LLM 的意图是「我这边的时间」，故统一按本地时区解释，避免差 8 小时。
        const dt = buildLocalDate(year, month, day, hour, minute, second);
        return dt ? { ok: true, iso: dt.toISOString() } : { ok: false, error: 'invalid' };
    }

    // ---- ② 本地日期时间 / 纯日期（`-` 与 `/` 混用）----
    const local = RE_LOCAL.exec(text);
    if (local) {
        const [, ys, mos, ds, hs, mis, ss] = local;
        const hasTime = hs !== undefined;
        const dt = buildLocalDate(
            Number(ys), Number(mos), Number(ds),
            hasTime ? Number(hs) : DEFAULT_DATE_TIME.hour,
            hasTime ? Number(mis) : DEFAULT_DATE_TIME.minute,
            hasTime && ss ? Number(ss) : DEFAULT_DATE_TIME.second
        );
        return dt ? { ok: true, iso: dt.toISOString() } : { ok: false, error: 'invalid' };
    }

    // ---- ③ 纯时刻：落到当天 ----
    const timeOnly = RE_TIME_ONLY.exec(text);
    if (timeOnly) {
        const [, hs, mis, ss] = timeOnly;
        const today = new Date();
        const dt = buildLocalDate(
            today.getFullYear(), today.getMonth() + 1, today.getDate(),
            Number(hs), Number(mis), ss ? Number(ss) : 0
        );
        return dt ? { ok: true, iso: dt.toISOString() } : { ok: false, error: 'invalid' };
    }

    return { ok: false, error: 'unparseable' };
}

/** 当天 00:00:00.000（本地时区） */
export function startOfLocalDay(d = new Date()) {
    const ref = toDate(d) || new Date();
    return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), 0, 0, 0, 0);
}

/** 当天 23:59:59.999（本地时区） */
export function endOfLocalDay(d = new Date()) {
    const ref = toDate(d) || new Date();
    return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), 23, 59, 59, 999);
}

/** 两个时间点是否落在同一个本地自然日 */
export function isSameLocalDay(a, b) {
    const da = toDate(a);
    const db = toDate(b);
    if (!da || !db) return false;
    return startOfLocalDay(da).getTime() === startOfLocalDay(db).getTime();
}

/** 当天分钟数（0 ~ 1439），用于时间窗判断 */
export function minutesOfDay(d = new Date()) {
    const ref = toDate(d) || new Date();
    return ref.getHours() * 60 + ref.getMinutes();
}

/** 跨了几个本地自然日（b - a），同一天为 0 */
function localDayDiff(a, b) {
    return Math.round((startOfLocalDay(b).getTime() - startOfLocalDay(a).getTime()) / 86_400_000);
}

/**
 * 任务到期时间的紧凑展示（本地时区）。
 *
 * @param {Date|number|string|null} iso - ISO 8601（兼容 Case：任何 parseDueTime 能吃的写法）
 * @param {Date|number|string} [now] - 基准时刻，默认当下；不要在调用方缓存 new Date()
 * @returns {string} `今日 18:00` | `明天 09:00` | `昨天 09:00` | `10月1日 15:00` | `2027年1月3日 09:00` | `无时间`
 */
export function formatTaskDue(iso, now = new Date()) {
    const d = toDate(iso);
    if (!d) return '无时间';
    const ref = toDate(now) || new Date();
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

    const diff = localDayDiff(ref, d);
    if (diff === 0) return `今日 ${hhmm}`;
    if (diff === 1) return `明天 ${hhmm}`;
    if (diff === -1) return `昨天 ${hhmm}`;

    if (d.getFullYear() !== ref.getFullYear()) {
        return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
    }
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
}
