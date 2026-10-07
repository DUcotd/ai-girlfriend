/**
 * 主动消息的展示策略（纯函数，便于确定性测试）。
 */
import { defaultTypingDelay } from "./proactiveQueue";

/** 「思考中」时长：单一真源，主动消息与手写消息共用 */
export const proactiveTypingDelay = defaultTypingDelay;

/**
 * 消息是否应该由页面自己朗读。
 *
 * 页面隐藏时不朗读（省得对着看不见的屏幕说话），但桌面通知照发 ——
 * 通知承诺的就是「切走以后也能收到她」。
 */
export function shouldSpeakProactive(opts: {
    voiceMode: boolean;
    /** 主动消息单独静音开关（FE-15：朗读可以单独关掉，不影响打字回复的朗读） */
    speakProactive: boolean;
    hidden: boolean;
}): boolean {
    if (opts.hidden) return false;
    return opts.voiceMode && opts.speakProactive;
}
