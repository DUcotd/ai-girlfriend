"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { cleanupLegacyEmbeddingDefaults, get, getChatConfig, isSetupComplete, set } from "@/lib/storage";
import { useChatStore } from "@/stores/chatStore";
import { useUiStore } from "@/stores/uiStore";

/**
 * 一次性客户端引导：首启判定、通知权限、状态/历史拉取、配置下发后端。
 * localStorage 只能在客户端读取，故首帧渲染与水合保持一致，
 * 挂载后再一次性恢复并同步（非响应式状态同步），豁免该条规则。
 * 主题/模式由 layout 防 FOUC 脚本恢复，ttsEngine 由 settingsStore 初始化恢复，
 * 好感度镜像由 chatStore.restoreAffinity 恢复（均不影响水合首帧一致性）。
 */
export function useBootstrap() {
  const [isFirstRun, setIsFirstRun] = useState<boolean | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setIsFirstRun(!isSetupComplete());

    // 旧版嵌入默认值残留一次性清理（详见 storage.cleanupLegacyEmbeddingDefaults）
    cleanupLegacyEmbeddingDefaults();

    // 通知权限只问一次：问过就记下来，已授权/已拒绝也不再打扰
    if (
      "Notification" in window &&
      Notification.permission === "default" &&
      !get("notificationAsked")
    ) {
      set("notificationAsked", "true");
      void Notification.requestPermission();
    }

    const { restoreAffinity, syncState, fetchHistory } = useChatStore.getState();
    // 好感度镜像必须在挂载后恢复：store 初始值是常量以保证 SSR 与水合首帧一致
    restoreAffinity();
    void syncState();
    void fetchHistory();

    // 已有配置时同步给后端（后端配置仅存于内存，重启后需要重新下发）。
    // 只配了语音 Key、没配主 Key 的场景也要下发，否则 tts_api_key 永远到不了后端；
    // 仅配嵌入 Key 的场景同理（记忆设置随每次 syncConfig 一起下发）
    const config = getChatConfig();
    if (config.apiKey || config.ttsApiKey || config.embApiKey) {
      api.syncConfig(config).catch((e: unknown) => {
        console.warn("[Bootstrap] syncConfig failed:", e);
        // 静默吞掉的话用户要等到发消息报错才会发现后端没就绪
        useUiStore.getState().pushToast("配置同步失败，请确认后端已启动", "error");
      });
    }
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  return { isFirstRun, completeFirstRun: () => setIsFirstRun(false) };
}
