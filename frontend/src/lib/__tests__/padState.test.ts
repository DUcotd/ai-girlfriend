import { describe, expect, it } from "vitest";
import { readAxisSeries, readPadAxes } from "../padState";

/**
 * PAD 展示数据的归一（FE-11）：一个展示用数字不该有能力白屏。
 */
describe("readPadAxes", () => {
    it("正常值原样读出", () => {
        expect(readPadAxes({ P: 0.4, A: -0.2, D: 0.1 })).toEqual({ P: 0.4, A: -0.2, D: 0.1 });
    });

    it("缺字段 / 整段缺失 / NaN / 字符串值都回落 0，不抛异常", () => {
        expect(readPadAxes(undefined)).toEqual({ P: 0, A: 0, D: 0 });
        expect(readPadAxes(null)).toEqual({ P: 0, A: 0, D: 0 });
        expect(readPadAxes({})).toEqual({ P: 0, A: 0, D: 0 });
        expect(readPadAxes({ P: NaN, A: "0.3", D: Infinity })).toEqual({ P: 0, A: 0, D: 0 });
        expect(readPadAxes("坏掉的镜像值")).toEqual({ P: 0, A: 0, D: 0 });
        expect(readPadAxes([1, 2])).toEqual({ P: 0, A: 0, D: 0 });
    });

    it("0 是合法值，不能被当成缺失", () => {
        expect(readPadAxes({ P: 0, A: 0, D: 0 })).toEqual({ P: 0, A: 0, D: 0 });
    });
});

describe("readAxisSeries", () => {
    it("脏条目被跳过，好条目按时间保留（一个 null 不能打断整条时间线）", () => {
        const series = readAxisSeries(
            [
                { t: 1, P: 0.2 },
                null,
                { t: "x", P: 0.5 },
                { t: 2, pad: { P: -0.4 } },
                "垃圾",
                { t: 3, value: 0.9 },
            ],
            "P"
        );
        expect(series).toEqual([
            { t: 1, value: 0.2 },
            { t: 2, value: -0.4 },
            { t: 3, value: 0 },
        ]);
    });

    it("非数组入参返回空序列而不是抛", () => {
        expect(readAxisSeries(undefined, "A")).toEqual([]);
        expect(readAxisSeries({}, "A")).toEqual([]);
    });
});
