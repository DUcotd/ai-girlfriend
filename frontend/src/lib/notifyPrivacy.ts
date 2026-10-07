/**
 * 桌面通知文案（FE-15 / P8）。
 *
 * 默认锁屏不露正文：她发来的内容可能是「你昨天说的那件事后来怎么样了」，
 * 落在锁屏上就是隐私事故。要预览正文得在设置里显式打开。
 */

export type NotifyPrivacy = "hidden" | "preview";

export const NOTIFY_HIDDEN_BODY = "小爱给你发来一条消息";

/** storage 里存的是字符串，脏值必须回落到「隐藏正文」这个更安全的默认 */
export function parseNotifyPrivacy(raw: string | null | undefined): NotifyPrivacy {
    return raw === "preview" ? "preview" : "hidden";
}

export function notificationBody(content: string, mode: NotifyPrivacy): string {
    if (mode === "preview") return content;
    return NOTIFY_HIDDEN_BODY;
}

/** 朗读开关同样是「显式打开才生效」，缺省读不到时保持现有行为（不静音） */
export function parseSpeakProactive(raw: string | null | undefined): boolean {
    return raw !== "false";
}
