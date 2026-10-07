"use client";

import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Note from "@/components/ui/Note";
import Switch from "@/components/ui/Switch";
import DataBackupPanel from "@/components/settings/DataBackupPanel";
import { api, hasAuthToken, setAuthToken } from "@/lib/api";
import { formatLlmCallsLine } from "@/lib/llmCallsDisplay";
import type { LlmCallsSnapshot } from "@/lib/llmCallsDisplay";
import { useToast } from "@/components/ui/Toast";
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

/**
 * 设置 → 系统：访问令牌 + 陪伴感子系统开关 + 危险操作区。
 *
 * 为什么要专门给一个令牌输入框（FE-08 / HTTP-05）：后端一旦设了
 * `AI_GIRLFRIEND_API_KEY` 之外的 `AI_GIRLFRIEND_TOKEN`（或监听在非本机地址），
 * 所有请求都会 401；此前这个值只能靠 DevTools 手敲 localStorage 写进
 * `ai-girlfriend-token`，界面上的报错却只会说「请确认后端已启动」——
 * 用户照着查网络，而真正缺的是这一格令牌。
 */
export default function SettingsAdvancedTab({
    onReset,
    companion,
    onCompanionChange,
}: SettingsAdvancedTabProps) {
    const showToast = useToast();
    const [tokenDraft, setTokenDraft] = useState("");
    /** 只记「存没存过」，绝不在界面上回显令牌内容 */
    const [tokenStored, setTokenStored] = useState(() => hasAuthToken());

    const handleSaveToken = () => {
        const saved = setAuthToken(tokenDraft);
        setTokenStored(saved);
        if (saved) {
            setTokenDraft("");
            showToast("访问令牌已保存在本机，刷新即生效", "success");
        } else {
            showToast("已清除访问令牌（输入框留空即为清除）", "info");
        }
    };

    /**
     * 模型调用计数（B1-2）：这轮到底调了几次模型，以前完全不可观测。
     * 打开这一格时取一次快照即可（不是实时仪表盘），通道清单与中文名都跟后端下发的一致。
     */
    const [llmCalls, setLlmCalls] = useState<LlmCallsSnapshot | null>(null);
    useEffect(() => {
        let cancelled = false;
        api.getConfigStatus()
            .then((data) => {
                if (!cancelled) setLlmCalls(data.llmCalls ?? null);
            })
            .catch(() => {
                // 后端没起来：下面按「没有计数」如实说明，不显示一排 0
            });
        return () => {
            cancelled = true;
        };
    }, []);
    const callsLine = formatLlmCallsLine(llmCalls);

    return (
        <div className="space-y-6">
            <div className="space-y-3">
                <h4 className="text-xs font-bold text-content-secondary">模型调用计数（排障用）</h4>
                <div className="rounded-2xl border border-line-subtle bg-surface-2/50 p-4">
                    {callsLine ? (
                        <p role="status" className="text-[11px] leading-relaxed text-content-secondary">
                            {callsLine}
                        </p>
                    ) : (
                        <p className="text-[11px] text-content-muted">
                            后端还没有下发调用计数（老进程或还没聊过天）。发一条消息后重开这个页签就能看到。
                        </p>
                    )}
                    <p className="mt-1 text-[10px] text-content-muted">
                        这是「她这轮做了多少事」的观测口，不是配额，也不是省钱开关。
                    </p>
                </div>
            </div>

            <div className="space-y-3">
                <h4 className="text-xs font-bold text-content-secondary">后端访问令牌</h4>
                <div className="space-y-2 rounded-2xl border border-line-subtle bg-surface-2/50 p-4">
                    <p className="text-[11px] leading-relaxed text-content-muted">
                        后端配置了 <code>AI_GIRLFRIEND_TOKEN</code>，或监听在非 127.0.0.1 的地址时，
                        每个请求都要带这把令牌。留空保存 = 清除。
                    </p>
                    <div className="flex gap-2">
                        <Input
                            type="password"
                            value={tokenDraft}
                            onChange={(e) => setTokenDraft(e.target.value)}
                            placeholder={tokenStored ? "已保存令牌（输入新值可覆盖）" : "填写访问令牌"}
                            aria-label="后端访问令牌"
                            className="flex-1 py-2 text-sm"
                            autoComplete="off"
                        />
                        <Button onClick={handleSaveToken} className="px-4 py-2 text-xs">
                            保存
                        </Button>
                    </div>
                    <p className="text-[10px] text-content-muted">
                        当前状态：{tokenStored ? "本机已保存令牌" : "本机未保存令牌（未启用鉴权的后端不需要）"}
                    </p>
                </div>
            </div>

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

            <DataBackupPanel />

            <div className="space-y-3 rounded-2xl border border-status-danger/25 bg-status-danger/5 p-4">
                <h4 className="flex items-center gap-1 text-xs font-bold text-status-danger">
                    <ShieldAlert size={14} /> 危险操作
                </h4>
                <Button variant="danger" size="sm" className="w-full py-2.5" onClick={onReset}>
                    🔄 完全重置小爱
                </Button>
                <p className="text-center text-[10px] text-status-danger/80">
                    这将清空好感度、性格、情绪、全部任务、长期记忆、主动消息状态与生活日志。
                    重置前会自动存一份快照（见上方「数据与备份」），万一后悔还能恢复回去 ——
                    但只有「最近几次」，想长期留存请点「导出档案」把数据拿到自己手里。
                </p>
            </div>

            <div className="space-y-2 rounded-2xl border border-line-subtle bg-surface-2/50 p-4 text-[11px] italic text-content-secondary">
                <p>前端: Next.js 16</p>
                <p>后端接口详见 README 的「API 一览」</p>
            </div>
        </div>
    );
}
