/**
 * streamFilter 单元测试：验证三类片段在任意切分下都不会泄漏进正文气泡，
 * 且 CoT 与内心独白被正确分流（这是最容易混淆的一对）。
 * 运行: node scripts/test-stream-filter.mjs
 */
import assert from 'assert';
import { createStreamFilter, splitDelta, extractReasoning } from '../src/core/streamFilter.js';

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
function check(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  OK   ${name}`);
    } catch (e) {
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

const TOTAL = 11;
console.log(passed === TOTAL ? `\n全部 ${passed} 项通过` : `\n${passed}/${TOTAL} 通过，存在失败`);
