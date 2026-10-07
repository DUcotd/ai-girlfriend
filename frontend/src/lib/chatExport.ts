/**
 * 聊天记录导出（纯函数）。
 *
 * FE-09：旧实现导出的是**内存里的 messages**——刷新前只拉过一页、或者后端中途重启过，
 * 导出的文件就和后端真实历史不一致，而用户以为备份下来了。
 * 现在导出前先向服务器要全量历史，再由这两个纯函数把历史渲染成文件内容。
 */

export interface ExportMessage {
    role: string;
    content: string;
    timestamp?: number;
}

export interface ExportMeta {
    /** 导出时间（ISO 字符串）；由调用方传入以便测试确定化 */
    exportedAt: string;
    /** 本地化后的导出时间，写进 TXT 头部 */
    exportedAtLocal?: string;
}

const ROLE_LABELS: Record<string, string> = {
    user: "👤 我",
    assistant: "💖 小爱",
    system: "· 系统",
};

export function roleLabel(role: string): string {
    return ROLE_LABELS[role] ?? `· ${role}`;
}

export function buildJsonExport(messages: ExportMessage[], meta: ExportMeta): string {
    return JSON.stringify(
        {
            exportDate: meta.exportedAt,
            totalMessages: messages.length,
            messages,
        },
        null,
        2
    );
}

export function buildTxtExport(messages: ExportMessage[], meta: ExportMeta): string {
    const head = meta.exportedAtLocal ?? meta.exportedAt;
    let content = `💕 小爱聊天记录 💕\n`;
    content += `导出时间: ${head}\n`;
    content += `消息总数: ${messages.length}\n`;
    content += `${"=".repeat(40)}\n\n`;
    for (const msg of messages) {
        content += `${roleLabel(msg.role)}:\n${msg.content}\n\n`;
    }
    content += `${"=".repeat(40)}\n`;
    content += `感谢使用 AI 女友应用 ❤️\n`;
    return content;
}

export function buildExport(messages: ExportMessage[], format: "json" | "txt", meta: ExportMeta): string {
    return format === "json" ? buildJsonExport(messages, meta) : buildTxtExport(messages, meta);
}
