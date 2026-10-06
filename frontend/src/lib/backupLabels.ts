/**
 * 备份相关的人类可读文案（从 DataBackupPanel 里拆出来，为了能单测）。
 *
 * 拆出去的理由：快照的标识就是后端生成的目录名
 * `2026-10-06T16-49-30-108Z-pre-import`，直接摆给用户看等于没看懂；
 * 而这串名字的拆分规则一旦写错（比如换了时间格式），恢复时用户点对的是哪一份都说不清。
 */

/** 后端快照目录名的时间戳前缀：ISO 但把 `:` 和 `.` 换成了 `-` */
const TS_PREFIX = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/;

/** reason 片段翻成中文（后端写死的几种来源） */
const REASONS: Record<string, string> = {
    "manual": "手动备份",
    "pre-reset": "完全重置前",
    "pre-import": "导入档案前",
    "pre-restore": "恢复快照前",
    "ui": "设置页",
};

export function describeSnapshotReason(reason: string | null): string {
    if (!reason) return "未标注来源";
    const exact = REASONS[reason];
    if (exact) return exact;
    // pre-restore-<某份快照 id> 这类带后缀的，取前缀翻译 + 保留原始尾巴
    for (const [key, label] of Object.entries(REASONS)) {
        if (reason.startsWith(`${key}-`)) return `${label}（${reason.slice(key.length + 1)}）`;
    }
    return reason;
}

/**
 * 目录名 → 「2026-10-06 16:49:30 · 导入档案前」。
 * 认不出时间格式时原样返回：宁可显示得难看，也不要显示错时间让用户恢复错份。
 */
export function formatSnapshotName(id: string): string {
    const m = TS_PREFIX.exec(id);
    if (!m) return id;
    const when = `${m[1]} ${m[2]}:${m[3]}:${m[4]}`;
    const reason = id.slice(m[0].length).replace(/^-/, "");
    return reason ? `${when} · ${describeSnapshotReason(reason)}` : when;
}

/** 档案下载文件名是否可信（后端的 Content-Disposition 解析不出来时的兜底） */
export const FALLBACK_ARCHIVE_NAME = "ai-girlfriend-archive.json";
