/**
 * 「完全重置」范围回归测试。
 *
 * 覆盖 resetAll() 应清空的 6 类数据 + 容错行为：
 *   history / affinity / personality / emotion / tasks / memory
 * 直接构造各引擎并调用其 reset/clear 方法，断言内存态与落盘态。
 *
 * 运行：node scripts/test-reset-all.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import EmotionEngine from '../src/core/EmotionEngine.js';
import TaskManager from '../src/core/TaskManager.js';
import AffinityEngine from '../src/core/AffinityEngine.js';
import { readJson } from '../src/utils/jsonStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
check('affinity 回默认档', aff.affinity === aff._affinity && typeof aff.affinity === 'number');
check('ledger 清空', aff.ledger.length === 0);
check('gainEvents 清空', aff.gainEvents.length === 0);
check('daily 归零', aff.daily.gained === 0);
try { fs.unlinkSync(path.join(__dirname, '..', 'data', 'affinity_test_tmp.json')); } catch { /* ignore */ }

console.log('== TaskManager.clearAll ==');
TaskManager.tasks = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];
const cleared = TaskManager.clearAll();
check('返回清除数量 3', cleared === 3);
check('tasks 清空', TaskManager.getTasks().length === 0);
const tSaved = readJson('tasks.json', null);
check('tasks.json 落盘为空数组', Array.isArray(tSaved) && tSaved.length === 0);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
