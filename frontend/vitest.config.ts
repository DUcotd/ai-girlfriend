import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Vitest 配置（纯逻辑单测，不做组件快照）。
 *
 * - environment: jsdom —— storage.ts 依赖 window / localStorage，
 *   jsdom 提供浏览器全局，使生产代码无需为了可测性改动接口。
 * - include 只收集 src 下的 test/spec，避免误扫 .next 等构建产物。
 * - alias @ → src，与 tsconfig.json 的 paths 保持一致。
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    globals: false,
    restoreMocks: true,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
