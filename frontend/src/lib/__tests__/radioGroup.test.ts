import { describe, expect, it } from "vitest";
import {
    resolveRadioKey,
    selectableIndexes,
    stepSelectable,
    tabStopIndex,
    type RadioOption,
} from "@/lib/radioGroup";

/**
 * 单选组键盘模型的守卫（FE-10 无障碍基线）。
 *
 * 分段选择器 / 主题弹窗 / 性格预设网格共用这套规则，而它恰好是
 * 「写了就没人能按出来」的那类代码：没有单测的话，回归的唯一表现是
 * 键盘用户默默切不动档，而鼠标点一切正常。
 */
const OPTIONS: RadioOption[] = [
    { value: "low" },
    { value: "medium" },
    { value: "high" },
];

const DISABLED: RadioOption[] = [
    { value: "openai" },
    { value: "custom", disabled: true },
    { value: "local" },
];

describe("selectableIndexes", () => {
    it("跳过禁用项（它们只展示，不参与循环）", () => {
        expect(selectableIndexes(DISABLED)).toEqual([0, 2]);
    });

    it("全部禁用时是空集合", () => {
        expect(selectableIndexes([{ value: "a", disabled: true }])).toEqual([]);
    });
});

describe("tabStopIndex", () => {
    it("roving tabindex 停在选中项", () => {
        expect(tabStopIndex(OPTIONS, "medium")).toBe(1);
    });

    it("当前值命中禁用项时退回第一个可选项（否则整组 tabindex 全是 -1，键盘进不来）", () => {
        expect(tabStopIndex(DISABLED, "custom")).toBe(0);
    });

    it("当前值根本不在选项里时也能进得来", () => {
        expect(tabStopIndex(OPTIONS, "nope")).toBe(0);
        expect(tabStopIndex(OPTIONS, undefined)).toBe(0);
    });

    it("全组禁用时返回 -1（没有任何停靠点）", () => {
        expect(tabStopIndex([{ value: "a", disabled: true }], "a")).toBe(-1);
    });
});

describe("stepSelectable", () => {
    it("向右/向左在可选项之间循环", () => {
        expect(stepSelectable(0, 1, OPTIONS)).toBe(1);
        expect(stepSelectable(2, 1, OPTIONS)).toBe(0);   // 末尾回绕
        expect(stepSelectable(0, -1, OPTIONS)).toBe(2);  // 首部回绕
    });

    it("跨过禁用项，不会停在按不动的选项上", () => {
        expect(stepSelectable(0, 1, DISABLED)).toBe(2);
        expect(stepSelectable(2, -1, DISABLED)).toBe(0);
    });

    it("焦点落在禁用项上时，仍能走到最近的可选项", () => {
        expect(stepSelectable(1, 1, DISABLED)).toBe(2);
        expect(stepSelectable(1, -1, DISABLED)).toBe(0);
    });

    it("全组禁用时不动", () => {
        expect(stepSelectable(0, 1, [{ value: "a", disabled: true }])).toBeNull();
    });
});

describe("resolveRadioKey", () => {
    it.each([
        ["ArrowRight", 1],
        ["ArrowDown", 1],
    ])("%s → 移到下一项", (key, expected) => {
        expect(resolveRadioKey(key, 0, OPTIONS)).toEqual({ kind: "move", index: expected });
    });

    it.each(["ArrowLeft", "ArrowUp"])("%s → 移到上一项（首项回绕到末项）", (key) => {
        expect(resolveRadioKey(key, 0, OPTIONS)).toEqual({ kind: "move", index: 2 });
    });

    it("Home / End 跳首尾", () => {
        expect(resolveRadioKey("Home", 2, OPTIONS)).toEqual({ kind: "move", index: 0 });
        expect(resolveRadioKey("End", 0, OPTIONS)).toEqual({ kind: "move", index: 2 });
    });

    it("Enter / 空格是确认当前项，不换焦点", () => {
        expect(resolveRadioKey("Enter", 1, OPTIONS)).toEqual({ kind: "confirm" });
        expect(resolveRadioKey(" ", 1, OPTIONS)).toEqual({ kind: "confirm" });
    });

    it("无关按键一律放行（Tab 必须能离开整组）", () => {
        expect(resolveRadioKey("Tab", 0, OPTIONS)).toBeNull();
        expect(resolveRadioKey("a", 0, OPTIONS)).toBeNull();
    });

    it("全组禁用时方向键不产生动作", () => {
        const none = [{ value: "a", disabled: true }];
        expect(resolveRadioKey("ArrowRight", 0, none)).toBeNull();
        expect(resolveRadioKey("Home", 0, none)).toBeNull();
        expect(resolveRadioKey("End", 0, none)).toBeNull();
    });
});
