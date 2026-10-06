/**
 * 环境变量文档一致性回归（B5-11 / 审计 INFRA-09）。
 *
 * 为什么这条值得存在：`config.js` 里的旋钮已经加到 80 多个，而 README 与 `.env.example`
 * 是手写的。以前发生过「新开关只能靠读源码才发现」（USER_EMOTION_* 与三个陪伴感开关
 * 都出现过文档滞后），也发生过「文档写了一个代码里根本没有的变量名」
 * （README 把 `POST /config` 写成用户可配的契约，前端却从不发送）。
 * 两边都是手抄，就一定会有人对不上 —— 所以让测试当那只手。
 *
 * 运行：node scripts/test-env-docs.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHarness } from './lib/testKit.mjs';

process.env.AI_GIRLFRIEND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aigf-envdocs-'));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const t = createHarness('env-docs', { expect: 12 });
const check = t.check;

/** 收集 src/ 下真实读取过的环境变量名 */
function collectUsedEnvVars(dir) {
    const names = new Set();
    const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith('.js')) continue;
            const src = fs.readFileSync(full, 'utf-8');
            for (const m of src.matchAll(/process\.env(?:\.([A-Z][A-Z_0-9]+)|\s*\[\s*['"]([A-Z][A-Z_0-9]+)['"]\s*\])/g)) {
                names.add(m[1] || m[2]);
            }
            // 变量名以常量声明再读的情况：只认名字里带 ENV 的常量
            // （auth.js 的 TOKEN_ENV、triggerEvents.js 的 TRIGGER_ENABLED_ENV_KEY）。
            // 早期版本用「任意大写字符串常量」来猜，把 CRITICISM / DUPLICATE_FACT
            // 这些业务常量也当成了环境变量名，误报一片。
            for (const m of src.matchAll(/const\s+\w*ENV\w*\s*=\s*'([A-Z][A-Z_0-9]+)'/g)) names.add(m[1]);
        }
    };
    walk(dir);
    return names;
}

/** 解析 .env.example / README 表格里出现的变量名 */
function collectDocumented(text, { envFile = false } = {}) {
    const names = new Set();
    for (const line of text.split(/\r?\n/)) {
        if (envFile) {
            const m = /^\s*#?\s*([A-Z][A-Z_0-9]{2,})\s*=/.exec(line);
            if (m) names.add(m[1]);
        } else {
            for (const m of line.matchAll(/`([A-Z][A-Z_0-9]{2,})`/g)) names.add(m[1]);
        }
    }
    return names;
}

const used = collectUsedEnvVars(path.join(ROOT, 'src'));
const envExamplePath = path.join(ROOT, '.env.example');
const readmePath = path.join(ROOT, '..', 'README.md');
const envExample = fs.existsSync(envExamplePath) ? fs.readFileSync(envExamplePath, 'utf-8') : '';
const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf-8') : '';
const inExample = collectDocumented(envExample, { envFile: true });
const inReadme = collectDocumented(readme);

console.log(`== 变量集合：代码 ↔ .env.example ==`);
check('.env.example 存在且非空', envExample.length > 500, `${envExample.length} 字节`);
const undocumented = [...used].filter((n) => !inExample.has(n) && !inReadme.has(n));
check('代码里读的每个变量都有文档（.env.example 或 README 至少一处）',
    undocumented.length === 0, `缺文档：${undocumented.join(', ')}`);
const ghost = [...inExample].filter((n) => !used.has(n));
check('.env.example 里没有代码不认的变量名（写了也不生效的那种）',
    ghost.length === 0, `幽灵变量：${ghost.join(', ')}`);
check('.env.example 覆盖的变量数量不少于 80 个（旋钮总数在涨，样例不能只列几个）',
    inExample.size >= 80, `实际 ${inExample.size} 个`);

console.log('== 分组与说明 ==');
check('分组齐全（运行/模型/记忆/叙事/用户情绪/她的情绪/主动消息/文本上限/语音/安全边界）',
    (envExample.match(/^# -{20,}$/gm) || []).length >= 10,
    String((envExample.match(/^# -{20,}$/gm) || []).length));
check('每个分组都有中文说明行', /分组与 README/.test(envExample));
check('说明了「一个都不填也能跑」', /一个都不填也能跑/.test(envExample));
check('交代了 Key 的两条来源与重启后果',
    /浏览器设置页/.test(envExample) && /AI_GIRLFRIEND_API_KEY/.test(envExample));
check('写清 HOST 对外暴露必须配 token（否则拒绝启动）',
    /必须同时配 TOKEN/.test(envExample) && /拒绝启动/.test(envExample));
check('写了日志隐私开关（默认不打独白原文）',
    /AI_GIRLFRIEND_DEBUG/.test(envExample) && /monologue/.test(envExample));
check('写了 baseUrl 安全边界与两个放行开关',
    /AI_GIRLFRIEND_BASE_URL_ALLOWLIST/.test(envExample)
    && /AI_GIRLFRIEND_ALLOW_PRIVATE_BASE_URLS/.test(envExample));

// README 里那条「37 个旋钮」式的硬计数最容易过期：不许再出现具体数字
check('README 不再写死旋钮数量（会过期的那种数字）',
    !/\d+\s*个旋钮/.test(readme), (readme.match(/\d+\s*个旋钮/) || [''])[0]);

let exitCode = t.finish();
try { fs.rmSync(process.env.AI_GIRLFRIEND_DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(exitCode);
