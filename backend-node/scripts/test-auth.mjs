/**
 * 鉴权中间件回归测试（P0 安全加固）。
 *
 * 单进程自包含，仅使用 Node 内置 assert + http；不调用 LLM、不访问外网。
 * 通过临时启动真实 Express app 实例（随机端口）发真实 HTTP 请求做断言。
 *
 * 覆盖场景：
 *   - 无 token 且来自非本机 → 401（核心 P0：阻断局域网 / 外部访问）
 *   - 无 token 且来自本机 → 放行（开箱可用）
 *   - 带正确 token → 放行
 *   - 带错误 token → 401
 *   - 缺 Authorization 头 / 格式错误 → 401
 *   - 健康检查 GET / 豁免
 *   - CORS 预检 OPTIONS 豁免
 *   - 静态资源 /static 豁免
 *   - token 长度不等时 timingSafeEqual 不抛异常
 */
import assert from 'assert';
import http from 'node:http';
import express from 'express';
import {
    createAuthMiddleware,
    safeTokenEquals,
    extractBearerToken,
    isExemptPath,
    isLoopbackRequest,
} from '../src/middleware/auth.js';

let passed = 0;
let failed = 0;

function check(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  OK   ${name}`);
    } catch (error) {
        failed += 1;
        process.exitCode = 1;
        console.error(`  FAIL ${name}\n       ${error.message}`);
    }
}

async function checkAsync(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  OK   ${name}`);
    } catch (error) {
        failed += 1;
        process.exitCode = 1;
        console.error(`  FAIL ${name}\n       ${error.message}`);
    }
}

// ==================== 纯函数层（不依赖网络） ====================
console.log('纯函数层:');

check('safeTokenEquals：等长匹配 / 不匹配 / 长度不等均不抛异常', () => {
    assert.strictEqual(safeTokenEquals('abc123', 'abc123'), true);
    assert.strictEqual(safeTokenEquals('abc123', 'abc124'), false);
    // 长度不等：crypto.timingSafeEqual 原始实现会抛 RangeError，包装后必须安全返回 false
    assert.strictEqual(safeTokenEquals('short', 'a-much-longer-token'), false);
    assert.strictEqual(safeTokenEquals('', 'nonempty'), false);
    assert.strictEqual(safeTokenEquals(null, 'x'), false);
    assert.strictEqual(safeTokenEquals('x', undefined), false);
});

check('extractBearerToken：大小写 / 空白 / 无头解析', () => {
    assert.strictEqual(extractBearerToken({ headers: { authorization: 'Bearer abc' } }), 'abc');
    assert.strictEqual(extractBearerToken({ headers: { authorization: 'bearer abc' } }), 'abc');
    assert.strictEqual(extractBearerToken({ headers: { authorization: '  Bearer   abc  ' } }), 'abc');
    assert.strictEqual(extractBearerToken({ headers: { authorization: 'Basic abc' } }), null);
    assert.strictEqual(extractBearerToken({ headers: { authorization: 'Bearer' } }), null);
    assert.strictEqual(extractBearerToken({ headers: {} }), null);
});

check('isLoopbackRequest：仅认 socket 层回环地址，不信任 X-Forwarded-For', () => {
    assert.strictEqual(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' } }), true);
    assert.strictEqual(isLoopbackRequest({ socket: { remoteAddress: '::1' } }), true);
    assert.strictEqual(isLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
    assert.strictEqual(isLoopbackRequest({ ip: 'localhost' }), true);
    assert.strictEqual(isLoopbackRequest({ socket: { remoteAddress: '192.168.1.5' } }), false);
    assert.strictEqual(isLoopbackRequest({ socket: { remoteAddress: '10.0.0.1' } }), false);
    assert.strictEqual(isLoopbackRequest({}), false);
});

check('isExemptPath：OPTIONS / 健康检查 / 静态资源豁免，业务路由不豁免', () => {
    assert.strictEqual(isExemptPath({ method: 'OPTIONS', path: '/chat' }), true);
    assert.strictEqual(isExemptPath({ method: 'GET', path: '/' }), true);
    assert.strictEqual(isExemptPath({ method: 'GET', path: '/static/a.mp3' }), true);
    assert.strictEqual(isExemptPath({ method: 'GET', path: '/static' }), true);
    assert.strictEqual(isExemptPath({ method: 'POST', path: '/config' }), false);
    assert.strictEqual(isExemptPath({ method: 'POST', path: '/reset' }), false);
    assert.strictEqual(isExemptPath({ method: 'GET', path: '/history' }), false);
});

// ==================== 集成层：真实 HTTP 请求 ====================

/** 启动一个挂载指定鉴权中间件的测试 app；返回 { server, base, close }。 */
async function startServer(token) {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use(createAuthMiddleware({ token }));
    // 健康检查（与生产 app.js 一致，豁免）
    app.get('/', (req, res) => res.json({ message: 'AI Girlfriend Node Backend is Running' }));
    // 模拟静态资源（豁免）
    app.use('/static', (req, res) => res.json({ ok: 'static' }));
    // 受保护的业务路由
    app.post('/config', (req, res) => res.json({ status: 'updated' }));
    app.post('/reset', (req, res) => res.json({ status: 'reset' }));
    app.get('/history', (req, res) => res.json([]));

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return {
        server,
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(resolve);
        }),
    };
}

/** 发真实 HTTP 请求；返回 { status, json, headers }。 */
async function call(base, method, path, headers = {}, body) {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined
            ? headers
            : { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json };
}

const CONFIGURED_TOKEN = 'test-secret-token-1234567890';

console.log('集成层 · 已配置 token:');
{
    const { base, close } = await startServer(CONFIGURED_TOKEN);
    try {
        await checkAsync('带正确 token 的 POST /config 放行（200）', async () => {
            const { status, json } = await call(base, 'POST', '/config',
                { authorization: `Bearer ${CONFIGURED_TOKEN}` }, { api_key: 'k' });
            assert.strictEqual(status, 200);
            assert.strictEqual(json.status, 'updated');
        });
        await checkAsync('带正确 token 的 POST /reset 放行（200）', async () => {
            const { status } = await call(base, 'POST', '/reset',
                { authorization: `Bearer ${CONFIGURED_TOKEN}` });
            assert.strictEqual(status, 200);
        });
        await checkAsync('带正确 token 的 GET /history 放行（200）', async () => {
            const { status } = await call(base, 'GET', '/history',
                { authorization: `Bearer ${CONFIGURED_TOKEN}` });
            assert.strictEqual(status, 200);
        });
        await checkAsync('带错误 token → 401', async () => {
            const { status, json } = await call(base, 'POST', '/config',
                { authorization: 'Bearer wrong-token' }, { api_key: 'k' });
            assert.strictEqual(status, 401);
            assert.ok(typeof json.detail === 'string' && json.detail.length > 0);
        });
        await checkAsync('token 长度不等 → 401 且服务不崩溃', async () => {
            const { status } = await call(base, 'POST', '/reset',
                { authorization: 'Bearer x' });
            assert.strictEqual(status, 401);
        });
        await checkAsync('完全缺少 Authorization 头 → 401', async () => {
            const { status } = await call(base, 'POST', '/config', {}, { api_key: 'k' });
            assert.strictEqual(status, 401);
        });
        await checkAsync('Authorization 格式非 Bearer → 401', async () => {
            const { status } = await call(base, 'GET', '/history',
                { authorization: 'Basic abc' });
            assert.strictEqual(status, 401);
        });
        await checkAsync('健康检查 GET / 豁免（即使无 token）', async () => {
            const { status, json } = await call(base, 'GET', '/');
            assert.strictEqual(status, 200);
            assert.strictEqual(json.message, 'AI Girlfriend Node Backend is Running');
        });
        await checkAsync('CORS 预检 OPTIONS 豁免（即使无 token）', async () => {
            const { status } = await call(base, 'OPTIONS', '/config');
            assert.ok(status < 400, `OPTIONS 预检不应被拦截，实际 ${status}`);
        });
        await checkAsync('静态资源 /static 豁免（即使无 token）', async () => {
            const { status } = await call(base, 'GET', '/static/voice.mp3');
            assert.strictEqual(status, 200);
        });
    } finally {
        await close();
    }
}

console.log('集成层 · 未配置 token（本机守卫）:');
{
    const { base, close } = await startServer(null);
    try {
        await checkAsync('本机回环请求（无 token）放行（200）', async () => {
            const { status, json } = await call(base, 'POST', '/config', {}, { api_key: 'k' });
            assert.strictEqual(status, 200, '本机守卫模式应放行回环请求');
            assert.strictEqual(json.status, 'updated');
        });
        await checkAsync('本机回环 GET /history 放行（200）', async () => {
            const { status } = await call(base, 'GET', '/history');
            assert.strictEqual(status, 200);
        });
        await checkAsync('未配置 token 时任意 Bearer 头仍放行（回环）', async () => {
            const { status } = await call(base, 'POST', '/reset', { authorization: 'Bearer whatever' });
            assert.strictEqual(status, 200);
        });
    } finally {
        await close();
    }
}

// 非本机来源模拟：直接驱动中间件，构造远端 socket 地址，断言 401。
console.log('集成层 · 未配置 token 且来源非本机:');
await checkAsync('非回环地址 + 无 token → 401（核心 P0 断言）', async () => {
    const middleware = createAuthMiddleware({ token: null });
    const req = { method: 'POST', path: '/reset', headers: {}, socket: { remoteAddress: '192.168.0.42' }, ip: '192.168.0.42' };
    const res = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false, '非本机请求不得放行');
    assert.strictEqual(res.statusCode, 401);
    assert.ok(typeof res.body.detail === 'string' && res.body.detail.includes('AI_GIRLFRIEND_TOKEN'));
});

await checkAsync('伪造 X-Forwarded-For 无法绕过本机守卫', async () => {
    const middleware = createAuthMiddleware({ token: null });
    const req = {
        method: 'POST',
        path: '/config',
        headers: { 'x-forwarded-for': '127.0.0.1' },
        socket: { remoteAddress: '203.0.113.9' },
        ip: '203.0.113.9',
    };
    const res = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 401);
});

const total = passed + failed;
if (failed > 0) {
    console.error(`\n${passed}/${total} 通过，${failed} 项失败`);
} else {
    console.log(`\n全部 ${passed} 项通过`);
}
