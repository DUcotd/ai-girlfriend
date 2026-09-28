/**
 * 对比流式与非流式的「首字可见时间」。
 * 用法: node scripts/bench-chat.mjs
 */
const BASE = 'http://127.0.0.1:8000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function benchStream() {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '你叫什么名字？' }),
  });
  if (!res.ok) throw new Error(`stream HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let firstTokenAt = null;
  let deltaCount = 0;
  let done = null;

  while (true) {
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
      }
    }
  }
  const total = Date.now() - t0;
  return {
    firstTokenMs: firstTokenAt ? firstTokenAt - t0 : null,
    totalMs: total,
    deltaCount,
    reply: done?.reply,
    emotion: done?.emotion,
    affinity: done?.affinity,
  };
}

async function benchBlocking() {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '你叫什么名字？' }),
  });
  const data = await res.json();
  return {
    firstTokenMs: Date.now() - t0, // 非流式：只能等全部完成才看得到内容
    totalMs: Date.now() - t0,
    reply: data.reply,
    emotion: data.emotion,
    affinity: data.affinity,
  };
}

(async () => {
  console.log('=== 流式 /chat/stream ===');
  const s = await benchStream();
  console.log(`  首个片段到达: ${s.firstTokenMs} ms`);
  console.log(`  全部完成    : ${s.totalMs} ms`);
  console.log(`  片段数      : ${s.deltaCount}`);
  console.log(`  回复内容    : ${JSON.stringify(s.reply)}`);
  console.log(`  emotion=${s.emotion} affinity=${s.affinity}`);

  await sleep(500);
  console.log('\n=== 非流式 /chat ===');
  const b = await benchBlocking();
  console.log(`  首个片段到达: ${b.firstTokenMs} ms（等于全部完成时间）`);
  console.log(`  全部完成    : ${b.totalMs} ms`);
  console.log(`  回复内容    : ${JSON.stringify(b.reply)}`);
  console.log(`  emotion=${b.emotion} affinity=${b.affinity}`);

  console.log('\n=== 结论 ===');
  console.log(`  首字等待: ${b.firstTokenMs} ms -> ${s.firstTokenMs} ms` +
    `（快 ${(b.firstTokenMs / Math.max(s.firstTokenMs, 1)).toFixed(1)}x）`);

  const leak = /<think>|<\/think>|<monologue>|<\/monologue>|<metadata>|<\/metadata>|他在问我名字|他在主动认识我/.test(s.reply || '');
  console.log(`  流式回复是否泄漏 think/metadata: ${leak ? '❌ 泄漏' : '✅ 未泄漏'}`);
  const leak2 = /<think>|<metadata>/.test(b.reply || '');
  console.log(`  非流式回复是否泄漏标签        : ${leak2 ? '❌ 泄漏' : '✅ 未泄漏'}`);
})().catch((e) => {
  console.error('BENCH FAIL:', e.message);
  process.exit(1);
});
