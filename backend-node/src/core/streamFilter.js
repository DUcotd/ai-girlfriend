/**
 * 流式输出过滤器。
 *
 * 小爱的回复里可能夹带三类「不该出现在气泡正文里」的片段，语义各不相同：
 *   <think>...</think>          模型自己的推理链 CoT（推理模型 / 蒸馏版会把 CoT 写进正文）
 *                               —— 永远不展示给用户
 *   <monologue>...</monologue>  小爱的人设内心独白（我们 prompt 要求写的）
 *                               —— 默认隐藏，前端小图标 hover 可看
 *   <metadata>{...}</metadata>  情绪 / 好感度等结构化元数据 —— 只进情绪系统
 *
 * 注意：<think> 与 <monologue> 必须分开。两者都是「思考」，但归属不同：
 * 前者是模型的能力产物，后者是角色的人设产物，混为一谈会导致独白被误丢、或 CoT 被误展示。
 *
 * 流式场景下这些标签会被切成任意片段（"<thi" + "nk>..."），
 * 所以这里用一个小状态机逐 chunk 判断，只把确定属于正文的部分吐出去。
 */

const TAGS = [
    { open: '<think>', close: '</think>', key: 'cot' },
    { open: '<monologue>', close: '</monologue>', key: 'monologue' },
    { open: '<metadata>', close: '</metadata>', key: 'metadata' },
];

/**
 * 从一个 SSE chunk 里同时取出「正文」与「模型原生思考」。
 *
 * 两者是 OpenAI 兼容协议里平级的两个字段：
 *   content            —— 模型最终要说的话（我们的 <monologue> 人设独白也混在里面）
 *   reasoning_content  —— 推理模型自己的 CoT（R1 / QwQ / o-series / GLM-4.5 等）
 *                         部分厂商用 reasoning 这个别名。
 *
 * 重构前只读 content，原生思考被静默丢弃；这里显式分流，便于分别处理与排障。
 *
 * @param {object} chunk - stream 迭代出的 chunk
 * @returns {{content: string, reasoning: string}}
 */
export function splitDelta(chunk) {
    const delta = chunk?.choices?.[0]?.delta;
    if (!delta) return { content: '', reasoning: '' };
    return {
        content: delta.content || '',
        reasoning: delta.reasoning_content || delta.reasoning || '',
    };
}

/** 非流式响应里取原生思考（message 而非 delta）。 */
export function extractReasoning(message) {
    if (!message) return '';
    return message.reasoning_content || message.reasoning || '';
}

/** rest 是否是 tag 的「尚未收全的前缀」（如 "<thi" 对 "<think>"） */
function isPartialTag(rest, tag) {
    return rest.length > 0 && rest.length <= tag.length && tag.startsWith(rest);
}

/**
 * 消费缓冲区，但保留尾部可能是 endTag 前缀的片段，避免把结束标签的一半吐给用户。
 * 返回 { consumed, keep }。
 */
function flushKeepingSuffix(buf, endTag) {
    for (let k = Math.min(endTag.length - 1, buf.length); k > 0; k--) {
        if (endTag.startsWith(buf.slice(buf.length - k))) {
            return { consumed: buf.slice(0, buf.length - k), keep: buf.slice(buf.length - k) };
        }
    }
    return { consumed: buf, keep: '' };
}

/**
 * 非流式场景：把一整段文本一次性喂给状态机，复用同一套标签识别规则。
 *
 * 为什么要有这个函数？——「标签如何被识别与剥离」这条规则必须只有一处实现。
 * 重构前 AiGirlfriend 里用三处正则手写同一规则（_parseReplyText 的 <monologue>/<think>/
 * <metadata> 剥离 + 未闭合截断、generateProactiveMessage 的 <think>/<monologue> 清理），
 * 与这里的状态机规则重复，将来标签格式一变就要同步改多处、极易遗漏。
 * 现在非流式路径也走状态机，规则单一真源。
 *
 * 返回结构与「逐字符流式喂入」完全一致，这是本次重构的核心保证
 * （scripts/test-stream-filter.mjs 有对照测试锁定）：
 *   replyText  —— 剥离三类标签后的正文（保留原文空白，由调用方决定是否 trim，
 *                 与流式路径 out + tail 拼接的语义一致）
 *   cot / monologue / metadata —— 三类被剥离的内容（trim 后）
 *
 * @param {string} text - 完整回复文本
 * @returns {{replyText: string, cot: string, monologue: string, metadata: string}}
 */
export function parseFullText(text) {
    const filter = createStreamFilter();
    const visible = filter.push(text || '');
    const { tail, cot, monologue, metadata } = filter.finish();
    return { replyText: visible + tail, cot, monologue, metadata };
}

export function createStreamFilter() {
    let current = null; // null 表示正在输出正文
    let buf = '';
    const captured = { cot: '', monologue: '', metadata: '' };

    const matchOpen = (rest) => TAGS.find((t) => rest.startsWith(t.open)) || null;
    const isPartialOpen = (rest) => TAGS.some((t) => isPartialTag(rest, t.open));

    return {
        /** 喂入一个 chunk，返回此刻可以展示给用户的正文 */
        push(chunk) {
            if (!chunk) return '';
            buf += chunk;
            let out = '';

            for (;;) {
                if (!current) {
                    const lt = buf.indexOf('<');
                    if (lt === -1) {
                        out += buf;
                        buf = '';
                        break;
                    }
                    out += buf.slice(0, lt);
                    const rest = buf.slice(lt);

                    // 完整的开始标签（后面可能已经跟了正文，如 "<think>他在…"）
                    const opened = matchOpen(rest);
                    if (opened) {
                        current = opened;
                        buf = rest.slice(opened.open.length);
                        continue;
                    }
                    // 标签只到了一半，先攒着等下一个 chunk
                    if (isPartialOpen(rest)) {
                        buf = rest;
                        break;
                    }
                    // 普通的 '<' 字符，原样输出后继续扫描剩余部分
                    out += '<';
                    buf = rest.slice(1);
                    continue;
                }

                const idx = buf.indexOf(current.close);
                if (idx !== -1) {
                    captured[current.key] += buf.slice(0, idx);
                    buf = buf.slice(idx + current.close.length);
                    current = null;
                    continue;
                }
                const { consumed, keep } = flushKeepingSuffix(buf, current.close);
                captured[current.key] += consumed;
                buf = keep;
                break;
            }

            return out;
        },

        /**
         * 流结束，收尾。
         * 返回剩余正文，以及三类被剥离的内容；未闭合的 metadata 也一并返回供解析。
         */
        finish() {
            let tail = '';
            if (!current) {
                tail = buf;
            } else if (current.key === 'metadata') {
                captured.metadata += buf; // 未闭合的 metadata，尽力解析
            }
            buf = '';
            current = null;
            return {
                tail,
                cot: captured.cot.trim(),
                monologue: captured.monologue.trim(),
                metadata: captured.metadata.trim(),
            };
        },
    };
}
