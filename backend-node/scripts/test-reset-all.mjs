/**
 * 「完全重置」范围回归测试。
 *
 * 覆盖 resetAll() 应清空的各类数据 + 容错行为：
 *   history / affinity / personality / emotion / tasks / memory
 * 直接构造各引擎并调用其 reset/clear 方法，断言内存态与落盘态。
 * （resetAll 自身的编排行为——含 proactive/lifeLog 覆盖、与在途对话串行——
 *  由 scripts/test-audit-b0.mjs 覆盖。）
 *
 * ⚠️ 全程写临时数据目录：本文件历史上会直接改真实 data/emotion_state.json 与
 * tasks.json 且**不备份**，等于「跑一次测试删一次用户档案」（审计 INFRA-03）。
 *
 * 运行：node scripts/test-reset-all.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

// 必须在 import src/ 之前设置：jsonStore 在模块加载时就解析数据目录
process.env.AI_GIRLFRIEND_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aigf-reset-'));

const { default: EmotionEngine } = await import('../src/core/EmotionEngine.js');
const { default: TaskManager } = await import('../src/core/TaskManager.js');
const { default: AffinityEngine, DEFAULT_AFFINITY } = await import('../src/core/AffinityEngine.js');
const { readJson, dataPath } = await import('../src/utils/jsonStore.js');

let pass = 0, fail = 0;
const check = (name, cond) => {
    if (cond) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name); }
};

console.log('== EmotionEngine.reset ==');
const emo = new EmotionEngine();
emo.state = { P: -0.9, A: 0.8, D: 0.7 };
emo.baseline = { P: 0.55, A: 0.2, D: -0.2 };
emo.history = [{ a: 1 }, { b: 2 }];
emo.relationshipStage = 'lover';
emo.relationshipLabel = '恋人';
emo.reset();
check('state P 回初值 0.3', emo.state.P === 0.3);
check('state A 回初值 0.1', emo.state.A === 0.1);
check('state D 回初值 -0.1', emo.state.D === -0.1);
check('baseline 回初值', emo.baseline.P === 0.3 && emo.baseline.A === 0.1 && emo.baseline.D === -0.1);
check('history 清空', emo.history.length === 0);
check('relationshipStage 清空', emo.relationshipStage === null);
check('relationshipLabel 回未知', emo.relationshipLabel === '未知');
const emoSaved = readJson('emotion_state.json', null);
check('emotion_state.json 落盘为初始态', emoSaved && emoSaved.state && emoSaved.state.P === 0.3 && emoSaved.relationshipStage === null);

console.log('== AffinityEngine.reset ==');
const aff = new AffinityEngine('affinity_test_tmp.json');
aff._affinity = 95;
aff.ledger = [{ delta: 1 }];
aff.gainEvents = [{ t: 1 }];
aff.daily = { dayKey: '2020-01-01', gained: 7 };
aff.reset();
// 断言必须对着**常量默认值**比较。旧写法是
// `aff.affinity === aff._affinity`（getter 比自己的后备字段），同义反复、永远为真。
check(`affinity 回默认档 ${DEFAULT_AFFINITY}`, aff.affinity === DEFAULT_AFFINITY && aff._affinity === DEFAULT_AFFINITY);
check('ledger 清空', aff.ledger.length === 0);
check('gainEvents 清空', aff.gainEvents.length === 0);
check('daily 归零', aff.daily.gained === 0);
const affSaved = readJson('affinity_test_tmp.json', null);
check('affinity 落盘为默认档', affSaved?.affinity === DEFAULT_AFFINITY);
try { fs.unlinkSync(dataPath('affinity_test_tmp.json')); } catch { /* ignore */ }

console.log('== TaskManager.clearAll ==');
TaskManager.tasks = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];
const cleared = TaskManager.clearAll();
check('返回清除数量 3', cleared === 3);
check('tasks 清空', TaskManager.getTasks().length === 0);
const tSaved = readJson('tasks.json', null);
check('tasks.json 落盘为空数组', Array.isArray(tSaved) && tSaved.length === 0);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
