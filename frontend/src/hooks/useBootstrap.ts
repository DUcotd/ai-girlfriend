"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { get, getChatConfig, isSetupComplete, set } from "@/lib/storage";
import { useChatStore } from "@/stores/chatStore";

/**
 * 一次性客户端引导：首启判定、通知权限、状态/历史拉取、配置下发后端。
 * localStorage 只能在客户端读取，故首帧渲染与水合保持一致，
 * 挂载后再一次性恢复并同步（非响应式状态同步），豁免该条规则。
 * 主题/模式由 layout 防 FOUC 脚本恢复，ttsEngine 由 settingsStore 初始化恢复。
 */
export function useBootstrap() {
  const [isFirstRun, setIsFirstRun] = useState<boolean | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setIsFirstRun(!isSetupComplete());

    // 通知权限只问一次：问过就记下来，已授权/已拒绝也不再打扰
    if (
      "Notification" in window &&
      Notification.permission === "default" &&
      !get("notificationAsked")
    ) {
      set("notificationAsked", "true");
      void Notification.requestPermission();
    }

    const { syncState, fetchHistory } = useChatStore.getState();
    void syncState();
    void fetchHistory();

    // 已有配置时同步给后端（后端配置仅存于内存，重启后需要重新下发）
    const config = getChatConfig();
    if (config.apiKey) {
      api.updateConfig(config).catch(() => {});
    }
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  return { isFirstRun, completeFirstRun: () => setIsFirstRun(false) };
}
