"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { CurrentActivity } from "@/types";

/** 生活模拟：每 2 分钟刷新一次小爱的当前活动（仅聊天页消费，保持局部态） */
export function useActivityPolling() {
  const [currentActivity, setCurrentActivity] = useState<CurrentActivity | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchActivity = () => {
      api
        .getCurrentActivity()
        .then((activity) => {
          if (!cancelled) setCurrentActivity(activity);
        })
        .catch(() => {
          // 后端未启动，忽略
        });
    };
    fetchActivity();
    const interval = setInterval(fetchActivity, 120_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return currentActivity;
}
