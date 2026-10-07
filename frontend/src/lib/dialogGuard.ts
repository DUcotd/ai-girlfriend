/**
 * 弹窗「有未保存改动」闸门（FE-07）。
 *
 * 关闭路径有三条（X 按钮 / Esc / 点遮罩），前两条走组件自己的 onClose，
 * Esc 与遮罩在 Modal 里 —— 如果只守 X 按钮，用户照样能用 Esc 丢掉改动。
 * 所以闸门注册在一个独立模块里，Modal 与调用方共用同一个判定，
 * 而不是让 uiStore / Modal / 每个弹窗互相传 props（三处都要改，漏一处就失效）。
 *
 * 约定：guard 返回 false 表示**拦下这次关闭**（guard 自己负责提示用户）；
 * 第二次关闭请求由 guard 自己放行（「再点一次就放弃改动」的语义在调用方实现）。
 */

type DirtyGuard = () => boolean;

let guard: DirtyGuard | null = null;

/** 注册闸门，返回注销函数（必须在卸载清理里调用，否则关不掉别的弹窗） */
export function setDialogDirtyGuard(next: DirtyGuard | null): () => void {
    guard = next;
    return () => {
        // 只注销自己那一份：新弹窗顶掉旧的之后，旧 cleanup 不该把新的清空
        if (guard === next) guard = null;
    };
}

/** Modal 在 Esc / 遮罩关闭前调用；true = 可以关闭 */
export function dialogCanClose(): boolean {
    return guard ? guard() : true;
}

/** 仅测试与排障用：当前是否挂着闸门 */
export function hasDialogDirtyGuard(): boolean {
    return guard !== null;
}
