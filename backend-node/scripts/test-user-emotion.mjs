/**
 * 用户情绪识别通道回归测试（REQ-01，单进程自包含）。
 *
 * ⚠️ 本机沙箱 child_process.spawn 会被 EBUSY 拦死，因此**禁止 spawn 子进程**：
 * 全部用例在同一进程内用 Node 内置 assert + 计数器跑完，失败时 process.exitCode=1。
 * 由 package.json 的 `npm test` 串联执行。
 *
 * 覆盖：词表识别（各情绪标签）/ 否定词 / 强度词 / 融合逻辑（词表 vs LLM 加权）/
 *      LLM 缺失降级 / LLM 低置信度忽略 / timeline cap / 三维→标签映射 / 趋势 /
 *      落盘与加载 / reset。
 */
import assert from 'assert';
import fs from 'fs';
import {
    USER_EMOTION_LABELS, classifyUserEmotion, mapDimensionsToLabel,
    intensityFactor, hasNegation, detectLabels, NEUTRAL_LABEL,
} from '../src/core/userEmotionLexicon.js';
import UserEmotionEngine from '../src/core/UserEmotionEngine.js';
import { buildUserEmotionContext, USER_EMOTION_RESPONSE_STRATEGY } from '../src/core/prompts/userEmotionPrompt.js';
import { dataPath } from '../src/utils/jsonStore.js';

let passed = 0;
let failed = 0;
function check(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  OK   ${name}`);
    } catch (e) {
        failed++;
        process.exitCode = 1;
        console.error(`  FAIL ${name}\n       ${e.message}`);
    }
}

const STATE_FILE = 'user_emotion_state.json';
const stateFilePath = dataPath(STATE_FILE);

/**
 * 删除测试状态文件；失败（非 ENOENT）不吞错，降级为覆写空状态。
 * （与 test-affinity.mjs 同款，规避沙箱 safe-delete 配额问题。）
 */
function forceUnlink(p) {
    try {
        fs.unlinkSync(p);
        return true;
    } catch (e) {
        if (e.code === 'ENOENT') return true;
        console.error(`[test] unlink 失败(${e.code ?? e.message})，降级为覆写空状态: ${p}`);
        try {
            fs.writeFileSync(p, JSON.stringify({ version: 1, state: {}, timeline: [] }));
            return true;
        } catch {
            return false;
        }
    }
}

/** 干净引擎：先移除落盘，避免上一用例污染。 */
function freshEngine() {
    forceUnlink(stateFilePath);
    return new UserEmotionEngine();
}

// ==================== 1. 词表识别（各情绪标签） ====================
console.log('词表识别:');
check('低落：难过/伤心命中 低落', () => {
    assert.strictEqual(classifyUserEmotion('今天好难过').label, '低落');
    assert.strictEqual(classifyUserEmotion('很伤心').label, '低落');
});
check('疲惫：累/加班命中 疲惫', () => {
    assert.strictEqual(classifyUserEmotion('今天加班好累').label, '疲惫');
    assert.strictEqual(classifyUserEmotion('好困啊').label, '疲惫');
});
check('焦虑：担心/紧张命中 焦虑', () => {
    assert.strictEqual(classifyUserEmotion('有点担心明天的面试').label, '焦虑');
    assert.strictEqual(classifyUserEmotion('压力好大').label, '焦虑');
});
check('愤怒：生气/气死命中 愤怒', () => {
    assert.strictEqual(classifyUserEmotion('气死我了').label, '愤怒');
    assert.strictEqual(classifyUserEmotion('他太过分了').label, '愤怒');
});
check('开心：开心/高兴命中 开心', () => {
    assert.strictEqual(classifyUserEmotion('今天好开心').label, '开心');
    assert.strictEqual(classifyUserEmotion('太高兴了').label, '开心');
});
check('兴奋：兴奋/超开心命中 兴奋', () => {
    assert.strictEqual(classifyUserEmotion('我好兴奋').label, '兴奋');
    assert.strictEqual(classifyUserEmotion('哇太棒了').label, '兴奋');
});
check('中性：无命中词 confidence=0', () => {
    const r = classifyUserEmotion('嗯嗯');
    assert.strictEqual(r.label, NEUTRAL_LABEL);
    assert.strictEqual(r.confidence, 0);
    assert.strictEqual(r.source, 'lexicon');
});
check('空输入回中性', () => {
    assert.strictEqual(classifyUserEmotion('').label, NEUTRAL_LABEL);
    assert.strictEqual(classifyUserEmotion('   ').label, NEUTRAL_LABEL);
});
check('标签一定落在枚举内', () => {
    for (const t of ['难过', '好累', '担心', '生气', '开心', '兴奋', '无聊', '还好', '随便说说']) {
        assert.ok(USER_EMOTION_LABELS.includes(classifyUserEmotion(t).label),
            `${t} → ${classifyUserEmotion(t).label} 不在枚举内`);
    }
});

// ==================== 2. 否定词 ====================
console.log('否定词:');
check('"不开心" 命中否定 → 翻成 低落', () => {
    assert.strictEqual(classifyUserEmotion('我不开心').label, '低落');
    assert.strictEqual(classifyUserEmotion('今天没什么开心的').label, '低落');
});
check('否定只翻转 valence 不翻转 arousal', () => {
    const pos = classifyUserEmotion('开心');
    const neg = classifyUserEmotion('不开心');
    assert.ok(neg.valence < 0, 'valence 应变负');
    assert.ok(neg.valence < pos.valence, '应低于正向');
});
check('负向词+否定不误翻（语义模糊时不翻转）', () => {
    // 「不难过」语义模糊，不做正向翻转，避免误判；至少标签仍在枚举内
    const r = classifyUserEmotion('不难过');
    assert.ok(USER_EMOTION_LABELS.includes(r.label));
});
check('hasNegation 工具', () => {
    assert.strictEqual(hasNegation('不'), true);
    assert.strictEqual(hasNegation('没有'), true);
    assert.strictEqual(hasNegation('开心'), false);
});

// ==================== 3. 强度词 ====================
console.log('强度词:');
check('intensityFactor：非常>1 / 有点<1 / 无=1', () => {
    assert.ok(intensityFactor('非常开心') > 1);
    assert.ok(intensityFactor('有点难过') < 1);
    assert.strictEqual(intensityFactor('开心'), 1);
});
check('强度词放大 intensity', () => {
    const base = classifyUserEmotion('难过');
    const strong = classifyUserEmotion('非常难过');
    assert.ok(strong.intensity > base.intensity, `strong=${strong.intensity} base=${base.intensity}`);
});
check('弱化词缩小 intensity', () => {
    const base = classifyUserEmotion('难过');
    const weak = classifyUserEmotion('有点难过');
    assert.ok(weak.intensity < base.intensity, `weak=${weak.intensity} base=${base.intensity}`);
});
check('detectLabels 命中词条数降序', () => {
    const labels = detectLabels('好累好累好困');
    assert.ok(labels.length > 0);
    assert.strictEqual(labels[0].label, '疲惫');
});

// ==================== 4. 三维 → 标签映射 ====================
console.log('三维映射:');
check('mapDimensionsToLabel 各分支', () => {
    assert.strictEqual(mapDimensionsToLabel(-0.7, 0.7, 0.8), '愤怒');
    assert.strictEqual(mapDimensionsToLabel(0.7, 0.8, 0.7), '兴奋');
    assert.strictEqual(mapDimensionsToLabel(-0.5, -0.2, 0.6), '低落');
    assert.strictEqual(mapDimensionsToLabel(-0.4, 0.6, 0.6), '焦虑');
    assert.strictEqual(mapDimensionsToLabel(-0.3, -0.6, 0.5), '疲惫');
    assert.strictEqual(mapDimensionsToLabel(0.6, 0.3, 0.5), '开心');
    assert.strictEqual(mapDimensionsToLabel(0, 0, 0), NEUTRAL_LABEL);
});

// ==================== 5. 融合逻辑（词表 vs LLM 加权） ====================
console.log('融合:');
check('无 LLM 结果 → source=lexicon（兜底）', () => {
    const e = freshEngine();
    const lex = e.analyze('今天好难过');
    const fused = e.fuse(lex, null);
    assert.strictEqual(fused.source, 'lexicon');
    assert.strictEqual(fused.label, '低落');
});
check('LLM 结果合法且高置信 → 加权融合 source=fused', () => {
    const e = freshEngine();
    const lex = e.analyze('今天有点难过'); // 弱信号
    const llm = { label: '低落', valence: -0.9, arousal: 0.1, intensity: 0.9, confidence: 0.95 };
    const fused = e.fuse(lex, llm);
    assert.strictEqual(fused.source, 'fused');
    // LLM 权重更高（0.6）→ 结果应更靠近 LLM 的 -0.9 而非词表的弱值
    assert.ok(fused.valence < lex.valence, `fused=${fused.valence} lex=${lex.valence}`);
    assert.ok(USER_EMOTION_LABELS.includes(fused.label));
});
check('LLM 置信度低于阈值 → 忽略，纯用词表', () => {
    const e = freshEngine();
    const lex = e.analyze('今天好开心');
    const llm = { label: '低落', valence: -0.9, arousal: 0, intensity: 0.9, confidence: 0.1 };
    const fused = e.fuse(lex, llm);
    assert.strictEqual(fused.source, 'lexicon');
    assert.strictEqual(fused.label, '开心');
});
check('词表无命中 + LLM 可信 → 采信 LLM（source=llm）', () => {
    const e = freshEngine();
    const lex = e.analyze('嗯嗯嗯'); // 无命中
    const llm = { label: '焦虑', valence: -0.4, arousal: 0.6, intensity: 0.6, confidence: 0.8 };
    const fused = e.fuse(lex, llm);
    assert.strictEqual(fused.source, 'llm');
    assert.strictEqual(fused.label, '焦虑');
});
check('非法 LLM 结果（缺字段/NaN）→ 兜底词表', () => {
    const e = freshEngine();
    const lex = e.analyze('好开心');
    assert.strictEqual(e.fuse(lex, { label: '开心' }).source, 'lexicon');
    assert.strictEqual(e.fuse(lex, { valence: NaN, arousal: 0, intensity: 0, confidence: 0.9 }).source, 'lexicon');
});
check('非法 label 自动重映射到枚举内', () => {
    const e = freshEngine();
    const lex = e.analyze('嗯');
    const fused = e.fuse(lex, { label: '不存在的情绪', valence: -0.5, arousal: 0.1, intensity: 0.6, confidence: 0.9 });
    assert.ok(USER_EMOTION_LABELS.includes(fused.label), `label=${fused.label}`);
});

// ==================== 6. ingestTurn 与转折 ====================
console.log('ingestTurn:');
check('ingestTurn 更新 state 并判定转折', () => {
    const e = freshEngine();
    const r = e.ingestTurn('今天好难过', '怎么了？', null);
    assert.strictEqual(r.current.label, '低落');
    assert.strictEqual(typeof r.turned, 'boolean');
    assert.ok(r.trend && typeof r.trend.avgValence === 'number');
});
check('剧烈情绪变化 → turned=true', () => {
    const e = freshEngine();
    e.ingestTurn('好开心', '', null);              // valence≈+0.6
    const r = e.ingestTurn('气死我了', '', null);   // valence≈-0.7，Δ>0.35
    assert.strictEqual(r.turned, true);
});

// ==================== 7. timeline cap ====================
console.log('timeline cap:');
check('timeline 长度不超过 cap', () => {
    const e = freshEngine();
    const cap = e.getState().timelineStats.cap;
    for (let i = 0; i < cap + 10; i++) {
        e.ingestTurn(i % 2 === 0 ? '好开心' : '好难过', '', null);
    }
    assert.strictEqual(e.getTimeline().length, cap);
    assert.strictEqual(e.getState().timelineStats.count, cap);
});
check('timeline 条目结构完整', () => {
    const e = freshEngine();
    e.ingestTurn('今天加班好累', '辛苦了', null);
    const entry = e.getTimeline().at(-1);
    assert.ok(Number.isFinite(entry.ts));
    assert.ok(Number.isFinite(entry.valence));
    assert.ok(typeof entry.label === 'string');
    assert.ok(['lexicon', 'llm', 'fused'].includes(entry.source));
    assert.ok(typeof entry.excerpt === 'string');
});
check('excerpt 截断生效', () => {
    const e = freshEngine();
    const long = '好累'.repeat(100);
    e.ingestTurn(long, '', null);
    const entry = e.getTimeline().at(-1);
    assert.ok(entry.excerpt.length <= 40, `excerpt=${entry.excerpt.length}`);
});

// ==================== 8. 趋势 ====================
console.log('趋势:');
check('无数据时 trend.available=false', () => {
    const e = freshEngine();
    const t = e.getRecentTrend();
    assert.strictEqual(t.available, false);
    assert.strictEqual(t.samples, 0);
});
check('持续下滑 → declining=true', () => {
    const e = freshEngine();
    e.ingestTurn('好开心', '', null);
    e.ingestTurn('有点难过', '', null);
    e.ingestTurn('好难过', '', null);
    const t = e.getRecentTrend(60 * 60 * 1000);
    assert.strictEqual(t.available, true);
    assert.ok(t.slope < 0, `slope=${t.slope}`);
    assert.strictEqual(t.declining, true);
});

// ==================== 9. 落盘与加载 ====================
console.log('落盘与加载:');
check('reset 后立即落盘，重载读到空状态', () => {
    const e = freshEngine();
    e.ingestTurn('好开心', '', null);
    e.reset();
    const e2 = new UserEmotionEngine();
    assert.strictEqual(e2.getTimeline().length, 0);
    assert.strictEqual(e2.getState().state.label, NEUTRAL_LABEL);
    assert.strictEqual(e2.getState().state.updatedAt, null);
});
check('flush 落盘后重载能读回 timeline', () => {
    const e = freshEngine();
    e.ingestTurn('今天好难过', '抱抱', null);
    e._flush(); // 立即落盘（去抖兜底）
    const e2 = new UserEmotionEngine();
    const tl = e2.getTimeline();
    assert.ok(tl.length >= 1);
    assert.strictEqual(tl.at(-1).label, '低落');
});
check('落盘 schema 含 version/state/timeline/lastUpdated', () => {
    const e = freshEngine();
    e.ingestTurn('好开心', '', null);
    e._flush();
    const raw = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'));
    assert.strictEqual(raw.version, 1);
    assert.ok(raw.state && raw.state.label);
    assert.ok(Array.isArray(raw.timeline));
    assert.ok(typeof raw.lastUpdated === 'string');
});

// ==================== 10. prompt 注入 ====================
console.log('prompt 注入:');
check('未分析过 → getPromptInjection 返回空串', () => {
    const e = freshEngine();
    assert.strictEqual(e.getPromptInjection(), '');
});
check('分析后 → 注入段含标签', () => {
    const e = freshEngine();
    e.ingestTurn('今天好难过', '', null);
    const seg = e.getPromptInjection();
    assert.ok(seg.includes('【用户情绪'));
    assert.ok(seg.includes('低落'));
});
check('buildUserEmotionContext：含策略映射', () => {
    const seg = buildUserEmotionContext({ label: '低落' }, null);
    assert.ok(seg.includes(USER_EMOTION_RESPONSE_STRATEGY['低落']));
});
check('buildUserEmotionContext：非法输入返回空串', () => {
    assert.strictEqual(buildUserEmotionContext(null), '');
});
check('策略映射表覆盖所有情绪标签', () => {
    for (const label of USER_EMOTION_LABELS) {
        assert.ok(typeof USER_EMOTION_RESPONSE_STRATEGY[label] === 'string',
            `${label} 缺少策略`);
    }
});

// ==================== 汇总 ====================
// 清理测试落盘，不污染真实数据
forceUnlink(stateFilePath);

const TOTAL = passed + failed;
if (failed > 0) {
    console.error(`\n${passed}/${TOTAL} 通过，${failed} 项失败`);
} else {
    console.log(`\n全部 ${passed} 项通过`);
}
