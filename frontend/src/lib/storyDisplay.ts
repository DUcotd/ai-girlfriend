/**
 * 「我们的故事」（REQ-03 共同经历叙事）的展示格式化（纯函数，便于确定性测试）。
 *
 * 为什么要单独成文件：后端 `GET /state/narratives` 的 `type` 只给英文枚举值，
 * 中文标签与图标必须由前端映射才能给人看；而日期/回忆次数这些换算一旦写进组件
 * 就没法在没有后端的情况下验证（本项目的所有跨端换算都有过「写了没接线」的前科）。
 *
 * ⚠️ 时间戳口径：叙事的 occurredAt / createdAt / updatedAt / lastRecalledAt 是 epoch **毫秒**
 * （NarrativeStore.normalizeNarrative 取 Date.now()），而 `GET /memories` 的
 * episodes.timestamp 是**秒**。两套口径共存于同一个弹窗，所以本文件的每个换算都先过
 * `toMillis()`，而不是假定调用方给对了单位。
 *
 * 类型镜像表由 `__tests__/storyDisplay.test.ts` 直接 import 后端
 * `core/narrative/narrativeTypes.js` 逐键比对钉住 —— 抄写清单是这个项目最容易漂移的东西
 * （同类守卫见 baseUrlGrade / errorCodes / proactiveDefaults）。
 */
import type { NarrativeDateSource, NarrativeItem } from "@/types";

/**
 * 叙事类型 → 中文标签 + 图标。
 * key 与 label 必须与后端 NARRATIVE_TYPES 的 `label` / `labelZh` 一一对应（测试钉住）；
 * emoji 是纯展示装饰，后端没有对应字段，因此只此一份、不参与跨端比对。
 */
export const STORY_TYPE_META: Record<string, { label: string; emoji: string }> = {
    first_time: { label: "第一次", emoji: "🌱" },
    anniversary: { label: "纪念日", emoji: "🎂" },
    promise: { label: "约定", emoji: "🤝" },
    inside_joke: { label: "专属梗", emoji: "😆" },
    milestone: { label: "关系里程碑", emoji: "💞" },
    shared_event: { label: "共同经历", emoji: "✨" },
};

/** 后端 normalizeNarrativeType 的兜底类型（脏数据/老数据没 type 时按它显示，不显示空白） */
export const DEFAULT_STORY_TYPE = "shared_event";

/** 类型元数据：未知类型回落到默认类型（后端存盘前也做同样的归一，两侧结论一致） */
export function storyTypeMeta(type: string | null | undefined): { label: string; emoji: string } {
    return STORY_TYPE_META[type ?? ""] ?? STORY_TYPE_META[DEFAULT_STORY_TYPE];
}

/**
 * 秒/毫秒归一到毫秒。
 *
 * 判据是量级而不是「配置项」：真正的毫秒时间戳在 2001 年之后恒 > 1e12，
 * 秒时间戳要到公元 5138 年才会越过 1e11，两条区间现实中不可能重叠。
 * 没有这层校正，把 episodes 的秒值误传进来会显示成 1970-01-20 —— 时间错得离谱、
 * 看上去却像正常日期，用户根本发现不了。
 */
function toMillis(ts: number | null | undefined): number | null {
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return null;
    return ts < 1e11 ? ts * 1000 : ts;
}

/** 毫秒（或误传的秒）→ 本地时区「YYYY-MM-DD」；无有效时间返回空串，界面据此省略这一段 */
/**
 * 她「真的知道日子」的来源白名单。与后端 narrativePrompt.js 的 TRUSTED_DATE_SOURCES
 * 同一口径（跨端测试逐值比对）——两边不一致的后果是：界面显示一个日期、
 * 而她自己在对话里从不提，用户会以为她记错了。
 */
export const TRUSTED_DATE_SOURCES: readonly NarrativeDateSource[] = ["stated", "relative", "month-day"];

/**
 * 故事日期（只在来源可信时给）。
 *
 * 为什么不能直接用 formatStoryDate(occurredAt)：后端在模型没给出可解析日期时
 * 会把 occurredAt 补成「抽取当天」，那个数字永远存在、永远看起来正常 ——
 * 但它不是她的回忆，只是这条记录的入库时间。显示出来等于替她编了一个日子。
 */
export function storyDateLine(n: Pick<NarrativeItem, "occurredAt" | "occurredAtSource">): string {
    if (!n || TRUSTED_DATE_SOURCES.indexOf(n.occurredAtSource ?? ("fallback" as NarrativeDateSource)) === -1) return "";
    return formatStoryDate(n.occurredAt);
}

export function formatStoryDate(ts: number | null | undefined): string {
    const ms = toMillis(ts);
    if (ms === null) return "";
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 相对时间（以 now 为基准，测试显式传 now 保证确定性）；超过 30 天改用绝对日期 */
function formatAgo(ms: number, now: number): string {
    const HOUR = 3_600_000;
    const DAY = 86_400_000;
    const diff = now - ms;
    // 时钟回拨/未来时间（后端机器改过系统时间）不该显示「-3 小时前」
    if (diff < HOUR) return "刚刚";
    if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
    if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`;
    return formatStoryDate(ms);
}

/**
 * 「她想起过 3 次 · 上次 2 天前」。
 *
 * 这一行是 REQ-03 唯一的「她真的在回忆」证据，所以从没想起过时要说人话
 * （「她还没想起过这个故事」），而不是显示「想起过 0 次 · 上次 –」这种半成品。
 */
export function storyRecallLine(
    n: Pick<NarrativeItem, "recallCount" | "lastRecalledAt">,
    now = Date.now()
): string {
    const raw = typeof n?.recallCount === "number" && Number.isFinite(n.recallCount) ? n.recallCount : 0;
    const count = Math.max(0, Math.floor(raw));
    if (count === 0) return "她还没想起过这个故事";
    const last = toMillis(n?.lastRecalledAt);
    return last === null ? `她想起过 ${count} 次` : `她想起过 ${count} 次 · 上次 ${formatAgo(last, now)}`;
}

/** 专属梗话术：后端给 null 或空串都算「没有梗」，避免渲染出一个空的「专属梗」标记 */
export function storyJokeTrigger(n: Pick<NarrativeItem, "jokeTrigger">): string | null {
    const text = typeof n?.jokeTrigger === "string" ? n.jokeTrigger.trim() : "";
    return text || null;
}

/**
 * 标签归一（后端存的是字符串数组，但脏档案里什么都可能塞进来）。
 * 顺手去重：抽取链路重复 update 过同一个词，界面出现两枚一模一样的 chip 时，
 * 用户只会觉得坏了，而 React 也会因重复 key 直接告警。
 */
export function storyTags(n: Pick<NarrativeItem, "tags">): string[] {
    if (!Array.isArray(n?.tags)) return [];
    const cleaned = n.tags
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim())
        .filter(Boolean);
    return [...new Set(cleaned)];
}

/**
 * 关键词匹配标题 / 梗概 / 标签 —— 与记忆 tab 同一把尺子（trim + 大小写不敏感的包含匹配）。
 * 空关键词原样返回同一个引用，让调用方的 useMemo 不必多做一次拷贝。
 */
export function filterStories<T extends Pick<NarrativeItem, "title" | "summary" | "tags">>(
    list: T[],
    keyword: string
): T[] {
    const k = (keyword ?? "").trim().toLowerCase();
    if (!k) return list;
    return list.filter(
        (n) =>
            (n.title ?? "").toLowerCase().includes(k) ||
            (n.summary ?? "").toLowerCase().includes(k) ||
            storyTags(n).some((t) => t.toLowerCase().includes(k))
    );
}

export interface StoryGroup<T> {
    key: string;
    label: string;
    items: T[];
}

/**
 * 按「事件发生时间」分组：最近 30 天 / 今年（写明年份）/ 去年 / 更早 / 时间不详。
 *
 * 组内**不重排**：后端 getAll() 已按「重要度→新近」排好，前端再按时间排序会把她最看重的
 * 那段故事挤到组尾 —— 用户该看到的是「哪段关系最重」，而不是又一本流水账。
 * 时间不详单独成组放最后，脏数据不至于让整段列表消失。
 */
export function groupStoriesByRecency<T extends Pick<NarrativeItem, "occurredAt">>(
    list: T[],
    now = Date.now()
): StoryGroup<T>[] {
    const DAY = 86_400_000;
    const buckets: StoryGroup<T>[] = [];
    const push = (key: string, label: string, items: T[]) => {
        if (items.length) buckets.push({ key, label, items });
    };
    const recent: T[] = [];
    const thisYear: T[] = [];
    const lastYear: T[] = [];
    const older: T[] = [];
    const unknown: T[] = [];
    const thisYearNum = new Date(toMillis(now) ?? now).getFullYear();

    for (const item of list) {
        const ms = toMillis(item?.occurredAt);
        if (ms === null) {
            unknown.push(item);
            continue;
        }
        if (now - ms < 30 * DAY) recent.push(item);
        else if (new Date(ms).getFullYear() === thisYearNum) thisYear.push(item);
        else if (new Date(ms).getFullYear() === thisYearNum - 1) lastYear.push(item);
        else older.push(item);
    }

    push("recent", "最近", recent);
    push("this_year", `${thisYearNum} 年`, thisYear);
    push("last_year", `${thisYearNum - 1} 年`, lastYear);
    push("older", "更早", older);
    push("unknown", "时间不详", unknown);
    return buckets;
}

/** 故事总数（后端 stats.total 是全库条数，与当前列表长度可能不同——列表才是用户能看见的） */
export function storyCountLabel(count: number): string {
    return `共 ${count} 个故事`;
}
