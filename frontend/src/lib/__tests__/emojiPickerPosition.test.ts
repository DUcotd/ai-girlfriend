import { describe, expect, it } from "vitest";
import { placePopoverBesideTrigger, type BoxRect } from "@/lib/emojiPickerPosition";

/**
 * 表情面板定位（FE-13 移动端）。
 *
 * 旧写法是 `absolute bottom-full left-0`：位置在代码里就定死了，
 * 375px 宽的手机上触发按钮偏右 → 面板右半边被 overflow-hidden 裁掉；
 * 软键盘顶起可视区 → 上方空间不足，面板顶部被切。
 * 算法本身与 DOM 无关，所以逐条钉在这里，而不是靠「在真机上看看」。
 */
const trigger = (top: number, left: number, width = 44, height = 44): BoxRect => ({
    top,
    left,
    width,
    height,
});

const PANEL = { width: 344, height: 260 };
const PHONE = { width: 375, height: 667 };

describe("placePopoverBesideTrigger", () => {
    it("默认贴在触发元素上方、左对齐（输入栏在屏幕底部，向上才有空间）", () => {
        const pos = placePopoverBesideTrigger({
            trigger: trigger(600, 20),
            panel: PANEL,
            viewport: { width: 800, height: 700 },
        });
        expect(pos.placement).toBe("above");
        // top = 触发元素顶 600 - 间距 12 - 面板高 260
        expect(pos.top).toBe(600 - 12 - 260);
        expect(pos.left).toBe(20);
        expect(pos.flippedHorizontally).toBe(false);
    });

    it("上方放不下、下方放得下 → 翻到触发元素下方", () => {
        const pos = placePopoverBesideTrigger({
            trigger: trigger(180, 40),
            panel: PANEL,
            viewport: { width: 800, height: 600 },
        });
        expect(pos.placement).toBe("below");
        // top = 触发元素底 180+44 + 间距 12
        expect(pos.top).toBe(180 + 44 + 12);
    });

    it("上下都放不下 → 选空间更大的一边，并钳进视口不裁边", () => {
        const pos = placePopoverBesideTrigger({
            trigger: trigger(150, 20),
            panel: PANEL,
            viewport: { width: 375, height: 300 },
        });
        // 上方 150-12=138 > 下方 300-194-12=94 → 仍选上方
        expect(pos.placement).toBe("above");
        expect(pos.top).toBe(16);
        expect(pos.top + PANEL.height).toBeLessThanOrEqual(300);
    });

    it("面板比视口还高（横屏小窗）时无解，但至少贴住上边距、不裁左右", () => {
        const pos = placePopoverBesideTrigger({
            trigger: trigger(120, 20),
            panel: PANEL,
            viewport: { width: 375, height: 200 },
        });
        expect(pos.top).toBe(16);
        expect(pos.left).toBeGreaterThanOrEqual(16);
    });

    it("触发元素靠右 → 面板改成右对齐，跟着触发元素的右边缘走而不再溢出右边", () => {
        const pos = placePopoverBesideTrigger({
            // 语音模式下表情键会排到输入行右边
            trigger: trigger(400, 400),
            panel: PANEL,
            viewport: { width: 500, height: 800 },
        });
        expect(pos.flippedHorizontally).toBe(true);
        // 右对齐：面板右边缘与触发元素右边缘（400+44=444）齐平
        expect(pos.left).toBe(444 - 344);
        expect(pos.left + PANEL.width).toBeLessThanOrEqual(500 - 16);
    });

    it("375 窄屏 + 按钮靠右：右对齐会顶穿左边缘，于是钳到最小留白，两头都不裁", () => {
        const pos = placePopoverBesideTrigger({
            trigger: trigger(600, 280),
            panel: PANEL,
            viewport: PHONE,
        });
        expect(pos.flippedHorizontally).toBe(true);
        expect(pos.left).toBe(16);
        // 344 宽的面板在 375 的视口里本来就只能贴边放（这也是它自带 max-w-[calc(100vw-2rem)] 的原因）
        expect(pos.left + PANEL.width).toBeLessThanOrEqual(PHONE.width);
    });

    it("任何情况下都不会把面板推到视口外（窄屏 + 面板比视口还宽）", () => {
        const pos = placePopoverBesideTrigger({
            trigger: trigger(300, 300),
            panel: { width: 344, height: 260 },
            viewport: { width: 340, height: 500 },
        });
        expect(pos.left).toBe(16);
        expect(pos.top).toBeGreaterThanOrEqual(16);
        expect(pos.top + 260).toBeLessThanOrEqual(500);
    });

    it("间距与留白可覆盖（面板要离触发元素远一点时）", () => {
        const pos = placePopoverBesideTrigger({
            trigger: trigger(600, 20),
            panel: PANEL,
            viewport: PHONE,
            gap: 20,
            margin: 8,
        });
        expect(pos.top).toBe(600 - 20 - 260);
    });

    it("桌面宽屏 + 富余空间：位置完全按触发元素走，不做任何钳制", () => {
        const pos = placePopoverBesideTrigger({
            trigger: trigger(800, 900),
            panel: PANEL,
            viewport: { width: 1440, height: 900 },
        });
        expect(pos.left).toBe(900);
        expect(pos.placement).toBe("above");
    });
});
