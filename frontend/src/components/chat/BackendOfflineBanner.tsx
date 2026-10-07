"use client";

import { WifiOff } from "lucide-react";
import { retryBackendNow } from "@/hooks/useBackendWatcher";
import { offlineBannerText } from "@/lib/backendWatcher";
import { useUiStore } from "@/stores/uiStore";

/**
 * 后端离线横幅（B7-3）。
 *
 * 只在**确认离线**时出现：`unknown`（还没探过）不弹，否则每次刷新都会闪一下假的故障。
 * 常驻而不是 toast：这是「现在正在影响使用」的持续状态，三秒钟就消失的提示等于没说。
 * 恢复由 watcher 负责（自动重拉历史 + 回灌 Key），横幅自己消失，用户不用刷新页面。
 */
export default function BackendOfflineBanner() {
    const backendState = useUiStore((s) => s.backendState);
    const text = offlineBannerText(backendState);
    if (!text) return null;

    return (
        // role=status + aria-live=polite：读屏用户也要被告知「她听不见了」，
        // 而不是对着一个按了没反应的输入框怀疑自己
        <div
            role="status"
            aria-live="polite"
            className="mx-4 mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-status-warning/40 bg-status-warning/10 px-4 py-2.5 text-content-primary md:mx-6"
        >
            <WifiOff size={16} className="shrink-0 text-status-warning" aria-hidden />
            <p className="min-w-0 flex-1 text-xs leading-relaxed">{text}</p>
            <button
                type="button"
                onClick={retryBackendNow}
                className="shrink-0 rounded-full border border-status-warning/50 px-3 py-1 text-xs font-medium text-status-warning transition-colors hover:bg-status-warning/15"
            >
                立即重试
            </button>
        </div>
    );
}
