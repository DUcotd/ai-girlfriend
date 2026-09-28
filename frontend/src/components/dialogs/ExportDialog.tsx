"use client";

import { useState } from "react";
import Button from "../ui/Button";
import Dialog from "../ui/Dialog";
import { cn } from "@/lib/cn";
import type { Message } from "@/types";

interface ExportDialogProps {
    messages: Message[];
    onClose: () => void;
}

export default function ExportDialog({ messages, onClose }: ExportDialogProps) {
    const [exportFormat, setExportFormat] = useState<"json" | "txt">("txt");

    const generateFileName = (ext: string) => {
        const date = new Date().toISOString().split("T")[0];
        return `小爱聊天记录_${date}.${ext}`;
    };

    const downloadFile = (content: string, filename: string, mimeType: string) => {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const exportAsJSON = () => {
        const data = {
            exportDate: new Date().toISOString(),
            totalMessages: messages.length,
            messages: messages,
        };
        downloadFile(
            JSON.stringify(data, null, 2),
            generateFileName("json"),
            "application/json"
        );
        onClose();
    };

    const exportAsTXT = () => {
        let content = `💕 小爱聊天记录 💕\n`;
        content += `导出时间: ${new Date().toLocaleString("zh-CN")}\n`;
        content += `消息总数: ${messages.length}\n`;
        content += `${"=".repeat(40)}\n\n`;

        messages.forEach((msg) => {
            const sender = msg.role === "user" ? "👤 我" : "💖 小爱";
            content += `${sender}:\n${msg.content}\n\n`;
        });

        content += `${"=".repeat(40)}\n`;
        content += `感谢使用 AI 女友应用 ❤️\n`;

        downloadFile(content, generateFileName("txt"), "text/plain;charset=utf-8");
        onClose();
    };

    const handleExport = () => {
        if (exportFormat === "json") {
            exportAsJSON();
        } else {
            exportAsTXT();
        }
    };

    const formatOptions = [
        { id: "txt" as const, label: "📝 纯文本" },
        { id: "json" as const, label: "📊 JSON 格式" },
    ];

    return (
        <Dialog title="💾 导出聊天记录" onClose={onClose} widthClassName="w-80">
            {/* 统计 */}
            <div className="mb-4 rounded-2xl bg-accent-1/10 p-4">
                <div className="flex justify-between text-sm">
                    <span className="text-content-secondary">消息数量</span>
                    <span className="font-bold text-accent-strong dark:text-accent-1">
                        {messages.length} 条
                    </span>
                </div>
            </div>

            {/* 格式选择 */}
            <div className="mb-4">
                <p className="mb-2 text-sm font-medium">导出格式</p>
                <div className="flex gap-2">
                    {formatOptions.map((opt) => (
                        <button
                            key={opt.id}
                            onClick={() => setExportFormat(opt.id)}
                            className={cn(
                                "flex-1 rounded-xl py-2 text-sm font-medium transition-all",
                                exportFormat === opt.id
                                    ? "bg-accent-1/15 text-accent-strong ring-2 ring-accent-1 dark:text-accent-1"
                                    : "bg-surface-2 text-content-secondary hover:bg-surface-2/70"
                            )}
                        >
                            {opt.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* 格式说明 */}
            <p className="mb-4 text-xs text-content-secondary">
                {exportFormat === "txt"
                    ? "纯文本格式，方便阅读和打印"
                    : "JSON 格式，包含完整数据，适合备份"}
            </p>

            {/* 导出按钮 */}
            <Button
                onClick={handleExport}
                disabled={messages.length === 0}
                className="w-full py-3"
            >
                {messages.length === 0 ? "暂无消息可导出" : "开始导出 ✨"}
            </Button>
        </Dialog>
    );
}
