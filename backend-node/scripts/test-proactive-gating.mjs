/**
 * 主动消息闸门测试（2026-10-01，docs/proactive-consistency/DIAGNOSIS.md 修复 5）。
 *
 * 覆盖：陌生档 minAffinity 拦截、初识解锁、全局自发间隔、相似度去重、
 * 情绪闸门三档（pass/suppress/block）、ghost 停发但 task_reminder 豁免、
 * memory_share ≥50、getStatus 暴露。
 *
 * 纯 Node 断言，不调 LLM：generateProactiveMessage 用 mock 替身。
 * 真实数据保护：构造 ProactiveEngine 会读 data/proactive_state.json，stop() 会回写——
 * 与 test-personality.mjs 同一套备份/还原（导入前存原始字节，finally 原样还原；
 * 文件可能不存在，读取必须有 ENOENT 容错）。
 */
import fs from 'node:fs';
import { dataPath } from '../src/utils/jsonStore.js';

let failed = 0;
function check(name, cond, detail = '') {
    if (cond) {
        console.log(`  OK  ${name}`);
    } else {
        failed++;
        console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
    }
}

// ---- 真实 proactive_state.json 备份（必须在动态 import 之前） ----
const stateUrl = dataPath('proactive_state.json');
let stateBackup = null;
let hadStateFile = false;
try {
    stateBackup = fs.readFileSync(stateUrl);
    hadStateFile = true;
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}

try {
    const { default: ProactiveEngine } = await import('../src/core/ProactiveEngine.js');
    const { DEFAULT_ENABLED_TYPES } = await import('../src/core/proactiveTypes.js');

    /** mock aiGirlfriend：affinity / emotionEngine.state.P / 生成回复都可随时改 */
    function makeMock({ affinity = 35, P = 0.3, reply = '今天天气不错呢。' } = {}) {
        const mock = {
            affinity,
            emotionEngine: { state: { P, A: 0.1, D: 0 } },
            reply,
            generateCallCount: 0,
            generateProactiveMessage: async () => {
                mock.generateCallCount++;
                // 读 mock.reply 而非闭包参数：测试用例要在运行中换回复内容
                return { reply: mock.reply, emotion: '平静' };
            },
            recordProactiveMessage: () => {},
        };
        return mock;
    }

    const mock = makeMock();
    const engine = new ProactiveEngine(mock);
    engine.stop(); // 关掉 60s 检查定时器与 LifeSimulator，测试期间手动控制全部状态

    /** 清空从真实 proactive_state.json 恢复的运行时状态，保证用例确定性 */
    function resetEngineState({ customDailyLimit = 20 } = {}) {
        engine.lastTriggerByType = {};
        engine.sentDays = {};
        engine.dailyMessageCount = 0;
        engine.lastSpontaneousAt = 0;
        engine.recentSentTexts = [];
        engine.messageQueue = [];
        engine.config.enabledTypes = [...DEFAULT_ENABLED_TYPES];
        engine.config.customDailyLimit = customDailyLimit;
    }

    console.log('A. 陌生档（好感度 0）禁用自发类:');
    resetEngineState();
    mock.affinity = 0;
    mock.emotionEngine.state.P = 0.3;
    for (const type of ['mood_check', 'miss_you', 'random_chat', 'life_update', 'memory_share']) {
        check(`canTrigger('${type}') 被拦`, engine.canTrigger(type) === false);
    }
    check('canTrigger(\'task_reminder\') 不受限', engine.canTrigger('task_reminder') === true);
    check('canTrigger(\'morning_greeting\') 不受限', engine.canTrigger('morning_greeting') === true);
    check('手动 trigger(\'random_chat\') 被拒', await engine.trigger('random_chat') === false);
    check('被拒时未调 LLM', mock.generateCallCount === 0, `calls=${mock.generateCallCount}`);

    console.log('B. 初识档（好感度 20）解锁，手动触发成功:');
    mock.affinity = 20;
    check("canTrigger('mood_check') 解锁", engine.canTrigger('mood_check') === true);
    check("trigger('mood_check') 成功", await engine.trigger('mood_check') === true);
    check('消息入队', engine.messageQueue.length === 1);
    check('自发间隔时间戳已记', engine.lastSpontaneousAt > 0);
    check('已发文本进入去重缓存', engine.recentSentTexts.length === 1);
    check('占用了每日配额', engine.dailyMessageCount === 1, `count=${engine.dailyMessageCount}`);
    check('consumeMessage 取到消息', engine.consumeMessage()?.reason === 'mood_check');

    console.log('C. 全局自发间隔（90min 内第二条自发类被拦）:');
    check("紧随其后的 trigger('random_chat') 被拒", await engine.trigger('random_chat') === false);
    check('被拒时未调 LLM', mock.generateCallCount === 1, `calls=${mock.generateCallCount}`);

    console.log('D. 相似度去重（开头 8 字符雷同即丢弃）:');
    engine.lastSpontaneousAt = 0; // 绕过自发间隔，只验去重
    engine.recentSentTexts = ['那个……下午好。今天过得怎么样？'];
    mock.reply = '那个……下午好。刚才在阳台看了会儿风景。';
    check('复读消息被丢弃', await engine.trigger('miss_you', { inactiveMinutes: 130 }) === false);
    check('丢弃时调了 LLM（先生成后比对）', mock.generateCallCount === 2, `calls=${mock.generateCallCount}`);
    check('丢弃不入队', engine.messageQueue.length === 0);
    check('丢弃不占配额', engine.dailyMessageCount === 1);
    check('写同类型冷却防止重试风暴', (engine.lastTriggerByType.miss_you || 0) > 0);
    engine.lastSpontaneousAt = 0; // 每次触发前都要重置，否则上一条已把间隔计时器拨到当下
    mock.reply = '今天看的电影真不错。';
    check('内容不同则放行', await engine.trigger('miss_you', { inactiveMinutes: 130 }) === true);
    check('正常消息入队', engine.messageQueue.length === 1);

    console.log('E. 情绪 block 档（P < -0.5）:');
    resetEngineState();
    mock.affinity = 35;
    mock.emotionEngine.state.P = -0.6;
    check('getEmotionGate() = block', engine.getEmotionGate().mode === 'block');
    check("trigger('random_chat') 被拒", await engine.trigger('random_chat') === false);
    check('被拒时未调 LLM', mock.generateCallCount === 3, `calls=${mock.generateCallCount}`);

    console.log('F. 情绪 suppress 档（-0.5 ≤ P < -0.2）:');
    mock.emotionEngine.state.P = -0.3;
    check('getEmotionGate() = suppress × 0.3', engine.getEmotionGate().mode === 'suppress' && engine.getEmotionGate().factor === 0.3);
    check('suppress 档手动触发不拦（只压自动概率）', await engine.trigger('random_chat') === true);

    console.log('G. ghost（P < -0.75）: 自发类与定时问候停发，task_reminder 豁免:');
    mock.emotionEngine.state.P = -0.8;
    check('isGhosting() = true', engine.isGhosting() === true);
    check("trigger('mood_check') 被拒", await engine.trigger('mood_check') === false);
    check("trigger('morning_greeting') 被拒", await engine.trigger('morning_greeting') === false);
    check("ghost 中 trigger('task_reminder') 照发",
        await engine.trigger('task_reminder', { task: { id: 't1', title: '买牛奶', dueTime: null }, kind: 'due' }) === true);
    check('任务提醒入队', engine.messageQueue.some(m => m.reason === 'task_reminder'));

    console.log('H. memory_share 好感度门槛（≥50）:');
    mock.emotionEngine.state.P = 0.3;
    mock.affinity = 40;
    check('好感 40 被拦', engine.canTrigger('memory_share') === false);
    mock.affinity = 60;
    check('好感 60 解锁', engine.canTrigger('memory_share') === true);

    console.log('I. getStatus() 暴露闸门状态:');
    mock.affinity = 35;
    const status = engine.getStatus();
    check('emotionGate 结构完整', ['pass', 'suppress', 'block'].includes(status.emotionGate?.mode)
        && typeof status.emotionGate?.P === 'number');
    check('ghosting 为布尔', typeof status.ghosting === 'boolean');
    check('spontaneousGapRemainingMs 为非负数', typeof status.spontaneousGapRemainingMs === 'number'
        && status.spontaneousGapRemainingMs >= 0);

    console.log('');
    if (failed > 0) {
        console.error(`test-proactive-gating: ${failed} 项失败`);
        process.exit(1);
    }
    console.log('test-proactive-gating: 全部通过');
} finally {
    if (hadStateFile) {
        fs.writeFileSync(stateUrl, stateBackup);
    } else {
        try { fs.unlinkSync(stateUrl); } catch { /* 本来就没有 */ }
    }
}
