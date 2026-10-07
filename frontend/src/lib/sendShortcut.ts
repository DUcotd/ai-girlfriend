/**
 * sendShortcut.ts —— 「回车是否该发送」这件事的唯一判定（B7）。
 *
 * 起因（2026-10-07 实测撞到）：旧写法是 `e.key === "Enter" && !e.shiftKey && onSend()`。
 * 中文输入法组词时按回车是「确认候选词」，不是「发送」—— 旧写法会把还没打完的
 * 半截话直接发出去（比如想打「今天有点累」，选词那一压回车就发了「今天有点」），
 * 而且发出去的东西已经进历史、会参与好感度与记忆，用户根本没法撤回。
 *
 * 判定抽成纯函数的原因：本项目的前端测试没有装 RTL（装它要几十 MB，本机出网只有
 * 几十 KB/s），把决策收成一个不依赖 DOM 的函数才能真正写用例，而不是只能人工试。
 */
export interface EnterKeyLike {
    key?: string;
    shiftKey?: boolean;
    /** React 的 KeyboardEvent 用 nativeEvent.isComposing；原生事件直接挂在这 */
    isComposing?: boolean;
    keyCode?: number;
    nativeEvent?: { isComposing?: boolean; keyCode?: number };
}

/** 组词中的判定：标准 isComposing + 老 WebKit 的 keyCode 229 兜底 */
function isComposing(e: EnterKeyLike): boolean {
    if (e.isComposing ?? e.nativeEvent?.isComposing) return true;
    const keyCode = e.keyCode ?? e.nativeEvent?.keyCode;
    return keyCode === 229;
}

/**
 * 只有「真正的回车」才发送：
 *   - Shift+Enter 不发（留给以后换行；也顺手避开某些输入法用 Shift 组合确认）；
 *   - 输入法组词中不发；
 *   - 其它键（包括数字小键盘的 Enter 之外的 Enter 变种）不发。
 */
export function shouldSendOnEnter(e: EnterKeyLike): boolean {
    if (e.key !== "Enter") return false;
    if (e.shiftKey) return false;
    return !isComposing(e);
}
