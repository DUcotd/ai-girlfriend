/**
 * 性格系统回归测试：规则、六道闸、迁移与引擎编排。
 *
 * 单进程自包含，只使用 Node 内置 assert；不调用 LLM、不访问网络。
 * 测试状态固定写入 data/personality_state.test.json，结束后清理。
 */
import assert from 'assert';
import fs from 'fs';
import { dataPath, readJson, writeJson } from '../src/utils/jsonStore.js';
import { dayKey } from '../src/utils/dayKey.js';
import {
    DEFAULT_TRAITS,
    DIM_KEYS,
    PERSONALITY_DIMS,
    isDimKey,
} from '../src/core/personalityDims.js';
import {
    DEFAULT_PRESET_ID,
    PERSONALITY_PRESETS,
    getPreset,
} from '../src/core/personalityPresets.js';
import {
    APOLOGY,
    DEPENDENCY,
    REASSURANCE,
    RELATIONSHIP_LEXICON,
} from '../src/core/lexicon.js';
import {
    fatigueMultiplier,
    pruneRuleHits,
    recordRuleHit,
} from '../src/core/personalityFatigue.js';
import {
    PERSONALITY_RULES,
    applyBaselinePull,
    applyDailyCap,
    buildDayStats,
    buildSignals,
    clampCurrent,
    computeBaselineAdapt,
    computeDrift,
    round1,
    tierIndex,
} from '../src/core/personalityRules.js';
import { buildPersonalityPrompt } from '../src/core/prompts/personalityPrompt.js';
import PersonalityDrift from '../src/core/PersonalityDrift.js';
import express from 'express';

let passed = 0;
let failed = 0;
function check(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  OK   ${name}`);
    } catch (error) {
        failed += 1;
        process.exitCode = 1;
        console.error(`  FAIL ${name}\n       ${error.message}`);
    }
}

function deltaOf(result, dim) {
    return result.changes.find((change) => change.dim === dim)?.delta || 0;
}

function instant(input, {
    stage = 'friend',
    affinity = 40,
    sentiment = 0,
    affinityChange = 0,
    fatigueCounts = {},
    totalMessages = 20,
} = {}) {
    const signals = buildSignals(input, { stage, affinity, sentiment, affinityChange });
    return computeDrift(signals, { mode: 'instant', fatigueCounts, totalMessages });
}

function pattern(overrides = {}, totalMessages = 20) {
    const base = {
        consecutiveInactiveDays: 0,
        avgDaily7: 0,
        positiveRatio50: 0.5,
        positiveRatio7: 0.5,
        conflictRate50: 0,
        criticismCount50: 0,
        criticismRateToday: 0,
        todayTurns: 0,
        hotColdFlips: 0,
        recentTurnCount: 0,
        activeEveryDay7: false,
    };
    return computeDrift({ ...base, ...overrides }, { mode: 'pattern', totalMessages });
}

function assertHit(result, ruleId) {
    assert.ok(result.hits.some((hit) => hit.ruleId === ruleId), `未命中 ${ruleId}`);
}

const TEST_FILE = 'personality_state.test.json';
const testFilePath = dataPath(TEST_FILE);
/**
 * 删除测试状态文件；失败（非 ENOENT）绝不吞错（与 test-affinity.mjs 的 forceUnlink 同款）。
 * 本机沙箱 safe-delete 配额触顶时 unlinkSync 会被静默拦截，残留文件会把上一用例/
 * 上一轮的状态读回引擎，造成确定性污染。降级方案：覆写为 {"version":2}——
 * 引擎走 v2 加载快速路径且全部字段回落默认值；注意不能用 {}（会被判成 v1 存档触发迁移，
 * presetId 变成 'custom' 污染后续断言）。
 */
function forceUnlink(p) {
    try {
        fs.unlinkSync(p);
        return true;
    } catch (e) {
        if (e.code === 'ENOENT') return true;
        console.error(`[test] unlink 失败(${e.code ?? e.message})，降级为覆写 v2 空状态: ${p}`);
        try {
            fs.writeFileSync(p, '{"version":2}');
            return true;
        } catch {
            return false;
        }
    }
}

function removeTestFile() {
    forceUnlink(testFilePath);
    forceUnlink(`${testFilePath}.tmp`);
}
function freshEngine() {
    removeTestFile();
    return new PersonalityDrift(TEST_FILE);
}

console.log('真源与信号:');
check('7 维顺序固定且默认值完整', () => {
    assert.deepStrictEqual(DIM_KEYS, [
        'independence', 'willfulness', 'sensitivity', 'security',
        'affection', 'playfulness', 'trust',
    ]);
    assert.strictEqual(PERSONALITY_DIMS.length, 7);
    assert.ok(DIM_KEYS.every((key) => Number.isFinite(DEFAULT_TRAITS[key])));
    assert.strictEqual(isDimKey('playfulness'), true);
    assert.strictEqual(isDimKey('unknown'), false);
});
check('6 个预设及温柔默认值与契约一致', () => {
    assert.strictEqual(DEFAULT_PRESET_ID, 'gentle');
    assert.strictEqual(PERSONALITY_PRESETS.length, 6);
    assert.deepStrictEqual(getPreset('gentle').traits, {
        independence: 50, willfulness: 30, sensitivity: 55, security: 65,
        affection: 60, playfulness: 45, trust: 60,
    });
    assert.deepStrictEqual(getPreset('clingy').traits, {
        independence: 20, willfulness: 55, sensitivity: 70, security: 40,
        affection: 85, playfulness: 70, trust: 65,
    });
});
check('三张性格词表独立导出且未加入关系互斥链', () => {
    assert.deepStrictEqual(DEPENDENCY, ['陪我', '帮我', '陪陪', '离不开', '只有你', '需要你', '靠你', '别走', '一个人']);
    assert.ok(REASSURANCE.includes('有我在'));
    assert.ok(APOLOGY.includes('sorry'));
    assert.strictEqual(RELATIONSHIP_LEXICON.length, 7);
    assert.ok(!RELATIONSHIP_LEXICON.some(([, words]) => words === DEPENDENCY || words === REASSURANCE || words === APOLOGY));
});
check('buildSignals 集中匹配关系、叠加与摘要信号', () => {
    const signals = buildSignals(`${'我今天很难过，'.repeat(8)}有我在！`, {
        sentiment: -0.4,
        affinity: 70,
        affinityChange: -4,
    });
    assert.strictEqual(signals.stage, 'close');
    assert.strictEqual(signals.sad, true);
    assert.strictEqual(signals.reassurance, true);
    assert.strictEqual(signals.hasExclamation, true);
    assert.strictEqual(signals.isLongTalk, true);
    assert.strictEqual(signals.isConflict, true);
    assert.ok(signals.digest.length <= 20);
});
check('buildDayStats 能识别忽冷忽热与当日批评占比', () => {
    const stats = buildDayStats({
        recentTurns: Array.from({ length: 20 }, (_, index) => ({
            sentiment: index < 18 ? 0.5 : -0.5,
            criticism: index >= 15,
            conflict: index >= 16,
        })),
        dailyMessageCounts: Array.from({ length: 7 }, (_, index) => ({ date: `2026-09-${23 + index}`, count: 2 })),
        sentimentHistory: [],
        today: { turns: 10, criticismCount: 4, sentiments: [0.8, -0.8, -0.8, 0.8] },
        consecutiveInactiveDays: 3,
    }, new Date('2026-09-30T12:00:00').getTime());
    assert.strictEqual(stats.consecutiveInactiveDays, 3);
    assert.strictEqual(stats.hotColdFlips, 2);
    assert.strictEqual(stats.criticismRateToday, 0.4);
    assert.strictEqual(stats.activeEveryDay7, true);
});

console.log('18 条即时规则:');
check('R01 praise_warmth', () => {
    const result = instant('你真好');
    assertHit(result, 'praise_warmth');
    assert.strictEqual(deltaOf(result, 'security'), 0.6);
    assert.strictEqual(deltaOf(result, 'affection'), 0.4);
});
check('R02 praise_vanity 在此前夸奖四次后触发', () => {
    const result = instant('你真好', { fatigueCounts: { praise_warmth: 4 } });
    assertHit(result, 'praise_vanity');
    assert.strictEqual(deltaOf(result, 'willfulness'), 0.5);
});
check('R03 criticism_hurt', () => {
    const result = instant('真无语');
    assertHit(result, 'criticism_hurt');
    assert.strictEqual(deltaOf(result, 'sensitivity'), 0.7);
    assert.strictEqual(deltaOf(result, 'security'), -0.6);
});
check('R04 hard_rejection_guard', () => {
    const result = instant('我们还不熟');
    assertHit(result, 'hard_rejection_guard');
    assert.strictEqual(deltaOf(result, 'trust'), -0.8);
});
check('R05 soft_rejection_tsundere', () => {
    const result = instant('讨厌');
    assertHit(result, 'soft_rejection_tsundere');
    assert.strictEqual(deltaOf(result, 'playfulness'), 0.5);
});
check('R06 deep_intimacy_bond 仅深阶段触发', () => {
    const result = instant('宝贝', { stage: 'close', affinity: 70 });
    assertHit(result, 'deep_intimacy_bond');
    assert.strictEqual(deltaOf(result, 'trust'), 0.6);
});
check('R07 deep_intimacy_overstep 仅浅阶段触发', () => {
    const result = instant('宝贝', { stage: 'stranger', affinity: 5 });
    assertHit(result, 'deep_intimacy_overstep');
    assert.strictEqual(deltaOf(result, 'independence'), 0.5);
});
check('R08 mild_intimacy_open', () => {
    const result = instant('我喜欢你');
    assertHit(result, 'mild_intimacy_open');
    assert.strictEqual(deltaOf(result, 'affection'), 0.5);
});
check('R09 teasing_playful 在朋友及以上触发', () => {
    const result = instant('小傻瓜', { stage: 'friend', affinity: 40 });
    assertHit(result, 'teasing_playful');
    assert.strictEqual(deltaOf(result, 'playfulness'), 0.7);
});
check('R10 teasing_offend 在浅阶段触发', () => {
    const result = instant('小傻瓜', { stage: 'acquaintance', affinity: 20 });
    assertHit(result, 'teasing_offend');
    assert.strictEqual(deltaOf(result, 'trust'), -0.4);
});
check('R11 dependency_cling', () => {
    const result = instant('陪我一会儿');
    assertHit(result, 'dependency_cling');
    assert.strictEqual(deltaOf(result, 'independence'), -0.6);
});
check('R12 reassurance_secure', () => {
    const result = instant('别怕，有我在');
    assertHit(result, 'reassurance_secure');
    assert.strictEqual(deltaOf(result, 'security'), 0.9);
});
check('R13 apologized_repair', () => {
    const result = instant('对不起，是我的错');
    assertHit(result, 'apologized_repair');
    assert.strictEqual(deltaOf(result, 'sensitivity'), -0.4);
});
check('R14 sad_empathy', () => {
    const result = instant('我今天很难过');
    assertHit(result, 'sad_empathy');
    assert.strictEqual(deltaOf(result, 'affection'), 0.6);
});
check('R15 exciting_energy 支持感叹号', () => {
    const result = instant('今天真特别！');
    assertHit(result, 'exciting_energy');
    assert.strictEqual(deltaOf(result, 'playfulness'), 0.6);
});
check('R16 calming_serene', () => {
    const result = instant('慢慢来，别急');
    assertHit(result, 'calming_serene');
    assert.strictEqual(deltaOf(result, 'playfulness'), -0.4);
});
check('R17 deep_talk 与悲伤信号叠加', () => {
    const result = instant(`${'我最近真的很难过，'.repeat(8)}想和你说说`);
    assertHit(result, 'deep_talk');
    assertHit(result, 'sad_empathy');
    assert.strictEqual(deltaOf(result, 'trust'), 1.2);
    assert.strictEqual(deltaOf(result, 'sensitivity'), 1.3);
});
check('R18 question_curious 仅在无其他命中时触发', () => {
    const result = instant('为什么天空是蓝色的？');
    assertHit(result, 'question_curious');
    assert.strictEqual(result.hits.length, 1);
    assert.strictEqual(deltaOf(result, 'playfulness'), 0.2);
});

console.log('8 条模式规则:');
check('S01 long_absence 不受单轮 1.5 上限', () => {
    const result = pattern({ consecutiveInactiveDays: 3 });
    assertHit(result, 'long_absence');
    assert.strictEqual(deltaOf(result, 'independence'), 2);
    assert.strictEqual(deltaOf(result, 'security'), -2.5);
});
check('S02 hot_and_cold', () => {
    const result = pattern({ hotColdFlips: 2 });
    assertHit(result, 'hot_and_cold');
});
check('S03 always_agreeable 要求至少 20 轮', () => {
    const result = pattern({ recentTurnCount: 20, positiveRatio50: 0.9, criticismCount50: 0 });
    assertHit(result, 'always_agreeable');
});
check('S04 frequent_conflict', () => {
    const result = pattern({ recentTurnCount: 20, conflictRate50: 0.25 });
    assertHit(result, 'frequent_conflict');
});
check('S05 high_frequency', () => {
    const result = pattern({ avgDaily7: 16 });
    assertHit(result, 'high_frequency');
});
check('S06 stable_positive', () => {
    const result = pattern({ avgDaily7: 6, positiveRatio7: 0.7 });
    assertHit(result, 'stable_positive');
});
check('S07 monotone_chat', () => {
    const result = pattern({ avgDaily7: 2, activeEveryDay7: true });
    assertHit(result, 'monotone_chat');
});
check('S08 low_quality_day', () => {
    const result = pattern({ todayTurns: 10, criticismRateToday: 0.4 });
    assertHit(result, 'low_quality_day');
});

console.log('六道闸与提示词:');
check('疲劳系数为 1.0 → 0.6 → 0.3', () => {
    assert.strictEqual(fatigueMultiplier(0), 1);
    assert.strictEqual(fatigueMultiplier(1), 0.6);
    assert.strictEqual(fatigueMultiplier(2), 0.3);
    assert.strictEqual(fatigueMultiplier(5), 0.3);
});
check('规则命中裁窗、记录不改入参且单条最多 50', () => {
    const now = 1_000_000_000;
    const original = { praise_warmth: [now - PERSONALITY_RULES.FATIGUE_WINDOW_MS, now - 1] };
    const pruned = pruneRuleHits(original, now, PERSONALITY_RULES.FATIGUE_WINDOW_MS);
    assert.deepStrictEqual(pruned, { praise_warmth: [now - 1] });
    let recorded = {};
    for (let index = 0; index < 55; index += 1) recorded = recordRuleHit(recorded, 'x', now + index);
    assert.strictEqual(recorded.x.length, 50);
    assert.strictEqual(original.praise_warmth.length, 2);
});
check('单日上限把 accum=2 时的 +3 削到 +1', () => {
    const result = applyDailyCap([{ dim: 'security', delta: 3 }], { security: 2 });
    assert.deepStrictEqual(result.changes, [{ dim: 'security', delta: 1 }]);
    assert.strictEqual(result.accum.security, 3);
});
check('单日净上限同时约束负向变化', () => {
    const result = applyDailyCap([{ dim: 'security', delta: -2 }], { security: -2.5 });
    assert.deepStrictEqual(result.changes, [{ dim: 'security', delta: -0.5 }]);
    assert.strictEqual(result.accum.security, -3);
});
check('浮动带端点先夹 0/100', () => {
    assert.strictEqual(clampCurrent(105, 95), 100);
    assert.strictEqual(clampCurrent(-3, 5), 0);
    assert.strictEqual(clampCurrent(70, 50), 65);
    assert.strictEqual(clampCurrent(Number.NaN, 62), 62);
});
check('每日基线回拉 8%', () => {
    const result = applyBaselinePull({ security: 80 }, { security: 50 }, 0.08);
    assert.strictEqual(result.security, 77.6);
});
check('冷启动把即时与模式变化都乘 0.5', () => {
    assert.strictEqual(deltaOf(instant('你真好', { totalMessages: 10 }), 'security'), 0.3);
    assert.strictEqual(deltaOf(pattern({ consecutiveInactiveDays: 3 }, 10), 'independence'), 1);
});
check('单轮同维叠加净变化不超过 1.5', () => {
    const input = `${'我很难过，'.repeat(10)}别怕，有我在！`;
    const result = instant(input, { totalMessages: 20 });
    for (const change of result.changes) assert.ok(Math.abs(change.delta) <= 1.5);
});
check('基线连续偏移 7 天后最多沉淀 2 点', () => {
    const baseline = { ...DEFAULT_TRAITS };
    const current = { ...DEFAULT_TRAITS, security: 80 };
    const adapt = { security: { streak: 6, dir: 1, lastAdaptAt: null } };
    const result = computeBaselineAdapt({ baseline, current, adapt, now: 1000, enabled: true });
    const move = result.moves.find((item) => item.dim === 'security');
    assert.strictEqual(move.before, 65);
    assert.strictEqual(move.after, 67);
    assert.strictEqual(move.delta, 2);
});
check('关闭基线沉淀时只更新跟踪状态、不移动 baseline', () => {
    const result = computeBaselineAdapt({
        baseline: { ...DEFAULT_TRAITS },
        current: { ...DEFAULT_TRAITS, security: 80 },
        adapt: { security: { streak: 6, dir: 1, lastAdaptAt: null } },
        now: 1000,
        enabled: false,
    });
    assert.deepStrictEqual(result.moves, []);
});
check('tierIndex 五档边界稳定', () => {
    assert.deepStrictEqual([0, 19, 20, 39, 40, 59, 60, 79, 80, 100].map(tierIndex),
        [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
});
check('提示词对任意 current 都输出 7 个维度与底色', () => {
    const prompt = buildPersonalityPrompt({
        presetId: 'gentle',
        baseline: DEFAULT_TRAITS,
        current: Object.fromEntries(DIM_KEYS.map((key, index) => [key, index * 17])),
        ledger: [],
    });
    assert.ok(prompt.includes('你的底色是「温柔」'));
    for (const dimension of PERSONALITY_DIMS) assert.ok(prompt.includes(`- ${dimension.label}：`));
});

console.log('对账补齐（TEST-CASES 87 条对账后的 P0 缺口）:');
check('长文本边界：恰 50 字不触发 R17，51 字触发（TC-INST-20）', () => {
    const base = '今天有点难过，';
    const exact50 = base + '好'.repeat(50 - base.length);
    assert.strictEqual(exact50.length, 50);
    const at50 = instant(exact50);
    assert.ok(!at50.hits.some((hit) => hit.ruleId === 'deep_talk'), '恰 50 字不应算长文本');
    assertHit(at50, 'sad_empathy');
    const at51 = instant(`${exact50}好`);
    assert.strictEqual(at51.hits.some((hit) => hit.ruleId === 'deep_talk'), true);
    assert.strictEqual(deltaOf(at51, 'trust'), 1.2);
});
check('TEASING 与 QUESTION 同现时 R18 让位（TC-INST-21）', () => {
    const result = instant('笨蛋，为什么');
    assertHit(result, 'teasing_playful');
    assert.ok(!result.hits.some((hit) => hit.ruleId === 'question_curious'), 'R18 要求未命中其它规则');
    assert.strictEqual(deltaOf(result, 'playfulness'), 0.7, '不得叠加 R18 的 0.2');
});
check('正向同维叠加精确削到 1.5（R12+R17 trust 1.8→1.5，TC-THR-01 精确值）', () => {
    const long = `${'别怕，'.repeat(16)}有我在`;
    const result = instant(long);
    assertHit(result, 'reassurance_secure');
    assertHit(result, 'deep_talk');
    assert.strictEqual(deltaOf(result, 'trust'), 1.5);
    assert.strictEqual(deltaOf(result, 'security'), 0.9);
    assert.strictEqual(deltaOf(result, 'sensitivity'), 0.8);
});
check('单日上限满额时 delta 归零且 accum 不动（TC-THR-04）', () => {
    const result = applyDailyCap([{ dim: 'security', delta: 1 }], { security: 3 });
    assert.deepStrictEqual(result.changes, []);
    assert.strictEqual(result.accum.security, 3);
});
check('反向额度重置：accum=-1 时 +3 全额放行且 accum 反转为 2（TC-THR-06，R-3 口径）', () => {
    const result = applyDailyCap([{ dim: 'security', delta: 3 }], { security: -1 });
    assert.deepStrictEqual(result.changes, [{ dim: 'security', delta: 3 }]);
    assert.strictEqual(result.accum.security, 2);
});
check('clampCurrent 保留一位小数（TC-THR-12）', () => {
    assert.strictEqual(clampCurrent(50.04, 50), 50);
    assert.strictEqual(clampCurrent(50.06, 50), 50.1);
});
check('PERSONALITY_DIMS 每项字段完整且 order 严格递增（TC-SRC-01 补强）', () => {
    for (let index = 0; index < PERSONALITY_DIMS.length; index += 1) {
        const dim = PERSONALITY_DIMS[index];
        for (const field of ['key', 'label', 'low', 'high', 'shiftUp', 'shiftDown', 'order']) {
            assert.ok(dim[field] !== undefined, `dims[${index}].${field} 缺失`);
        }
        if (index > 0) {
            assert.ok(dim.order > PERSONALITY_DIMS[index - 1].order, 'order 必须严格递增');
        }
    }
});
check('数据不足保护：recentTurnCount<20 时 S03/S04 不触发（DESIGN Q5）', () => {
    const agreeable = pattern({ recentTurnCount: 19, positiveRatio50: 0.9, criticismCount50: 0 });
    assert.ok(!agreeable.hits.some((hit) => hit.ruleId === 'always_agreeable'));
    const conflict = pattern({ recentTurnCount: 19, conflictRate50: 0.3 });
    assert.ok(!conflict.hits.some((hit) => hit.ruleId === 'frequent_conflict'));
});
check('纯函数层零 I/O、零网络、零 await（TC-SRC-06）', () => {
    for (const file of ['personalityRules.js', 'personalityFatigue.js', 'personalityDims.js', 'personalityPresets.js']) {
        const source = fs.readFileSync(new URL(`../src/core/${file}`, import.meta.url), 'utf-8');
        assert.ok(!/jsonStore|from 'fs'|fetch\(|await /.test(source), `${file} 不得含 I/O、网络或 await`);
    }
});
check('源码回归：sentiment 兜底用 ?? 而非 ||（TC-REG-02，R-4 建议的源码断言）', () => {
    const source = fs.readFileSync(new URL('../src/core/AiGirlfriend.js', import.meta.url), 'utf-8');
    assert.ok(
        source.includes('const sentiment = emotionDelta?.P ?? autoDelta.P;'),
        'emotionDelta.P === 0 时必须保留 0，不得回退为 autoDelta.P',
    );
});
check('源码回归：_prepare 中 settleDaily 先于 shouldGhost 早退（TC-REG-01）', () => {
    const source = fs.readFileSync(new URL('../src/core/AiGirlfriend.js', import.meta.url), 'utf-8');
    const prepareStart = source.indexOf('async _prepare(');
    const settleIndex = source.indexOf('personalityDrift.settleDaily(', prepareStart);
    const ghostIndex = source.indexOf('shouldGhost()', prepareStart);
    assert.ok(prepareStart !== -1 && settleIndex !== -1 && ghostIndex !== -1);
    assert.ok(settleIndex < ghostIndex, '性格每日结算必须先于 ghosting 早退，否则冷淡期跨天规则被跳过');
});
check('源码回归：resetAll 会重置性格引擎（TC-REG-03）', () => {
    const source = fs.readFileSync(new URL('../src/core/AiGirlfriend.js', import.meta.url), 'utf-8');
    const resetAllIndex = source.indexOf('resetAll() {');
    const callIndex = source.indexOf('this.personalityDrift.reset()', resetAllIndex);
    assert.ok(resetAllIndex !== -1 && callIndex !== -1, 'resetAll 必须调用 personalityDrift.reset()');
});

console.log('引擎、迁移与账本:');
try {
    check('v1 存档迁移为 v2 并归一化旧日期', () => {
        removeTestFile();
        writeJson(TEST_FILE, {
            traits: { willfulness: 32.751999999999995, security: 59.604 },
            stats: {
                totalMessages: 44,
                lastActiveDate: 'Tue Sep 29 2026',
                dailyMessageCounts: [{ date: 'Tue Sep 29 2026', count: 1 }],
            },
        });
        const engine = new PersonalityDrift(TEST_FILE);
        assert.strictEqual(engine.version, 2);
        assert.strictEqual(engine.presetId, 'custom');
        assert.strictEqual(engine.baseline.willfulness, 33);
        assert.strictEqual(engine.baseline.security, 60);
        assert.strictEqual(engine.baseline.playfulness, 50);
        assert.strictEqual(engine.stats.lastActiveDate, null);
        assert.deepStrictEqual(engine.stats.dailyMessageCounts, []);
        assert.strictEqual(readJson(TEST_FILE).version, 2);
    });
    check('settleDaily 同一自然日幂等', () => {
        const engine = freshEngine();
        const now = new Date('2026-09-30T12:00:00').getTime();
        assert.strictEqual(engine.settleDaily(now).settled, true);
        assert.strictEqual(engine.settleDaily(now + 1000).settled, false);
    });
    check('引擎 R01 正常阶段应用 +0.6/+0.4 并写摘要账本', () => {
        const engine = freshEngine();
        engine.stats.totalMessages = 20;
        const beforeSecurity = engine.current.security;
        const beforeAffection = engine.current.affection;
        const result = engine.recordUserTurn('你真好', {
            sentiment: 0.5,
            affinity: 40,
            affinityChange: 0,
        }, new Date('2026-09-30T12:00:00').getTime());
        assert.ok(Math.abs(engine.current.security - beforeSecurity - 0.6) < 1e-9);
        assert.ok(Math.abs(engine.current.affection - beforeAffection - 0.4) < 1e-9);
        assertHit(result, 'praise_warmth');
        const last = engine.getLedger().at(-1);
        assert.strictEqual(last.source, 'auto');
        assert.strictEqual(last.ruleId, 'praise_warmth');
        assert.ok(last.userInputDigest.length <= 20);
    });
    check('引擎冷启动自动变化减半', () => {
        const engine = freshEngine();
        engine.stats.totalMessages = 10;
        const before = engine.current.security;
        engine.recordUserTurn('你真好', { sentiment: 0.5, affinity: 40, affinityChange: 0 },
            new Date('2026-09-30T12:00:00').getTime());
        assert.ok(Math.abs(engine.current.security - before - 0.3) < 1e-9);
    });
    check('applyManual 平移基线并保留旧偏移', () => {
        const engine = freshEngine();
        engine.current.independence = 54;
        engine.daily.accum.independence = 2;
        engine.applyManual({ independence: 62 });
        assert.strictEqual(engine.baseline.independence, 62);
        assert.strictEqual(engine.current.independence, 66);
        assert.strictEqual(engine.daily.accum.independence, undefined);
        assert.strictEqual(engine.getLedger().at(-1).source, 'manual');
    });
    check('applyPreset 清空浮动并写 preset 账本', () => {
        const engine = freshEngine();
        engine.applyPreset('tsundere');
        assert.deepStrictEqual(engine.baseline, getPreset('tsundere').traits);
        assert.deepStrictEqual(engine.current, getPreset('tsundere').traits);
        assert.strictEqual(engine.getLedger().at(-1).source, 'preset');
    });
    check('reset 恢复 gentle、清账本和 daily，保留统计与开关', () => {
        const engine = freshEngine();
        engine.stats.totalMessages = 42;
        engine.setFlags({ baselineAdaptEnabled: false });
        engine.applyPreset('tsundere');
        engine.reset();
        assert.deepStrictEqual(engine.baseline, getPreset('gentle').traits);
        assert.deepStrictEqual(engine.current, getPreset('gentle').traits);
        assert.deepStrictEqual(engine.getLedger(), []);
        assert.deepStrictEqual(engine.daily.accum, {});
        assert.strictEqual(engine.stats.totalMessages, 42);
        assert.strictEqual(engine.baselineAdaptEnabled, false);
    });
    check('关闭漂移立即收回 baseline，后续只记统计', () => {
        const engine = freshEngine();
        engine.current.security = 70;
        engine.setFlags({ driftEnabled: false });
        assert.strictEqual(engine.current.security, engine.baseline.security);
        const ledgerCount = engine.getLedger().length;
        const messages = engine.stats.totalMessages;
        engine.recordUserTurn('你真好', { sentiment: 0.5, affinity: 40, affinityChange: 0 });
        assert.strictEqual(engine.getLedger().length, ledgerCount);
        assert.strictEqual(engine.stats.totalMessages, messages + 1);
    });
    check('连发 30 句夸奖受单日 +3 与浮动带约束', () => {
        const engine = freshEngine();
        engine.stats.totalMessages = 20;
        const now = new Date('2026-09-30T12:00:00').getTime();
        for (let index = 0; index < 30; index += 1) {
            engine.recordUserTurn('你真好', { sentiment: 0.5, affinity: 40, affinityChange: 0 }, now + index);
        }
        assert.ok(engine.current.security - engine.baseline.security <= 3);
        assert.ok(engine.current.security <= engine.baseline.security + PERSONALITY_RULES.FLOAT_BAND);
    });
    check('账本统一 FIFO 裁到 200 且零变化不写', () => {
        const engine = freshEngine();
        engine.applyPreset('gentle');
        assert.strictEqual(engine.getLedger().length, 0, '同一预设产生全零 changes，不应写账本');
        for (let index = 0; index < 205; index += 1) {
            engine._appendLedger({
                at: new Date(index).toISOString(),
                source: 'manual',
                ruleId: null,
                reason: String(index),
                changes: [{ dim: 'security', before: 50, after: 51, delta: 1 }],
            });
        }
        assert.strictEqual(engine.getLedger().length, 200);
        assert.strictEqual(engine.getLedger()[0].reason, '5');
    });
    check('getPublicState 重算 customized，不信任落盘标志', () => {
        const engine = freshEngine();
        assert.strictEqual(engine.getPublicState().customized, false);
        engine.baseline.security += 1;
        const state = engine.getPublicState();
        assert.strictEqual(state.customized, true);
        assert.strictEqual(state.customizedCount, 1);
        engine.presetId = 'custom';
        assert.strictEqual(engine.getPublicState().customized, true);
    });
    check('明显偏移时提示词包含最近变化原因', () => {
        const engine = freshEngine();
        engine.current.playfulness = engine.baseline.playfulness + 9;
        engine._appendLedger({
            at: new Date().toISOString(),
            source: 'auto',
            ruleId: 'teasing_playful',
            reason: '你逗她，她觉得逗你回去挺有意思',
            userInputDigest: '小傻瓜',
            changes: [{ dim: 'playfulness', before: 45, after: 54, delta: 9 }],
        });
        const prompt = engine.getPromptInjection();
        assert.ok(prompt.includes('你逗她，她觉得逗你回去挺有意思'));
        assert.ok(prompt.includes('更俏皮了'));
    });
    check('getDominantTraits 能覆盖新增俏皮维度', () => {
        const engine = freshEngine();
        for (const dim of DIM_KEYS) engine.current[dim] = 50;
        engine.current.playfulness = 90;
        assert.ok(engine.getDominantTraits().includes('俏皮'));
    });
    check('跨日结算会重置 daily.accum 并触发长期冷落规则', () => {
        const engine = freshEngine();
        engine.stats.totalMessages = 20;
        engine.stats.lastActiveDate = '2026-09-25';
        engine.lastSettledDay = '2026-09-25';
        engine.daily = { dayKey: '2026-09-25', accum: { security: 3 } };
        const result = engine.settleDaily(new Date('2026-09-30T12:00:00').getTime());
        assert.strictEqual(result.settled, true);
        assert.strictEqual(engine.daily.dayKey, '2026-09-30');
        assert.ok(engine.getLedger().some((entry) => entry.ruleId === 'long_absence'));
        assert.ok(engine.daily.accum.security <= 0);
    });
    check('迁移后的 v2 文件二次构造不再重复迁移（TC-MIG-04）', () => {
        removeTestFile();
        writeJson(TEST_FILE, {
            traits: { willfulness: 32.751999999999995, security: 59.604 },
            stats: { totalMessages: 44 },
        });
        const first = new PersonalityDrift(TEST_FILE);
        assert.strictEqual(first.version, 2);
        assert.strictEqual(first.presetId, 'custom');
        const second = new PersonalityDrift(TEST_FILE);
        assert.strictEqual(second.version, 2);
        assert.strictEqual(second.presetId, 'custom', 'presetId 不得被二次迁移覆盖');
        assert.strictEqual(second.baseline.willfulness, 33);
        assert.strictEqual(second.baseline.security, 60);
        assert.strictEqual(second.baseline.playfulness, 50);
    });
    check('编排层 accum 记实际位移而非 applyDailyCap 的申请值（架构 §10 回归）', () => {
        const engine = freshEngine();
        engine.lastSettledDay = '2026-09-30'; // 与注入的 now 同日，跳过 settleDaily 回拉
        engine.stats.totalMessages = 20;
        engine.current.security = engine.baseline.security + PERSONALITY_RULES.FLOAT_BAND; // 80，浮动带上沿
        engine.daily.accum.security = 2;
        const result = engine.recordUserTurn('你真好', { sentiment: 0.5, affinity: 40, affinityChange: 0 },
            new Date('2026-09-30T12:00:00').getTime());
        assert.strictEqual(
            result.changes.find((change) => change.dim === 'security'),
            undefined,
            '浮动带上沿时 security 实际位移应为 0',
        );
        assert.strictEqual(engine.current.security, 80);
        assert.strictEqual(engine.daily.accum.security, 2,
            'accum 必须记实际位移 0 的结果；若误用 applyDailyCap 返回的 accum 会变成 2.6');
    });
    check('引擎级疲劳按 24h 裁窗：跨出窗口后再夸不衰减（TC-THR-15）', () => {
        const engine = freshEngine();
        engine.stats.totalMessages = 20;
        const now = new Date('2026-09-30T12:00:00').getTime();
        const first = engine.recordUserTurn('你真好', { sentiment: 0.5, affinity: 40, affinityChange: 0 }, now);
        assert.ok(first.changes.some((change) => change.dim === 'security' && change.delta === 0.6));
        const nextDay = now + PERSONALITY_RULES.FATIGUE_WINDOW_MS + 60 * 60 * 1000; // +25h
        const second = engine.recordUserTurn('你真好', { sentiment: 0.5, affinity: 40, affinityChange: 0 }, nextDay);
        assert.ok(
            second.changes.some((change) => change.dim === 'security' && Math.abs(change.delta - 0.6) < 1e-9),
            '上一次命中已超出 24h 窗口，应视为第 1 次，不衰减',
        );
    });
    check('每日回拉不占日额度也不写账本（TC-THR-19 / TC-THR-20）', () => {
        const engine = freshEngine();
        engine.stats.totalMessages = 20;
        engine.current.security = engine.baseline.security + 10; // 75，带内
        const result = engine.settleDaily(new Date('2026-09-30T12:00:00').getTime());
        assert.strictEqual(result.settled, true);
        assert.ok(Math.abs(engine.current.security - 74.2) < 1e-9, '回拉 8%：75 + (65-75)*0.08 = 74.2');
        assert.deepStrictEqual(engine.daily.accum, {}, '回拉力不计入 daily.accum');
        assert.deepStrictEqual(engine.getLedger(), [], '回拉力不写账本');
    });
    check('applyManual 负偏移随基线下移并被浮动带夹住（TC-MAN-02）', () => {
        const engine = freshEngine();
        engine.baseline.independence = 80;
        engine.current.independence = 76; // offset -4
        engine.applyManual({ independence: 10 });
        assert.strictEqual(engine.baseline.independence, 10);
        assert.strictEqual(engine.current.independence, 6, 'clamp(10-4, 0, 25) = 6');
    });
    check('applyManual 只清对应维的日额度，其它维保留（TC-MAN-03）', () => {
        const engine = freshEngine();
        engine.daily.accum = { security: 1.2, independence: 0.8 };
        engine.applyManual({ independence: 62 });
        assert.strictEqual(engine.daily.accum.independence, undefined, '手动位移的维不占漂移额度');
        assert.strictEqual(engine.daily.accum.security, 1.2, '其它维的已用额度必须保留');
    });
    check('引擎级疲劳序列：连夸三次 delta 依次 0.6/0.4/0.2（TC-THR-14，±0.05 容差）', () => {
        const engine = freshEngine();
        engine.stats.totalMessages = 20;
        const now = new Date('2026-09-30T12:00:00').getTime();
        const expected = [0.6, 0.4, 0.2]; // 原始 0.6/0.36/0.18 落盘一位小数
        const raw = [0.6, 0.36, 0.18];
        for (let index = 0; index < 3; index += 1) {
            const result = engine.recordUserTurn('你真好',
                { sentiment: 0.5, affinity: 40, affinityChange: 0 }, now + index * 60 * 60 * 1000);
            const delta = result.changes.find((change) => change.dim === 'security')?.delta;
            assert.ok(delta !== undefined, `第 ${index + 1} 次夸奖应有 security 变化`);
            assert.ok(Math.abs(delta - expected[index]) < 1e-9,
                `第 ${index + 1} 次 security 位移 ${delta}，期望落盘值 ${expected[index]}`);
            assert.ok(Math.abs(delta - raw[index]) <= 0.05, `与原始乘积 ${raw[index]} 容差 ±0.05`);
        }
    });
    check('账本 before/after/delta 均为一位小数且自洽（TC-LED-06）', () => {        const engine = freshEngine();
        engine.stats.totalMessages = 20;
        engine.recordUserTurn('你真好', { sentiment: 0.5, affinity: 40, affinityChange: 0 },
            new Date('2026-09-30T12:00:00').getTime());
        const last = engine.getLedger().at(-1);
        assert.ok(last.changes.length > 0);
        for (const change of last.changes) {
            assert.strictEqual(round1(change.after - change.before), change.delta);
            for (const value of [change.before, change.after, change.delta]) {
                assert.ok(Math.abs(value * 10 - Math.round(value * 10)) < 1e-9, `${value} 应为一位小数`);
            }
        }
    });
} finally {
    removeTestFile();
}

// ==================== API 契约（G 组 P0：路由层直测，真实数据零写入） ====================
console.log('API 契约:');
// 动态导入 container：其构造对真实数据只读，但 container 导入会实例化 ProactiveEngine，
// 随后 stop() 触发 _saveState() 回写 proactive_state.json（内容等价、mtime 变化）。
// 为做到「真实数据分毫不动」，导入前先备份该文件原始字节，停掉定时器后在 finally 中
// 原样还原。文件可能不存在（.gitignore 忽略 data/，新 clone / CI 上从未跑过后端），
// 读取必须有 ENOENT 容错——此前顶层裸 readFileSync 会让整个 npm test 在此崩溃，
// 后面 7 条 API 契约用例全部不执行；finally 也只在原文件存在时还原。
// 路由闭包每次请求都动态读取 aiGirlfriend.personalityDrift，替换为测试引擎后，
// 全部 POST 写的都是 personality_state.test.json。
// node:fetch(undici) 不走系统代理，127.0.0.1 随机端口不会被本机 HTTP 代理 502。
const proactiveStateUrl = new URL('../data/proactive_state.json', import.meta.url);
let proactiveStateBackup = null;
let hadProactiveState = false;
try {
    proactiveStateBackup = fs.readFileSync(proactiveStateUrl);
    hadProactiveState = true;
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}
const { default: personalityRoutes } = await import('../src/routes/personalityRoutes.js');
const { aiGirlfriend, proactiveEngine } = await import('../src/services/container.js');
proactiveEngine.stop();
aiGirlfriend.personalityDrift = new PersonalityDrift(TEST_FILE);
const apiApp = express();
apiApp.use(express.json());
apiApp.use(personalityRoutes);
const apiServer = apiApp.listen(0, '127.0.0.1');
await new Promise((resolve) => apiServer.once('listening', resolve));
const apiBase = `http://127.0.0.1:${apiServer.address().port}`;
async function apiCall(method, path, body) {
    const response = await fetch(`${apiBase}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
}
async function checkAsync(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  OK   ${name}`);
    } catch (error) {
        failed += 1;
        process.exitCode = 1;
        console.error(`  FAIL ${name}\n       ${error.message}`);
    }
}

try {
    await checkAsync('TC-API-06 空账本 GET /personality/ledger 返回 []', async () => {
        aiGirlfriend.personalityDrift = new PersonalityDrift(TEST_FILE);
        const { status, json } = await apiCall('GET', '/personality/ledger');
        assert.strictEqual(status, 200);
        assert.deepStrictEqual(json, []);
    });
    await checkAsync('TC-API-01 GET /personality 契约字段完整', async () => {
        aiGirlfriend.personalityDrift = new PersonalityDrift(TEST_FILE);
        const { status, json } = await apiCall('GET', '/personality');
        assert.strictEqual(status, 200);
        for (const field of ['version', 'presetId', 'presetName', 'customized', 'customizedCount',
            'baseline', 'current', 'dims', 'presets', 'band', 'driftEnabled',
            'baselineAdaptEnabled', 'stats']) {
            assert.ok(field in json, `缺少字段 ${field}`);
        }
        assert.strictEqual(json.version, 2);
        assert.strictEqual(json.dims.length, 7);
        for (let index = 1; index < json.dims.length; index += 1) {
            assert.ok(json.dims[index].order > json.dims[index - 1].order, 'dims.order 须升序');
        }
        assert.strictEqual(json.presets.length, 6);
        assert.strictEqual(json.band, 15);
        assert.deepStrictEqual(
            Object.keys(json.stats).sort(),
            ['activeDays', 'totalDays', 'totalMessages'],
        );
    });
    await checkAsync('TC-API-02 POST traits 合法值生效并落盘', async () => {
        aiGirlfriend.personalityDrift = new PersonalityDrift(TEST_FILE);
        const { status, json } = await apiCall('POST', '/personality', { traits: { independence: 62 } });
        assert.strictEqual(status, 200);
        assert.strictEqual(json.baseline.independence, 62);
        assert.strictEqual(readJson(TEST_FILE).baseline.independence, 62, '落盘文件须同步更新');
    });
    await checkAsync('TC-API-05 POST 越界值 clamp 不报错', async () => {
        aiGirlfriend.personalityDrift = new PersonalityDrift(TEST_FILE);
        const { status, json } = await apiCall('POST', '/personality', { traits: { independence: 150 } });
        assert.strictEqual(status, 200);
        assert.strictEqual(json.baseline.independence, 100);
    });
    await checkAsync('TC-API-03 未知维度返回 400', async () => {
        aiGirlfriend.personalityDrift = new PersonalityDrift(TEST_FILE);
        const { status, json } = await apiCall('POST', '/personality', { traits: { foo: 1 } });
        assert.strictEqual(status, 400);
        assert.strictEqual(json.detail, 'unknown personality dim: foo');
    });
    await checkAsync('TC-API-04 未知预设返回 400', async () => {
        aiGirlfriend.personalityDrift = new PersonalityDrift(TEST_FILE);
        const { status, json } = await apiCall('POST', '/personality', { presetId: 'nope' });
        assert.strictEqual(status, 400);
        assert.strictEqual(json.detail, 'unknown presetId: nope');
    });
    await checkAsync('TC-API-07 reset 恢复 gentle、清账本、保留开关与统计', async () => {
        const engine = new PersonalityDrift(TEST_FILE);
        engine.stats.totalMessages = 42;
        engine.setFlags({ driftEnabled: false });
        engine.applyPreset('tsundere'); // 写入一条 preset 账本（setFlags(false) 后 reset 才有意义）
        aiGirlfriend.personalityDrift = engine;
        const { status, json } = await apiCall('POST', '/personality/reset');
        assert.strictEqual(status, 200);
        assert.strictEqual(json.status, 'reset');
        assert.deepStrictEqual(json.baseline, getPreset('gentle').traits);
        assert.deepStrictEqual(json.current, getPreset('gentle').traits);
        assert.strictEqual(json.presetId, 'gentle');
        assert.deepStrictEqual(json.ledger, []);
        assert.strictEqual(json.driftEnabled, false, 'reset 不得打开已关闭的漂移开关');
        assert.strictEqual(json.stats.totalMessages, 42, 'reset 保留统计');
    });
} finally {
    apiServer.close();
    apiServer.closeAllConnections?.();
    if (hadProactiveState && proactiveStateBackup !== null) {
        // 还原 container 导入 + stop() 期间的等价回写；原文件不存在时删掉测试产生的
        fs.writeFileSync(proactiveStateUrl, proactiveStateBackup);
    } else {
        try { fs.unlinkSync(proactiveStateUrl); } catch { /* 文件本就不存在 */ }
    }
    removeTestFile();
}

const total = passed + failed;
if (failed > 0) {
    console.error(`\n${passed}/${total} 通过，${failed} 项失败`);
} else {
    console.log(`\n全部 ${passed} 项通过`);
}
