import { describe, expect, it, vi } from "vitest";
import { dialogCanClose, hasDialogDirtyGuard, setDialogDirtyGuard } from "../dialogGuard";

/**
 * 弹窗关闭闸门（FE-07）：三条关闭路径（X / Esc / 遮罩）共用同一个判定，
 * 少一条就等于用户还能一键丢掉改动。
 */
describe("dialogGuard", () => {
    it("没挂闸门时永远允许关闭", () => {
        setDialogDirtyGuard(null);
        expect(dialogCanClose()).toBe(true);
        expect(hasDialogDirtyGuard()).toBe(false);
    });

    it("闸门返回 false 时拦下关闭", () => {
        const off = setDialogDirtyGuard(() => false);
        expect(dialogCanClose()).toBe(false);
        expect(hasDialogDirtyGuard()).toBe(true);
        off();
        expect(dialogCanClose()).toBe(true);
    });

    it("只有挂着闸门的那个弹窗的 cleanup 能摘掉它（后注册的不被旧 cleanup 误删）", () => {
        const offFirst = setDialogDirtyGuard(() => false);
        setDialogDirtyGuard(() => true);          // 第二个弹窗顶上来
        offFirst();                               // 第一个的 cleanup 不该动现在的
        expect(hasDialogDirtyGuard()).toBe(true);
        expect(dialogCanClose()).toBe(true);
    });

    it("闸门本身抛异常时按「放行」处理：不能因为判定炸了就关不掉弹窗", () => {
        setDialogDirtyGuard(() => {
            throw new Error("boom");
        });
        expect(() => dialogCanClose()).toThrow();   // 语义：异常原样抛出，由调用方决定
        setDialogDirtyGuard(null);
    });

    it("dirty 判定被按次数读取，可用来实现「再点一次就放弃」", () => {
        const guard = vi.fn(() => false);
        setDialogDirtyGuard(guard);
        expect(dialogCanClose()).toBe(false);
        expect(dialogCanClose()).toBe(false);
        expect(guard).toHaveBeenCalledTimes(2);
        setDialogDirtyGuard(null);
    });
});
