/**
 * 单选组（radiogroup）的纯逻辑：可选集合、Tab 停靠点、方向键去向。
 *
 * 拆成纯函数的原因：键盘导航是这个应用里最容易「写了但没人能按出来」的一段，
 * 而它完全不需要 DOM 就能验算（分段选择器、主题弹窗、预设网格共用同一套规则）。
 * 语义按 WAI-ARIA Radio Group：整组只占一个 Tab 停靠点（落在选中项），
 * 方向键在**可选项**之间循环并即时选中，Home/End 跳首尾。
 */

export interface RadioOption {
    value: string;
    /** 仅展示不可点 */
    disabled?: boolean;
}

/** 可选项的下标（禁用项不参与循环，也永远不该成为 Tab 停靠点） */
export function selectableIndexes(options: readonly RadioOption[]): number[] {
    const picked: number[] = [];
    options.forEach((opt, index) => {
        if (!opt.disabled) picked.push(index);
    });
    return picked;
}

/**
 * roving tabindex 的停靠下标：选中项优先；
 * 当前值不在可选集合里（外部把选中项置灰 / 值还没初始化）时退到第一个可选项，
 * 否则整组 tabindex 全是 -1，键盘就再也进不来了。
 */
export function tabStopIndex(
    options: readonly RadioOption[],
    value: string | null | undefined
): number {
    const selectable = selectableIndexes(options);
    const active = options.findIndex((opt) => !opt.disabled && opt.value === value);
    if (active >= 0) return active;
    return selectable.length > 0 ? selectable[0] : -1;
}

/** 沿可选项循环走 dir 步；全组禁用时返回 null */
export function stepSelectable(
    index: number,
    dir: 1 | -1,
    options: readonly RadioOption[]
): number | null {
    const selectable = selectableIndexes(options);
    if (selectable.length === 0) return null;
    const pos = selectable.indexOf(index);
    // 焦点落在被禁用的选中项上时，从它右侧的第一个可选项继续
    const anchor = pos >= 0 ? pos : selectable.findIndex((i) => i > index);
    if (anchor < 0) return selectable[selectable.length - 1];
    return selectable[(anchor + dir + selectable.length) % selectable.length];
}

export type RadioKeyResult =
    | { kind: "move"; index: number }
    | { kind: "confirm" }
    | null;

/** 把一个 keydown 翻译成单选组的动作；无关按键返回 null（不拦截默认行为） */
export function resolveRadioKey(
    key: string,
    index: number,
    options: readonly RadioOption[]
): RadioKeyResult {
    const selectable = selectableIndexes(options);
    switch (key) {
        case "ArrowRight":
        case "ArrowDown": {
            const next = stepSelectable(index, 1, options);
            return next === null ? null : { kind: "move", index: next };
        }
        case "ArrowLeft":
        case "ArrowUp": {
            const next = stepSelectable(index, -1, options);
            return next === null ? null : { kind: "move", index: next };
        }
        case "Home":
            return selectable.length > 0 ? { kind: "move", index: selectable[0] } : null;
        case "End":
            return selectable.length > 0
                ? { kind: "move", index: selectable[selectable.length - 1] }
                : null;
        case "Enter":
        case " ":
            return { kind: "confirm" };
        default:
            return null;
    }
}
