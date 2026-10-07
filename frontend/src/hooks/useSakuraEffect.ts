"use client";

import { useEffect } from "react";

const PETAL_LIFETIME_MS = 7000;
const SPAWN_INTERVAL_MS = 1000;

/**
 * 樱花飘落背景特效。
 * 原实现内联在 page.tsx 中，此处独立为 hook。
 *
 * 「减少动态效果」这一档必须真的停手：utilities.css 只能把 CSS 动画关掉，
 * 而花瓣是这里用 setInterval 持续往 body 里 insert 的 DOM——
 * 动画被禁后花瓣会变成一堆停在半空的死元素，而且定时器一直白跑。
 * 所以这里在 reduce 时既不生成新花瓣，也清掉已有的，整个特效（含定时器）不存在。
 */
export function useSakuraEffect(): void {
  useEffect(() => {
    const query =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;

    /** 生成器排出去的延时卸载句柄：卸载时要一并清掉，否则残留定时器会在
        花瓣已被移除后再摸一次 DOM（以及 React StrictMode 双挂载时互相打架） */
    let spawnTimer: number | null = null;
    const pendingRemovals = new Set<number>();

    const stop = () => {
      if (spawnTimer !== null) {
        clearInterval(spawnTimer);
        spawnTimer = null;
      }
      pendingRemovals.forEach((id) => clearTimeout(id));
      pendingRemovals.clear();
      document.querySelectorAll(".sakura-petal").forEach((petal) => petal.remove());
    };

    const start = () => {
      if (spawnTimer !== null) return; // 已在跑（含偏好来回切换）
      const createPetal = () => {
        const petal = document.createElement("div");
        petal.classList.add("sakura-petal");
        petal.style.left = `${Math.random() * 100}vw`;
        petal.style.animationDuration = `${Math.random() * 3 + 4}s`;
        // 个体随机透明度用变量承载（不直接写 opacity）：最终视觉 = 模式系数 × 随机系数，
        // 由 CSS 里的 calc 相乘，明暗模式（0.7/0.4）与随机感同时生效
        petal.style.setProperty("--petal-opacity", (Math.random() * 0.5 + 0.3).toFixed(3));
        document.body.appendChild(petal);
        const removeTimer = window.setTimeout(() => {
          petal.remove();
          pendingRemovals.delete(removeTimer);
        }, PETAL_LIFETIME_MS);
        pendingRemovals.add(removeTimer);
      };
      spawnTimer = window.setInterval(createPetal, SPAWN_INTERVAL_MS);
    };

    const apply = () => {
      if (query?.matches) stop();
      else start();
    };

    apply();
    query?.addEventListener("change", apply);

    return () => {
      query?.removeEventListener("change", apply);
      stop();
    };
  }, []);
}
