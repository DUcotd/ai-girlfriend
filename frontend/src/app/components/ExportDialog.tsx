"use client";

import { useState } from "react";

interface Message {
    role: "user" | "assistant" | "system";
    content: string;
}

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

    return (
        <div className="modal-glass p-6 w-80">
            {/* 标题 */}
            <div className="flex justify-between items-center mb-4">
                <h3 className="font-bold text-lg">💾 导出聊天记录</h3>
                <button
                    onClick={onClose}
                    className="text-gray-400 hover:text-gray-600 transition-colors"
                >
                    ✕
                </button>
            </div>

            {/* 统计 */}
            <div className="bg-pink-50 rounded-2xl p-4 mb-4">
                <div className="flex justify-between text-sm">
                    <span className="text-gray-600">消息数量</span>
                    <span className="font-bold text-pink-600">{messages.length} 条</span>
                </div>
            </div>

            {/* 格式选择 */}
            <div className="mb-4">
                <p className="text-sm font-medium mb-2">导出格式</p>
                <div className="flex gap-2">
                    <button
                        onClick={() => setExportFormat("txt")}
                        className={`flex-1 py-2 rounded-xl text-sm font-medium transition-all ${exportFormat === "txt"
                            ? "bg-pink-100 text-pink-600 ring-2 ring-pink-400"
                            : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                            }`}
                    >
                        📝 纯文本
                    </button>
                    <button
                        onClick={() => setExportFormat("json")}
                        className={`flex-1 py-2 rounded-xl text-sm font-medium transition-all ${exportFormat === "json"
                            ? "bg-pink-100 text-pink-600 ring-2 ring-pink-400"
                            : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                            }`}
                    >
                        📊 JSON 格式
                    </button>
                </div>
            </div>

            {/* 格式说明 */}
            <p className="text-xs text-gray-500 mb-4">
                {exportFormat === "txt"
                    ? "纯文本格式，方便阅读和打印"
                    : "JSON 格式，包含完整数据，适合备份"}
            </p>

            {/* 导出按钮 */}
            <button
                onClick={handleExport}
                disabled={messages.length === 0}
                className="btn-cute w-full py-3 disabled:opacity-50 disabled:cursor-not-allowed"
            >
                {messages.length === 0 ? "暂无消息可导出" : "开始导出 ✨"}
            </button>
        </div>
    );
}
