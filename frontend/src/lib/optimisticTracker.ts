/**
 * 乐观更新的记账本（FE-07）。
 *
 * 拖动/切换这类即时提交的控件会先改界面再发请求，请求失败必须能退回**改动前**的值。
 * 记原值的规则只有一条：同一轮未确认的改动里，**只有第一次**记下的原值有效
 * （用户连着拖三次，回滚要回到第一次之前的那个值，不是上一次的中间值）。
 *
 * 抽成纯对象是因为这段账目是「界面和后端不一致」的根源，值得被单独测一遍。
 */

export interface OptimisticTracker<K extends string> {
    /** 记下 dim 的原值（已有记录时不覆盖） */
    note(dim: K, previousValue: number): void;
    /** 回滚用的 (dim, 原值) 列表 */
    entries(): [K, number][];
    /** 服务端确认后清空：此后的失败该回滚的是更新的改动 */
    clear(): void;
    /** 当前是否记着原值（用于「无待回滚项」断言） */
    readonly size: number;
}

export function createOptimisticTracker<K extends string>(): OptimisticTracker<K> {
    const prev = new Map<K, number>();
    return {
        note(dim, previousValue) {
            if (!prev.has(dim) && Number.isFinite(previousValue)) prev.set(dim, previousValue);
        },
        entries() {
            return [...prev.entries()];
        },
        clear() {
            prev.clear();
        },
        get size() {
            return prev.size;
        },
    };
}
