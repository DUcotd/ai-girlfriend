"use client";

import { useCallback, useEffect, useState } from "react";
import Button from "@/components/ui/Button";
import ProgressBar from "@/components/ui/ProgressBar";
import { useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { ProactiveEngineStatus } from "@/types";

const POLL_MS = 20_000;

interface ProactiveStatusStripProps {
    /** 总开关状态：关闭时不该再产生新消息 */
    enabled: boolean;
}

function Dot() {
    return <span className="text-content-muted/40">·</span>;
}

/**
 * 旧版后端（refactor 之前启动、还没重启）的 /chat/proactive/status 不含
 * quietHours / stageLabel / autoDailyLimit 等字段，直接读会整块崩掉。
 * 这里统一兜底成「未知但可渲染」的值，等后端重启后自然恢复。
 */
function normalizeStatus(raw: ProactiveEngineStatus): ProactiveEngineStatus {
    return {
        ...raw,
        queueSize: raw.queueSize ?? 0,
        dailyMessagesSent: raw.dailyMessagesSent ?? 0,
        dailyLimit: raw.dailyLimit ?? 0,
        autoDailyLimit: raw.autoDailyLimit ?? raw.dailyLimit ?? 0,
        stageLabel: raw.stageLabel || "—",
        affinity: raw.affinity ?? 0,
        affinityBonus: raw.affinityBonus ?? 1,
        quietHours: raw.quietHours ?? { active: false, from: "23:30", to: "07:00" },
        nextEligible: raw.nextEligible ?? {},
        sentToday: raw.sentToday ?? {},
        currentCooldowns: raw.currentCooldowns ?? {},
    };
}

/**
 * 主动消息「运行状态」条。
 *
 * 设置页此前只有静态开关，用户看不到"到底发了没有、还剩多少配额"。
 * 这里直连 /chat/proactive/status（自带轮询，不占用 SettingsDialog 的状态）。
 * 刻意做成一屏高：主内容是下方的类型列表，状态条只做摘要，不能把它挤出可视区。
 */
export default function ProactiveStatusStrip({ enabled }: ProactiveStatusStripProps) {
    const [status, setStatus] = useState<ProactiveEngineStatus | null>(null);
    const [offline, setOffline] = useState(false);
    const [firing, setFiring] = useState(false);
    const showToast = useToast();

    const load = useCallback(async () => {
        try {
            const data = await api.getProactiveStatus();
            setStatus(normalizeStatus(data.engine));
            setOffline(false);
        } catch {
            setOffline(true);
        }
    }, []);

    useEffect(() => {
        let cancelled = false;
        const run = () => {
            if (cancelled) return;
            void load();
        };
        run();
        const timer = setInterval(run, POLL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [load]);

    const handleFire = async () => {
        setFiring(true);
        try {
            await api.triggerProactive("random_chat");
            showToast("小爱正在想说什么…稍后会出现聊天里 ✨", "success");
            await load();
        } catch {
            showToast("触发失败，请检查后端连接", "error");
        } finally {
            setFiring(false);
        }
    };

    const quotaPercent = status && status.dailyLimit > 0
        ? (status.dailyMessagesSent / status.dailyLimit) * 100
        : 0;

    return (
        <div className="rounded-2xl border border-line-subtle bg-surface-2/30 p-4">
            <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                    <h4 className="text-sm font-bold text-content-primary">运行状态</h4>
                    <span
                        className={cn(
                            "flex items-center gap-1.5 text-[10px]",
                            offline ? "text-status-danger" : "text-content-muted"
                        )}
                    >
                        <span
                            className={cn(
                                "h-1.5 w-1.5 rounded-full",
                                offline ? "bg-status-danger" : enabled ? "bg-status-success" : "bg-content-muted/50"
                            )}
                        />
                        {offline ? "未连接后端" : enabled ? "运行中" : "已暂停"}
                    </span>
                </div>
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleFire}
                    disabled={!enabled || firing || offline}
                >
                    {firing ? "生成中…" : "现在发一条"}
                </Button>
            </div>

            {offline || !status ? (
                <p className="mt-2 text-[11px] text-content-muted">
                    {offline
                        ? "拉取不到主动消息引擎状态，请确认后端已启动。"
                        : "正在读取引擎状态…"}
                </p>
            ) : (
                <>
                    <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-content-secondary">
                        <span>
                            今日已发{" "}
                            <b className="text-content-primary">
                                {status.dailyMessagesSent} / {status.dailyLimit} 条
                            </b>
                        </span>
                        <Dot />
                        <span>
                            待送达 <b className="text-content-primary">{status.queueSize} 条</b>
                        </span>
                        <Dot />
                        <span>
                            {status.stageLabel} · 倍率 ×{status.affinityBonus}
                        </span>
                        <Dot />
                        <span className={status.quietHours.active ? "text-status-info" : undefined}>
                            {status.quietHours.active ? "深夜免打扰" : "可打扰"}
                        </span>
                    </div>

                    <ProgressBar value={quotaPercent} className="mt-2 h-1" />

                    <p className="mt-2 text-[10px] leading-relaxed text-content-muted">
                        {status.quietHours.active
                            ? `免打扰时段内只有定时问候与任务提醒会发出（${status.quietHours.from} – ${status.quietHours.to}）`
                            : `想念、闲聊、回忆分享会按好感度与冷却时间随机发出；${status.quietHours.from} – ${status.quietHours.to} 为静音时段`}
                    </p>
                </>
            )}
        </div>
    );
}
