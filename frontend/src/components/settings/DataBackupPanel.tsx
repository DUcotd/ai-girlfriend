"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, HardDriveDownload, History, UploadCloud } from "lucide-react";
import Button from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api";
import { formatSnapshotName } from "@/lib/backupLabels";
import type { BackupStatus } from "@/types";


/**
 * 数据与备份面板（B5-12）。
 *
 * 为什么值得在设置页占一格：这个应用的全部关系只存在于后端那几个 JSON 里，
 * 而在做这块之前**没有任何恢复路径** —— 「完全重置」按下去就没了，
 * 换机器要手动拷目录。现在导出是一个按钮、导入是一个文件，
 * 重置前还会自动留一份快照（面板里能看到它在哪）。
 *
 * 刻意不做的两件事：
 * · 不做「自动定时备份」——没有调度器，且默认往磁盘写用户对话副本需要更慎重的取舍；
 * · 不在浏览器里存档案（localStorage 装不下，也不该装）。
 */
export default function DataBackupPanel() {
    const [status, setStatus] = useState<BackupStatus | null>(null);
    const [busy, setBusy] = useState<"" | "export" | "import" | "snapshot" | "restore">("");
    const [offline, setOffline] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);
    const showToast = useToast();

    const load = useCallback(async (signal?: { cancelled: boolean }) => {
        try {
            const data = await api.getBackupStatus();
            if (signal?.cancelled) return;
            setStatus(data);
            setOffline(false);
        } catch {
            // 后端没起 / 版本旧（没有 /backup/*）：整块降级成一行说明，不抛错
            if (!signal?.cancelled) setOffline(true);
        }
    }, []);

    // 与 ProactiveStatusStrip 同一写法：setState 关在局部 run() 里而不是 effect 体内直接调用
    // （react-hooks/set-state-in-effect 这条规则会拦），signal 用来兜住
    // 「组件已卸载但请求才回来」的 setState。
    useEffect(() => {
        const signal = { cancelled: false };
        const run = () => {
            void load(signal);
        };
        run();
        return () => { signal.cancelled = true; };
    }, [load]);

    async function withBusy<T>(kind: typeof busy, fn: () => Promise<T>, failPrefix: string) {
        setBusy(kind);
        try {
            return await fn();
        } catch (e) {
            showToast(`${failPrefix}：${(e as Error).message}`, "error");
            return null;
        } finally {
            setBusy("");
        }
    }

    async function onExport() {
        const got = await withBusy("export", () => api.exportArchive(), "导出失败");
        if (!got) return;
        const url = URL.createObjectURL(got.blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = got.filename;
        a.click();
        // 浏览器对 blob URL 没有自动回收，不释放会一直占着内存
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        showToast(`已导出 ${got.filename}`, "success");
    }

    async function onPickFile(file: File) {
        let parsed: unknown = null;
        try {
            parsed = JSON.parse(await file.text());
        } catch {
            showToast("这个文件不是合法的 JSON，选错文件了吗？", "error");
            return;
        }
        // 导入前先看一眼它像不像一份档案，并让用户明确知道会被覆盖什么
        const kind = (parsed as { kind?: string } | null)?.kind;
        if (kind !== "ai-girlfriend-archive") {
            showToast("这份 JSON 不是小爱的档案（缺 kind 标识），已取消", "error");
            return;
        }
        const ok = window.confirm(
            "导入会覆盖当前的全部对话、记忆、好感度与性格。\n\n" +
            "后端会先把现在的状态存成一份快照（在设置页下方能看到路径），随时可以再恢复回去。\n\n确定继续吗？"
        );
        if (!ok) return;
        const report = await withBusy("import", () => api.importArchive(parsed), "导入失败");
        if (!report) return;
        if (report.writeFailed?.length) {
            showToast(`部分文件写入失败：${report.writeFailed.join(", ")}`, "error");
        } else if (report.restartRecommended) {
            showToast("导入完成，但有引擎没能热加载 —— 请重启后端一次", "info");
        } else {
            showToast("导入完成，已生效", "success");
        }
        void load();
    }

    async function onSnapshot() {
        const r = await withBusy("snapshot", () => api.createSnapshot("manual"), "快照失败");
        if (r) showToast(`已存一份快照（${r.files.length} 个文件）`, "success");
        void load();
    }

    async function onRestore(id: string) {
        if (!window.confirm(`恢复这份快照？\n\n${formatSnapshotName(id)}\n\n当前状态会先被另存一份，所以还能再退回来。`)) {
            return;
        }
        const r = await withBusy("restore", () => api.restoreSnapshot(id), "恢复失败");
        if (r) showToast(r.restartRecommended ? "已恢复，但请重启后端确保全部生效" : "已恢复", "success");
        void load();
    }

    if (offline) {
        return (
            <div className="space-y-2 rounded-2xl border border-line-subtle bg-surface-2/50 p-4">
                <h4 className="flex items-center gap-1 text-xs font-bold text-content-secondary">
                    <HardDriveDownload size={14} /> 数据与备份
                </h4>
                <p className="text-[10px] text-content-tertiary">
                    当前后端没有提供档案接口（多半是版本较旧）。重启后端后即可在此导出/导入整份数据。
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-3 rounded-2xl border border-line-subtle bg-surface-2/50 p-4">
            <h4 className="flex items-center gap-1 text-xs font-bold text-content-secondary">
                <HardDriveDownload size={14} /> 数据与备份
            </h4>
            <p className="text-[10px] leading-relaxed text-content-tertiary">
                整份关系（对话、记忆、好感度、性格、任务、她这几小时做了什么）都在后端那几个文件里。
                导出来就是一份可下载的 JSON；换机器时把它导入即可。完全重置前也会自动留一份快照。
            </p>

            <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={onExport} disabled={busy !== ""}>
                    <Download size={12} className="mr-1" />
                    {busy === "export" ? "导出中…" : "导出档案"}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()} disabled={busy !== ""}>
                    <UploadCloud size={12} className="mr-1" />
                    {busy === "import" ? "导入中…" : "导入档案"}
                </Button>
                <Button size="sm" variant="ghost" onClick={onSnapshot} disabled={busy !== ""}>
                    {busy === "snapshot" ? "存盘中…" : "只存一份快照"}
                </Button>
                <input
                    ref={fileRef}
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = "";     // 同一个文件再选一次也要能触发
                        if (f) void onPickFile(f);
                    }}
                />
            </div>

            <div className="space-y-1">
                <p className="flex items-center gap-1 text-[10px] font-bold text-content-tertiary">
                    <History size={11} /> 服务器上的快照（保留最近 {status?.keep ?? "—"} 份）
                </p>
                {!status?.snapshots?.length ? (
                    <p className="text-[10px] text-content-muted">还没有快照。</p>
                ) : (
                    <ul className="max-h-40 space-y-1 overflow-y-auto pr-1">
                        {status.snapshots.map((s) => (
                            <li key={s.id} className="flex items-center justify-between gap-2 text-[10px]">
                                <span className="truncate text-content-secondary" title={s.dir}>
                                    {formatSnapshotName(s.id)}
                                    {s.files ? ` · ${s.files.length} 个文件` : ""}
                                </span>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    className="shrink-0 px-2 py-1"
                                    disabled={busy !== ""}
                                    onClick={() => onRestore(s.id)}
                                >
                                    {busy === "restore" ? "恢复中…" : "恢复"}
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
                <p className="break-all text-[9px] text-content-muted">
                    备份目录：{status?.backupDir ?? "—"}
                </p>
            </div>
        </div>
    );
}
