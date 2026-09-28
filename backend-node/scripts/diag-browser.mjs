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

await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
// 跳过首次运行引导（localStorage 在无头浏览器里是空的）
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
  return {
    bubbleCount: bubbles.length,
    thoughtIconCount: icons.length,
    bubbleTexts: Array.from(bubbles).map((b) => b.textContent?.slice(0, 40)),
  };
});

console.log('\n=== DOM 检查 ===');
console.log(`  气泡数: ${info.bubbleCount}`);
console.log(`  内心独白图标数: ${info.thoughtIconCount}`);
console.log(`  气泡内容: ${JSON.stringify(info.bubbleTexts)}`);

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
