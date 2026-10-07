/**
 * 浮层（表情面板这类贴在触发元素旁边的弹层）的定位纯逻辑。
 *
 * 为什么单独成文件：以前面板位置等于一串写死的 Tailwind 类
 * （absolute bottom-full left-0），也就是「永远贴在触发元素上方、永远左对齐」——
 * 375px 宽的手机上，触发按钮偏右时面板右半边直接溢出视口被裁掉，
 * 键盘弹起后上方空间不够时面板顶部也被切掉。
 * 位置既然依赖运行时矩形，就只能算出来，写成类是修不好的；
 * 而算法本身与 DOM 无关，所以抽成纯函数逐条钉住（见 __tests__/emojiPickerPosition.test.ts）。
 */

/** 只取定位用得上的四个数，方便测试直接传字面量 */
export interface BoxRect {
    top: number;
    left: number;
    width: number;
    height: number;
}

export interface PlacePopoverOptions {
    /** 触发元素在视口中的矩形 */
    trigger: BoxRect;
    /** 面板自身尺寸（已排版的实际宽高） */
    panel: { width: number; height: number };
    /** 视口尺寸 */
    viewport: { width: number; height: number };
    /** 面板与触发元素的间距，默认 12px */
    gap?: number;
    /** 距视口边缘的最小留白，默认 16px */
    margin?: number;
}

export interface PopoverPosition {
    left: number;
    top: number;
    /** 贴在哪一侧：above = 面板在触发元素上方，below = 下方 */
    placement: "above" | "below";
    /** 横向是否翻了方向：触发元素靠右时面板右对齐（否则会被视口右边裁掉） */
    flippedHorizontally: boolean;
}

const DEFAULT_GAP = 12;
const DEFAULT_MARGIN = 16;

const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), Math.max(min, max));

/**
 * 优先贴在触发元素上方（输入栏在屏幕底部，向上才有空间）；
 * 上方放不下就让到下方；两边都放不下就选空间更大的一侧，
 * 最后再统一把坐标钳进视口，保证任何尺寸都不被裁。
 */
export function placePopoverBesideTrigger({
    trigger,
    panel,
    viewport,
    gap = DEFAULT_GAP,
    margin = DEFAULT_MARGIN,
}: PlacePopoverOptions): PopoverPosition {
    const triggerBottom = trigger.top + trigger.height;
    const spaceAbove = trigger.top - gap;
    const spaceBelow = viewport.height - triggerBottom - gap;

    const fitsAbove = panel.height <= spaceAbove;
    const fitsBelow = panel.height <= spaceBelow;
    // 首选上方；放不下再看下方；都不行则挑更宽的一边（反正后面要钳进视口）
    const placement: PopoverPosition["placement"] = fitsAbove
        ? "above"
        : fitsBelow
          ? "below"
          : spaceAbove >= spaceBelow
            ? "above"
            : "below";

    const rawTop = placement === "above" ? trigger.top - gap - panel.height : triggerBottom + gap;
    // 默认左边缘对齐触发元素；触发元素靠右、照左对齐会溢出右边缘时改成右对齐
    const leftAligned = trigger.left;
    const rightAligned = trigger.left + trigger.width - panel.width;
    const overflowsRight = leftAligned + panel.width > viewport.width - margin;
    const rawLeft = overflowsRight ? rightAligned : leftAligned;

    return {
        // 再统一钳进视口：上下都放不下时（小屏 + 键盘弹起）也保证面板完整可见、不裁边
        top: clamp(rawTop, margin, Math.max(margin, viewport.height - panel.height - margin)),
        left: clamp(rawLeft, margin, Math.max(margin, viewport.width - panel.width - margin)),
        placement,
        flippedHorizontally: overflowsRight,
    };
}
