/**
 * 好感度规则行为验证（一次性脚本，不进测试套件）。
 * 场景覆盖：阶段映射 / 越界惩罚 / 加分疲劳 / 正向上限 / 高好感惯性。
 */
import { validateAffinityChange } from '../src/core/affinityRules.js';
import { getStageForAffinity } from '../src/core/relationshipStages.js';

let pass = 0, fail = 0;
function check(name, actual, expected) {
    const ok = actual === expected;
    ok ? pass++ : fail++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: got ${actual}, want ${expected}`);
}

// ---- 阶段映射（用户心智：35=朋友, 70-80=挚友, 100=亲密） ----
check('35 → friend', getStageForAffinity(35).stage, 'friend');
check('20 → acquaintance', getStageForAffinity(20).stage, 'acquaintance');
check('70 → close', getStageForAffinity(70).stage, 'close');
check('100 → lover', getStageForAffinity(100).stage, 'lover');
check('0 → stranger', getStageForAffinity(0).stage, 'stranger');

// ---- 普通闲聊：LLM 给了 +1，疲劳计数 0 → 保留（prompt 负责让它给 0） ----
check('普通闲聊 +1 (无疲劳)', validateAffinityChange(1, '今天天气不错', '是呀', 35, 'friend', 0), 1);

// ---- 加分疲劳：24h 内已加过 1 次 → 减半；已加 3 次 → 归零 ----
check('疲劳 1 次: +1 → 减半', validateAffinityChange(1, '你今天真好看', '谢谢...', 35, 'friend', 1), 1); // round(0.5)=1? Math.round(0.5)=1
check('疲劳 2 次: +3 → 减半', validateAffinityChange(3, '表白', '诶...', 35, 'friend', 2), 2);
check('疲劳 3 次: +1 → 0', validateAffinityChange(1, '关心', '嗯', 35, 'friend', 3), 0);

// ---- 正向上限：LLM 给 +10 → clamp 到 +3 ----
check('正向 clamp +10 → +3', validateAffinityChange(10, '深情表白', '我也爱你', 90, 'lover', 0), 3);

// ---- 越界惩罚：30 分（初识）说亲密话 ----
check('30分 用户说"宝贝" → ≤-3', validateAffinityChange(0, '宝贝在吗', '你...你叫我什么？', 30, 'acquaintance', 0), -3);
check('30分 用户说"喜欢你" → ≤-2', validateAffinityChange(0, '我喜欢你', '太突然了...', 30, 'acquaintance', 0), -2);
check('30分 LLM 还给 +2 → 强制 -2', validateAffinityChange(2, '想你了', '我们还没那么熟', 30, 'acquaintance', 0), -2);

// ---- 朋友阶段（35-59）重度亲密 → -1；轻度亲密不强制 ----
check('40分 叫"老婆" → -1', validateAffinityChange(1, '老婆晚上好', '谁是你老婆！', 40, 'friend', 0), -1);
check('40分 说"喜欢你" → 不强制', validateAffinityChange(1, '我喜欢你', '诶嘿嘿...', 40, 'friend', 0), 1);

// ---- 挚友/恋人阶段亲密 → 正常加分 ----
check('70分 说"爱你" → +1 保留', validateAffinityChange(1, '爱你哦', '嗯...我也是', 70, 'close', 0), 1);

// ---- 硬拒绝 + 强行亲密 ----
check('硬拒绝+亲密 → ≤-2', validateAffinityChange(0, '亲亲', '我们还不熟，请不要这样', 20, 'acquaintance', 0), -2);

// ---- 高好感惯性：90 分被骂 → 大幅衰减（Math.round(-10*0.15)=-1，JS 负数向零取整） ----
check('90分 -10 → 惯性衰减', validateAffinityChange(-10, '你真恶心', '...', 90, 'lover', 0), -1);

// ---- 超低好感保护：5 分 → 正向衰减（注意回复文本不能含软拒绝词，否则先被规则2拦截） ----
check('5分 +3 → 衰减', validateAffinityChange(3, '对不起', '……', 5, 'stranger', 0), 1);
// 附带验证：陌生阶段软拒绝会拦住正向变化
check('陌生阶段软拒绝拦正向', validateAffinityChange(3, '对不起', '...哼', 5, 'stranger', 0), 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
