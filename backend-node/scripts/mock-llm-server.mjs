/**
 * 本地 mock 的 OpenAI 兼容服务，用于验证流式链路与测量首字延迟。
 *
 * 它会把回复切成若干片、每片间隔 CHUNK_DELAY_MS 吐出，
 * 模拟真实模型逐 token 生成的过程，从而对比：
 *   - 非流式 /chat：要等全部生成完才返回
 *   - 流式 /chat/stream：第一片到达就能渲染
 *
 * 用法: node scripts/mock-llm-server.mjs [port]
 */
import http from 'http';

const PORT = Number(process.argv[2]) || 8899;
const CHUNK_DELAY_MS = 200;

// 三类片段齐全，用来验证：CoT 与独白都不泄漏进正文气泡，但独白要能被单独取出
const REASONING = '用户问我的名字，这是破冰阶段的常见问题，回答要亲切一点。';
const REPLY =
  '<think>他在问我名字，我该怎么回答呢</think>' +
  '<monologue>他在主动认识我，好开心，要表现得亲切一点～</monologue>' +
  '我叫小爱呀～很高兴认识你！以后就是你的专属陪伴啦。' +
  '<metadata>{"emotion":"happy","affinity_change":2}</metadata>';

/** 把回复切成小片，模拟 token 粒度 */
function slice(text, size = 6) {
  const parts = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts;
}

const server = http.createServer((req, res) => {
  if (!req.url.startsWith('/v1/chat/completions')) {
    res.writeHead(404).end('{"error":"not found"}');
    return;
  }

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    let payload = {};
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      /* ignore */
    }

    if (payload.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // 推理模型会先吐一串 reasoning_content，再吐 content，这里照抄这个顺序
      for (const part of slice(REASONING, 8)) {
        await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS));
        res.write(
          `data: ${JSON.stringify({
            id: 'mock',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { reasoning_content: part }, finish_reason: null }],
          })}\n\n`
        );
      }
      for (const part of slice(REPLY)) {
        await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS));
        res.write(
          `data: ${JSON.stringify({
            id: 'mock',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { content: part }, finish_reason: null }],
          })}\n\n`
        );
      }
      res.write(
        `data: ${JSON.stringify({
          id: 'mock',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // 非流式：等全部「生成」完（同样耗时）再一次性返回
    await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS * slice(REPLY).length));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: REPLY, reasoning_content: REASONING },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      })
    );
  });
});

server.listen(PORT, () => {
  const parts = slice(REPLY);
  console.log(`[mock-llm] listening on http://127.0.0.1:${PORT}`);
  console.log(
    `[mock-llm] ${parts.length} chunks x ${CHUNK_DELAY_MS}ms = 约 ${(parts.length * CHUNK_DELAY_MS) / 1000}s 生成完毕`
  );
});
