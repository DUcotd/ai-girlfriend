"use client";

import { useEffect } from "react";
import { api, setNetworkObserver } from "@/lib/api";
import { createBackendWatcher, type BackendWatcher } from "@/lib/backendWatcher";
import { getChatConfig } from "@/lib/storage";
import { useChatStore } from "@/stores/chatStore";
import { useUiStore } from "@/stores/uiStore";

/**
 * 后端可达性监听（B7-3）。挂在 ChatPage 上，与 useBootstrap 同级。
 *
 * 解决的问题：后端是本机可以独立重启的进程。旧版在页面开着时如果后端重启了 ——
 * 聊天一路失败、界面既不说明原因，**后端回来之后也不会自己恢复**，
 * 必须刷新页面才会重新拉历史、才会把浏览器里的 API Key 回灌给后端。
 * 现在：离线立刻出横幅，每 30 秒自动重试，恢复的瞬间重做一遍开机那三件事。
 */

/** 当前挂载的 watcher（给横幅上的「立即重试」按钮用） */
let current: BackendWatcher | null = null;

/** 横幅里的「立即重试」；没挂载 watcher（比如 SSR）时静默忽略 */
export function retryBackendNow(): void {
    void current?.checkNow();
}

/**
 * 恢复在线后必须重做的事，与 useBootstrap 开机那一段保持一致：
 * 1. 配置回灌（后端只把 Key 放在内存里，重启即丢 —— 不做这一步会一路 400）；
 * 2. 重拉状态与历史（离线期间她可能已经生成过主动消息、跑过生活模拟）。
 */
async function resyncAfterRecovery(): Promise<void> {
    const config = getChatConfig();
    if (config.apiKey || config.ttsApiKey || config.embApiKey) {
        try {
            await api.syncConfig(config);
        } catch (e) {
            // 回灌失败不能静默：那正是「明明连上了却每轮都报错」的那类坑
            console.error("[BackendWatcher] resync config failed:", e);
            useUiStore.getState().pushToast("后端已连上，但配置没送进去，请打开设置页重新保存一次", "error");
            return;
        }
    }
    const { syncState, fetchHistory } = useChatStore.getState();
    await Promise.all([syncState(), fetchHistory()]);
    useUiStore.getState().pushToast("后端已重新连上，对话历史已恢复", "success");
}

export function useBackendWatcher(): void {
    useEffect(() => {
        const watcher = createBackendWatcher({
            ping: () => api.healthPing(),
            // onOnline 只在 offline → online 的跳变上触发，所以首次进入页面不会多打一次同步
            onOnline: () => {
                void resyncAfterRecovery().catch((e) => {
                    console.error("[BackendWatcher] resync failed:", e);
                });
            },
            onOffline: () => {
                // 只提示一次由 uiStore 的跳变负责（横幅会常驻），这里补一条明确的 toast
                useUiStore.getState().pushToast("连不上后端，小爱暂时听不到你说话", "error");
            },
            onStateChange: (state) => {
                useUiStore.getState().setBackendState(state);
            },
            schedule: (fn, ms) => {
                const id = setTimeout(fn, ms);
                return () => clearTimeout(id);
            },
        });

        current = watcher;
        // 任何请求撞上网络层失败时，比下一次定时探活更早认定离线
        const detachObserver = setNetworkObserver(() => watcher.notifyFailure());
        // 启动那一轮的探活不 await：effect 里等 promise 会把 cleanup 推到微任务之后
        void watcher.start();

        return () => {
            detachObserver();
            watcher.stop();
            if (current === watcher) current = null;
        };
    }, []);
}
