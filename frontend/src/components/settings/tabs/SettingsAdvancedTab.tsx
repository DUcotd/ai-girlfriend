"use client";

import { ShieldAlert } from "lucide-react";
import Button from "@/components/ui/Button";
import Note from "@/components/ui/Note";
import Switch from "@/components/ui/Switch";
import type { CompanionConfig } from "@/lib/storage";

interface SettingsAdvancedTabProps {
    /** 点击「完全重置」（确认弹窗由外壳持有） */
    onReset: () => void;
    /** 陪伴感三子系统开关（值由外壳持有，保存时统一下发） */
    companion: CompanionConfig;
    onCompanionChange: (patch: Partial<CompanionConfig>) => void;
}

/** 三个子系统开关的文案：一句话说清「关掉会退回什么」 */
const COMPANION_TOGGLES = [
    {
        key: "userEmotionEnabled",
        label: "读懂你的情绪",
        desc: "关掉后她不再追踪你的情绪时间线，也不会「先共情再回应」，退回只描述自己情绪的改造前行为。",
    },
    {
        key: "narrativeEnabled",
        label: "我们的故事",
        desc: "关掉后不再沉淀共同经历（第一次、约定、纪念日），也不会主动提起「你还记得那次…」。",
    },
    {
        key: "triggerEnabled",
        label: "事件驱动的主动关心",
        desc: "关掉后主动消息退回纯定时轮询：情绪转折、纪念日、约定到期都不会触发她来找你。",
    },
] as const;

/** 设置 → 系统：陪伴感子系统开关 + 危险操作区。 */
export default function SettingsAdvancedTab({
    onReset,
    companion,
    onCompanionChange,
}: SettingsAdvancedTabProps) {
    return (
        <div className="space-y-6">
            <div className="space-y-3">
                <h4 className="text-xs font-bold text-content-secondary">陪伴感子系统</h4>
                {COMPANION_TOGGLES.map(({ key, label, desc }) => (
                    <div key={key} className="rounded-2xl border border-line-subtle bg-surface-2/50 p-4">
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-xs font-bold text-content-primary">{label}</span>
                            <Switch
                                checked={companion[key]}
                                onChange={(checked) => onCompanionChange({ [key]: checked })}
                                label={label}
                            />
                        </div>
                        <Note className="mt-2">{desc}</Note>
                    </div>
                ))}
                <p className="text-[10px] text-content-tertiary">
                    改动需点右下角「保存」生效；保存后会写入后端并持久化，重启不再弹回默认值。
                </p>
            </div>

            <div className="space-y-3 rounded-2xl border border-status-danger/25 bg-status-danger/5 p-4">
                <h4 className="flex items-center gap-1 text-xs font-bold text-status-danger">
                    <ShieldAlert size={14} /> 危险操作
                </h4>
                <Button variant="danger" size="sm" className="w-full py-2.5" onClick={onReset}>
                    🔄 完全重置小爱 (不可逆)
                </Button>
                <p className="text-center text-[10px] text-status-danger/80">
                    这将清空好感度、性格、情绪、全部任务、长期记忆、主动消息状态与生活日志，此操作不可恢复。
                </p>
            </div>

            <div className="space-y-2 rounded-2xl border border-line-subtle bg-surface-2/50 p-4 text-[11px] italic text-content-secondary">
                <p>前端: Next.js 16</p>
                <p>后端接口详见 README 的「API 一览」</p>
            </div>
        </div>
    );
}
