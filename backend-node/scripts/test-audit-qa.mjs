/**
 * test-audit-qa.mjs —— 把两份「独立怀疑式验证探针」里没被任何套件覆盖的部分收进 CI。
 *
 * 来源：仓库里曾长期留着两个未纳管的散件 `_qa_w1_probe.mjs` / `_qa_w2_verify.mjs`
 * （审计当时由 QA 独立编写，刻意不复用工程师的断言）。它们的**断言有价值、外壳有害**：
 * 两份都直接 import 真实 container / 直接读写 `data/user_emotion_state.json`，
 * 不带沙盒、不声明断言条数、跑完还可能把真实档案改脏（正是本项目历史上出过事故的那类
 * 「测试污染真实数据」）。这里只搬**其它 20 套都没测到**的行为，搬完即删除散件。
 *
 * 覆盖的空白（grep 过 test-*.mjs 确认无重复）：
 *   A. `fuse()` 对畸形 LLM 输出的容错 —— 超范围/字符串数字/Infinity/NaN/null/非法 label
 *   B. 用户情绪 timeline 上限 + 「去抖不等于永不落盘」+ 无脏数据时 flush 幂等（B0-6 语义）
 *   C. EventBus 异常隔离与 `on`/`once` 入参校验
 *   D. 叙事写入去重（标题/摘要归一化后互为包含）
 *   E. 词表在极端输入下的边界（10 万字符、纯符号 emoji、强度词放大）
 *   F. 事件驱动主动消息类型的目录规格（4 类属性完整且 spontaneous+eventDriven）
 *
 * 全部断言与时间无关：需要落盘时显式 `flush()`，靠 sleep 等去抖是 CI 上假失败的来源。
 */
import fs from 'fs';
import assert from 'assert';
import { createHarness } from './lib/testKit.mjs';
import { dataPath } from '../src/utils/jsonStore.js';
import { config } from '../src/config.js';
import UserEmotionEngine from '../src/core/UserEmotionEngine.js';
import EventBus from '../src/core/EventBus.js';
import NarrativeStore from '../src/core/narrative/NarrativeStore.js';
import { PROACTIVE_TYPES, getProactiveType } from '../src/core/proactiveTypes.js';
import { classifyUserEmotion, USER_EMOTION_LABELS } from '../src/core/userEmotionLexicon.js';
import AiGirlfriend from '../src/core/AiGirlfriend.js';

// 32 个 check 调用点，其中 F1 在 4 个事件驱动类型的循环里 → 实际执行 35 条
const t = createHarness('test-audit-qa', { expect: 35 });
const STATE_FILE = 'user_emotion_state.json';
const statePath = dataPath(STATE_FILE);

/** 每个用例用干净的状态文件起步（沙盒目录内，绝不碰真实 data/） */
function freshEngine() {
    try { fs.unlinkSync(statePath); } catch { /* 还没有文件 */ }
    return new UserEmotionEngine();
}

function within(value, min, max) {
    return Number.isFinite(value) && value >= min && value <= max;
}

// ─────────────────────────── A. 畸形 LLM 输出的容错 ───────────────────────────
{
    const e = freshEngine();
    const lex = e.analyze('嗯');

    t.check('A1 三维超范围（99/-99）→ 全部 clamp 进合法区间', (() => {
        const f = e.fuse(lex, { label: '开心', valence: 99, arousal: -99, intensity: 99, confidence: 5 });
        return within(f.valence, -1, 1) && within(f.arousal, -1, 1)
            && within(f.intensity, 0, 1) && within(f.confidence, 0, 1);
    })());

    t.check('A2 字符串数字 "0.5" → 归一为有限数字且 label 仍在枚举内', (() => {
        const f = e.fuse(lex, { label: '低落', valence: '-0.5', arousal: '0.1', intensity: '0.6', confidence: '0.9' });
        return USER_EMOTION_LABELS.includes(f.label) && Number.isFinite(f.valence);
    })());

    t.check('A3 Infinity/-Infinity/NaN/非数字串 → 一律拒绝并回退词表', (() => {
        for (const bad of [Infinity, -Infinity, NaN, 'abc']) {
            const f = e.fuse(lex, { label: '低落', valence: bad, arousal: 0, intensity: 0, confidence: 0.9 });
            if (f.source !== 'lexicon') return false;
        }
        return true;
    })());

    t.check('A4 三维为 null → 不抛错，结果仍在区间内', (() => {
        try {
            const f = e.fuse(lex, { label: '低落', valence: null, arousal: null, intensity: null, confidence: 0.9 });
            return within(f.valence, -1, 1) && within(f.arousal, -1, 1) && within(f.intensity, 0, 1);
        } catch { return false; }
    })());

    t.check('A5 非法 label（"???"）→ 重映射，标签必在枚举内', (() => {
        const f = e.fuse(lex, { label: '???', valence: -0.6, arousal: 0.1, intensity: 0.6, confidence: 0.9 });
        return USER_EMOTION_LABELS.includes(f.label);
    })());

    t.check('A6 LLM 没返回 user_emotion → 纯词表，source=lexicon', (() => {
        const f = e.fuse(e.analyze('今天好难过'), null);
        return f.source === 'lexicon' && f.label === '低落';
    })());

    t.check('A7 llmResult 是字符串/数组/缺字段对象 → 都不抛错且回退词表', (() => {
        for (const junk of ['not-an-object', [1, 2, 3], { label: '开心' }, {}]) {
            const f = e.fuse(e.analyze('气死我了'), junk);
            if (f.source !== 'lexicon' || !USER_EMOTION_LABELS.includes(f.label)) return false;
        }
        return true;
    })());

    e.reset();
}

// ─────────────── B. timeline 上限与「去抖 ≠ 永不落盘」 ───────────────
{
    const e = freshEngine();

    // B0-6 之后 flush() 回传布尔：无待写数据时视为已完成，且不该凭空造一个文件
    t.check('B1 新引擎无脏数据时 flush() 返回 true 且不创建状态文件',
        e.flush() === true && !fs.existsSync(statePath));

    for (let i = 0; i < 3; i++) e.ingestTurn('好难过', '抱抱你', null);
    t.check('B2 连续 ingestTurn 不去抖窗口内同步写盘（每轮全量重写会拖慢对话）',
        !fs.existsSync(statePath));

    const flushed = e.flush();
    const onDisk = fs.existsSync(statePath)
        ? JSON.parse(fs.readFileSync(statePath, 'utf-8'))
        : null;
    // 与内存条数对齐，而不是硬编码 3：时间线会不会合并同类条目属于实现细节，
    // 这里要钉的是「落盘内容 == 内存内容」
    t.check('B3 显式 flush() 之后时间线真的落盘，且落的就是内存里那份（去抖不是永不写）',
        flushed === true && !!onDisk && Array.isArray(onDisk.timeline)
        && onDisk.timeline.length === e.getTimeline().length && e.getTimeline().length >= 3);

    const cap = config.userEmotion.timelineMax;
    // 这 70 轮 ingest 会打 70 行词表日志，把套件输出淹掉；引擎的日志是行为的一部分，
    // 但断言的是条数封顶，这里临时静音（不改生产代码）
    const originalLog = console.log;
    console.log = () => {};
    try {
        for (let i = 0; i < cap + 20; i++) e.ingestTurn('好开心', '', null);
    } finally {
        console.log = originalLog;
    }
    t.check(`B4 timeline 封顶：写入 ${cap}+20 条后长度 == ${cap}`,
        e.getTimeline().length === cap);
    t.check('B5 时间线上限可配且落在 config.userEmotion.timelineMax（不是写死的数字）',
        Number.isInteger(cap) && cap >= 5 && cap <= 1000);

    e.reset();
    t.check('B6 reset() 之后时间线清空', e.getTimeline().length === 0);
}

// ───────────────────────── C. EventBus 健壮性 ─────────────────────────
{
    const bus = new EventBus();
    const order = [];
    bus.on('e', () => order.push('a'));
    bus.on('e', () => { throw new Error('boom'); });
    bus.on('e', () => order.push('c'));

    let threw = false;
    try { bus.emit('e', {}); } catch { threw = true; }
    t.check('C1 某个 handler 抛异常，不影响后续 handler 执行', order.join(',') === 'a,c');
    t.check('C2 handler 的异常不冒泡到 emit 调用方（一个订阅者写坏不能拖垮事件层）', threw === false);

    t.check('C3 on(空事件名) 抛 TypeError', (() => {
        try { bus.on('', () => {}); return false; } catch (e) { return e instanceof TypeError; }
    })());
    t.check('C4 on(event, 非函数) 抛 TypeError', (() => {
        try { bus.on('e', 'not-fn'); return false; } catch (e) { return e instanceof TypeError; }
    })());
    t.check('C5 once(event, 非函数) 同样抛 TypeError', (() => {
        try { bus.once('e', 42); return false; } catch (e) { return e instanceof TypeError; }
    })());

    const onceHits = [];
    bus.on('one', () => onceHits.push('always'));
    bus.once('one', () => onceHits.push('once'));
    bus.emit('one', {});
    bus.emit('one', {});
    t.check('C6 once 只触发一次，on 每次都触发',
        onceHits.filter((x) => x === 'once').length === 1 && onceHits.filter((x) => x === 'always').length === 2);
}

// ─────────────────────── D. 叙事写入去重 ───────────────────────
{
    // 只借原型方法，不构造实例：构造会读 state.json、建 LLM 客户端与定时器
    const agf = Object.create(AiGirlfriend.prototype);
    agf.narrativeStore = new NarrativeStore();
    agf.narrativeStore.narratives = [
        { title: '第一次一起看雪', summary: '用户和小爱第一次一起看雪的那晚' },
    ];

    t.check('D1 标题完全相同 → 判为重复',
        agf._isDuplicateNarrative({ title: '第一次一起看雪', summary: '换了个说法' }) === true);
    t.check('D2 标题互为包含（多写几个字）→ 仍判为重复',
        agf._isDuplicateNarrative({ title: '第一次一起看雪的那个晚上', summary: '完全不同的描述内容' }) === true);
    t.check('D3 摘要互为包含 → 判为重复（只改标题骗不过去重）',
        agf._isDuplicateNarrative({ title: '无关的新标题', summary: '用户和小爱第一次一起看雪' }) === true);
    t.check('D4 确实不同的事件 → 不误判',
        agf._isDuplicateNarrative({ title: '一起吃火锅', summary: '周末吃了顿麻辣火锅' }) === false);
    t.check('D5 空标题/空摘要不会被「空串互为包含」误判成重复',
        agf._isDuplicateNarrative({ title: '', summary: '' }) === false);

    agf.narrativeStore.flush();
}

// ─────────────────── E. 词表在极端输入下的边界 ───────────────────
{
    t.check('E1 十万字符长文本 → 不抛错且强度有界（长文不能把词表拖死）', (() => {
        const r = classifyUserEmotion('好累'.repeat(50000));
        return USER_EMOTION_LABELS.includes(r.label) && within(r.intensity, 0, 1);
    })());

    t.check('E2 空串/纯空白/null/undefined → 中性', [
        classifyUserEmotion('').label,
        classifyUserEmotion('     ').label,
        classifyUserEmotion(null).label,
        classifyUserEmotion(undefined).label,
    ].every((l) => l === '中性'));

    t.check('E3 纯符号与 emoji → 中性且不抛错',
        classifyUserEmotion('!!!???……').label === '中性' && classifyUserEmotion('😀🎉').label === '中性');

    t.check('E4 强度词「非常」会放大 intensity', (() => {
        const base = classifyUserEmotion('难过');
        const strong = classifyUserEmotion('非常难过');
        return strong.intensity > base.intensity && strong.valence <= base.valence + 1e-9;
    })());

    t.check('E5「一点都不开心」不判成开心（否定式跨词也要挡住）',
        classifyUserEmotion('一点都不开心').label !== '开心');
}

// ───────────── F. 事件驱动主动消息类型的目录规格 ─────────────
{
    const EVENT_DRIVEN_IDS = [ 'emotion_resonance', 'anniversary_recall', 'promise_followup', 'stage_transition' ];
    for (const id of EVENT_DRIVEN_IDS) {
        const type = getProactiveType(id);
        t.check(`F1 事件驱动类型 ${id} 规格完整（priority/baseCooldown/ttl/minAffinity/labelZh）`,
            !!type
            && typeof type.priority === 'number'
            && typeof type.baseCooldown === 'number'
            && typeof type.ttl === 'number'
            && type.minAffinity !== undefined
            && typeof type.labelZh === 'string' && type.labelZh.length > 0);
    }

    t.check('F2 事件驱动类型同时是 spontaneous —— 必须过 trigger() 全闸门，不能旁路入队',
        EVENT_DRIVEN_IDS.every((id) => {
            const type = getProactiveType(id);
            return type?.eventDriven === true && type?.spontaneous === true;
        }));

    t.check('F3 最早的 8 类仍在目录里（新增事件类型没有挤掉老功能）', [
        'morning_greeting', 'night_greeting', 'task_reminder', 'miss_you',
        'mood_check', 'memory_share', 'random_chat', 'life_update',
    ].every((id) => PROACTIVE_TYPES.some((x) => x.id === id)));
}

const code = t.finish();
// 收尾：状态文件留在沙盒里也没关系，但定时器必须清掉，否则进程不退出
try { fs.unlinkSync(statePath); } catch { /* 已不存在 */ }
process.exit(code);
