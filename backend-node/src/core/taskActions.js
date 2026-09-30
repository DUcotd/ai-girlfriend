/**
 * task_action 执行器 —— 把 LLM 在 <metadata> 里回传的任务意图落成真实写操作。
 *
 * 关键设计：
 * 1. 意图来自**本次对话已有的 LLM 返回**，这里只做纯本地执行，绝不新增第二次网络往返（硬约束 C2）。
 * 2. `normalizeTaskAction()` 内部统一 toArray()：对象 → [对象]，数组 → 过滤后的对象数组。
 *    P0 只取第一条；将来放开「一次说多件事」（P1-4）只需在 executeTaskAction 里改为遍历。
 * 3. `ENABLED_ACTIONS` 是动作白名单，P0 **只开 add**（Q8）。complete / delete 命中时不执行，
 *    回 `reason:"unknown_action"`；P1 放开只需往这个 Set 里加两个字符串。
 * 4. 时间解析失败不是错误（D4）：任务照样建，dueTime 置 null，回 `reason:"bad_due_time"`。
 */
import TaskManager from './TaskManager.js';
import { parseDueTime } from './taskTime.js';

/**
 * 当前允许执行的动作。'none' 是缺省值，永远存在。
 * ⚠️ P0 只开 add —— 改动这一个 Set 即可演进，不要把判断散落到别处。
 */
export const ENABLED_ACTIONS = new Set(['add', 'none']);

/** 契约里的合法 action 取值（用于 unknown_action 时决定回什么） */
const KNOWN_ACTIONS = new Set(['add', 'complete', 'delete', 'none']);

/** @returns {string|null} 归一化后的字符串，非字符串或空白返回 null */
function cleanString(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
}

/**
 * 把 LLM 给的 task_action 归一化成动作数组。
 *
 * 容错：非对象、数组里的脏元素一律丢掉；action 转小写去空格；缺省 = 'none'。
 *
 * @param {object|Array|null|undefined} raw
 * @returns {Array<{action:string, title:string, dueTime:*, taskId:?string}>} 一定返回数组（可能为空）
 */
export function normalizeTaskAction(raw) {
    if (!raw) return [];
    if (typeof raw !== 'object') return [];

    const list = Array.isArray(raw) ? raw : [raw];
    return list
        .filter(item => item && typeof item === 'object' && !Array.isArray(item))
        .map((item) => {
            const action = cleanString(item.action)?.toLowerCase() ?? 'none';
            const taskId = cleanString(item.taskId);
            const result = {
                action: KNOWN_ACTIONS.has(action) ? action : 'none',
                title: cleanString(item.title) || '',
            };
            if (taskId) result.taskId = taskId;
            // dueTime 保留原值交给 parseDueTime 判定，null/'' 视为「没给时间」
            if (item.dueTime !== undefined && item.dueTime !== null && item.dueTime !== '') {
                result.dueTime = item.dueTime;
            }
            return result;
        });
}

/**
 * 按 id 精确匹配或按标题模糊匹配任务（P1 的 complete/delete 用）。
 *
 * 安全优先（D8）：命中多条一律判 ambiguous，由调用方拒绝执行，绝不猜一个删。
 *
 * @param {{taskId?: string, title?: string}} criteria
 * @returns {{ok:true, task:object}|{ok:false, reason:'not_found'|'ambiguous'}}
 */
export function matchTask(criteria = {}, _options = {}) {
    const { taskId, title } = criteria;

    // 短 id 匹配：注入给模型的是 uuid 前 8 位，模型也可能只回前 4 位
    if (typeof taskId === 'string' && taskId.trim().length >= 4) {
        const prefix = taskId.trim();
        const hits = TaskManager.getTasks().filter(t => typeof t.id === 'string' && t.id.startsWith(prefix));
        if (hits.length === 1) return { ok: true, task: hits[0] };
        if (hits.length > 1) return { ok: false, reason: 'ambiguous' };
        // 0 命中时继续用 title 兜底
    }

    const name = cleanString(title);
    if (!name) return { ok: false, reason: 'not_found' };

    const candidates = TaskManager.getTasks().filter((t) => {
        const taskTitle = typeof t.title === 'string' ? t.title.trim() : '';
        if (!taskTitle) return false;
        return taskTitle === name || taskTitle.includes(name) || name.includes(taskTitle);
    });
    if (candidates.length === 1) return { ok: true, task: candidates[0] };
    if (candidates.length === 0) return { ok: false, reason: 'not_found' };
    return { ok: false, reason: 'ambiguous' };
}

/**
 * 执行新增任务（P0 唯一开放的动作）。
 *
 * @returns {{action:string, ok:boolean, task?:object, reason?:string}}
 */
function runAdd(action) {
    if (!action.title) {
        console.log('[taskActions] add skipped: missing title');
        return { action: 'add', ok: false, reason: 'missing_title' };
    }

    // 预留插入点（P2-3）：同名未完成任务检测，命中时回 reason:'duplicate'

    let dueTime = null;
    let badDueTime = false;
    if (action.dueTime !== undefined) {
        const parsed = parseDueTime(action.dueTime);
        if (parsed.ok) {
            dueTime = parsed.iso;
        } else {
            // D4：时间没听懂也要把事记下来
            badDueTime = true;
            console.warn(`[taskActions] Unparsable dueTime "${action.dueTime}" (${parsed.error}), task kept without due time`);
        }
    }

    const task = TaskManager.addTask({ title: action.title, dueTime, source: 'ai' });
    return badDueTime
        ? { action: 'add', ok: true, task, reason: 'bad_due_time' }
        : { action: 'add', ok: true, task };
}

/**
 * 执行 LLM 回传的 task_action。
 *
 * @param {object|Array|null} raw - metadata.task_action 原值
 * @param {{now?: Date}} [options]
 * @returns {{action:string, ok:boolean, task?:object, reason?:string}|null}
 *          null 表示「无事发生」——老模型不输出 task_action、或 action 为 none 时，
 *          行为与重构前完全一致（调用方回 taskResult: null）。
 */
export function executeTaskAction(raw, options = {}) {
    const actions = normalizeTaskAction(raw);
    if (actions.length === 0) return null;

    // P0 单条：取第一条。放开多条时改为逐条执行并聚合即可（P1-4）。
    const action = actions[0];
    if (action.action === 'none') return null;

    if (!ENABLED_ACTIONS.has(action.action)) {
        console.log(`[taskActions] Action "${action.action}" is disabled in the current phase, skipped`);
        return { action: 'none', ok: false, reason: 'unknown_action' };
    }

    try {
        return runAdd(action);
    } catch (e) {
        console.error(`[taskActions] Execute failed: ${e.message}`);
        return { action: 'add', ok: false, reason: 'missing_title' };
    }
}
