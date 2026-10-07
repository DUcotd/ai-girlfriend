import { describe, expect, it } from "vitest";
import {
    NOTIFY_HIDDEN_BODY,
    notificationBody,
    parseNotifyPrivacy,
    parseSpeakProactive,
} from "../notifyPrivacy";
import { proactiveTypingDelay, shouldSpeakProactive } from "../proactiveDisplay";

/** 通知隐私与主动消息朗读（FE-15 / P8） */
describe("notifyPrivacy", () => {
    it("默认隐藏正文：读不到值、脏值、空串都算 hidden", () => {
        expect(parseNotifyPrivacy(undefined)).toBe("hidden");
        expect(parseNotifyPrivacy(null)).toBe("hidden");
        expect(parseNotifyPrivacy("")).toBe("hidden");
        expect(parseNotifyPrivacy("true")).toBe("hidden");
        expect(parseNotifyPrivacy("preview")).toBe("preview");
    });

    it("hidden 时通知正文不含她说的原话", () => {
        const body = notificationBody("你昨天说和谁一起吃的饭？", "hidden");
        expect(body).toBe(NOTIFY_HIDDEN_BODY);
        expect(body).not.toContain("谁一起吃");
    });

    it("preview 时才显示原话", () => {
        expect(notificationBody("想你", "preview")).toBe("想你");
    });

    it("朗读开关缺省为开，只有显式 false 才关", () => {
        expect(parseSpeakProactive(null)).toBe(true);
        expect(parseSpeakProactive("true")).toBe(true);
        expect(parseSpeakProactive("false")).toBe(false);
    });
});

describe("shouldSpeakProactive", () => {
    it("页面隐藏时一律不朗读（通知照发）", () => {
        expect(shouldSpeakProactive({ voiceMode: true, speakProactive: true, hidden: true })).toBe(false);
    });

    it("两个开关任一关掉都不朗读", () => {
        expect(shouldSpeakProactive({ voiceMode: false, speakProactive: true, hidden: false })).toBe(false);
        expect(shouldSpeakProactive({ voiceMode: true, speakProactive: false, hidden: false })).toBe(false);
        expect(shouldSpeakProactive({ voiceMode: true, speakProactive: true, hidden: false })).toBe(true);
    });
});

describe("proactiveTypingDelay", () => {
    it("钳在 800~2000ms 之间", () => {
        expect(proactiveTypingDelay("hi")).toBe(800);
        expect(proactiveTypingDelay("x".repeat(500))).toBe(2000);
        // 30ms/字：40 字 = 1200ms，落在窗口内
        expect(proactiveTypingDelay("x".repeat(40))).toBe(1200);
    });
});
