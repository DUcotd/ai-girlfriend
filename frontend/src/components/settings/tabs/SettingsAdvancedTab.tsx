"use client";

import { ShieldAlert } from "lucide-react";
import Button from "@/components/ui/Button";

interface SettingsAdvancedTabProps {
    /** 点击「完全重置」（确认弹窗由外壳持有） */
    onReset: () => void;
}

/** 设置 → 系统：危险操作区 + 版本信息。 */
export default function SettingsAdvancedTab({ onReset }: SettingsAdvancedTabProps) {
    return (
        <div className="space-y-6">
            <div className="space-y-3 rounded-2xl border border-status-danger/25 bg-status-danger/5 p-4">
                <h4 className="flex items-center gap-1 text-xs font-bold text-status-danger">
                    <ShieldAlert size={14} /> 危险操作
                </h4>
                <Button variant="danger" size="sm" className="w-full py-2.5" onClick={onReset}>
                    🔄 完全重置小爱 (不可逆)
                </Button>
                <p className="text-center text-[10px] text-status-danger/80">
                    这将清空好感度、性格、情绪、全部任务、长期记忆与对话记录，此操作不可恢复。
                </p>
            </div>

            <div className="space-y-2 rounded-2xl border border-line-subtle bg-surface-2/50 p-4 text-[11px] italic text-content-secondary">
                <p>后端 API 版本: v1.2.0</p>
                <p>前端版本: Next.js 16</p>
            </div>
        </div>
    );
}
