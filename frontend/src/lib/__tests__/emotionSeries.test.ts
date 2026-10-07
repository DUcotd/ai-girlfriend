import { describe, expect, it } from "vitest";
import { describeTrend, toEmotionPoints, toPolyline } from "../emotionSeries";

/** 情绪时间线（REQ-10）的数据整理：脏条目免疫、趋势判定、折线映射。 */

const point = (t: number, P: number, A = 0, D = 0) => ({
    timestamp: t,
    before: { P: 0, A: 0, D: 0 },
    delta: { P },
    after: { P, A, D },
});

describe("toEmotionPoints", () => {
    it("正常条目按 after 读数并保留最后 N 条", () => {
        const list = toEmotionPoints([point(1, 0.2), point(2, 0.4)], 50);
        expect(list).toHaveLength(2);
        expect(list[1]).toEqual({ t: 2, P: 0.4, A: 0, D: 0 });
    });

    it("缺 after 时退回 before，两者都缺则读成中性 0", () => {
        expect(toEmotionPoints([{ timestamp: 1, before: { P: -0.3 } }], 50)[0].P).toBe(-0.3);
        expect(toEmotionPoints([{ timestamp: 1 }], 50)[0].P).toBe(0);
    });

    it("脏数据（null、非对象、时间戳不是数、NaN 轴值）不会抛，也不会占位", () => {
        const list = toEmotionPoints(
            [null, "x", { timestamp: "1", after: { P: 0.5 } }, { timestamp: 2, after: { P: NaN } }],
            50
        );
        // 前两条整条被丢（null / 非对象 / 时间戳不是数字），只有时间戳合法的那条留下、轴值回落中性
        expect(list).toHaveLength(1);
        expect(list[0]).toEqual({ t: 2, P: 0, A: 0, D: 0 });
    });

    it("非数组入参返回空数组", () => {
        expect(toEmotionPoints(undefined, 50)).toEqual([]);
        expect(toEmotionPoints({}, 50)).toEqual([]);
    });

    it("limit 只保留最新的条目（她记得最近的情绪，不是全部历史）", () => {
        const list = toEmotionPoints([point(1, 0.1), point(2, 0.2), point(3, 0.3)], 2);
        expect(list.map((p) => p.t)).toEqual([2, 3]);
    });
});

describe("describeTrend", () => {
    it("点数不足时不给结论（不替她编一句没根据的话）", () => {
        expect(describeTrend(toEmotionPoints([point(1, 0.9)], 50)).sentence).toBeNull();
    });

    it("P 轴上行 → 「比前阵子亮一些」", () => {
        const trend = describeTrend(
            toEmotionPoints([point(1, -0.2), point(2, -0.1), point(3, 0.4), point(4, 0.5)], 50)
        );
        expect(trend.dP).toBeGreaterThan(0.3);
        expect(trend.sentence).toContain("亮一些");
    });

    it("P 轴变化不到阈值时改用 A/D 轴解释，全都持平就不说", () => {
        const flat = describeTrend(
            toEmotionPoints([point(1, 0.1), point(2, 0.1), point(3, 0.11), point(4, 0.1)], 50)
        );
        expect(flat.sentence).toBeNull();
    });
});

describe("toPolyline", () => {
    it("把 [-1,1] 映射到画布：P=1 在最上边（y=0），P=-1 在最下边", () => {
        expect(toPolyline(toEmotionPoints([point(1, 1), point(2, -1)], 50), 100, 40)).toBe(
            "0.0,0.0 100.0,40.0"
        );
    });

    it("只有一个点时落在中间，不会算出 NaN", () => {
        expect(toPolyline(toEmotionPoints([point(1, 0)], 50), 100, 40)).toBe("50.0,20.0");
    });

    it("空序列返回空串（组件据此不画线）", () => {
        expect(toPolyline([], 100, 40)).toBe("");
    });
});
