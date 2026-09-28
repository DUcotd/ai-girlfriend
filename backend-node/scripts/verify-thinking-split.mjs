/**
 * 端到端验证「CoT 与内心独白分流」是否正确。
 *
 * 用本地 mock LLM（会同时吐 reasoning_content、<think>、<monologue>、<metadata>）
 * 打一遍 /chat/stream 与 /chat，检查：
 *   1. 气泡正文里没有任何标签、没有 CoT、没有独白
 *   2. inner_thought 拿到的是人设独白（<monologue>），不是 CoT
 *   3. model_reasoning 拿到的是原生 reasoning_content + 正文里的 <think>
 *
 * ⚠️ 会把后端临时指向 mock 并往 data/ 写入几条测试消息，跑完记得恢复
 *    （先 cp data/*.json 到别处备份，跑完拷回来重启后端）。
 *
 * 用法:
 *   1) node scripts/mock-llm-server.mjs 8899
 *   2) node scripts/verify-thinking-split.mjs [mockPort]
 */
const BASE = 'http://127.0.0.1:8000';
const MOCK_PORT = Number(process.argv[2]) || 8899;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}/v1`;

const LEAK_RE = /<think>|<\/think>|<monologue>|<\/monologue>|<metadata>|<\/metadata>/;

/**
 * 非流式 POST：必须把响应体读掉，否则 undici 的连接不会归还连接池，
 * 后续同域请求会一直排队（表现为「卡住不返回」）。
 */
async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** SSE 用：只拿响应对象，body 交给 readStream 逐段消费 */
const postRaw = (path, body) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

async function readStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let firstTokenAt = null;
  const t0 = Date.now();
  let done = null;

  for (;;) {
    // 注意：reader.read() 返回的是 { value, done }，字段名写错会导致读完不停循环
    const { value, done: finished } = await reader.read();
    if (finished) break;
    buf += decoder.decode(value, { stream: true });
    const events = buf.split('\n\n');
    buf = events.pop() || '';
    for (const ev of events) {
      const line = ev.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trim();
      if (!line) continue;
      const p = JSON.parse(line);
      if (p.type === 'delta' && firstTokenAt === null) firstTokenAt = Date.now();
      if (p.type === 'done') done = p;
    }
  }
  return { done, firstTokenMs: firstTokenAt ? firstTokenAt - t0 : null, totalMs: Date.now() - t0 };
}

let failures = 0;
function assert(name, cond, extra = '') {
  if (cond) {
    console.log(`  OK   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${extra ? ' -> ' + extra : ''}`);
  }
}

(async () => {
  const before = await (await fetch(`${BASE}/config/status`)).json();
  console.log(`当前配置: model=${before.currentModel} baseUrl=${before.baseUrl}\n`);

  console.log('指向 mock…');
  await post('/config', { api_key: 'mock-key', base_url: MOCK_BASE, model_name: 'mock-model' });

  console.log('\n=== 流式 /chat/stream ===');
  const sRes = await postRaw('/chat/stream', { message: '你叫什么名字？' });
  const s = await readStream(sRes);
  console.log(`  首字可见: ${s.firstTokenMs} ms / 总耗时 ${s.totalMs} ms`);
  console.log(`  正文    : ${JSON.stringify(s.done?.reply)}`);
  console.log(`  独白    : ${JSON.stringify(s.done?.inner_thought)}`);
  console.log(`  CoT     : ${JSON.stringify(s.done?.model_reasoning)}`);

  assert('流式正文无标签泄漏', !LEAK_RE.test(s.done?.reply || ''), s.done?.reply);
  assert('流式正文不含 CoT 原文', !/他在问我名字/.test(s.done?.reply || ''));
  assert('流式正文不含独白原文', !/他在主动认识我/.test(s.done?.reply || ''));
  assert('inner_thought 是独白而非 CoT', s.done?.inner_thought === '他在主动认识我，好开心，要表现得亲切一点～', s.done?.inner_thought);
  assert('model_reasoning 含原生 CoT', /用户问我的名字/.test(s.done?.model_reasoning || ''), s.done?.model_reasoning);
  assert('model_reasoning 含正文里的 <think>', /他在问我名字/.test(s.done?.model_reasoning || ''), s.done?.model_reasoning);

  console.log('\n=== 非流式 /chat ===');
  const b = await post('/chat', { message: '你叫什么名字？' });
  console.log(`  正文    : ${JSON.stringify(b.reply)}`);
  console.log(`  独白    : ${JSON.stringify(b.inner_thought)}`);
  console.log(`  CoT     : ${JSON.stringify(b.model_reasoning)}`);

  assert('非流式正文无标签泄漏', !LEAK_RE.test(b.reply || ''), b.reply);
  assert('非流式 inner_thought 是独白', b.inner_thought === '他在主动认识我，好开心，要表现得亲切一点～', b.inner_thought);
  assert('非流式 model_reasoning 含原生 CoT', /用户问我的名字/.test(b.model_reasoning || ''), b.model_reasoning);

  console.log('\n=== 还原配置 ===');
  await post('/config', { base_url: before.baseUrl, model_name: before.currentModel });
  console.log(`  已还原 baseUrl=${before.baseUrl} model=${before.currentModel}`);
  console.log('  注意: api_key 被改成了 mock-key，重启后端即可恢复（key 只存在内存里）');

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  if (failures > 0) process.exitCode = 1;
})().catch((e) => {
  console.error('VERIFY FAIL:', e.message);
  process.exit(1);
});
