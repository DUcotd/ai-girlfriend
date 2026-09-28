/**
 * 用真实模型打一遍 /chat/stream，做配置体检。
 *
 * 检查项：
 *   1. 首字可见时间 / 总耗时（顺带看原生 reasoning 占了多少）
 *   2. 气泡正文有没有泄漏 <think> / <monologue> / <metadata>
 *   3. inner_thought 拿到的是不是人设独白（而不是 CoT）
 *   4. model_reasoning 是否有内容（推理模型应有），长度多少
 *   5. metadata 有没有解析成功（情绪 / 好感度是否变化）
 *
 * ⚠️ 会产生一条真实对话（写进 history / memory，好感度也会变）。
 *    想不留痕就先备份：cp data/*.json 到别处，跑完拷回来重启后端。
 *
 * 用法: node scripts/probe-real-model.mjs "要发送的话"
 */
const BASE = 'http://127.0.0.1:8000';
const MESSAGE = process.argv[2] || '你好呀，今天过得怎么样？';
const LEAK_RE = /<think>|<\/think>|<monologue>|<\/monologue>|<metadata>|<\/metadata>/;

async function postJson(path, body) {
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

async function streamOnce(message) {
  const res = await fetch(`${BASE}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let firstTokenAt = null;
  const t0 = Date.now();
  let done = null;
  let deltaCount = 0;

  for (;;) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    buf += decoder.decode(value, { stream: true });
    const events = buf.split('\n\n');
    buf = events.pop() || '';
    for (const ev of events) {
      const line = ev.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trim();
      if (!line) continue;
      const p = JSON.parse(line);
      if (p.type === 'delta') {
        deltaCount++;
        if (firstTokenAt === null) firstTokenAt = Date.now();
      } else if (p.type === 'done') {
        done = p;
      } else if (p.type === 'error') {
        throw new Error(p.detail || 'stream error');
      }
    }
  }
  return {
    firstTokenMs: firstTokenAt ? firstTokenAt - t0 : null,
    totalMs: Date.now() - t0,
    deltaCount,
    done,
  };
}

const truncate = (s, n = 400) => (!s ? '' : s.length > n ? s.slice(0, n) + ' …' : s);

(async () => {
  const status = await (await fetch(`${BASE}/config/status`)).json();
  if (!status.isConfigured) {
    console.error('❌ 后端还没配置 API Key（/config/status 返回 isConfigured:false）');
    console.error('   在前端设置页填好 Key 后再跑本脚本。');
    process.exit(1);
  }
  console.log(`模型: ${status.currentModel}\nBase URL: ${status.baseUrl}`);
  console.log(`发送消息: ${JSON.stringify(MESSAGE)}\n`);

  const r = await streamOnce(MESSAGE);
  const d = r.done || {};

  console.log('--- 时序 ---');
  console.log(`  首字可见: ${r.firstTokenMs} ms`);
  console.log(`  总耗时  : ${r.totalMs} ms`);
  console.log(`  片段数  : ${r.deltaCount}`);

  console.log('\n--- 正文（用户在气泡里看到的）---');
  console.log(`  ${JSON.stringify(d.reply)}`);
  console.log(`  泄漏标签: ${LEAK_RE.test(d.reply || '') ? '❌ 有' : '✅ 无'}`);

  console.log('\n--- 内心独白（hover 小图标显示）---');
  console.log(`  ${JSON.stringify(truncate(d.inner_thought))}`);
  console.log(`  判定: ${d.inner_thought ? '✅ 有独白' : '⚠️ 空（模型没按格式输出 <monologue>）'}`);

  console.log('\n--- 模型 CoT（不展示，仅排障）---');
  const mr = d.model_reasoning || '';
  console.log(`  长度: ${mr.length} 字符`);
  console.log(`  ${JSON.stringify(truncate(mr, 300))}`);
  console.log(`  判定: ${mr ? '✅ 抓到了原生/正文 CoT' : 'ℹ️ 无（该模型不输出推理内容，或走的是独立字段）'}`);

  console.log('\n--- 情绪 / 好感度 ---');
  console.log(`  emotion=${d.emotion} affinity=${d.affinity}`);
  console.log(`  metadata 解析: ${d.emotion && d.emotion !== '平静' ? '✅ 成功' : '⚠️ 可能没解析到（默认"平静"）'}`);
})().catch((e) => {
  console.error('PROBE FAIL:', e.message);
  process.exit(1);
});
