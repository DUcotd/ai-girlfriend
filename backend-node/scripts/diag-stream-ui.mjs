/**
 * 无头浏览器端到端自检：流式对话的两个回归点。
 *   1) 等待回复期间只应有「打字指示器」一个元素（不再出现 🔊 空气泡 + ··· 并存）
 *   2) 回复完成后气泡旁应出现「内心独白」小图标（Brain，aria-label=查看小爱的内心独白）
 *
 * ⚠️ 会发一次真实 LLM 请求（依赖后端已配好 Key 并在跑），并轻微污染 data/（多一条对话）。
 * 用法: node scripts/diag-stream-ui.mjs
 */
import { createRequire } from "module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire("C:/Users/25776/.workbuddy/binaries/node/workspace/");
const { chromium } = require("playwright-core");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOT_WAIT = path.join(HERE, "..", "diag-stream-wait.png");
const SHOT_DONE = path.join(HERE, "..", "diag-stream-done.png");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text());
});

await page.goto(BASE, { waitUntil: "networkidle" });
await page.evaluate(() => {
    localStorage.setItem("hasCompletedSetup", "true");
    localStorage.setItem("apiKey", "headless-test");
    localStorage.setItem("notificationAsked", "true");
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);

/** 统计当前消息区里的关键元素 */
const snapshot = () =>
    page.evaluate(() => {
        const bubbles = [...document.querySelectorAll(".message-bubble")];
        const speakerButtons = [...document.querySelectorAll("button")].filter(
            (b) => (b.getAttribute("aria-label") || "").includes("朗读") || b.querySelector("svg.lucide-volume-2")
        ).length;
        const typingDots = document.querySelectorAll(".animate-bounce").length;
        return {
            bubbleCount: bubbles.length,
            bubbleTexts: bubbles.map((b) => (b.textContent || "").trim().slice(0, 24)),
            speakerButtons,
            typingDots,
        };
    });

// ---- 发送消息 ----
await page.locator('input[placeholder="说点什么..."]').fill("在吗，随便聊一句就好");
await page.locator('input[placeholder="说点什么..."]').press("Enter");

// 等待期状态：占位空气泡不该渲染成气泡（历史消息仍在，不能假设 bubbleCount===1）
await page.waitForTimeout(1500);
const waiting = await snapshot();
console.log("=== 等待期 ===");
console.log("  气泡数:", waiting.bubbleCount, JSON.stringify(waiting.bubbleTexts));
console.log("  打字指示器点数:", waiting.typingDots);
const emptyBubbles = waiting.bubbleTexts.filter((t) => !t).length;
const waitOk = emptyBubbles === 0 && waiting.typingDots > 0;
console.log(
    "  空气泡已消失 & 打字指示器在场:",
    waitOk ? "✅" : `❌ (空气泡 ${emptyBubbles} 个)`
);
await page.screenshot({ path: SHOT_WAIT });

// ---- 等回复完成（最长 90s，思考模型可能较慢）----
try {
    await page.waitForFunction(
        () => {
            const bubbles = [...document.querySelectorAll(".message-bubble")];
            const last = bubbles[bubbles.length - 1];
            return last && (last.textContent || "").trim().length > 10;
        },
        { timeout: 90_000 }
    );
} catch {
    console.log("  ❌ 90s 内未等到回复正文");
}

await page.waitForTimeout(1200); // 等 settle 完成（thought 图标在 done 后挂上）
const finished = await snapshot();
const thoughtCount = await page.locator('[aria-label="查看小爱的内心独白"]').count();
console.log("\n=== 完成后 ===");
console.log("  气泡数:", finished.bubbleCount, JSON.stringify(finished.bubbleTexts));
console.log("  内心独白图标:", thoughtCount > 0 ? "✅ 出现" : "❌ 缺失");
await page.screenshot({ path: SHOT_DONE });

console.log("\n=== 页面错误 ===");
console.log(errors.length ? errors.join("\n") : "(无)");

await browser.close();
const ok = waitOk && thoughtCount > 0 && errors.length === 0;
console.log("\n结论:", ok ? "✅ 两项修复均生效" : "❌ 仍有问题，看上方明细");
process.exit(ok ? 0 : 1);
