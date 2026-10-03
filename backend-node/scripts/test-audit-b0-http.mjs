/**
 * B0 批次的 HTTP 层回归测试（真实起服务、真实断开连接）。
 *
 * 覆盖：
 *   B0-2   客户端断开 → 上游 LLM 请求被 abort，且中断的半轮只入历史、不改关系
 *   B0-8   POST /reset 部分失败回 200 + status:'partial'（不再是前端读不懂的 207）
 *   HTTP-04 未匹配路径回 JSON 而不是 Express 默认 HTML
 *   HTTP-09 CORS 允许 PATCH（PATCH /memories/facts/:id 在用）
 *   B0-1   POST /system_prompt 不清历史
 *
 * 运行：node scripts/test-audit-b0-http.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.AI_GIRLFRIEND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aigf-b0http-'));
process.env.HOST = '127.0.0.1';

const { createApp } = await import('../src/app.js');
const { aiGirlfriend, proactiveEngine } = await import('../src/services/container.js');

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log('  PASS', name); }
    else { failures.push(`${name}${detail ? ` —— ${detail}` : ''}`); console.log('  FAIL', name, detail); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const app = createApp();
const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

// ---- 假上游：可中断的慢速流 ----
const upstream = { sawAbort: false, chunksSent: 0, ranToCompletion: false };
aiGirlfriend.apiKey = 'sk-test';
aiGirlfriend.openai = {
    chat: {
        completions: {
            create: async (_params, opts = {}) => {
                const signal = opts.signal;
                // 断言点 1：路由必须把 AbortSignal 透传到上游调用
                if (signal) signal.addEventListener('abort', () => { upstream.sawAbort = true; }, { once: true });
                return {
                    [Symbol.asyncIterator]: async function* () {
                        try {
                            for (let i = 0; i < 40; i++) {
                                if (signal?.aborted) return;
                                await sleep(25);
                                upstream.chunksSent++;
                                yield { choices: [{ delta: { content: `第${i}段正文。` } }] };
                            }
                            // 断言点 2：能被消费到这里的说明整段都生成完了
                            upstream.ranToCompletion = true;
                            yield { choices: [{ delta: { content: '<metadata>{"emotion":"平静","affinity_change":3}</metadata>' } }] };
                        } finally {
                            // 消费方 break 时 for-await 会 return() 掉迭代器，走到这里
                        }
                    },
                };
            },
        },
    },
};
aiGirlfriend.memory.embedding = { available: false, model: 'fake', embed: async () => null, update: () => {} };

console.log('== B0-2 客户端断开即中止上游 ==');
const affinityBefore = aiGirlfriend.affinity;
const historyBefore = aiGirlfriend.getHistory().length;
{
    const ctrl = new AbortController();
    const resPromise = fetch(`${base}/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: '随便说点长的' }),
        signal: ctrl.signal,
    }).catch(() => null);
    const res = await resPromise;
    check('流已建立', !!res && res.status === 200, `status=${res?.status}`);
    // 读一小段就断开，模拟用户关页面
    const reader = res.body.getReader();
    await reader.read();
    await reader.read();
    ctrl.abort();
    await sleep(400);

    check('AbortSignal 已透传到上游调用', upstream.sawAbort === true,
        `断开前已发 ${upstream.chunksSent} 段`);
    check('上游没有把整段生成完（省掉的钱与时间）', upstream.ranToCompletion === false,
        `ranToCompletion=${upstream.ranToCompletion}, chunksSent=${upstream.chunksSent}`);
    check('中止发生在早期而非尾部', upstream.chunksSent < 20, `chunksSent=${upstream.chunksSent}`);
    const historyAfter = aiGirlfriend.getHistory();
    check('半轮正文入了历史（刷新不会凭空消失）',
        historyAfter.length > historyBefore && historyAfter.some((m) => m.content.includes('第')),
        `历史 ${historyBefore} → ${historyAfter.length}`);
    check('中断的半轮不改好感度', aiGirlfriend.affinity === affinityBefore,
        `${affinityBefore} → ${aiGirlfriend.affinity}`);
}

console.log('== HTTP-04 未匹配路径回 JSON ==');
{
    const res = await fetch(`${base}/definitely-not-a-route`);
    const text = await res.text();
    check('404 状态码', res.status === 404, `实际 ${res.status}`);
    check('404 是 JSON 而非 HTML', !text.includes('<!DOCTYPE') && (() => { try { return !!JSON.parse(text).detail; } catch { return false; } })(),
        text.slice(0, 60));
}

console.log('== HTTP-09 CORS 允许 PATCH ==');
{
    const res = await fetch(`${base}/memories/facts/abc`, {
        method: 'OPTIONS',
        headers: {
            origin: 'http://localhost:3000',
            'access-control-request-method': 'PATCH',
            'access-control-request-headers': 'content-type',
        },
    });
    const allow = res.headers.get('access-control-allow-methods') || '';
    check('预检通过', res.status < 400, `status=${res.status}`);
    check('allow-methods 含 PATCH', /PATCH/i.test(allow), allow);
}

console.log('== B0-1 POST /system_prompt 不清历史 ==');
{
    aiGirlfriend.history.push({ role: 'user', content: '留着这句' });
    aiGirlfriend.history.push({ role: 'assistant', content: '也留着这句' });
    const before = aiGirlfriend.getHistory().length;
    const res = await fetch(`${base}/system_prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ system_prompt: '新人设：安静一点' }),
    });
    const json = await res.json();
    const after = aiGirlfriend.getHistory().length;
    check('返回 200', res.status === 200, `实际 ${res.status}`);
    check('对话条数不变', after === before, `${before} → ${after}`);
    check('响应带 persisted 标记', json.saved === true, JSON.stringify(json).slice(0, 80));
    const bad = await fetch(`${base}/system_prompt`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ system_prompt: '   ' }),
    });
    check('空白人设被拒（400）', bad.status === 400, `实际 ${bad.status}`);
}

console.log('== B0-8 POST /reset 回 200（不再用 207）==');
{
    const res = await fetch(`${base}/reset`, { method: 'POST' });
    const json = await res.json();
    check('状态码 200', res.status === 200, `实际 ${res.status}`);
    check('status 为 reset 或 partial', json.status === 'reset' || json.status === 'partial', json.status);
    check('reset 列表包含 proactive', Array.isArray(json.reset) && json.reset.includes('proactive'),
        JSON.stringify(json.reset));
    check('重置后历史为空', aiGirlfriend.getHistory().length === 0);
}

console.log(`\n结果: ${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('失败明细:'); for (const f of failures) console.log('  -', f); }

proactiveEngine.stop();
server.closeAllConnections?.();
await new Promise((r) => server.close(r));
try { fs.rmSync(process.env.AI_GIRLFRIEND_DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failures.length ? 1 : 0);
