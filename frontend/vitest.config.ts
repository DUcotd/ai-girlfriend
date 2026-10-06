import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Vitest 配置（纯逻辑单测，不做组件快照）。
 *
 * - environment: jsdom —— storage.ts 依赖 window / localStorage，
 *   jsdom 提供浏览器全局，使生产代码无需为了可测性改动接口。
 * - include 只收集 src 下的 test/spec，避免误扫 .next 等构建产物。
 * - alias @ → src，与 tsconfig.json 的 paths 保持一致。
 * - server.fs.allow 放开到仓库根目录：跨端一致性测试需要**真的 import 后端模块**
 *   （如 baseUrlGrade.test.ts 比对 configValidation.js 的分级），而不是用正则抄一份
 *   断言 —— 正则解析后端源码一旦后端改写风格就静默失配，直接执行才叫钉住。
 */
export default defineConfig({
  server: {
    fs: {
      allow: [fileURLToPath(new URL("..", import.meta.url))],
    },
  },
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
