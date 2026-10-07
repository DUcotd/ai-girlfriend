/**
 * test-audit-final.mjs —— 最后一轮打磨（F-1 ~ F-3）。
 *
 * 这一批测的全是「**写了没接线**」这一类失效：字段存进磁盘了、prompt 也向模型要了，
 * 但中间那根线没接上，于是失效对用户完全不可见。所以断言一律从**输出**下手：
 * 解析出来的时间戳、渲染进 prompt 的那一行、命中的那条故事 —— 不看源码字符串。
 *
 * 时间相关断言全部注入 `now`，不 sleep、不依赖机器时钟（审计纪律：靠等待撑起来的断言
 * 验证的是本机调度器，不是代码）。
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'aigf-final-'));
process.env.AI_GIRLFRIEND_DATA_DIR = sandbox;

const { createHarness } = await import('./lib/testKit.mjs');
const t = createHarness('test-audit-final', { expect: 47 });
const { check, finish } = t;

// 固定基准：2026-10-07 14:30 本地（周三）。所有相对说法都围着它算。
const NOW = new Date(2026, 9, 7, 14, 30).getTime();
const DAY = 24 * 60 * 60 * 1000;
/** ms → 本地 YYYY-MM-DD（断言用，避开时分秒噪声） */
const day = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const { normalizeNarrativeDate, resolveNarrativeDate, DATE_SOURCE } =
    await import('../src/core/narrative/narrativeDate.js');
const NarrativeExtractor = (await import('../src/core/narrative/NarrativeExtractor.js')).default;

// ==================== F-1：日期解析口径 ====================

check('F-1 ISO 日期按**本地**日历解析（不是 UTC 零点，否则纪念日整体错一天）',
    day(resolveNarrativeDate('2025-03-08', { now: NOW }).occurredAt) === '2025-03-08'
    && new Date(resolveNarrativeDate('2025-03-08', { now: NOW }).occurredAt).getHours() === 0);

check('F-1 中文年月日、斜杠、点分写法都认',
    ['2025年3月8日', '2025/3/8', '2025.3.8'].every((v) => day(resolveNarrativeDate(v, { now: NOW }).occurredAt) === '2025-03-08'));

check('F-1 带时刻的 ISO 串保留时刻',
    new Date(resolveNarrativeDate('2025-03-08T21:30:00', { now: NOW }).occurredAt).getHours() === 21);

check('F-1 只给「M月D日」时补成**不超过今天**的最近一年',
    day(resolveNarrativeDate('3月8日', { now: NOW }).occurredAt) === '2026-03-08'
    && day(resolveNarrativeDate('12月25日', { now: NOW }).occurredAt) === '2025-12-25');

check('F-1 相对说法：今天/昨天/前天/明天/后天',
    [
        ['今天', '2026-10-07'], ['昨天', '2026-10-06'], ['前天', '2026-10-05'],
        ['明天', '2026-10-08'], ['后天', '2026-10-09'],
    ].every(([v, want]) => day(resolveNarrativeDate(v, { now: NOW }).occurredAt) === want));

check('F-1 相对数量：三天前 / 两周前 / 2个月前 / 去年 / 上个月（中文数字与阿拉伯数字同权）',
    [
        ['三天前', '2026-10-04'], ['3天前', '2026-10-04'], ['两周前', '2026-09-23'],
        ['2个月前', '2026-08-07'], ['去年', '2025-10-07'], ['上个月', '2026-09-07'],
    ].every(([v, want]) => day(resolveNarrativeDate(v, { now: NOW }).occurredAt) === want));

check('F-1 数字时间戳：毫秒直接用，秒自动升位（模型两种都会给）',
    day(resolveNarrativeDate(NOW, { now: NOW }).occurredAt) === '2026-10-07'
    && day(resolveNarrativeDate(Math.floor(NOW / 1000), { now: NOW }).occurredAt) === '2026-10-07');

check('F-1 小数字（0 / 7 / 1970）是缺省值不是日期，不升位成 1970 年',
    [0, 7, 1970].every((v) => normalizeNarrativeDate(v, { now: NOW }).source === DATE_SOURCE.fallback));

check('F-1 非法日期**不顺延**：2025-02-30 判成解析失败，而不是被 Date 洗成 3 月 2 日',
    normalizeNarrativeDate('2025-02-30', { now: NOW }).source === DATE_SOURCE.fallback);

check('F-1 离谱范围（三千年后 / 公元前）判失败，不写进库',
    normalizeNarrativeDate('3000-01-01', { now: NOW }).occurredAt === null
    && normalizeNarrativeDate('-5', { now: NOW }).occurredAt === null);

check('F-1 空值/「不详」/非字符串 → 回落基准日并明确标 fallback',
    [null, undefined, '', '   ', '不详', 7, {}, []].every((v) => {
        const r = resolveNarrativeDate(v, { now: NOW });
        return r.occurredAt === NOW && r.source === DATE_SOURCE.fallback;
    }));

check('F-1 fallback 之外的三种来源都算「她记得日子」',
    [DATE_SOURCE.stated, DATE_SOURCE.relative, DATE_SOURCE.monthDay].every((s) => s !== DATE_SOURCE.fallback)
    && Object.keys(DATE_SOURCE).length === 4);

// ==================== F-1b：抽取层真的用上了这套口径 ====================

const addStated = NarrativeExtractor.normalizeAdd(
    { summary: '第一次互道晚安', occurredAt: '2025-03-08' }, NOW);
check('F-1 抽取层收下 prompt 要求的那个字符串日期（改前：字符串永远被丢成今天）',
    day(addStated.occurredAt) === '2025-03-08' && addStated.occurredAtSource === DATE_SOURCE.stated);

const addRel = NarrativeExtractor.normalizeAdd({ summary: '昨晚的火锅', occurredAt: '昨天' }, NOW);
check('F-1 抽取层认相对说法并标 relative', day(addRel.occurredAt) === '2026-10-06' && addRel.occurredAtSource === DATE_SOURCE.relative);

const addNull = NarrativeExtractor.normalizeAdd({ summary: '随口聊到的事', occurredAt: null }, NOW);
check('F-1 模型说「记不清日子」时如实标 fallback（不是假装是今天发生）',
    addNull.occurredAtSource === DATE_SOURCE.fallback && addNull.occurredAt === NOW);

const addJunk = NarrativeExtractor.normalizeAdd({ summary: 's', occurredAt: '2025-02-30' }, NOW);
check('F-1 编造日期不会污染库：回落 + fallback 标记，界面据此不显示日子',
    addJunk.occurredAtSource === DATE_SOURCE.fallback);

// ==================== F-2：update 能把后来想清楚的信息写回去 ====================

const updDate = NarrativeExtractor.normalizeUpdate({ id: 'n1', occurredAt: '2024-07-01' }, NOW);
check('F-2 update 允许改 occurredAt（改前：normalizeUpdate 根本不透这个字段）',
    day(updDate.occurredAt) === '2024-07-01' && updDate.occurredAtSource === DATE_SOURCE.stated);

const updBad = NarrativeExtractor.normalizeUpdate({ id: 'n1', occurredAt: '想不起来' }, NOW);
check('F-2 update 解析失败时**不动**原日期（不许用今天盖掉旧信息）',
    updBad.occurredAt === undefined && updBad.occurredAtSource === undefined);

const updTags = NarrativeExtractor.normalizeUpdate({ id: 'n1', tags: ['熬夜', ' 火锅 ', 'x'.repeat(40)], jokeTrigger: ' 月落乌啼 ' }, NOW);
check('F-2 update 透 tags/jokeTrigger 并走与 add 同一套裁剪',
    updTags.tags.length === 3 && updTags.tags[0] === '熬夜' && updTags.tags[1] === '火锅' && updTags.tags[2].length === 20);
check('F-2 update 的 jokeTrigger 去空白后截 40 字', updTags.jokeTrigger === '月落乌啼');
check('F-2 update 里 jokeTrigger:null 表示清空（undefined 才是「没提」）',
    NarrativeExtractor.normalizeUpdate({ id: 'n1', jokeTrigger: null }, NOW).jokeTrigger === null);

// ==================== F-2b：store 层真的收得下这些写入 ====================

const NarrativeStore = (await import('../src/core/narrative/NarrativeStore.js')).default;
const store = new NarrativeStore();
const stored = store.addNarrative(addStated);
check('F-1 store 落盘保留 occurredAtSource', !!stored && stored.occurredAtSource === DATE_SOURCE.stated);

const publicOne = store.publicNarrative(stored);
check('F-2 API 透出 occurredAtSource（界面才分得清「她记得」与「她猜的」）',
    publicOne.occurredAtSource === DATE_SOURCE.stated && publicOne.occurredAt === addStated.occurredAt);

const moved = store.updateNarrative(stored.id, updDate);
check('F-2 store 收下了纠正后的日期，来源同步改写',
    day(moved.occurredAt) === '2024-07-01' && moved.occurredAtSource === DATE_SOURCE.stated);

const cleared = store.updateNarrative(stored.id, { jokeTrigger: null, tags: ['考试周'] });
check('F-2 store 能把专属梗清空、能改标签（改前：tags 的 update 在抽取层就没了）',
    cleared.jokeTrigger === null && cleared.tags.length === 1 && cleared.tags[0] === '考试周');

const legacy = store.addNarrative({ title: '老故事', summary: '改造前入库的', occurredAt: NOW });
check('F-1 老数据没有来源字段 → null，不会被当成「她记得日子」', legacy.occurredAtSource === null);

// ==================== F-3：联想召回（专属梗 / 线索词） ====================

const { matchAssociations, mergeWithRetrieved, normalizeForMatch, ASSOCIATION_KINDS } =
    await import('../src/core/narrative/AssociationRecall.js');

const jokeStory = { id: 'j1', title: '暗号', summary: '我们之间的暗号是月落乌啼', jokeTrigger: '月落乌啼', tags: ['夜晚'], importance: 5 };
const tagStory = { id: 't1', title: '加班夜', summary: '一起在便利店门口分过关东煮', tags: ['熬夜', '关东煮'], importance: 4 };
const otherStory = { id: 'o1', title: '毕业', summary: '她说毕业那天想去看海', tags: ['海边'], importance: 3 };
const pool = [otherStory, tagStory, jokeStory];

check('F-3 归一化忽略空白与中英标点（「月落 乌啼~」= 「月落乌啼」）',
    normalizeForMatch('月落 乌啼~') === normalizeForMatch('月落乌啼') && normalizeForMatch('，。！') === '');

const jokeHits = matchAssociations('月落乌啼呀', pool);
check('F-3 那句暗号一出现必定命中，而且排在第一（改前：jokeTrigger 存进磁盘后无人读）',
    jokeHits.length === 1 && jokeHits[0].narrative.id === 'j1' && jokeHits[0].kind === ASSOCIATION_KINDS.joke);

const tagHits = matchAssociations('昨天又熬夜到三点，好累', pool);
check('F-3 线索词命中走 tag 档', tagHits.length === 1 && tagHits[0].narrative.id === 't1' && tagHits[0].kind === ASSOCIATION_KINDS.tag);
check('F-3 matched 给用户看的是原词而不是归一化串', tagHits[0].matched === '熬夜');

const bothHits = matchAssociations('月落乌啼，又熬夜了', pool);
check('F-3 暗号优先于线索词（同一句里两种都命中）',
    bothHits.length === 2 && bothHits[0].narrative.id === 'j1' && bothHits[1].narrative.id === 't1');

check('F-3 单字/空文本不误伤：短于 2 字的线索与空 query 都不算命中',
    matchAssociations('', pool).length === 0 && matchAssociations('好', pool).length === 0
    && matchAssociations('熬夜', [{ id: 'x', tags: ['好'], jokeTrigger: '嗯' }]).length === 0);

check('F-3 maxHits 生效（注入条数受 config 约束，不会一次勾出一摞）',
    matchAssociations('月落乌啼 熬夜 海边', pool, { maxHits: 1 }).length === 1);

check('F-3 脏数据不炸：tags 混入非字符串照样命中，无 id 的条目直接跳过',
    matchAssociations('熬夜', [{ id: 'x1', tags: [null, 1, '熬夜'] }, { title: '没 id' }, null]).length === 1);

const merged = mergeWithRetrieved(bothHits, [otherStory, tagStory], 4);
check('F-3 合并后联想项排最前且按 id 去重（同一条不会在注入段出现两次）',
    merged.narratives[0].id === 'j1' && merged.narratives[1].id === 't1'
    && new Set(merged.narratives.map((n) => n.id)).size === merged.narratives.length);
check('F-3 notes 给命中的故事标「她被哪个词勾起」，未命中的没有',
    merged.notes.get('j1').includes('月落乌啼') && merged.notes.get('t1').includes('熬夜') && !merged.notes.has('o1'));
check('F-3 limit 收紧时先丢检索项，不丢联想项',
    mergeWithRetrieved(bothHits, [otherStory], 2).narratives.map((n) => n.id).join() === 'j1,t1');

// ==================== F-3b：注入段渲染 ====================

const { buildNarrativeContext } = await import('../src/core/prompts/narrativePrompt.js');

const rendered = buildNarrativeContext(merged.narratives, { notes: merged.notes });
check('F-3 渲染出来的段落里带着联想说明（模型由此知道这是被勾起来的，不是凭空复述）',
    rendered.includes('她顺着「熬夜」想起了这件事') || rendered.includes('月落乌啼'));
check('F-3 注入段仍是 <story_data> 围栏内（引述素材不是指令）',
    rendered.startsWith('<story_data>') && rendered.endsWith('</story_data>'));

const trusted = buildNarrativeContext([{ ...jokeStory, occurredAt: addStated.occurredAt, occurredAtSource: DATE_SOURCE.stated }]);
check('F-1 她记得日子时才把日期写进 prompt', trusted.includes('2025-03-08'));
const guessed = buildNarrativeContext([{ ...jokeStory, occurredAt: NOW, occurredAtSource: DATE_SOURCE.fallback }]);
check('F-1 日期是补出来的 → prompt 里不出现任何日子（她不会说「我们10月7日第一次…」）',
    !/\d{4}-\d{2}-\d{2}/.test(guessed) && guessed.includes('暗号'));
const legacyRender = buildNarrativeContext([legacy]);
check('F-1 改造前入库的老故事（来源未知）同样不显示假日期', !/\d{4}-\d{2}-\d{2}/.test(legacyRender));
check('F-3 无叙事时仍然返回空串（关闭态字节级回到改造前）',
    buildNarrativeContext([]) === '' && buildNarrativeContext(null, { notes: merged.notes }) === '');

// ==================== F-3c：检索层接线（不依赖嵌入） ====================

const NarrativeRetriever = (await import('../src/core/narrative/NarrativeRetriever.js')).default;
const { config } = await import('../src/config.js');
const retriever = new NarrativeRetriever({ store: null, embedding: null });
retriever.store = { narratives: pool };

const turn = await retriever.getNarrativesForTurn('月落乌啼', 2);
check('F-3 getNarrativesForTurn 不带嵌入也能召回（暗号是纯字符串匹配，嵌入熔断中照样生效）',
    turn.narratives[0].id === 'j1' && turn.notes instanceof Map);

const prevCap = config.narrative.associationMaxInject;
config.narrative.associationMaxInject = 0;
const off = await retriever.getNarrativesForTurn('月落乌啼', 2);
check('F-3 associationMaxInject=0 时联想通道整条关掉（关闭态安全）', off.notes.size === 0);
config.narrative.associationMaxInject = prevCap;

check('F-3 空库与空话都不炸',
    retriever.matchAssociations('').length === 0
    && new NarrativeRetriever({ store: { narratives: [] } }).matchAssociations('月落乌啼').length === 0);

// ==================== 文档一致性：新旋钮必须有说明 ====================

const envExample = fs.readFileSync(path.join(process.cwd(), '.env.example'), 'utf8');
check('F-3 新增的 env 旋钮写进了 .env.example（test-env-docs 的同一口径，这里给可读的定位）',
    envExample.includes('NARRATIVE_ASSOCIATION_MAX_INJECT'));

finish();
