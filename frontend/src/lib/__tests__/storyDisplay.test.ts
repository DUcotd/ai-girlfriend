import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
    DEFAULT_STORY_TYPE,
    STORY_TYPE_META,
    filterStories,
    formatStoryDate,
    groupStoriesByRecency,
    storyCountLabel,
    storyDateLine,
    TRUSTED_DATE_SOURCES,
    storyJokeTrigger,
    storyRecallLine,
    storyTags,
    storyTypeMeta,
} from "@/lib/storyDisplay";
import type { NarrativeItem } from "@/types";

/**
 * 后端叙事类型表（唯一事实源），直接 import 真模块而不是正则抄一遍：
 * 正则解析后端源码一旦后端改写风格就会静默失配，直接执行才叫钉住（见 baseUrlGrade.test.ts 同法）。
 */
interface BackendNarrativeTypes {
    NARRATIVE_TYPE_LABELS: string[];
    DEFAULT_NARRATIVE_TYPE: string;
    NARRATIVE_TYPES: Record<string, { label: string; labelZh: string }>;
}

let backend: BackendNarrativeTypes;

beforeAll(async () => {
    const modulePath = resolve(
        process.cwd(),
        "../backend-node/src/core/narrative/narrativeTypes.js"
    );
    backend = (await import(pathToFileURL(modulePath).href)) as BackendNarrativeTypes;
});

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** 本地正午：跨时区跑测试也不会因为 UTC 偏移把日期算错一天 */
const AT = (y: number, monthIndex: number, d: number) => new Date(y, monthIndex, d, 12, 0, 0).getTime();
const NOW = AT(2026, 4, 20); // 2026-05-20 12:00

function story(overrides: Partial<NarrativeItem> = {}): NarrativeItem {
    return {
        id: "n1",
        type: "first_time",
        title: "第一次互道晚安",
        summary: "用户第一次和小爱互道晚安。",
        occurredAt: AT(2026, 4, 18),
        importance: 4,
        recurring: null,
        jokeTrigger: null,
        tags: [],
        recallCount: 0,
        lastRecalledAt: null,
        createdAt: AT(2026, 4, 18),
        updatedAt: AT(2026, 4, 18),
        ...overrides,
    };
}

describe("formatStoryDate：毫秒/秒口径陷阱", () => {
    it("毫秒（后端叙事的口径）原样按日期显示", () => {
        expect(formatStoryDate(AT(2026, 4, 9))).toBe("2026-05-09");
    });

    it("误传秒级时间戳（/memories 的 episodes 口径）被校正成同一天", () => {
        const ms = AT(2026, 4, 9);
        expect(formatStoryDate(Math.floor(ms / 1000))).toBe("2026-05-09");
    });

    it("不做校正就会把 2026 年显示成 1970 —— 这条守住回归", () => {
        const sec = Math.floor(AT(2026, 4, 9) / 1000);
        // 未校正的直接喂给 new Date()：1.7e9 毫秒 = 1970 年 1 月，看着像个正常日期
        expect(new Date(sec).getFullYear()).toBe(1970);
        expect(formatStoryDate(sec)).not.toContain("1970");
    });

    it.each([
        { label: "0", value: 0 },
        { label: "负数", value: -1_700_000_000_000 },
        { label: "NaN", value: Number.NaN },
        { label: "Infinity", value: Number.POSITIVE_INFINITY },
    ])("无效时间 $label 返回空串（界面据此省略日期，不编一个日子）", ({ value }) => {
        expect(formatStoryDate(value)).toBe("");
    });

    it("null / undefined 返回空串", () => {
        expect(formatStoryDate(null)).toBe("");
        expect(formatStoryDate(undefined)).toBe("");
    });

    it("个位数日期补零", () => {
        expect(formatStoryDate(AT(2026, 0, 5))).toBe("2026-01-05");
    });
});

describe("storyRecallLine", () => {
    it("想起过 N 次并带「上次 …」", () => {
        expect(storyRecallLine({ recallCount: 3, lastRecalledAt: NOW - 2 * DAY }, NOW)).toBe(
            "她想起过 3 次 · 上次 2 天前"
        );
        expect(storyRecallLine({ recallCount: 1, lastRecalledAt: NOW - 5 * HOUR }, NOW)).toBe(
            "她想起过 1 次 · 上次 5 小时前"
        );
    });

    it("从没想起过时说人话，而不是「0 次 · 上次 –」", () => {
        expect(storyRecallLine({ recallCount: 0, lastRecalledAt: null }, NOW)).toBe("她还没想起过这个故事");
        expect(storyRecallLine({ recallCount: 0, lastRecalledAt: NOW - DAY }, NOW)).toBe(
            "她还没想起过这个故事"
        );
    });

    it("想起过但没有上次时间（脏数据）只说次数，不留半截「上次」", () => {
        expect(storyRecallLine({ recallCount: 5, lastRecalledAt: null }, NOW)).toBe("她想起过 5 次");
    });

    it("lastRecalledAt 是秒级值时也按最近算（同一处口径校正）", () => {
        const lastMs = NOW - 3 * HOUR;
        expect(storyRecallLine({ recallCount: 2, lastRecalledAt: Math.floor(lastMs / 1000) }, NOW)).toBe(
            "她想起过 2 次 · 上次 3 小时前"
        );
    });

    it("超过 30 天改用绝对日期", () => {
        expect(storyRecallLine({ recallCount: 4, lastRecalledAt: NOW - 90 * DAY }, NOW)).toBe(
            `她想起过 4 次 · 上次 ${formatStoryDate(NOW - 90 * DAY)}`
        );
    });

    it("未来时间（后端机器改过系统时间）说「刚刚」，不说「-3 小时前」", () => {
        expect(storyRecallLine({ recallCount: 1, lastRecalledAt: NOW + 5 * MIN }, NOW)).toBe(
            "她想起过 1 次 · 上次 刚刚"
        );
    });

    it("recallCount 为负数 / 脏值时按 0 处理", () => {
        expect(storyRecallLine({ recallCount: -2, lastRecalledAt: NOW }, NOW)).toBe("她还没想起过这个故事");
        expect(storyRecallLine({ recallCount: Number.NaN, lastRecalledAt: NOW }, NOW)).toBe(
            "她还没想起过这个故事"
        );
    });
});

describe("storyJokeTrigger / storyTags", () => {
    it("正常梗原样返回", () => {
        expect(storyJokeTrigger(story({ jokeTrigger: "土豆炖粉条" }))).toBe("土豆炖粉条");
    });

    it("null / 空串 / 纯空格都算「没有梗」（不渲染空的「专属梗」标记）", () => {
        expect(storyJokeTrigger(story({ jokeTrigger: null }))).toBeNull();
        expect(storyJokeTrigger(story({ jokeTrigger: "" }))).toBeNull();
        expect(storyJokeTrigger(story({ jokeTrigger: "   " }))).toBeNull();
        expect(storyJokeTrigger(story({ jokeTrigger: undefined }))).toBeNull();
    });

    it("两侧空格被裁掉，但梗本身不改写", () => {
        expect(storyJokeTrigger(story({ jokeTrigger: "  只有我们懂  " }))).toBe("只有我们懂");
    });

    it("标签过滤掉非字符串与空串", () => {
        expect(storyTags(story({ tags: ["熬夜", " 火锅 ", "", 3 as unknown as string] }))).toEqual([
            "熬夜",
            "火锅",
        ]);
        expect(storyTags(story({ tags: undefined as unknown as string[] }))).toEqual([]);
    });

    it("重复标签去重（两枚一模一样的 chip + 重复 key 都不是好事）", () => {
        expect(storyTags(story({ tags: ["熬夜", "熬夜", " 熬夜 "] }))).toEqual(["熬夜"]);
    });
});

describe("filterStories", () => {
    const list = [
        story({ id: "a", title: "第一次看雪", summary: "一起聊到凌晨三点。", tags: ["熬夜", "雪"] }),
        story({ id: "b", title: "认识满月", summary: "她说这是 ANNIVERSARY。", tags: ["纪念日"] }),
        story({ id: "c", title: "火锅之夜", summary: "约好下周再吃。", tags: ["火锅"] }),
    ];

    it("空关键词原样返回同一个引用（不做多余拷贝）", () => {
        expect(filterStories(list, "")).toBe(list);
        expect(filterStories(list, "   ")).toBe(list);
    });

    it("按标题匹配", () => {
        expect(filterStories(list, "看雪").map((n) => n.id)).toEqual(["a"]);
    });

    it("按梗概匹配且大小写不敏感", () => {
        expect(filterStories(list, "anniversary").map((n) => n.id)).toEqual(["b"]);
    });

    it("按标签匹配", () => {
        expect(filterStories(list, "火锅").map((n) => n.id)).toEqual(["c"]);
    });

    it("关键词两侧空格不影响结果", () => {
        expect(filterStories(list, "  第一次  ").map((n) => n.id)).toEqual(["a"]);
    });

    it("没有命中返回空数组", () => {
        expect(filterStories(list, "不存在的词")).toEqual([]);
    });

    it("脏数据（缺 tags / 缺梗概）不炸", () => {
        // 只剩标题可匹配（标题默认含「晚安」）：梗概是空串、tags 不是数组（老档案里的脏形状）
        const dirty = [story({ id: "x", tags: undefined as unknown as string[], summary: "" })];
        expect(filterStories(dirty, "晚安").map((n) => n.id)).toEqual(["x"]);
        expect(filterStories(dirty, "完全无关")).toEqual([]);
    });
});

describe("groupStoriesByRecency", () => {
    const recent = story({ id: "r", occurredAt: NOW - 2 * DAY });
    const thisYear = story({ id: "t", occurredAt: AT(2026, 0, 5) });
    const lastYear = story({ id: "l", occurredAt: AT(2025, 7, 1) });
    const older = story({ id: "o", occurredAt: AT(2024, 2, 1) });
    const unknown = story({ id: "u", occurredAt: 0 });

    it("按新近分组，组顺序从近到远，空组不出现", () => {
        const groups = groupStoriesByRecency([recent, thisYear, lastYear, older, unknown], NOW);
        expect(groups.map((g) => g.key)).toEqual(["recent", "this_year", "last_year", "older", "unknown"]);
        expect(groups.map((g) => g.label)).toEqual(["最近", "2026 年", "2025 年", "更早", "时间不详"]);
    });

    it("30 天内一律进「最近」（哪怕还没跨年）", () => {
        const groups = groupStoriesByRecency([recent], NOW);
        expect(groups).toHaveLength(1);
        expect(groups[0].key).toBe("recent");
    });

    it("组内保持后端的主序（重要度→新近），前端不再按时间重排", () => {
        const a = story({ id: "a", occurredAt: NOW - 25 * DAY });
        const b = story({ id: "b", occurredAt: NOW - 1 * DAY });
        const groups = groupStoriesByRecency([a, b], NOW);
        expect(groups[0].items.map((n) => n.id)).toEqual(["a", "b"]);
        expect(groups[0].items[0]).toBe(a);
    });

    it("时间不详只收无效 occurredAt，并排在最后", () => {
        const groups = groupStoriesByRecency([unknown, recent], NOW);
        expect(groups[groups.length - 1].key).toBe("unknown");
        expect(groups[groups.length - 1].items.map((n) => n.id)).toEqual(["u"]);
    });

    it("空列表返回空分组（界面走「还没有故事」空状态）", () => {
        expect(groupStoriesByRecency([], NOW)).toEqual([]);
    });

    it("不改动传入数组的顺序", () => {
        const input = [older, recent, thisYear];
        groupStoriesByRecency(input, NOW);
        expect(input.map((n) => n.id)).toEqual(["o", "r", "t"]);
    });
});

describe("storyCountLabel", () => {
    it("计数文案", () => {
        expect(storyCountLabel(3)).toBe("共 3 个故事");
        expect(storyCountLabel(0)).toBe("共 0 个故事");
    });
});

describe("叙事类型镜像表与后端 narrativeTypes.js 一致", () => {
    it("后端类型枚举能被前端测试导入（真源没改名挪位）", () => {
        expect(Array.isArray(backend.NARRATIVE_TYPE_LABELS)).toBe(true);
        expect(backend.NARRATIVE_TYPE_LABELS.length).toBeGreaterThan(0);
    });

    it("镜像表的键与后端 NARRATIVE_TYPES 完全一致（不多、不少）", () => {
        expect(Object.keys(STORY_TYPE_META).sort()).toEqual(Object.keys(backend.NARRATIVE_TYPES).sort());
    });

    it("后端每个类型都在镜像表里有中文标签，且逐字等于 labelZh", () => {
        for (const type of backend.NARRATIVE_TYPE_LABELS) {
            expect(STORY_TYPE_META).toHaveProperty(type);
            expect(STORY_TYPE_META[type].label).toBe(backend.NARRATIVE_TYPES[type].labelZh);
        }
    });

    it("兜底类型两侧同一个", () => {
        expect(DEFAULT_STORY_TYPE).toBe(backend.DEFAULT_NARRATIVE_TYPE);
    });

    it("每个类型都配了展示图标（emoji 是前端装饰，后端没有对应字段）", () => {
        const missing = Object.entries(STORY_TYPE_META).filter(([, meta]) => !meta.emoji).map(([type]) => type);
        expect(missing).toEqual([]);
    });

    it("未知类型回落到默认类型标签（后端存盘前也做同样归一）", () => {
        expect(storyTypeMeta("not_a_type").label).toBe(STORY_TYPE_META[DEFAULT_STORY_TYPE].label);
        expect(storyTypeMeta(null).label).toBe(backend.NARRATIVE_TYPES[backend.DEFAULT_NARRATIVE_TYPE].labelZh);
        expect(storyTypeMeta(undefined).emoji).toBe(STORY_TYPE_META[DEFAULT_STORY_TYPE].emoji);
    });

    it("专属梗类型名与界面标记用词一致（「专属梗」三处不能各写一套）", () => {
        expect(STORY_TYPE_META.inside_joke.label).toBe("专属梗");
    });
});


describe('storyDateLine —— 只有她记得日子时才显示日期（F-1 跨端口径）', () => {
    const MS = new Date(2025, 2, 8, 21, 30).getTime();
    it('stated / relative / month-day 都显示', () => {
        for (const source of TRUSTED_DATE_SOURCES) {
            expect(storyDateLine({ occurredAt: MS, occurredAtSource: source })).toBe("2025-03-08");
        }
    });
    it('fallback 与 null（改造前入库）一律不显示，哪怕 occurredAt 是个正常数字', () => {
        expect(storyDateLine({ occurredAt: MS, occurredAtSource: "fallback" })).toBe("");
        expect(storyDateLine({ occurredAt: MS, occurredAtSource: null })).toBe("");
        expect(storyDateLine({ occurredAt: MS })).toBe("");
    });
    it('白名单与后端 DATE_SOURCE 的取值逐一对得上（后端是唯一真源）', async () => {
        const mod = (await import(pathToFileURL(
            resolve(process.cwd(), "../backend-node/src/core/narrative/narrativeDate.js")
        ).href)) as { DATE_SOURCE: Record<string, string> };
        // 后端常量名与取值不同形（monthDay → "month-day"），所以比对**取值集合**而不是键名
        const values: string[] = Object.values(mod.DATE_SOURCE);
        expect(TRUSTED_DATE_SOURCES.slice().sort()).toEqual(
            values.filter((v) => v !== mod.DATE_SOURCE.fallback).sort()
        );
        expect(values).toContain("fallback");
        expect(TRUSTED_DATE_SOURCES).not.toContain("fallback");
    });
});
