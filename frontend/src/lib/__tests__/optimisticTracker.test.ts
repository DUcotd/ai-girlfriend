import { describe, expect, it } from "vitest";
import { createOptimisticTracker } from "../optimisticTracker";

/**
 * 乐观更新的原值记账（FE-07）。
 * 规则：同一轮未确认的改动里只有**第一次**记下的原值有效 ——
 * 连着拖三次失败，要回到第一次之前，而不是回到中间某个失败值。
 */
type Dim = "warmth" | "clingy";

describe("optimisticTracker", () => {
    it("第一次记原值，后续同维度不改写", () => {
        const t = createOptimisticTracker<Dim>();
        t.note("warmth", 0.2);
        t.note("warmth", 0.5);
        t.note("warmth", 0.8);
        expect(t.entries()).toEqual([["warmth", 0.2]]);
        expect(t.size).toBe(1);
    });

    it("多维度各自记账", () => {
        const t = createOptimisticTracker<Dim>();
        t.note("warmth", 0.2);
        t.note("clingy", -0.3);
        expect(t.entries()).toEqual([
            ["warmth", 0.2],
            ["clingy", -0.3],
        ]);
    });

    it("clear 之后可以重新记新一轮的原值（服务端确认后账本翻新）", () => {
        const t = createOptimisticTracker<Dim>();
        t.note("warmth", 0.2);
        t.clear();
        expect(t.size).toBe(0);
        t.note("warmth", 0.9);
        expect(t.entries()).toEqual([["warmth", 0.9]]);
    });

    it("非有限值不记：脏数据当原值回滚会把界面拖进更奇怪的状态", () => {
        const t = createOptimisticTracker<Dim>();
        t.note("warmth", NaN);
        t.note("clingy", Infinity);
        expect(t.size).toBe(0);
    });

    it("0 是合法原值", () => {
        const t = createOptimisticTracker<Dim>();
        t.note("warmth", 0);
        expect(t.entries()).toEqual([["warmth", 0]]);
    });
});
