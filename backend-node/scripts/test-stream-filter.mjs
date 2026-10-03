/**
 * streamFilter 单元测试：验证三类片段在任意切分下都不会泄漏进正文气泡，
 * 且 CoT 与内心独白被正确分流（这是最容易混淆的一对）。
 * 运行: node scripts/test-stream-filter.mjs
 */
import assert from 'assert';
import { createStreamFilter, splitDelta, extractReasoning, parseFullText } from '../src/core/streamFilter.js';

/** 把文本按给定大小切成 chunk，模拟流式到达 */
function feed(text, chunkSize, filter) {
    let out = '';
    for (let i = 0; i < text.length; i += chunkSize) {
        out += filter.push(text.slice(i, i + chunkSize));
    }
    const { tail, cot, monologue, metadata } = filter.finish();
    return { visible: out + tail, cot, monologue, metadata };
}

let passed = 0;
let failed = 0;
function check(name, fn) {
    try {
        const out = fn();
        if (out && typeof out.then === 'function') {
            throw new Error('check() 收到了 Promise —— 异步断言会被静默跳过，请改用 await + 显式断言');
        }
        passed++;
        console.log(`  OK   ${name}`);
    } catch (e) {
        failed++;
        console.error(`  FAIL ${name}\n       ${e.message}`);
        process.exitCode = 1;
    }
}

console.log('streamFilter:');

// 1. 纯文本
check('纯文本原样输出', () => {
    for (const size of [1, 2, 3, 5, 100]) {
        const { visible } = feed('你好呀，今天过得怎么样？', size, createStreamFilter());
        assert.strictEqual(visible, '你好呀，今天过得怎么样？');
    }
});

// 2. 人设内心独白 <monologue>
check('<monologue> 内心独白被剥离且可单独取出', () => {
    const full = '<monologue>他在试探我</monologue>当然记得啦～';
    for (const size of [1, 2, 3, 4, 7, 100]) {
        const { visible, monologue, cot } = feed(full, size, createStreamFilter());
        assert.strictEqual(visible, '当然记得啦～', `size=${size} visible=${visible}`);
        assert.strictEqual(monologue, '他在试探我', `size=${size} monologue=${monologue}`);
        assert.strictEqual(cot, '', `size=${size} cot=${cot}`);
    }
});

// 3. 结尾 metadata
check('<metadata> 元数据被过滤且可解析', () => {
    const full = '今天很开心呢～<metadata>{"emotion":"happy","affinity_change":2}</metadata>';
    for (const size of [1, 3, 5, 10, 100]) {
        const { visible, metadata } = feed(full, size, createStreamFilter());
        assert.strictEqual(visible, '今天很开心呢～', `size=${size} visible=${visible}`);
        assert.strictEqual(metadata, '{"emotion":"happy","affinity_change":2}');
        assert.deepStrictEqual(JSON.parse(metadata), { emotion: 'happy', affinity_change: 2 });
    }
});

// 4. 独白 + metadata 同时存在
check('monologue + metadata 同时存在', () => {
    const full = '<monologue>嗯…</monologue>好呀<metadata>{"emotion":"shy"}</metadata>';
    for (const size of [1, 2, 4, 8, 100]) {
        const { visible, monologue, metadata } = feed(full, size, createStreamFilter());
        assert.strictEqual(visible, '好呀', `size=${size}`);
        assert.strictEqual(monologue, '嗯…');
        assert.strictEqual(metadata, '{"emotion":"shy"}');
    }
});

// 5. 正文里含普通 '<' / '>'，不应被误当标签
check('正文中的普通 < > 不被误判', () => {
    const full = '我觉得 a < b 而且 c > d 哦';
    for (const size of [1, 2, 5, 100]) {
        const { visible } = feed(full, size, createStreamFilter());
        assert.strictEqual(visible, full, `size=${size} visible=${visible}`);
    }
});

// 6. 形似但未闭合的标签前缀，应按普通文本输出
check('未形成标签的 "<thi" 按正文输出', () => {
    const { visible } = feed('我喜欢 <thinki ng> 这个写法', 3, createStreamFilter());
    assert.strictEqual(visible, '我喜欢 <thinki ng> 这个写法');
});

// 7. metadata 在流结束时仍未闭合
check('未闭合的 metadata 不泄漏到正文', () => {
    const full = '答复内容<metadata>{"emotion":"sad"';
    const { visible, metadata } = feed(full, 4, createStreamFilter());
    assert.strictEqual(visible, '答复内容');
    assert.strictEqual(metadata, '{"emotion":"sad"');
});

// 8. 空 chunk 与多次 finish 的健壮性
check('空输入与重复 finish 安全', () => {
    const f = createStreamFilter();
    assert.strictEqual(f.push(''), '');
    assert.strictEqual(f.push(null), '');
    const r = f.finish();
    assert.strictEqual(r.tail, '');
    assert.strictEqual(f.finish().tail, '');
});

// 9. 模型 CoT 与内心独白共存时必须各归各位（核心回归点）
check('<think> 与 <monologue> 不混淆', () => {
    const full = '<think>先判断他的意图：这是寒暄还是试探</think><monologue>他在跟我打招呼呢</monologue>你好呀～';
    for (const size of [1, 2, 3, 5, 11, 100]) {
        const { visible, cot, monologue } = feed(full, size, createStreamFilter());
        assert.strictEqual(visible, '你好呀～', `size=${size} visible=${visible}`);
        assert.strictEqual(cot, '先判断他的意图：这是寒暄还是试探', `size=${size} cot=${cot}`);
        assert.strictEqual(monologue, '他在跟我打招呼呢', `size=${size} monologue=${monologue}`);
    }
});

// 10. splitDelta 分离 content 与 reasoning_content
check('splitDelta 分离 content 与 reasoning_content', () => {
    assert.deepStrictEqual(
        splitDelta({ choices: [{ delta: { content: '正文', reasoning_content: '让我想想…' } }] }),
        { content: '正文', reasoning: '让我想想…' }
    );
    assert.deepStrictEqual(
        splitDelta({ choices: [{ delta: { content: '正文' } }] }),
        { content: '正文', reasoning: '' }
    );
    // 只有 reasoning 的 chunk（推理阶段常见），content 应为空而不是 undefined
    assert.deepStrictEqual(
        splitDelta({ choices: [{ delta: { reasoning_content: '思考中' } }] }),
        { content: '', reasoning: '思考中' }
    );
    assert.deepStrictEqual(splitDelta({}), { content: '', reasoning: '' });
    assert.deepStrictEqual(splitDelta(undefined), { content: '', reasoning: '' });
});

// 11. 部分厂商把原生思考放在 reasoning 别名里
check('splitDelta / extractReasoning 兼容 reasoning 别名', () => {
    assert.strictEqual(
        splitDelta({ choices: [{ delta: { content: 'a', reasoning: 'CoT' } }] }).reasoning,
        'CoT'
    );
    assert.strictEqual(extractReasoning({ content: 'hi', reasoning_content: '原生思考' }), '原生思考');
    assert.strictEqual(extractReasoning({ content: 'hi', reasoning: '别名' }), '别名');
    assert.strictEqual(extractReasoning({ content: 'hi' }), '');
    assert.strictEqual(extractReasoning(null), '');
});

// 12. 【核心保证】非流式 parseFullText == 流式逐字符喂入
// 这是「标签规则单一真源」的正确性锁：两条路径结论必须逐字一致，
// 否则非流式（_parseReplyText / generateProactiveMessage）与流式可能出现不同行为。
check('parseFullText == 流式逐字符喂入（三类标签齐全）', () => {
    const full = '<think>先揣摩他的意图</think><monologue>他好像有点紧张</monologue>'
        + '别急嘛，慢慢说～<metadata>{"emotion":"gentle","affinity_change":1}</metadata>';
    const streamed = feed(full, 1, createStreamFilter());
    const parsed = parseFullText(full);
    assert.strictEqual(parsed.replyText, streamed.visible, 'replyText 必须与流式 visible 一致');
    assert.strictEqual(parsed.cot, streamed.cot, 'cot 必须一致');
    assert.strictEqual(parsed.monologue, streamed.monologue, 'monologue 必须一致');
    assert.strictEqual(parsed.metadata, streamed.metadata, 'metadata 必须一致');
});

// 13. 跨 chunk 半标签：非流式结果同样正确（规则等价，不受切分影响）
check('跨 chunk 半标签两侧一致', () => {
    const full = '前半句<monologue>偷偷想</monologue>后半句';
    // 流式按 3 字符切，必然在 "<monologue>" 中间断开（如 "<mo" + "nol"...）
    const streamed = feed(full, 3, createStreamFilter());
    const parsed = parseFullText(full);
    assert.strictEqual(parsed.replyText, '前半句后半句');
    assert.strictEqual(parsed.replyText, streamed.visible);
    assert.strictEqual(parsed.monologue, '偷偷想');
    assert.strictEqual(parsed.monologue, streamed.monologue);
});

// 14. 未闭合 metadata：两侧都不泄漏残片且 metadata 一致
check('未闭合 metadata 两侧行为一致', () => {
    const full = '答复内容<metadata>{"emotion":"sad"';
    const streamed = feed(full, 5, createStreamFilter());
    const parsed = parseFullText(full);
    assert.strictEqual(parsed.replyText, '答复内容');
    assert.strictEqual(parsed.replyText, streamed.visible);
    assert.strictEqual(parsed.metadata, '{"emotion":"sad"');
    assert.strictEqual(parsed.metadata, streamed.metadata);
});

// 15. 旧格式兼容：只有 <think> 无 <monologue> —— 状态机原样分离出 cot（供上层当独白）
// 兼容逻辑（<think> 当人设独白、modelReasoning 置 null）由 AiGirlfriend._parseReplyText 承担，
// 这里锁定 parseFullText 的职责：不越权，只负责如实分离标签。
check('旧格式只有 <think>：parseFullText 仍归入 cot 而非吞掉', () => {
    const full = '<think>他今天心情好像不太好</think>怎么啦，愿意跟我说说吗？';
    const parsed = parseFullText(full);
    assert.strictEqual(parsed.replyText, '怎么啦，愿意跟我说说吗？');
    assert.strictEqual(parsed.monologue, '');              // 没有 <monologue>
    assert.strictEqual(parsed.cot, '他今天心情好像不太好'); // 交由上层兼容判定
    // 与流式一致
    const streamed = feed(full, 2, createStreamFilter());
    assert.deepStrictEqual(parsed, { replyText: streamed.visible, cot: streamed.cot, monologue: streamed.monologue, metadata: streamed.metadata });
});

// 16. 无标签纯文本：replyText 原样返回，三类均空
check('无标签文本 replyText 原样、三类为空', () => {
    const parsed = parseFullText('就这样平平常常地聊着天。');
    assert.strictEqual(parsed.replyText, '就这样平平常常地聊着天。');
    assert.strictEqual(parsed.cot, '');
    assert.strictEqual(parsed.monologue, '');
    assert.strictEqual(parsed.metadata, '');
    assert.deepStrictEqual(parseFullText(''), { replyText: '', cot: '', monologue: '', metadata: '' });
    assert.deepStrictEqual(parseFullText(null), { replyText: '', cot: '', monologue: '', metadata: '' });
});

const TOTAL = 16;
console.log(`\n${passed}/${TOTAL} 通过，${failed} 失败`);
// 用例数对不上 = 有用例被删掉或提前 return 而没执行。这种情况以前只打印一行
// 「存在失败」却仍然 exit 0，CI 照绿（审计 INFRA-01）。现在直接判失败。
if (failed > 0 || passed !== TOTAL) process.exit(1);
