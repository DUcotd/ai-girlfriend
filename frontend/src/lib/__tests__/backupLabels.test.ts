import { describe, expect, it } from "vitest";
import { describeSnapshotReason, formatSnapshotName } from "@/lib/backupLabels";

/**
 * 快照名字的展示逻辑（B5-12）。
 *
 * 后端给的快照标识是目录名 `2026-10-06T16-49-30-108Z-pre-import`，
 * 用户要在里面挑一份恢复 —— 挑错份的代价是「把几周前的状态盖回现在」。
 * 所以时间必须翻准、来源必须说清，认不出来时宁可原样显示也不能显示错时间。
 */
describe("备份快照名称", () => {
    it("时间戳翻成人话，来源翻成中文", () => {
        expect(formatSnapshotName("2026-10-06T16-49-30-108Z-pre-import"))
            .toBe("2026-10-06 16:49:30 · 导入档案前");
    });

    it("恢复快照前的那份也标得出来（带被恢复的快照尾巴）", () => {
        const name = formatSnapshotName("2026-10-06T16-51-04-021Z-pre-restore-abc");
        expect(name).toContain("恢复快照前");
        expect(name).toContain("abc");
    });

    it("没有来源段时只显示时间，不留孤零零的分隔符", () => {
        expect(formatSnapshotName("2026-10-06T16-51-04-021Z-")).toBe("2026-10-06 16:51:04");
    });

    it("认不出的格式原样返回，绝不猜时间", () => {
        expect(formatSnapshotName("手工建的目录")).toBe("手工建的目录");
        expect(formatSnapshotName("2026-10-06 16-49-30")).toBe("2026-10-06 16-49-30");
    });

    it("reason 有中文映射，未知值原样透出", () => {
        expect(describeSnapshotReason("pre-reset")).toBe("完全重置前");
        expect(describeSnapshotReason("manual")).toBe("手动备份");
        expect(describeSnapshotReason("weekly-job")).toBe("weekly-job");
        expect(describeSnapshotReason(null)).toBe("未标注来源");
    });
});
