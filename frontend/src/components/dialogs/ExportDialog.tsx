"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import Button from "../ui/Button";
import Dialog from "../ui/Dialog";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api";
import { toApiError } from "@/lib/apiError";
import { buildExport } from "@/lib/chatExport";
import { useToast } from "../ui/Toast";
import type { Message } from "@/types";

interface ExportDialogProps {
    messages: Message[];
    onClose: () => void;
}

/**
 * 导出聊天记录（FE-09）。
 *
 * 旧实现直接导出**内存里的 messages** —— 那是刷新时 `/history` 的一屏，
 * 用户以为拿到了完整备份，实际可能只有最近几十条。
 * 现在导出前先向服务器要一次全量历史；拉不到就明确失败，绝不拿本地残档冒充备份。
 */
export default function ExportDialog({ messages, onClose }: ExportDialogProps) {
    const [exportFormat, setExportFormat] = useState<"json" | "txt">("txt");
    const [isLoading, setIsLoading] = useState(false);
    const showToast = useToast();

    // 弹窗打开时先向服务器要一次全量历史（后端 /history 就是它保留的全部）
    const [serverMessages, setServerMessages] = useState<Message[] | null>(null);
    useEffect(() => {
        let cancelled = false;
        api.getHistory()
            .then((list) => {
                if (!cancelled) setServerMessages(list);
            })
            .catch((e) => {
                if (cancelled) return;
                console.error("Export: fetch history failed", e);
                showToast("取不到服务器历史，导出可能不完整", "error");
            });
        return () => {
            cancelled = true;
        };
    }, [showToast]);

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

    const handleExport = () => {
        const source = serverMessages ?? messages;
        if (source.length === 0) {
            showToast("没有可导出的消息", "info");
            return;
        }
        setIsLoading(true);
        try {
            const now = new Date();
            const content = buildExport(source, exportFormat, {
                exportedAt: now.toISOString(),
                exportedAtLocal: now.toLocaleString("zh-CN"),
            });
            downloadFile(
                content,
                generateFileName(exportFormat),
                exportFormat === "json" ? "application/json" : "text/plain;charset=utf-8"
            );
            onClose();
        } catch (e) {
            console.error("Export failed", e);
            showToast(`导出失败：${toApiError(e).userMessage || "未知错误"}`, "error");
            setIsLoading(false);
        }
    };

    const count = (serverMessages ?? messages).length;

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
                        {serverMessages === null ? "读取中…" : `${count} 条`}
                    </span>
                </div>
                {/* 备份口径必须写清楚：这是服务器保留的全部历史，不是当前屏幕 */}
                <p className="mt-1 text-[10px] text-content-muted">
                    {serverMessages === null
                        ? "正在向小爱要完整历史"
                        : "以服务器保留的完整历史为准"}
                </p>
            </div>

            {/* 格式选择 */}
            <div className="mb-4">
                <p className="mb-2 text-sm font-medium">导出格式</p>
                <div className="flex gap-2">
                    {formatOptions.map((opt) => (
                        <button
                            key={opt.id}
                            onClick={() => setExportFormat(opt.id)}
                            aria-pressed={exportFormat === opt.id}
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
                disabled={isLoading || count === 0}
                className="w-full py-3"
            >
                {isLoading ? (
                    <span className="inline-flex items-center gap-2">
                        <Loader2 size={16} className="animate-spin" /> 导出中…
                    </span>
                ) : count === 0 ? (
                    "暂无消息可导出"
                ) : (
                    "开始导出 ✨"
                )}
            </Button>
        </Dialog>
    );
}
