import { describe, expect, it } from "vitest";
import { buildExport, buildJsonExport, buildTxtExport, roleLabel } from "../chatExport";

/** 导出内容（FE-09）：文件必须等于「服务器保留的完整历史」，格式可预期。 */
const MESSAGES = [
    { role: "user", content: "今天加班到十点" },
    { role: "assistant", content: "辛苦了，要不要先吃点东西" },
    { role: "system", content: "💔 已读不回..." },
];
const META = { exportedAt: "2026-10-07T00:00:00.000Z", exportedAtLocal: "2026/10/7 08:00:00" };

describe("chatExport", () => {
    it("JSON 导出带导出时间与条数，消息原样在内", () => {
        const parsed = JSON.parse(buildJsonExport(MESSAGES, META));
        expect(parsed.exportDate).toBe(META.exportedAt);
        expect(parsed.totalMessages).toBe(3);
        expect(parsed.messages[1].content).toContain("辛苦了");
    });

    it("TXT 导出按角色分行，含系统消息", () => {
        const text = buildTxtExport(MESSAGES, META);
        expect(text).toContain(`导出时间: ${META.exportedAtLocal}`);
        expect(text).toContain("消息总数: 3");
        expect(text).toContain(`👤 我:\n今天加班到十点`);
        expect(text).toContain(`💖 小爱:\n辛苦了，要不要先吃点东西`);
        expect(text).toContain("· 系统:");
    });

    it("未知角色不丢消息，用角色名标出来", () => {
        expect(roleLabel("tool")).toBe("· tool");
        expect(buildTxtExport([{ role: "tool", content: "x" }], META)).toContain("· tool:\nx");
    });

    it("buildExport 按格式分派", () => {
        expect(buildExport(MESSAGES, "json", META)).toContain('"totalMessages": 3');
        expect(buildExport(MESSAGES, "txt", META)).toContain("感谢使用");
    });

    it("空历史也产出合法文件（不抛异常）", () => {
        expect(JSON.parse(buildJsonExport([], META)).totalMessages).toBe(0);
        expect(buildTxtExport([], META)).toContain("消息总数: 0");
    });
});
