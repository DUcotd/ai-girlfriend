import { describe, expect, it } from "vitest";
import { formatLlmCallsLine, formatTurnCalls, llmCallChannels, type LlmCallsSnapshot } from "../llmCallsDisplay";

/** 模型调用计数展示（B1-2）：老后端没下发时必须「什么都不显示」，不能显示 0 次骗人。 */

const SNAP: LlmCallsSnapshot = {
    turnId: 7,
    turnStartedAt: 1_700_000_000_000,
    turn: { chat: 0, chatStream: 1, proactive: 0, fact: 1, narrative: 0, embedding: 0, tts: 0, asr: 0, total: 2 },
    lastHour: { chat: 3, chatStream: 9, proactive: 2, fact: 8, narrative: 4, embedding: 6, tts: 1, asr: 1, total: 34, windowMs: 3_600_000 },
    labelsZh: {
        chat: "主对话",
        chatStream: "主对话(流式)",
        proactive: "主动消息",
        fact: "事实提取",
        narrative: "叙事抽取",
        embedding: "嵌入",
        tts: "朗读",
        asr: "转写",
    },
};

describe("llmCallsDisplay", () => {
    it("通道清单与顺序完全跟后端下发的一致，不自己抄一份", () => {
        expect(llmCallChannels(SNAP)).toEqual([
            "chat", "chatStream", "proactive", "fact", "narrative", "embedding", "tts", "asr",
        ]);
    });

    it("本轮明细用中文标签", () => {
        expect(formatTurnCalls(SNAP)).toBe(
            "主对话 0 · 主对话(流式) 1 · 主动消息 0 · 事实提取 1 · 叙事抽取 0 · 嵌入 0 · 朗读 0 · 转写 0"
        );
    });

    it("总览一行含轮次、本轮总数与窗口总数", () => {
        const line = formatLlmCallsLine(SNAP);
        expect(line).toContain("第 7 轮");
        expect(line).toContain("本轮 2 次");
        expect(line).toContain("近 60 分钟共 34 次");
    });

    it("窗口长度按后端给的 windowMs 折算，不写死 60 分钟", () => {
        const short = { ...SNAP, lastHour: { ...SNAP.lastHour!, windowMs: 300_000 } };
        expect(formatLlmCallsLine(short)).toContain("近 5 分钟");
    });

    it("后端没下发 llmCalls（老进程）→ 整句为空，界面不显示这一行", () => {
        expect(formatLlmCallsLine(undefined)).toBe("");
        expect(formatLlmCallsLine(null)).toBe("");
        expect(formatLlmCallsLine({})).toBe("");
        expect(formatTurnCalls({})).toBe("");
    });

    it("没 labelsZh 时用通道名兜底，不显示 undefined", () => {
        const bare: LlmCallsSnapshot = { turn: { chat: 1, total: 1 }, lastHour: { total: 1 } };
        expect(formatTurnCalls(bare)).toBe("chat 1");
    });
});
