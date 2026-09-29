/**
 * 本地自然日 key（YYYY-MM-DD，按本机时区）。
 *
 * 为什么单独成文件：好感度的「每日涨分上限」与主动消息的「每日配额」
 * 必须共用同一个「自然日」口径（本地 00:00 重置），否则用户会在两条链路
 * 上看到不一致的「今天」。此前它内联在 ProactiveEngine 里，只能从
 * core 反向 import core（依赖方向 core → core）；抽到 utils 后方向变成
 * core → utils，任一方日后新增反向依赖都不会成环。
 */
export function dayKey(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
