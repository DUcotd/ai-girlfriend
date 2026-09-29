/**
 * 好感度规则回归测试（单进程自包含）。
 *
 * ⚠️ 本机沙箱 child_process.spawn 会被 EBUSY 拦死，因此**禁止 spawn 子进程**：
 * 全部用例在同一进程内用 Node 内置 assert + 计数器跑完，失败时 process.exitCode=1。
 * 由 package.json 的 `npm test` 与 test-stream-filter.mjs 串联执行。
 *
 * 覆盖（对应架构 §5 T05）：阶段映射 / 词表互斥 / 越界惩罚 / 软拒绝 / 疲劳 /
 * 单次上下限 / 超低保护 / 惯性 / 日上限 / trace 一致性 / 引擎惰性衰减 / 日上限跨日重置。
 */
import assert from 'assert';
import fs from 'fs';
import { validateAffinityChange, AFFINITY_RULES } from '../src/core/affinityRules.js';
import {
    getStageForAffinity, getStageIndex, getNextStage, buildStageMeta, RELATIONSHIP_STAGES,
} from '../src/core/relationshipStages.js';
import {
    HARD_REJECTION, SOFT_REJECTION, DEEP_INTIMACY, MILD_INTIMACY,
    PRAISE, CRITICISM, TEASING, EXCITING, CALMING, SAD, QUESTION,
    matchCategory,
} from '../src/core/lexicon.js';
import { pruneGainEvents, recordGain, applyGainFatigue } from '../src/core/affinityFatigue.js';
import { dayKey } from '../src/utils/dayKey.js';
import { dataPath } from '../src/utils/jsonStore.js';
import AffinityEngine from '../src/core/AffinityEngine.js';

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

const TEST_FILE = 'affinity_state.test.json';
const testFilePath = dataPath(TEST_FILE);
/** 干净的引擎：先删测试文件，避免上一用例的落盘污染 */
function freshEngine() {
    try { fs.unlinkSync(testFilePath); } catch { /* 不存在即忽略 */ }
    return new AffinityEngine(TEST_FILE);
}
/** trace 不变量：rawChange + Σ(to-from) === change */
function assertTraceInvariant(raw, input, reply, affinity, recent, daily) {
    const { change, trace } = validateAffinityChange(raw, input, reply, affinity, recent, daily);
    const sum = trace.reduce((s, t) => s + (t.to - t.from), 0);
    assert.strictEqual(raw + sum, change, `不变量破坏: raw=${raw} Σ=${sum} change=${change}`);
    return change;
}

// ==================== 1. 阶段映射 ====================
console.log('阶段映射:');
check('getStageForAffinity 五个边界', () => {
    assert.strictEqual(getStageForAffinity(0).stage, 'stranger');
    assert.strictEqual(getStageForAffinity(15).stage, 'stranger');
    assert.strictEqual(getStageForAffinity(16).stage, 'acquaintance');
    assert.strictEqual(getStageForAffinity(34).stage, 'acquaintance');
    assert.strictEqual(getStageForAffinity(35).stage, 'friend');
    assert.strictEqual(getStageForAffinity(59).stage, 'friend');
    assert.strictEqual(getStageForAffinity(60).stage, 'close');
    assert.strictEqual(getStageForAffinity(84).stage, 'close');
    assert.strictEqual(getStageForAffinity(85).stage, 'lover');
    assert.strictEqual(getStageForAffinity(100).stage, 'lover');
});
check('阈值数组未被改动（15/34/59/84）', () => {
    assert.deepStrictEqual(RELATIONSHIP_STAGES.map(s => [s.min, s.max]),
        [[0, 15], [16, 34], [35, 59], [60, 84], [85, 100]]);
});
check('getStageIndex / getNextStage', () => {
    assert.strictEqual(getStageIndex(0), 0);
    assert.strictEqual(getStageIndex(37), 2);
    assert.strictEqual(getStageIndex(100), 4);
    assert.strictEqual(getNextStage(37).stage, 'close');
    assert.strictEqual(getNextStage(100), null);
});
check('buildStageMeta(37).pointsToNextStage===23 且 stageProgress≈0.083', () => {
    const m = buildStageMeta(37);
    assert.strictEqual(m.stage, 'friend');
    assert.strictEqual(m.nextStage, 'close');
    assert.strictEqual(m.nextStageLabel, '挚友/暧昧');
    assert.strictEqual(m.pointsToNextStage, 23);
    assert.ok(Math.abs(m.stageProgress - 2 / 24) < 1e-9, `stageProgress=${m.stageProgress}`);
});
check('buildStageMeta 顶点（35 起点 / 100 封顶 lover）', () => {
    assert.strictEqual(buildStageMeta(35).stageProgress, 0);
    assert.strictEqual(buildStageMeta(35).pointsToNextStage, 25);
    const top = buildStageMeta(100);
    assert.strictEqual(top.nextStage, null);
    assert.strictEqual(top.nextStageLabel, null);
    assert.strictEqual(top.pointsToNextStage, 0);
    assert.strictEqual(top.stageProgress, 1);
});

// ==================== 2. 词表互斥 + matchCategory ====================
console.log('词表:');
check('11 张词表两两 exact-token 交集为空', () => {
    const tables = {
        HARD_REJECTION, SOFT_REJECTION, DEEP_INTIMACY, MILD_INTIMACY,
        PRAISE, CRITICISM, TEASING, EXCITING, CALMING, SAD, QUESTION,
    };
    const names = Object.keys(tables);
    for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
            const a = new Set(tables[names[i]]);
            const overlap = tables[names[j]].filter(w => a.has(w));
            assert.deepStrictEqual(overlap, [], `${names[i]} ∩ ${names[j]} = ${overlap}`);
        }
    }
});
check('matchCategory 同词同分类（含历史冲突修正）', () => {
    assert.strictEqual(matchCategory('抱抱'), 'DEEP_INTIMACY');
    assert.strictEqual(matchCategory('亲亲'), 'DEEP_INTIMACY');
    assert.strictEqual(matchCategory('讨厌'), 'SOFT_REJECTION');
    assert.strictEqual(matchCategory('哼'), 'SOFT_REJECTION');
    assert.strictEqual(matchCategory('喜欢你'), 'MILD_INTIMACY');
    assert.strictEqual(matchCategory('随便聊聊今天天气'), null);
});

// ==================== 3. 越界惩罚（五阶段 × MILD/DEEP） ====================
console.log('越界惩罚:');
check('越界分档表逐条（reply 无拒绝词，raw=0）', () => {
    // [affinity, 期望 MILD 越界, 期望 DEEP 越界]
    const cases = [
        [5, -2, -3],    // stranger
        [25, -2, -3],   // acquaintance
        [40, 0, -2],    // friend：MILD 不罚；DEEP 罚 -2
        [70, 0, 0],     // close
        [90, 0, 0],     // lover
    ];
    for (const [aff, expMild, expDeep] of cases) {
        const m = validateAffinityChange(0, '喜欢你', '', aff, 0, 0).change;
        const d = validateAffinityChange(0, '抱抱', '', aff, 0, 0).change;
        assert.strictEqual(m, expMild, `affinity=${aff} MILD got ${m} want ${expMild}`);
        assert.strictEqual(d, expDeep, `affinity=${aff} DEEP got ${d} want ${expDeep}`);
    }
});

// ==================== 4. 软拒绝 / 傲娇 ====================
console.log('软拒绝:');
check('close + 亲密 + 软拒绝 → 傲娇，不阻断不扣分', () => {
    assert.strictEqual(validateAffinityChange(-2, '抱抱', '...哼', 70, 0, 0).change, 0);
});
check('lover + 亲密 + 软拒绝 → 保留正向', () => {
    assert.strictEqual(validateAffinityChange(2, '亲亲', '不要嘛哼', 90, 0, 0).change, 2);
});
check('低阶段软拒绝阻断正向', () => {
    assert.strictEqual(validateAffinityChange(3, '你好', '哼', 25, 0, 0).change, 0);
});
check('硬拒绝 + 强行亲密 → 追加惩罚', () => {
    const r = validateAffinityChange(0, '抱抱', '我们还不熟，请不要这样', 25, 0, 0);
    assert.strictEqual(r.change, -2);
    assert.ok(r.trace.some(t => t.rule === 'forced_intimacy_penalty'));
});

// ==================== 5. 疲劳 ====================
console.log('疲劳:');
check('pruneGainEvents 24h 边界裁窗', () => {
    const now = 1_000_000_000_000;
    const DAY = 24 * 60 * 60 * 1000;
    assert.deepStrictEqual(pruneGainEvents([now - DAY, now - DAY + 1, now - 1], now, DAY), [now - DAY + 1, now - 1]);
    assert.deepStrictEqual(pruneGainEvents(null, now, DAY), []);
});
check('recordGain 追加且不改入参', () => {
    const src = [1, 2];
    const out = recordGain(src, 3);
    assert.deepStrictEqual(out, [1, 2, 3]);
    assert.deepStrictEqual(src, [1, 2], '不得改动入参');
});
check('applyGainFatigue 0/1/2/3 次', () => {
    assert.deepStrictEqual(applyGainFatigue(3, 0), { change: 3, applied: false });
    assert.deepStrictEqual(applyGainFatigue(3, 1), { change: 2, applied: true });
    assert.deepStrictEqual(applyGainFatigue(3, 2), { change: 2, applied: true });
    assert.deepStrictEqual(applyGainFatigue(3, 3), { change: 0, applied: true });
});

// ==================== 6. 单次上下限 ====================
console.log('单次上下限:');
check('正向 clamp +10 → +3', () => {
    assert.strictEqual(validateAffinityChange(10, '', '', 90, 0, 0).change, 3);
});
check('负向 clamp -30 → -10（friend 惯性 ×1.0）', () => {
    assert.strictEqual(validateAffinityChange(-30, '', '', 50, 0, 0).change, -10);
});

// ==================== 7. 超低保护 + 惯性 ====================
console.log('超低保护与惯性:');
check('affinity<10 正向 ×0.3', () => {
    assert.strictEqual(validateAffinityChange(3, '', '', 5, 0, 0).change, 1);
});
check('惯性 friend×1.0 / close×0.5 / lover×0.2', () => {
    assert.strictEqual(validateAffinityChange(-8, '', '', 50, 0, 0).change, -8);
    assert.strictEqual(validateAffinityChange(-8, '', '', 70, 0, 0).change, -4);
    assert.strictEqual(validateAffinityChange(-10, '', '', 90, 0, 0).change, -2);
});

// ==================== 8. 日上限 ====================
console.log('日上限:');
check('dailyGainedToday=7 时 +3 → +1，trace 记 daily_cap', () => {
    const r = validateAffinityChange(3, '', '', 50, 0, 7);
    assert.strictEqual(r.change, 1);
    assert.ok(r.trace.some(t => t.rule === 'daily_cap'));
});
check('dailyGainedToday=8 时 +3 → 0', () => {
    const r = validateAffinityChange(3, '', '', 50, 0, 8);
    assert.strictEqual(r.change, 0);
    assert.ok(r.trace.some(t => t.rule === 'daily_cap'));
});
check('日上限最后生效（越界负向不受影响）', () => {
    // 负变化不应被日上限触碰
    const r = validateAffinityChange(-3, '', '', 50, 0, 8);
    assert.strictEqual(r.change, -3);
    assert.ok(!r.trace.some(t => t.rule === 'daily_cap'));
});
check('DAILY_POSITIVE_CAP === 8（单一来源）', () => {
    assert.strictEqual(AFFINITY_RULES.DAILY_POSITIVE_CAP, 8);
});

// ==================== 9. trace 一致性 ====================
console.log('trace 一致性:');
check('多组用例满足 rawChange + Σ(to-from) === finalChange', () => {
    assertTraceInvariant(3, '老婆', '', 40, 0, 0);           // 越界 -2 + 疲劳/日上限
    assertTraceInvariant(3, '', '', 40, 2, 0);               // 疲劳减半
    assertTraceInvariant(10, '', '', 90, 0, 0);              // 单次上限
    assertTraceInvariant(-30, '', '', 90, 0, 0);             // 负向 clamp + 惯性
    assertTraceInvariant(3, '抱抱', '我们还不熟', 25, 0, 0); // 硬拒绝 + 强迫亲密
    assertTraceInvariant(3, '', '', 5, 0, 7);                // 超低保护 + 日上限
    assertTraceInvariant(0, '喜欢你', '', 5, 0, 0);          // 越界
});

// ==================== 10. 引擎惰性衰减 ====================
console.log('引擎惰性衰减:');
const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-09-30T12:00:00').getTime();
try {
    check('friend(40) 静默 71h → 不衰减', () => {
        const e = freshEngine();
        e.setAffinity(40);
        e.notifyUserActive(NOW - 71 * HOUR);
        const r = e.settleDecay(NOW);
        assert.strictEqual(r.applied, 0);
        assert.strictEqual(e.affinity, 40);
    });
    check('friend(40) 静默 72h → 37（floor(72/24)=3）', () => {
        const e = freshEngine();
        e.setAffinity(40);
        e.notifyUserActive(NOW - 72 * HOUR);
        const r = e.settleDecay(NOW);
        assert.strictEqual(r.applied, 3);
        assert.strictEqual(r.steps, 3);
        assert.strictEqual(e.affinity, 37);
    });
    check('friend(40) 静默 120h → 35（止跌于阶段下沿）', () => {
        const e = freshEngine();
        e.setAffinity(40);
        e.notifyUserActive(NOW - 120 * HOUR);
        const r = e.settleDecay(NOW);
        assert.strictEqual(r.steps, 5);
        assert.strictEqual(e.affinity, 35);
    });
    check('close(70) 静默 72h → 69（高级阶段 48h/点）', () => {
        const e = freshEngine();
        e.setAffinity(70);
        e.notifyUserActive(NOW - 72 * HOUR);
        const r = e.settleDecay(NOW);
        assert.strictEqual(r.steps, 1);
        assert.strictEqual(e.affinity, 69);
    });
    check('衰减账本记 time_decay 且满足不变量', () => {
        const e = freshEngine();
        e.setAffinity(40);
        e.notifyUserActive(NOW - 72 * HOUR);
        e.settleDecay(NOW);
        const last = e.getLedger().at(-1);
        assert.strictEqual(last.rawChange, 0);
        assert.strictEqual(last.trace[0].rule, 'time_decay');
        assert.strictEqual(last.finalChange, -3);
        assert.strictEqual(last.before + last.finalChange, last.after);
    });
    check('消耗式结算：再次结算不重复扣分', () => {
        const e = freshEngine();
        e.setAffinity(40);
        e.notifyUserActive(NOW - 72 * HOUR);
        e.settleDecay(NOW);                 // 已消耗 72h
        const again = e.settleDecay(NOW + 1000); // 只剩 1s
        assert.strictEqual(again.applied, 0);
        assert.strictEqual(e.affinity, 37);
    });

    // ==================== 11. 日上限跨自然日重置 ====================
    console.log('日上限跨日:');
    check('day1 满额变化归零，跨 00:00 后额度重置', () => {
        const e = freshEngine();
        e.setAffinity(50);
        const day1 = new Date('2026-09-29T10:00:00').getTime();
        const day2 = new Date('2026-09-30T10:00:00').getTime();
        // 直接预置「今日已涨 8」：正常 +3 路径受疲劳限制永远到不了 8（设计已知副作用），
        // 这里绕过疲劳累积、单独验证日上限闸门与跨日重置。
        e.daily = { dayKey: dayKey(new Date(day1)), gained: 8 };
        e.notifyUserActive(day1);

        const r1 = e.recordUserTurn('你好', 3, '', day1);
        assert.strictEqual(r1.change, 0, '日上限满额时正向变化应为 0');
        assert.ok(r1.trace.some(t => t.rule === 'daily_cap'));
        assert.strictEqual(r1.meta.dailyCapReached, true);

        const r2 = e.recordUserTurn('你好', 3, '', day2);
        assert.strictEqual(r2.change, 3, '跨 00:00 后额度重置，正向恢复');
        assert.strictEqual(r2.affinity, 53);
        assert.strictEqual(r2.meta.dailyCapReached, false);
    });
    check('recordUserTurn 返回结构完整（affinity/change/trace/meta）', () => {
        const e = freshEngine();
        e.setAffinity(40);
        const r = e.recordUserTurn('你好', 1, '', NOW);
        assert.strictEqual(typeof r.affinity, 'number');
        assert.strictEqual(typeof r.change, 'number');
        assert.ok(Array.isArray(r.trace));
        assert.strictEqual(typeof r.meta.stage, 'string');
        assert.strictEqual(typeof r.meta.stageLabel, 'string');
        assert.strictEqual(typeof r.meta.stageProgress, 'number');
    });

    // ==================== 12. 变化原因（无规则介入的常见路径） ====================
    // 回归：trace 只记录「被哪些规则改过」，正常涨分（无越界/拒绝/疲劳）trace 为空。
    // 若用 trace 当唯一原因来源，会导致「涨了分却显示没有变化」——这是日常最常走的路径。
    console.log('变化原因:');
    check('无规则命中时 recentChange / 原因不回退为「没有变化」', () => {
        const e = freshEngine();
        e.setAffinity(35);
        // 输入与回复都不含任何词表命中，rawChange=2 → 无规则介入
        const r = e.recordUserTurn('今天天气不错', 2, '嗯嗯', NOW);
        assert.strictEqual(r.change, 2);
        assert.strictEqual(e.getLedger().at(-1).trace.length, 0, 'trace 语义不变：无规则介入即空');
        const meta = e.getMeta(NOW);
        assert.strictEqual(meta.recentChange, 2);
        assert.ok(meta.recentChangeReason && meta.recentChangeReason.length > 0,
            'recentChangeReason 应走兜底文案而非 null');
    });
    check('0 变化回合保留上一次真实变化值与原因', () => {
        const e = freshEngine();
        e.setAffinity(35);
        e.recordUserTurn('今天天气不错', 2, '嗯嗯', NOW);
        const firstReason = e.getMeta(NOW).recentChangeReason;
        const r2 = e.recordUserTurn('嗯嗯', 0, '好', NOW + 1000);   // 本回合 0 变化
        assert.strictEqual(r2.change, 0);
        const meta2 = e.getMeta(NOW + 1000);
        assert.strictEqual(meta2.recentChange, 2, '仍是上一次真实变化值');
        assert.strictEqual(meta2.recentChangeReason, firstReason, '仍是上一次原因');
    });
} finally {
    // 清理测试落盘（含 settleDecay 存盘产生的文件），不污染真实数据
    try { fs.unlinkSync(testFilePath); } catch { /* 忽略 */ }
}

// ==================== 汇总 ====================
const TOTAL = passed + failed;
if (failed > 0) {
    console.error(`\n${passed}/${TOTAL} 通过，${failed} 项失败`);
} else {
    console.log(`\n全部 ${passed} 项通过`);
}
