/**
 * 无头浏览器体检：加载前端页面，收集 console 报错 + 检查内心独白图标是否渲染。
 * 用法: node scripts/diag-browser.mjs
 */
// playwright-core 装在隔离的 node workspace 里，这里用绝对路径导入
import { createRequire } from 'module';
const require = createRequire('C:/Users/25776/.workbuddy/binaries/node/workspace/');
const { chromium } = require('playwright-core');

const URL = 'http://127.0.0.1:3000';
const CHANNELS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const logs = [];
const errors = [];

let browser;
for (const executablePath of CHANNELS) {
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    console.log(`使用浏览器: ${executablePath}`);
    break;
  } catch {
    /* 试下一个 */
  }
}
if (!browser) {
  console.error('没找到可用的 Edge/Chrome 可执行文件');
  process.exit(1);
}

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));

// ---- 场景 1：全新用户（localStorage 为空）----
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
const firstPaint = await page.evaluate(() => ({
  hasLoadingText: document.body.innerText.includes('加载中'),
  bodyText: document.body.innerText.slice(0, 40).replace(/\s+/g, ' '),
}));
console.log('--- 首屏（SSR 首帧，未执行 effect）---');
console.log(`  出现「加载中」白屏: ${firstPaint.hasLoadingText ? '❌ 有' : '✅ 无'}`);
console.log(`  首帧文本: ${JSON.stringify(firstPaint.bodyText)}`);

await page.waitForTimeout(2000);
const firstRun = await page.evaluate(() => ({
  wizardVisible: document.body.innerText.includes('欢迎使用 AI 女友'),
  hasHeader: !!document.querySelector('header'),
}));
console.log(`  引导层可见: ${firstRun.wizardVisible ? '✅' : '❌'}  主界面已铺底: ${firstRun.hasHeader ? '✅' : '❌'}`);

// ---- 场景 2：回访用户 ----
await page.evaluate(() => {
  localStorage.setItem('hasCompletedSetup', 'true');
  localStorage.setItem('baseUrl', 'https://api.openai.com/v1');
  localStorage.setItem('modelName', 'gpt-4o-mini');
  localStorage.setItem('apiKey', 'headless-test');
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

console.log('\n=== console 消息 ===');
console.log(logs.length ? logs.join('\n') : '(无)');

console.log('\n=== 页面错误 ===');
console.log(errors.length ? errors.join('\n') : '(无)');

  const info = await page.evaluate(() => {
    const bubbles = document.querySelectorAll('.message-bubble');
    const icons = document.querySelectorAll('[aria-label="查看小爱的内心独白"]');
    const img = document.querySelector('img[src*="/characters/"]');
    return {
      bubbleCount: bubbles.length,
      thoughtIconCount: icons.length,
      bubbleTexts: Array.from(bubbles).map((b) => b.textContent?.slice(0, 40)),
      characterImg: img ? { src: img.getAttribute('src'), loaded: img.complete && img.naturalWidth > 0 } : null,
    };
  });

console.log('\n=== DOM 检查 ===');
console.log(`  气泡数: ${info.bubbleCount}`);
console.log(`  内心独白图标数: ${info.thoughtIconCount}`);
console.log(`  气泡内容: ${JSON.stringify(info.bubbleTexts)}`);
console.log(`  角色立绘: ${JSON.stringify(info.characterImg)}`);

// hover 第一个图标，验证心声卡片会展开
if (info.thoughtIconCount > 0) {
  await page.locator('[aria-label="查看小爱的内心独白"]').first().hover();
  await page.waitForTimeout(600);
  const tooltip = await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('div')).find(
      (e) => e.textContent?.trim().startsWith('小爱的心声') && e.offsetParent !== null
    );
    return t ? t.textContent?.slice(0, 80) : null;
  });
  console.log(`  hover 心声卡: ${tooltip ? JSON.stringify(tooltip) : '❌ 未展开'}`);
}

await page.screenshot({ path: 'diag-screenshot.png', fullPage: false });
console.log('\n截图已保存: backend-node/diag-screenshot.png');

await browser.close();
