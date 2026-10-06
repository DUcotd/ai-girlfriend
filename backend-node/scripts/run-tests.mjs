/**
 * 测试总入口：跑完**所有**套件再汇总失败数。
 *
 * 为什么不用 `npm test` 里的 `a && b && c` 串联：那种写法第一套失败后面全部不跑，
 * 一次只能暴露一个问题，九个下游回归被一个上游失败藏住（审计 INFRA-06）。
 * 这里逐套 spawn，任何一套失败都继续跑完，最后以失败套数作为退出码。
 *
 * 同时统一注入 AI_GIRLFRIEND_DATA_DIR 指向一次性临时目录：所有套件写的是沙盒，
 * 真实 backend-node/data/ 在跑测试后 mtime 零变化（审计 HTTP-03 / INFRA-03）。
 *
 * 运行：node scripts/run-tests.mjs [关键字]   —— 带关键字时只跑名字匹配的套件
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 顺序即依赖顺序：streamFilter 是最底层的纯函数，audit-b0 覆盖跨引擎的编排。
const SUITES = [
    'test-stream-filter.mjs',
    'test-boot-smoke.mjs',
    'test-env-docs.mjs',
    'test-affinity.mjs',
    'test-personality.mjs',
    'test-memory.mjs',
    'test-proactive-gating.mjs',
    'test-auth.mjs',
    'test-trigger-registry.mjs',
    'test-user-emotion.mjs',
    'test-narrative.mjs',
    'test-triggers.mjs',
    'test-reset-all.mjs',
    'test-audit-b0.mjs',
    'test-audit-b0-http.mjs',
    'test-audit-b2.mjs',
    'test-audit-b9.mjs',
    'test-audit-b4.mjs',
    'test-audit-b6.mjs',
    'test-audit-b3.mjs',
    'test-audit-b5b.mjs',
];

const filter = process.argv[2];
const suites = filter ? SUITES.filter((s) => s.includes(filter)) : SUITES;
if (suites.length === 0) {
    console.error(`没有名字包含「${filter}」的测试套件`);
    process.exit(2);
}

// 一次性沙盒数据目录：所有子进程共享，退出前删除
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'aigf-suite-'));

const results = [];
for (const suite of suites) {
    const started = Date.now();
    console.log(`\n──────── ${suite} ────────`);
    const r = spawnSync(process.execPath, [path.join(__dirname, suite)], {
        stdio: 'inherit',
        env: { ...process.env, AI_GIRLFRIEND_DATA_DIR: sandbox },
    });
    const ok = r.status === 0;
    results.push({ suite, ok, ms: Date.now() - started });
    if (!ok) console.error(`✗ ${suite} 退出码 ${r.status}`);
}

try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }

const failed = results.filter((x) => !x.ok);
console.log('\n════════ 测试汇总 ════════');
for (const { suite, ok, ms } of results) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${suite.padEnd(28)} ${(ms / 1000).toFixed(1)}s`);
}
console.log(`\n${results.length - failed.length}/${results.length} 套通过`
    + (failed.length ? `；失败：${failed.map((f) => f.suite).join(', ')}` : ''));
process.exit(failed.length > 0 ? 1 : 0);
