/**
 * lint-style.mjs - 零依赖的静态检查（B5-8「后端 eslint」的替代方案）。
 *
 * 为什么不上 eslint：装 eslint + 配套包要几十 MB，这台机器的出网只有几十 KB/s，
 * 一次安装会拖到几十分钟且随时可能断（见 README「环境变量」旁的说明与本机网络实测）。
 * 更重要的是：真正咬过我们的并不是格式类问题，而是下面这几条**可枚举的结构性错误**，
 * 每条都对应一次实际事故。所以这里做的是「有针对性、零依赖」的检查，
 * 而不是把一个通用 linter 的规则集抄一遍。
 *
 * 规则（每条后面括注它是怎么暴露出来的）：
 *   R1 顶层变量不得遮蔽 JS 全局          —— `const URL = 'url'` 让同文件的 new URL() 直接抛错，
 *                                          症状却是「每个合法地址都被判成非法」（2026-10-06 实测）
 *   R2 一个文件只能有一个 export default  —— 整段替换路由文件时留下了两份，报错信息还不直观
 *   R3 空 catch 必须写注释               —— 静默吞异常是本项目最容易复发的失效模式
 *   R4 不得留 debugger / console.trace 调试残留
 *   R5 未使用的 import 要删               —— 改完路由没删 asyncHandler，读代码的人会以为还有异步包装
 *
 * 运行：node scripts/lint-style.mjs（npm run lint）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, '..', 'src');
const scriptDir = __dirname;

/** 被遮蔽后会立刻改变语义的全局名（只列这些，避免把 label/next 之类误报） */
const SHADOWABLE_GLOBALS = new Set([
    'URL', 'Number', 'String', 'Object', 'Boolean', 'Symbol', 'BigInt', 'Promise', 'Date',
    'Math', 'JSON', 'Array', 'Error', 'TypeError', 'RangeError', 'Buffer', 'process',
    'console', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'globalThis',
]);

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            walk(path.join(dir, entry.name), out);
        } else if (/\.(mjs|js)$/.test(entry.name)) {
            // 以 `_` 开头的是临时排障脚本（`_qa_*.mjs` 这一类），不入版本库、
            // CI 也看不到；让它们卡住本地门禁只会逼人去改无关的一次性文件。
            if (entry.name.startsWith('_')) continue;
            out.push(path.join(dir, entry.name));
        }
    }
    return out;
}

const problems = [];
const files = [...walk(srcDir), ...walk(scriptDir)];

for (const file of files) {
    const rel = path.relative(path.resolve(__dirname, '..'), file);
    const source = fs.readFileSync(file, 'utf-8');
    const lines = source.split(/\r?\n/);

    // ---- R1 顶层遮蔽全局 ----
    lines.forEach((line, i) => {
        const m = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
        if (!m) return;
        if (SHADOWABLE_GLOBALS.has(m[1])) {
            problems.push({ rule: 'R1', where: `${rel}:${i + 1}`, msg: `${m[1]} 遮蔽了同名全局，同文件里的 new ${m[1]}()/全局用法会失效` });
        }
    });

    // ---- R2 重复 export default ----
    const defaults = lines
        .map((l, i) => [/^export\s+default\b/.test(l), i + 1])
        .filter(([ok]) => ok);
    if (defaults.length > 1) {
        problems.push({
            rule: 'R2', where: `${rel}:${defaults.map(([, n]) => n).join(',')}`,
            msg: `有 ${defaults.length} 处 export default（多半是整段替换时留下了旧内容）`,
        });
    }

    // ---- R3 空 catch 必须有注释 ----
    for (let i = 0; i < lines.length; i++) {
        const m = /^\s*\}\s*catch\s*(?:\([^)]*\))?\s*\{\s*$/.exec(lines[i]);
        if (!m) continue;
        const next = (lines[i + 1] || '').trim();
        if (next !== '}') continue;                      // 块内有内容就算合规（内容是否够另说）
        problems.push({ rule: 'R3', where: `${rel}:${i + 1}`, msg: '空的 catch 块必须写明为什么可以吞掉（`catch { /* … */ }`）' });
    }

    // ---- R4 调试残留 ----
    lines.forEach((line, i) => {
        if (/^\s*debugger\s*;/.test(line) || /console\.trace\(/.test(line)) {
            problems.push({ rule: 'R4', where: `${rel}:${i + 1}`, msg: '调试残留' });
        }
    });

    // ---- R5 未使用的具名 import ----
    // 只看具名导入（default/namespace 命中率高、误报率低的情况另说），
    // 在 import 语句之后的正文里找这个词；找不到就报未使用。
    const importBlocks = [...source.matchAll(/import\s+(?:([\w$]+)\s*,\s*)?\{([^}]*)\}\s*from\s*['"][^'"]+['"];?/g)];
    for (const block of importBlocks) {
        const names = block[2].split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => {
                const parts = s.split(/\s+as\s+/);
                return (parts[1] || parts[0]).trim();
            });
        if (block[1] && !names.includes(block[1])) names.push(block[1]);
        const body = source.slice(source.indexOf(block[0]) + block[0].length);
        for (const name of names) {
            if (!name) continue;
            const used = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(body);
            if (!used) {
                const lineNo = source.slice(0, source.indexOf(block[0])).split(/\r?\n/).length;
                problems.push({ rule: 'R5', where: `${rel}:${lineNo}`, msg: `导入了 ${name} 但文件里没再用到` });
            }
        }
    }
}

const byRule = {};
for (const p of problems) byRule[p.rule] = (byRule[p.rule] || 0) + 1;

if (problems.length) {
    console.error(`静态检查未通过：${problems.length} 处`);
    for (const [rule, count] of Object.entries(byRule)) console.error(`  ${rule}: ${count} 处`);
    for (const p of problems) console.error(`  [${p.rule}] ${p.where} —— ${p.msg}`);
    process.exit(1);
}
console.log(`静态检查通过（${files.length} 个文件，R1~R5 零问题）`);
process.exit(0);
