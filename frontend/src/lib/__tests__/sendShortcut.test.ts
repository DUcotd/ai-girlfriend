import { describe, expect, it } from "vitest";
import { shouldSendOnEnter } from "@/lib/sendShortcut";

/**
 * 回车发送的判定（B7）。
 *
 * 这条用例存在的原因是真实事故：输入法组词时按回车是「确认候选词」，
 * 旧写法却把它当「发送」，于是半截话被发出去并进了对话历史 ——
 * 那种东西没法撤回，还会参与好感度与记忆。
 */
describe("shouldSendOnEnter", () => {
    it("普通回车 → 发送", () => {
        expect(shouldSendOnEnter({ key: "Enter" })).toBe(true);
    });

    it("Shift+Enter → 不发送", () => {
        expect(shouldSendOnEnter({ key: "Enter", shiftKey: true })).toBe(false);
    });

    it("输入法组词中的回车 → 不发送（React 的事件在 nativeEvent 上）", () => {
        expect(shouldSendOnEnter({ key: "Enter", nativeEvent: { isComposing: true } })).toBe(false);
        // 原生事件/测试里也可能直接挂在顶层
        expect(shouldSendOnEnter({ key: "Enter", isComposing: true })).toBe(false);
    });

    it("老 WebKit 组词时 keyCode 固定是 229 → 同样不发送", () => {
        expect(shouldSendOnEnter({ key: "Enter", keyCode: 229 })).toBe(false);
        expect(shouldSendOnEnter({ key: "Enter", nativeEvent: { keyCode: 229 } })).toBe(false);
    });

    it("组词结束后的那一次回车仍然要能发送（不能一刀切禁掉 Enter）", () => {
        expect(shouldSendOnEnter({ key: "Enter", nativeEvent: { isComposing: false, keyCode: 13 } }))
            .toBe(true);
    });

    it("其它键一律不发送", () => {
        expect(shouldSendOnEnter({ key: "a" })).toBe(false);
        expect(shouldSendOnEnter({ key: "NumpadEnter" })).toBe(false);
        expect(shouldSendOnEnter({})).toBe(false);
    });
});
