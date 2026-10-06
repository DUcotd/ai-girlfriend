/**
 * 语法检查 + 真导入冒烟：
 *   1) 用 vm.SourceTextModule 解析 src/**\/*.js 与 scripts/*.mjs（仅解析不执行）；
 *   2) 起一个子进程真 import 一遍装配链（scripts/smoke-import.mjs）。
 * 用法：npm run check
 * （需要 --experimental-vm-modules，已在 package.json 中配置）
 *
 * 为什么要第 2 步：纯解析对「import 路径写错 / 具化名不存在 / 顶层执行就抛错 /
 * 同名常量遮蔽了全局对象」完全无感（INFRA-07）。scripts/ 也纳入解析，
 * 否则测试脚本自己写坏了都要到 npm test 才发现。
 */
import vm from 'node:vm';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, '..', 'src');

function collectJsFiles(dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...collectJsFiles(full));
        else if (entry.name.endsWith('.js')) files.push(full);
    }
    return files;
}

function collectScripts(dir) {
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
        .map((e) => path.join(dir, e.name));
}

let failed = 0;
const files = [...collectJsFiles(srcDir), ...collectScripts(__dirname)];
for (const file of files) {
    const source = fs.readFileSync(file, 'utf-8');
    try {
        // SourceTextModule 构造时会做完整 ESM 语法解析（不执行任何代码）
        new vm.SourceTextModule(source, { identifier: file });
        console.log(`OK    ${path.relative(srcDir, file)}`);
    } catch (e) {
        failed++;
        console.error(`FAIL  ${path.relative(srcDir, file)}\n  ${e.message}`);
    }
}

console.log(`\n${files.length - failed}/${files.length} files passed syntax check`);
if (failed > 0) process.exit(1);

// ---------- 真导入冒烟 ----------
// 沙盒数据目录：冒烟进程会实例化容器（各引擎构造时就读盘），绝不能落到 data/
const os = await import('node:os');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'aigf-smoke-'));
const smoke = spawnSync(process.execPath, [path.join(__dirname, 'smoke-import.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, AI_GIRLFRIEND_SMOKE_DATA_DIR: sandbox },
});
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
if (smoke.status !== 0) {
    console.error('FAIL  导入冒烟未通过');
    process.exit(1);
}
console.log('OK    导入冒烟');
process.exit(0);
