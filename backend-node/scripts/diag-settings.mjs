/**
 * 无头浏览器自检：设置弹窗（DialogLayer + SettingsProactiveTab 拆分后）是否仍正常渲染。
 * 用法: node scripts/diag-settings.mjs
 */
import { createRequire } from "module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire("C:/Users/25776/.workbuddy/binaries/node/workspace/");
const { chromium } = require("playwright-core");

// 截图写到 <repo>/backend-node/ 下，避免按 cwd 解析产生 backend-node/backend-node 嵌套
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(HERE, "..", "diag-settings.png");

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
// 跳过首次引导（若存在）
await page.evaluate(() => {
    // isSetupComplete() 要求 apiKey 与 hasCompletedSetup 同时存在
    localStorage.setItem("hasCompletedSetup", "true");
    localStorage.setItem("apiKey", "headless-test");
    localStorage.setItem("baseUrl", "https://api.openai.com/v1");
    localStorage.setItem("modelName", "gpt-4o-mini");
    localStorage.setItem("notificationAsked", "true");
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);

console.log("=== 工具栏 ===");
const toolbar = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("header button, [data-toolbar] button")];
    return btns.map((b) => b.getAttribute("aria-label")).filter(Boolean);
});
console.log("  工具按钮:", JSON.stringify(toolbar));

// 打开设置
const settingsBtn = page.locator('button[aria-label*="设置"]').first();
if ((await settingsBtn.count()) === 0) {
    console.log("  ❌ 找不到设置按钮");
    await browser.close();
    process.exit(1);
}
await settingsBtn.click();
await page.waitForTimeout(600);

console.log("=== 设置弹窗 ===");
const tabs = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")].map((b) => b.textContent?.trim()).filter(Boolean);
    return btns.filter((t) => ["通用", "语音", "记忆", "主动", "系统"].includes(t));
});
console.log("  页签:", JSON.stringify(tabs));

// 逐个切一遍，确认每个页签都能渲染出内容且不报错
for (const name of ["通用", "语音", "记忆", "主动", "系统"]) {
    await page.locator(`button:has-text("${name}")`).first().click();
    await page.waitForTimeout(400);
    const len = await page.evaluate(() => {
        // 取弹窗最外层：包含 aria-label="启用主动消息" 或输入框的可见浮层
        const panels = [...document.querySelectorAll("div")]
            .filter((d) => d.className && String(d.className).includes("z-50"))
            .map((d) => d.innerText || "");
        return Math.max(0, ...panels.map((t) => t.replace(/\s+/g, " ").trim().length));
    });
    console.log(`  页签「${name}」内容长度: ${len} ${len > 20 ? "✅" : "❌"}`);
}

// ---- 主动消息页签专项 ----
await page.locator('button:has-text("主动")').first().click();
await page.waitForTimeout(500);

const hasSwitch = await page.locator('button[aria-label="启用主动消息"]').count();
console.log("  总开关存在:", hasSwitch > 0 ? "✅" : "❌");

let state = "unknown";
if (hasSwitch > 0) {
    const sw = page.locator('button[aria-label="启用主动消息"]').first();
    state = await sw.getAttribute("aria-pressed");
    console.log("  开关初始状态:", state);
    if (state !== "true") {
        await sw.click();
        await page.waitForTimeout(500);
    }
}

const detail = await page.evaluate(() => {
    const txt = document.body.innerText.replace(/\s+/g, " ");
    return {
        freq: txt.includes("消息频率"),
        limit: txt.includes("每日消息上限"),
        types: txt.includes("消息类型"),
        checkboxes: document.querySelectorAll('input[type="checkbox"]').length,
    };
});
console.log("  展开后 → 频率:", detail.freq ? "✅" : "❌", "上限:", detail.limit ? "✅" : "❌", "类型:", detail.types ? "✅" : "❌", "checkbox 数:", detail.checkboxes);

const ok = hasSwitch > 0 && detail.freq && detail.limit && detail.types;
console.log("\n主动消息页签结论:", ok ? "✅ 正常" : "❌ 异常");

await page.screenshot({ path: SHOT, fullPage: false });
console.log("截图已保存:", SHOT);

console.log("\n=== 页面错误 ===");
console.log(errors.length ? errors.join("\n") : "(无)");

await browser.close();
process.exit(errors.length ? 1 : 0);
