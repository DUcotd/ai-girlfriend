/**
 * TaskManager - 任务清单的持久化与管理（单例）
 *
 * 本次重构（任务清单系统重构）的改动：
 * 1. `addTask()` 入参改为**字段白名单**（TASK_WRITE_FIELDS），`id` / `createdAt` 永不被外部覆盖。
 *    此前 `...taskData` 展开在默认值**之后**，POST /tasks 的 body 传 `id` 就能顶掉主键、传
 *    `completed:true` 就能造出一个天生已完成的任务。
 * 2. 任务实体追加 `source`（manual|ai）与 `reminderState`（三类提醒的"已发"标记），
 *    老数据由 `_load()` 做**幂等归一化迁移**，只有真的缺字段时才写一次盘（避免每次启动无谓写盘）。
 * 3. 新增 `getReminderCandidates()` —— 提醒候选的唯一真源（overdue / custom / due 三类 + 去重 + 排序），
 *    `markReminded()` 入队成功后写去重标记，`getTodayTasks()` 与前端 lib/taskView.ts 同口径。
 * 4. 提醒窗口常量的唯一真源也在这里（DUE_SOON_MINUTES / CUSTOM_WINDOW_MINUTES /
 *    OVERDUE_GRACE_MS / OVERDUE_WINDOW），ProactiveEngine 从这里取，避免两处各写一份。
 */
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import { dataPath, readJson, writeJson } from '../utils/jsonStore.js';
import { parseDueTime, startOfLocalDay, toDate } from './taskTime.js';

const TASKS_FILE = 'tasks.json';

/** 分钟 → 毫秒 */
const MIN = 60 * 1000;

/**
 * 允许外部写入的任务字段白名单。
 * `id` / `createdAt` / `reminderState` **不在**其中 —— 它们要么由本类生成，
 * 要么由本类的 markReminded() 独家维护。
 */
export const TASK_WRITE_FIELDS = ['title', 'description', 'dueTime', 'reminderTime', 'completed', 'source'];

/** 提醒类型（任务维度去重的 key） */
export const REMINDER_KIND = {
    due: 'due',         // 到期前提醒
    custom: 'custom',   // 用户自设 reminderTime 命中
    overdue: 'overdue', // 已逾期
    dialog: 'dialog',   // 对话内提及（P1-2 防抖用，不是主动消息）
};

/** kind → reminderState 里的字段名 */
export const REMINDER_FIELD = {
    due: 'dueRemindedAt',
    custom: 'customRemindedAt',
    overdue: 'overdueRemindedAt',
    dialog: 'dialogMentionedAt',
};

/** 到期前多久算「快到了」 */
export const DUE_SOON_MINUTES = 15;
/** reminderTime 的命中窗口：(now - 15min, now + 15min] */
export const CUSTOM_WINDOW_MINUTES = 15;
/** dueTime 超过至少 1 分钟才算逾期，避免刚到点就报逾期 */
export const OVERDUE_GRACE_MS = 60 * 1000;
/** 逾期提醒的允许时段（当天分钟数，闭区间）——凌晨不骚扰 */
export const OVERDUE_WINDOW = { from: 7 * 60, to: 23 * 60 };

/** 候选排序权重：overdue > custom > due */
const KIND_PRIORITY = {
    [REMINDER_KIND.overdue]: 0,
    [REMINDER_KIND.custom]: 1,
    [REMINDER_KIND.due]: 2,
};

/** @returns {number|null} 任意时间值 → epoch 毫秒；非法返回 null */
function toEpoch(value) {
    const d = toDate(value);
    return d ? d.getTime() : null;
}

/**
 * 单条任务的幂等归一化（迁移用）。
 *
 * @param {object} raw - data/tasks.json 里的一条
 * @returns {{task: object, dirty: boolean}} dirty 表示本次是否真的改了字段
 */
function normalizeTask(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const task = { ...input };
    let dirty = false;

    // source：只认 'ai'，其余一律 'manual'（含缺失、null、乱值）
    if (task.source !== 'manual' && task.source !== 'ai') {
        task.source = 'manual';
        dirty = true;
    }
    if (typeof task.completed !== 'boolean') {
        task.completed = Boolean(task.completed);
        dirty = true;
    }

    const knownFields = Object.values(REMINDER_FIELD);
    const state = task.reminderState;
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
        task.reminderState = {};
        dirty = true;
    } else {
        const cleaned = {};
        for (const field of knownFields) {
            if (typeof state[field] === 'string' && state[field]) cleaned[field] = state[field];
        }
        const extraKeys = Object.keys(state).filter(k => !knownFields.includes(k));
        if (extraKeys.length > 0 || Object.keys(cleaned).length !== Object.keys(state).length) {
            dirty = true;
        }
        task.reminderState = cleaned;
    }

    return { task, dirty };
}

class TaskManager {
    constructor() {
        this.tasksPath = dataPath(TASKS_FILE);
        this.tasks = this._load();
    }

    /**
     * 载入并做幂等迁移。老数据没有 source / reminderState，这里补齐；
     * 只有真的有字段被补齐时才写盘一次（Q6）。
     */
    _load() {
        // readJson 对「文件不存在」与「存在但损坏」都返回 fallback；损坏时若直接以空列表
        // 继续，下一次写盘会用空数组覆盖原文件、任务全部丢失——先把损坏文件隔离留存
        const fileExisted = fs.existsSync(this.tasksPath);
        const raw = readJson(TASKS_FILE, null);
        if (fileExisted && !Array.isArray(raw)) {
            const quarantine = `${this.tasksPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
            try {
                fs.renameSync(this.tasksPath, quarantine);
                console.error(
                    `[TaskManager] tasks.json 已损坏且无法解析，已隔离留存到 ${quarantine}；本次以空任务列表启动。`
                );
            } catch (e) {
                console.error(
                    `[TaskManager] tasks.json 已损坏且隔离失败（${e.message}）；在手工修复该文件前，任何写盘都会覆盖原数据！`
                );
            }
        }
        const list = Array.isArray(raw) ? raw : [];

        let dirty = false;
        const tasks = list.map((item) => {
            const { task, dirty: changed } = normalizeTask(item);
            if (changed) dirty = true;
            return task;
        });

        this.tasks = tasks;
        if (dirty) {
            this.saveTasks();
            console.log(`[TaskManager] Migrated ${tasks.length} task(s) to the latest schema (source/reminderState)`);
        }
        return tasks;
    }

    saveTasks() {
        return writeJson(TASKS_FILE, this.tasks);
    }

    /**
     * 清空全部任务（「完全重置」语义）。
     * @returns {number} 被清除的任务数
     */
    clearAll() {
        const count = this.tasks.length;
        this.tasks = [];
        this.saveTasks();
        return count;
    }

    /**
     * 按白名单收敛入参。
     * @param {object} data - 外部入参（body / LLM 动作）
     * @returns {object} 只含 TASK_WRITE_FIELDS 里出现过的字段
     */
    _pickWritable(data = {}) {
        const source = data && typeof data === 'object' ? data : {};
        const picked = {};
        for (const field of TASK_WRITE_FIELDS) {
            if (source[field] === undefined) continue;
            picked[field] = source[field];
        }
        if (typeof picked.title === 'string') picked.title = picked.title.trim();
        // 时间字段统一归一化成 ISO 8601 落盘（前端 datetime-local 发来的是本地写法）；
        // 解析失败的保留原值，由路由层拒绝
        for (const field of ['dueTime', 'reminderTime']) {
            if (typeof picked[field] === 'string' && picked[field].trim()) {
                const parsed = parseDueTime(picked[field]);
                if (parsed.ok) picked[field] = parsed.iso;
            }
        }
        if (typeof picked.source === 'string') {
            // Q5：source 只认 'ai'，其余一律 'manual'
            picked.source = picked.source === 'ai' ? 'ai' : 'manual';
        }
        if (picked.completed !== undefined) picked.completed = Boolean(picked.completed);
        return picked;
    }

    /**
     * 新增任务。
     *
     * 字段优先级：**白名单入参** → id / createdAt / reminderState 由本类强制覆盖。
     * AI 建单（source='ai'）永远是待办 —— 「帮我记一下开会」语义上不可能是一条已完成的事，
     * 也顺手挡掉外部注入 completed 的情况。
     *
     * @param {object} taskData
     * @returns {object} 新建的任务实体
     */
    addTask(taskData = {}) {
        const picked = this._pickWritable(taskData);
        const isAi = picked.source === 'ai';

        const newTask = {
            ...picked,
            id: uuidv4(),
            title: typeof picked.title === 'string' ? picked.title : '',
            description: typeof picked.description === 'string' ? picked.description : '',
            dueTime: picked.dueTime ?? null,
            reminderTime: picked.reminderTime ?? null,
            completed: isAi ? false : picked.completed === true,
            source: picked.source === 'ai' ? 'ai' : 'manual',
            createdAt: new Date().toISOString(),
            reminderState: {},
        };

        this.tasks.push(newTask);
        this.saveTasks();
        console.log(
            `[TaskManager] Task added: ${newTask.id.slice(0, 8)} "${newTask.title || '(untitled)'}" ` +
            `(source=${newTask.source}, due=${newTask.dueTime || 'none'})`
        );
        return newTask;
    }

    /**
     * 局部更新任务。id / createdAt 不在白名单里，永远改不掉。
     *
     * @returns {object|null} null 表示没找到
     */
    updateTask(id, updates = {}) {
        const index = this.tasks.findIndex(t => t.id === id);
        if (index === -1) return null;

        const picked = this._pickWritable(updates);
        // 改期 = 这轮提醒周期重新开始：清掉「已提醒」标记，
        // 否则新到期日的 due/overdue 提醒会被旧标记永久抑制
        const rescheduled =
            (picked.dueTime !== undefined && picked.dueTime !== this.tasks[index].dueTime) ||
            (picked.reminderTime !== undefined && picked.reminderTime !== this.tasks[index].reminderTime);
        const updated = { ...this.tasks[index], ...picked };
        if (rescheduled) updated.reminderState = {};
        this.tasks[index] = updated;
        this.saveTasks();
        console.log(`[TaskManager] Task updated: ${String(id).slice(0, 8)} (${Object.keys(picked).join(', ') || 'no writable field'})`);
        return updated;
    }

    deleteTask(id) {
        const index = this.tasks.findIndex(t => t.id === id);
        if (index === -1) return null;
        const deletedTask = this.tasks.splice(index, 1);
        this.saveTasks();
        console.log(`[TaskManager] Task deleted: ${String(id).slice(0, 8)}`);
        return deletedTask[0];
    }

    getTasks() {
        return this.tasks;
    }

    getPendingTasks() {
        return this.tasks.filter(t => !t.completed);
    }

    /** 保留给 `GET /tasks/due`（引擎早已不再依赖它） */
    getDueSoonTasks(minutes = 15) {
        const now = Date.now();
        const future = now + minutes * MIN;

        return this.tasks.filter(t => {
            if (t.completed || !t.dueTime) return false;
            const due = toEpoch(t.dueTime);
            return due !== null && due > now && due <= future;
        });
    }

    /**
     * 提醒候选 —— 「该提醒谁」的唯一真源。
     *
     * 三类各有一个独立的去重标记（同一任务的不同类提醒互不干扰，Q4），
     * 命中过一次且已入队的不会再出现在候选里。
     *
     * @param {Date} [now] - 基准时刻（不要在调用方缓存 new Date()）
     * @returns {Array<{task: object, kind: 'overdue'|'custom'|'due'}>} 已按 overdue>custom>due 排序
     */
    getReminderCandidates(now = new Date()) {
        const ref = now instanceof Date ? now : new Date(now);
        const nowMs = ref.getTime();
        const candidates = [];

        for (const task of this.tasks) {
            if (task.completed) continue;
            const state = task.reminderState || {};
            const dueMs = toEpoch(task.dueTime);
            const customMs = toEpoch(task.reminderTime);

            // ③ 已逾期：容忍 OVERDUE_GRACE_MS 的宽限，避免刚到点就报逾期
            if (dueMs !== null && !state[REMINDER_FIELD.overdue] && dueMs <= nowMs - OVERDUE_GRACE_MS) {
                candidates.push({ task, kind: REMINDER_KIND.overdue, at: dueMs });
            }
            // ② 自定义提醒时刻命中窗口 (now - 15min, now + 15min]
            if (customMs !== null && !state[REMINDER_FIELD.custom]
                && customMs > nowMs - CUSTOM_WINDOW_MINUTES * MIN
                && customMs <= nowMs + CUSTOM_WINDOW_MINUTES * MIN) {
                candidates.push({ task, kind: REMINDER_KIND.custom, at: customMs });
            }
            // ① 到期前 15 分钟内
            if (dueMs !== null && !state[REMINDER_FIELD.due]
                && dueMs > nowMs && dueMs <= nowMs + DUE_SOON_MINUTES * MIN) {
                candidates.push({ task, kind: REMINDER_KIND.due, at: dueMs });
            }
        }

        candidates.sort((a, b) => {
            const byKind = KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind];
            if (byKind !== 0) return byKind;
            return a.at - b.at;   // 同类按时间早的优先
        });

        return candidates.map(({ task, kind }) => ({ task, kind }));
    }

    /**
     * 写入"已提醒"标记。**只在通知真的入队成功后调用**，否则失败的那条会被永久跳过。
     *
     * @param {string} id - 任务 id
     * @param {'due'|'custom'|'overdue'|'dialog'} kind
     * @param {string|number|Date} [at] - 提醒时刻，默认当下
     * @returns {object|null} 更新后的任务；参数非法或找不到任务时返回 null
     */
    markReminded(id, kind = REMINDER_KIND.due, at = new Date()) {
        const field = REMINDER_FIELD[kind];
        if (!field) {
            console.warn(`[TaskManager] Unknown reminder kind: ${kind}`);
            return null;
        }
        const stamp = toDate(at);
        if (!stamp) {
            console.warn(`[TaskManager] Bad reminder timestamp: ${at}`);
            return null;
        }
        const index = this.tasks.findIndex(t => t.id === id);
        if (index === -1) {
            console.warn(`[TaskManager] Task not found for reminder mark: ${id}`);
            return null;
        }

        const updated = {
            ...this.tasks[index],
            reminderState: { ...(this.tasks[index].reminderState || {}), [field]: stamp.toISOString() },
        };
        this.tasks[index] = updated;
        this.saveTasks();
        console.log(`[TaskManager] Reminder marked: kind=${kind} task=${String(id).slice(0, 8)}`);
        return updated;
    }

    /**
     * 今日任务（与前端 lib/taskView.ts 的 pickTodayTasks 同口径）：
     * dueTime 落在今天，或没有 dueTime 且创建于今天。
     *
     * @param {Date} [now]
     * @returns {Array<object>}
     */
    getTodayTasks(now = new Date()) {
        const ref = now instanceof Date ? now : new Date(now);
        const dayStart = startOfLocalDay(ref).getTime();
        const dayEnd = dayStart + 86_400_000;   // [start, end)

        return this.tasks.filter((task) => {
            const dueMs = toEpoch(task.dueTime);
            if (dueMs !== null) return dueMs >= dayStart && dueMs < dayEnd;
            const createdMs = toEpoch(task.createdAt);
            return createdMs !== null && createdMs >= dayStart && createdMs < dayEnd;
        });
    }

    /**
     * 任务摘要。today 是 P1-6 追加的纯字段，老调用方读 total/completed/pending 不受影响。
     *
     * @param {Date} [now]
     * @returns {{total:number, completed:number, pending:number, today:{total:number, completed:number}}}
     */
    getSummary(now = new Date()) {
        const total = this.tasks.length;
        const completed = this.tasks.filter(t => t.completed).length;
        const todayTasks = this.getTodayTasks(now);
        const todayCompleted = todayTasks.filter(t => t.completed).length;

        return {
            total,
            completed,
            pending: total - completed,
            today: { total: todayTasks.length, completed: todayCompleted },
        };
    }
}

export default new TaskManager();
