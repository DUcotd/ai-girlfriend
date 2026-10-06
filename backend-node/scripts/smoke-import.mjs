/**
 * 真导入冒烟（B5-9 / 审计 INFRA-07）。
 *
 * `npm run check` 的语法检查只用 vm.SourceTextModule **解析**每个文件，从不执行，
 * 于是这一类错误全部溜过去：import 路径写错、大小写不对、具名导入的名字不存在、
 * 循环依赖在运行期才炸、模块顶层一执行就抛错。今晚就把 `configValidation.js`
 * 改成过 `const URL = 'url'` 遮蔽全局 URL —— 语法完全合法，跑起来才变成
 * 「每个合法地址都被判成非法」。
 *
 * 所以这里真的把整条装配链 import 一遍，并断言关键导出在位。
 * 必须在**子进程**里跑（本文件的容器会起定时器），结尾强制 exit。
 *
 * 用法：node scripts/smoke-import.mjs（check-syntax.mjs 会自动调用）
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 动态 import 必须走 file:// URL：Windows 上传裸绝对路径会被当成
 * 「协议 d:」直接抛 ERR_UNSUPPORTED_ESM_URL_SCHEME（本机第一次跑就撞上了）。
 */
const load = (rel) => import(pathToFileURL(path.join(__dirname, '..', rel)).href);

// 沙盒数据目录：冒烟绝不能碰用户真实数据
const sandbox = process.env.AI_GIRLFRIEND_SMOKE_DATA_DIR;
if (sandbox) process.env.AI_GIRLFRIEND_DATA_DIR = sandbox;

const failures = [];
const ok = (name, cond) => {
    if (!cond) failures.push(name);
    console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}`);
};

try {
    const container = await load('src/services/container.js');
    ok('container 可导入', !!container.aiGirlfriend && !!container.proactiveEngine);
    ok('事件层已注册 4 个触发源',
        (container.triggerRegistry?.triggers?.size ?? 0) === 4,
        String(container.triggerRegistry?.triggers?.size));

    const { createApp } = await load('src/app.js');
    ok('app 可装配', typeof createApp === 'function');

    // 关键契约导出：写错名字时 ESM 会在 import 阶段抛，这里再兜一层防 undefined
    const { TRIGGER_EVENTS } = await load('src/core/triggerEvents.js');
    ok('跃迁事件名在位', TRIGGER_EVENTS.STAGE_ADVANCED === 'stage_advanced');
    const cv = await load('src/utils/configValidation.js');
    ok('baseUrl 校验可用（真的能解析 URL，不被同名常量遮蔽）',
        cv.normalizeBaseUrl('https://api.example.com/v1')?.url === 'https://api.example.com/v1'
        && cv.normalizeBaseUrl('http://169.254.169.254/') === null);
    const ue = await load('src/utils/upstreamError.js');
    ok('上游错误分类可用', ue.classifyUpstreamError({ status: 429 }).code === ue.UPSTREAM_ERROR_CODES.RATE_LIMITED);
    const pt = await load('src/core/proactiveTypes.js');
    ok('主动消息类型目录含关系跃迁', !!pt.getProactiveType('stage_transition'));
} catch (e) {
    failures.push('导入链抛异常');
    console.error('  FAIL 导入链抛异常:', e?.stack || e);
}

if (failures.length) {
    console.error(`\n导入冒烟失败 ${failures.length} 项`);
    process.exit(1);
}
console.log('\n导入冒烟通过');
process.exit(0);
