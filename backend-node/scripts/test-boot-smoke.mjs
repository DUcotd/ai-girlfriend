/**
 * 启动冒烟（B5-10 / B5-8 的本地等价物）。
 *
 * 覆盖三件「服务到底算不算起来了」的事：
 *   1. GET /health 免鉴权可取，且字段足以判断状态（数据目录可写、Key 是否已下发）；
 *   2. 配了 AI_GIRLFRIEND_TOKEN 时 /health 仍然可达，而业务接口 401 ——
 *      探活通道不能被自己的鉴权挡掉，否则 CI/启动脚本会把「活着」误报成「挂了」；
 *   3. 响应体不含任何 Key 材料与完整 baseUrl（只回主机名）。
 *
 * 运行：node scripts/test-boot-smoke.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AI_GIRLFRIEND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aigf-boot-'));
process.env.HOST = '127.0.0.1';
// 本套件的用例就是要验证「带 token 时探活仍然可达」，所以整程都开着 token
const TOKEN = 'smoke-token-1234';
process.env.AI_GIRLFRIEND_TOKEN = TOKEN;

const { createApp } = await import('../src/app.js');
const { aiGirlfriend, eventBus, triggerRegistry } = await import('../src/services/container.js');
const { createHarness } = await import('./lib/testKit.mjs');

const t = createHarness('boot-smoke', { expect: 23 });
const check = t.check;

const app = createApp();
const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

async function get(p, headers = {}) {
    const res = await fetch(`${base}${p}`, { headers });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 留给断言判定 */ }
    return { status: res.status, json, text };
}

console.log('== /health 免鉴权 ==');
{
    const r = await get('/health');
    check('未带 token 也能取 /health（探活通道不能被鉴权挡掉）',
        r.status === 200, `${r.status} ${r.text.slice(0, 80)}`);
    check('回的是 JSON 而不是 HTML', r.json && typeof r.json === 'object');
    check('ok 字段在位且为布尔', typeof r.json?.ok === 'boolean', JSON.stringify(r.json?.ok));
    check('带版本号（排障时要能确认跑的是哪个版本）',
        typeof r.json?.version === 'string' && /^\d+\.\d+/.test(r.json.version), String(r.json?.version));
    check('带 node 版本与运行时长',
        /^v\d+/.test(r.json?.node || '') && typeof r.json?.uptimeSeconds === 'number');
    check('数据目录可写性被真实检查过', typeof r.json?.dataDirWritable === 'boolean');
    check('llmConfigured 可读（后端重启后有没有收到浏览器下发的 Key）',
        typeof r.json?.llmConfigured === 'boolean');
    check('只回 baseUrl 的主机名，不回完整地址与 Key',
        !r.text.includes(TOKEN)
        && !/(sk-|api[_-]?key)/i.test(r.text)
        && (r.json?.baseUrlHost === null || !r.json.baseUrlHost.startsWith('http')),
        JSON.stringify(r.json?.baseUrlHost));
    check('附带陪伴感三开关的当前值',
        r.json?.companion && typeof r.json.companion.userEmotionEnabled === 'boolean'
        && typeof r.json.companion.triggerEnabled === 'boolean',
        JSON.stringify(r.json?.companion));
    check('附带队列深度与主动消息队列长度（都是数字）',
        typeof r.json?.chatQueueDepth === 'number' && typeof r.json?.proactiveQueueSize === 'number');

    const root = await get('/');
    check('旧的 GET / 探活仍然可用', root.status === 200 && /Running/.test(root.text), `${root.status}`);
}

console.log('== 配了 token 时业务接口仍然要凭证 ==');
{
    const noAuth = await get('/config/status');
    check('不带 token 取业务接口 → 401', noAuth.status === 401, `${noAuth.status}`);
    const wrongAuth = await get('/config/status', { Authorization: 'Bearer not-the-token' });
    check('带错 token → 401', wrongAuth.status === 401, `${wrongAuth.status}`);
    const good = await get('/config/status', { Authorization: `Bearer ${TOKEN}` });
    check('带对 token → 200', good.status === 200, `${good.status}`);
    const health = await get('/health');
    check('此时 /health 依然可达（否则启动脚本会误判服务挂了）', health.status === 200, `${health.status}`);
}

console.log('== 未匹配路径与 500 ==');
{
    const miss = await get('/no/such/path', { Authorization: `Bearer ${TOKEN}` });
    check('未匹配路径回 JSON 404 而不是 HTML', miss.status === 404 && miss.json?.detail, `${miss.status}`);

    // errorHandler 必须把 500 的堆栈打进日志（B5-10），响应体却不泄漏任何内部细节
    const captured = [];
    const origError = console.error;
    console.error = (...a) => { captured.push(a.join(' ')); };
    aiGirlfriend.getCompanionStatus = () => { const e = new Error('boom'); e.status = 500; throw e; };
    const boom = await get('/health');
    console.error = origError;
    aiGirlfriend.getCompanionStatus = Object.getPrototypeOf(aiGirlfriend).getCompanionStatus;
    check('500 的响应体只有通用文案，不含堆栈与内部信息',
        boom.status === 500 && boom.json?.detail === 'Internal server error'
        && !/boom|at\s+\w+\s*\(|node_modules/.test(boom.text), `${boom.status} ${boom.text.slice(0, 80)}`);
    check('500 的堆栈进了日志（旧实现只打一行 message，成因查不到）',
        captured.some((l) => l.includes('boom') && /at\s/.test(l)),
        captured.join(' | ').slice(0, 160));
}

console.log('== 事件层在真实装配里确实是通电的 ==');
{
    // 这一节专门对付「代码写了但没接线」：单元测试各自 new 引擎都能过，
    // 只有 container 才代表服务进程里真实的那一套对象图。
    check('AiGirlfriend 持有 eventBus（情绪转折/叙事里程碑才有地方发出去）',
        typeof aiGirlfriend.eventBus?.emit === 'function');
    check('user_emotion_turn 有订阅者（不是发进一条空总线）',
        eventBus.listenerCount('user_emotion_turn') > 0,
        `count=${eventBus.listenerCount('user_emotion_turn')}`);
    check('narrative_milestone 有订阅者',
        eventBus.listenerCount('narrative_milestone') > 0,
        `count=${eventBus.listenerCount('narrative_milestone')}`);
    const delivered = eventBus.emit('user_emotion_turn', {
        valence: 0, arousal: 0, intensity: 0, label: '中性', turned: false,
        trend: { avgValence: 0, slope: 0, declining: false }, ts: Date.now(),
    });
    check('真的 emit 一次能派发到订阅者（订阅不是死代码）', delivered >= 1, `delivered=${delivered}`);
    check('触发源注册数量为 4（REQ-04 三源 + B6-α 的关系跃迁）',
        triggerRegistry.triggers.size === 4, `size=${triggerRegistry.triggers.size}`);
}

server.closeAllConnections?.();
await new Promise((r) => server.close(r));
let exitCode = t.finish();
try { fs.rmSync(process.env.AI_GIRLFRIEND_DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(exitCode);
