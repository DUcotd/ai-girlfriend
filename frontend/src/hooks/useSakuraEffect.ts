"use client";

import { useEffect } from "react";

const PETAL_LIFETIME_MS = 7000;
const SPAWN_INTERVAL_MS = 1000;

/**
 * 樱花飘落背景特效。
 * 原实现内联在 page.tsx 中，此处独立为 hook。
 */
export function useSakuraEffect(): void {
  useEffect(() => {
    const createPetal = () => {
      const petal = document.createElement("div");
      petal.classList.add("sakura-petal");
      petal.style.left = `${Math.random() * 100}vw`;
      petal.style.animationDuration = `${Math.random() * 3 + 4}s`;
      // 个体随机透明度用变量承载（不直接写 opacity）：最终视觉 = 模式系数 × 随机系数，
      // 由 CSS 里的 calc 相乘，明暗模式（0.7/0.4）与随机感同时生效
      petal.style.setProperty("--petal-opacity", (Math.random() * 0.5 + 0.3).toFixed(3));
      document.body.appendChild(petal);
      setTimeout(() => petal.remove(), PETAL_LIFETIME_MS);
    };

    const interval = setInterval(createPetal, SPAWN_INTERVAL_MS);
    return () => {
      clearInterval(interval);
      document.querySelectorAll(".sakura-petal").forEach((p) => p.remove());
    };
  }, []);
}
