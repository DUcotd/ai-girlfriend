/**
 * B7-① 回归：全站「非 2xx 必带稳定错误码」这条不变量。
 *
 * 为什么值得单独一套：错误码是**对外契约**，散落在 8 个路由 + 2 个中间件里。
 * 只要有一个分支只给文案不给码，前端就还得留着 `message.includes("409")` 那种文字匹配；
 * 而文字匹配分支在一次文案微调后失效时，表现是「用户明明收到了错误，界面却报成功」——
 * 本项目已经为这类静默失效付过两次学费。这套测试把契约钉死：
 *   1. 逐个真实打接口，断言状态码、稳定码、detail 三件事；
 *   2. 断言每个稳定码都在两张码表里（不许现场编字符串码）；
 *   3. 断言 failWith 漏传 code 时按状态码兜底，永远不给 undefined。
 *
 * 运行：node scripts/test-audit-b7.mjs（全程写沙盒数据目录，不碰 backend-node/data/）
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AI_GIRLFRIEND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aigf-b7-'));
process.env.HOST = '127.0.0.1';

const { createApp } = await import('../src/app.js');
const { aiGirlfriend, proactiveEngine } = await import('../src/services/container.js');
const { createHarness } = await import('./lib/testKit.mjs');
const { ERROR_CODES, codeFor } = await import('../src/utils/errorCodes.js');
const { UPSTREAM_ERROR_CODES } = await import('../src/utils/upstreamError.js');
const { createAuthMiddleware } = await import('../src/middleware/auth.js');
const { config } = await import('../src/config.js');

const KNOWN_CODES = new Set([
    ...Object.values(ERROR_CODES),
    ...Object.values(UPSTREAM_ERROR_CODES),
]);

/**
 * 每个用例 4 条断言：状态码 / error_code 值 / detail 非空 / 码在表里。
 * 断言总数由用例表长度算出来，加用例时不必再手改某个魔法数字。
 */
const CASES = [
    { name: '未匹配路径', method: 'GET', url: '/no/such/path', status: 404, code: ERROR_CODES.NOT_FOUND },
    { name: '旧的消费型 GET 明确失败', method: 'GET', url: '/chat/proactive', status: 405, code: ERROR_CODES.METHOD_NOT_ALLOWED },
    { name: '没配 Key 就发消息', method: 'POST', url: '/chat', body: { message: '你好' }, status: 400, code: UPSTREAM_ERROR_CODES.NOT_CONFIGURED },
    { name: '流式没配 Key', method: 'POST', url: '/chat/stream', body: { message: '你好' }, status: 400, code: UPSTREAM_ERROR_CODES.NOT_CONFIGURED },
    // 这三条要「有 Key 但消息不合法」才测得到入参分支：路由先查 Key，没 Key 时一律回 not_configured
    { name: '空消息', needKey: true, method: 'POST', url: '/chat', body: { message: '   ' }, status: 400, code: ERROR_CODES.INVALID_REQUEST },
    { name: '超长消息', needKey: true, method: 'POST', url: '/chat', body: { message: 'x'.repeat(config.chat.maxMessageLength + 1) }, status: 400, code: ERROR_CODES.INVALID_REQUEST },
    { name: '流式空消息', needKey: true, method: 'POST', url: '/chat/stream', body: { message: 123 }, status: 400, code: ERROR_CODES.INVALID_REQUEST },
    { name: '配置字段类型非法', method: 'POST', url: '/config', body: { api_key: {} }, status: 400, code: ERROR_CODES.INVALID_CONFIG },
    { name: '主动消息频率档位不存在', method: 'POST', url: '/config/proactive', body: { frequencyLevel: 'nope' }, status: 400, code: ERROR_CODES.INVALID_CONFIG },
    { name: '主动消息未知类型 id', method: 'POST', url: '/config/proactive', body: { enabledTypes: ['no_such_type'] }, status: 400, code: ERROR_CODES.INVALID_CONFIG },
    { name: '编辑不存在的事实', method: 'PATCH', url: '/memories/facts/nope', body: { content: 'x' }, status: 404, code: ERROR_CODES.FACT_NOT_FOUND },
    { name: '删除不存在的记忆', method: 'DELETE', url: '/memories/nope', status: 404, code: ERROR_CODES.MEMORY_NOT_FOUND },
    { name: '删除不存在的叙事', method: 'DELETE', url: '/state/narratives/nope', status: 404, code: ERROR_CODES.NARRATIVE_NOT_FOUND },
    { name: '删除不存在的任务', method: 'DELETE', url: '/tasks/nope', status: 404, code: ERROR_CODES.TASK_NOT_FOUND },
    { name: '朗读文本类型不对', method: 'POST', url: '/audio/speak', body: { text: 123 }, status: 400, code: ERROR_CODES.INVALID_REQUEST },
    { name: '没配语音 Key 就朗读', method: 'POST', url: '/audio/speak', body: { text: '你好' }, status: 400, code: ERROR_CODES.VOICE_NOT_CONFIGURED },
    { name: '转写没带文件', method: 'POST', url: '/audio/transcribe', body: {}, status: 400, code: ERROR_CODES.UPLOAD_REJECTED },
    { name: '导入的档案不是本格式', method: 'POST', url: '/backup/import', body: { hello: 'world' }, status: 400, code: ERROR_CODES.BACKUP_INVALID },
    { name: '恢复没给快照 id', method: 'POST', url: '/backup/restore', body: {}, status: 400, code: ERROR_CODES.BACKUP_BAD_REQUEST },
    { name: '恢复一个不存在的快照', method: 'POST', url: '/backup/restore', body: { id: 'nope-19700101' }, status: 404, code: ERROR_CODES.BACKUP_SNAPSHOT_NOT_FOUND },
];

// 这些用例需要「引擎/装配层给出特定失败」，用 stub 造，测完必须还原
const STUB_CASES = [
    {
        name: '添加重复的事实',
        method: 'POST', url: '/memories/facts', body: { content: '我喜欢下雨天' },
        status: 409, code: ERROR_CODES.DUPLICATE_FACT,
        setup() {
            aiGirlfriend.addFact = async () => {
                const e = new Error('已经记着类似的事了');
                e.code = 'DUPLICATE_FACT';      // 引擎的内部标记，路由要翻成对外稳定码
                throw e;
            };
        },
        restore() { delete aiGirlfriend.addFact; },
    },
    {
        name: 'LifeSimulator 还没就绪',
        method: 'GET', url: '/life/current',
        status: 503, code: ERROR_CODES.SERVICE_NOT_READY,
        setup() { this._sim = proactiveEngine.lifeSimulator; proactiveEngine.lifeSimulator = null; },
        restore() { proactiveEngine.lifeSimulator = this._sim; },
    },
    {
        name: '意外异常压成 500',
        method: 'GET', url: '/health',
        status: 500, code: ERROR_CODES.INTERNAL_ERROR,
        setup() {
            aiGirlfriend.getCompanionStatus = () => { throw new Error('kaboom-内部细节'); };
        },
        restore() { aiGirlfriend.getCompanionStatus = Object.getPrototypeOf(aiGirlfriend).getCompanionStatus; },
    },
];

/**
 * 断言总数按小节算出来，加用例时不用手改魔法数字：
 * 每个错误用例 4 条（状态码/码/detail/码在表里）+ stub 还原 3 + 泄漏与附加字段 3
 * + 鉴权 5 + 码表 3 + 状态码兜底 6
 */
const EXPECTED = 4 * (CASES.length + STUB_CASES.length) + 3 + 3 + 5 + 3 + 6;
const t = createHarness('test-audit-b7', { expect: EXPECTED });

const app = createApp();
const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

async function hit(method, url, body) {
    const res = await fetch(`${base}${url}`, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 交给断言判定「回的是不是 JSON」 */ }
    return { status: res.status, json, text };
}

/** 每个错误响应都验同一组事：状态码、稳定码、detail、码在表里 */
function assertErrorShape(label, r, expectStatus, expectCode) {
    t.check(`${label} · 状态码 ${expectStatus}`,
        r.status === expectStatus, `实际 ${r.status} —— ${r.text.slice(0, 120)}`);
    t.check(`${label} · error_code == ${expectCode}`,
        r.json?.error_code === expectCode, `实际 ${JSON.stringify(r.json?.error_code)}`);
    t.check(`${label} · detail 是非空字符串（有码也得有话可显示）`,
        typeof r.json?.detail === 'string' && r.json.detail.length > 0);
    t.check(`${label} · 码来自码表（不许现场编字符串）`,
        KNOWN_CODES.has(r.json?.error_code), `未知码 ${r.json?.error_code}`);
}

// 「没配 Key」分支要求进程内真的没有 Key；需要走消息校验分支的用例再临时给一个假 Key
// （假 Key 只用于过路由守卫：这三条的入参都不合法，走不到任何上游调用）
const originalApiKey = aiGirlfriend.apiKey;

try {
    console.log('== 逐路由：每个 4xx/5xx 都带稳定码 ==');
    for (const c of CASES) {
        aiGirlfriend.apiKey = c.needKey ? 'sk-b7-not-a-real-key' : null;
        const r = await hit(c.method, c.url, c.body);
        assertErrorShape(c.name, r, c.status, c.code);
    }
    aiGirlfriend.apiKey = null;

    console.log('== 需要 stub 的失败分支 ==');
    for (const c of STUB_CASES) {
        c.setup();
        try {
            const r = await hit(c.method, c.url, c.body);
            assertErrorShape(c.name, r, c.status, c.code);
        } finally {
            c.restore();
        }
    }
    t.check('stub 都还原了（getCompanionStatus 回到原型实现）',
        aiGirlfriend.getCompanionStatus === Object.getPrototypeOf(aiGirlfriend).getCompanionStatus);
    t.check('stub 都还原了（lifeSimulator 还在）', !!proactiveEngine.lifeSimulator);
    t.check('stub 都还原了（addFact 不再是被替换的那份）',
        !Object.prototype.hasOwnProperty.call(aiGirlfriend, 'addFact'));

    console.log('== 响应体里不能泄漏内部细节 ==');
    {
        const orig = aiGirlfriend.getCompanionStatus;
        aiGirlfriend.getCompanionStatus = () => { throw new Error('kaboom-内部细节'); };
        const r = await hit('GET', '/health');
        aiGirlfriend.getCompanionStatus = orig;
        t.check('500 的 detail 是通用文案，不含抛出的原文与堆栈',
            r.status === 500 && r.json?.detail === 'Internal server error'
            && !/kaboom|at\s+\w+\s*\(|node_modules/.test(r.text), `${r.status} ${r.text.slice(0, 80)}`);
        t.check('500 也带 error_code（前端要能显示「稍后再试」而不是猜）',
            r.json?.error_code === ERROR_CODES.INTERNAL_ERROR);

        // 405 除了码还带 allow：旧客户端靠它知道该改 POST，这个字段不能因为改用 failWith 而丢
        const r405 = await hit('GET', '/chat/proactive');
        t.check('405 的附加字段 allow 仍在（extra 透传没被吃掉）',
            Array.isArray(r405.json?.allow) && r405.json.allow.join(',') === 'POST',
            JSON.stringify(r405.json));
    }

    console.log('== 鉴权中间件的三个 401 分支各有自己的码 ==');
    {
        const mkRes = () => {
            const res = { statusCode: 0, body: null };
            res.status = (code) => { res.statusCode = code; return res; };
            res.json = (obj) => { res.body = obj; return res; };
            return res;
        };
        const req = (headers = {}, remoteAddress = '127.0.0.1') => ({
            method: 'GET', path: '/chat', headers, socket: { remoteAddress },
        });

        // 档位 1：根本没配 token → 只剩「本机守卫」，外部地址一律拒
        const openGuard = createAuthMiddleware({ token: null });
        const r1 = mkRes(); openGuard(req({}, '8.8.8.8'), r1, () => {});
        t.check('未配 token 且来自外部 → 401 unauthorized_open',
            r1.statusCode === 401 && r1.body?.error_code === ERROR_CODES.UNAUTHORIZED_OPEN,
            JSON.stringify(r1.body));
        const r1b = mkRes(); openGuard(req({}, '127.0.0.1'), r1b, () => {});
        t.check('未配 token 但来自本机 → 放行（单机自用的默认体验不能被自己的守卫挡住）',
            r1b.statusCode === 0 && r1b.body === null);

        // 档位 2：配了 token → 没带 与 带错 是两个不同的码（前者的提示是「去设置里填凭证」，
        // 后者是「凭证不对，重新填」，混成一个码界面就没法给出准确行动）
        const withToken = createAuthMiddleware({ token: 'b7-token' });
        const r2 = mkRes(); withToken(req({}, '127.0.0.1'), r2, () => {});
        t.check('配了 token 却没带 → 401 unauthorized_missing（本机也一样要带）',
            r2.statusCode === 401 && r2.body?.error_code === ERROR_CODES.UNAUTHORIZED_MISSING,
            JSON.stringify(r2.body));
        const r3 = mkRes(); withToken(req({ authorization: 'Bearer wrong' }), r3, () => {});
        t.check('带了但不对 → 401 unauthorized_token',
            r3.statusCode === 401 && r3.body?.error_code === ERROR_CODES.UNAUTHORIZED_TOKEN,
            JSON.stringify(r3.body));
        const r4 = mkRes(); withToken(req({ authorization: 'Bearer b7-token' }), r4, () => {});
        t.check('带对 → 放行且没有错误体', r4.statusCode === 0 && r4.body === null);
    }

    console.log('== 码表本身 ==');
    {
        const localValues = Object.values(ERROR_CODES);
        const upstreamValues = Object.values(UPSTREAM_ERROR_CODES);
        const overlap = localValues.filter((v) => upstreamValues.includes(v));
        t.check('两张表只共享刻意别名的 internal_error，其余不许重码',
            overlap.length === 1 && overlap[0] === UPSTREAM_ERROR_CODES.UNKNOWN,
            overlap.join(','));
        t.check('本表内部没有重复值',
            new Set(localValues).size === localValues.length,
            localValues.filter((v, i) => localValues.indexOf(v) !== i).join(','));
        t.check('码值都是 snake_case（对外契约风格统一）',
            localValues.every((v) => /^[a-z][a-z0-9_]*$/.test(v)),
            localValues.filter((v) => !/^[a-z][a-z0-9_]*$/.test(v)).join(','));
    }

    console.log('== 漏传 code 时按状态码兜底（不变量的来源）==');
    {
        t.check('codeFor(400) → invalid_request', codeFor(400) === ERROR_CODES.INVALID_REQUEST);
        t.check('codeFor(404) → not_found', codeFor(404) === ERROR_CODES.NOT_FOUND);
        t.check('codeFor(409) → duplicate_fact', codeFor(409) === ERROR_CODES.DUPLICATE_FACT);
        t.check('codeFor(413) → payload_too_large', codeFor(413) === ERROR_CODES.PAYLOAD_TOO_LARGE);
        t.check('codeFor(503) → service_not_ready', codeFor(503) === ERROR_CODES.SERVICE_NOT_READY);
        t.check('codeFor(未知状态) → internal_error，绝不返回 undefined',
            codeFor(418) === ERROR_CODES.INTERNAL_ERROR);
    }
} finally {
    aiGirlfriend.apiKey = originalApiKey;
    proactiveEngine.stop();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    try { fs.rmSync(process.env.AI_GIRLFRIEND_DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

const code = t.finish();
process.exit(code);
