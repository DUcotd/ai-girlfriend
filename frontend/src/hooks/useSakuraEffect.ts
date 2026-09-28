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
      petal.style.opacity = (Math.random() * 0.5 + 0.3).toString();
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
