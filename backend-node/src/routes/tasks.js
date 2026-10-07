/**
 * 任务路由：/tasks CRUD + 摘要 + 到期查询
 */
import { Router } from 'express';
import { fail, failWith } from '../middleware/validate.js';
import { ERROR_CODES } from '../utils/errorCodes.js';
import TaskManager from '../core/TaskManager.js';
import { parseDueTime } from '../core/taskTime.js';
import { config } from '../config.js';

const router = Router();

router.get('/tasks', (req, res) => {
    res.json(TaskManager.getTasks());
});

/** title 的统一入参校验：非字符串会在这之前抛 TypeError 落成 500，必须先拦下 */
function badTitle(title) {
    return typeof title !== 'string' || title.trim() === '';
}

/**
 * 自由文本长度守卫（审计 HTTP-18）：超限直接 400 并给出实际上限，
 * 而不是「收下了但每轮偷偷截断」—— 那会让用户看到的与模型看到的对不上。
 * @returns {string|null} 错误信息；合法返回 null
 */
function tooLongError(body, field, limit) {
    const value = body?.[field];
    if (typeof value !== 'string' || value.length <= limit) return null;
    return `${field} 最长 ${limit} 个字符（收到 ${value.length}）`;
}

/** dueTime/reminderTime 给了就必须能解析成合法日期（TaskManager 只归一化，不拒绝） */
function badTimeField(body, field) {
    const value = body?.[field];
    return value !== undefined && value !== null
        && (typeof value !== 'string' || !parseDueTime(value).ok);
}

router.post('/tasks', (req, res) => {
    if (fail(res, badTitle(req.body?.title), 'title is required and must be a non-empty string')) return;
    if (fail(res, badTimeField(req.body, 'dueTime') || badTimeField(req.body, 'reminderTime'),
        'dueTime/reminderTime is not a valid date')) return;
    const tooLong = tooLongError(req.body, 'title', config.textLimits.taskTitle)
        || tooLongError(req.body, 'description', config.textLimits.taskDescription);
    if (fail(res, !!tooLong, tooLong)) return;
    const task = TaskManager.addTask({ ...req.body, title: req.body.title.trim() });
    res.json(task);
});

router.put('/tasks/:id', (req, res) => {
    // POST 侧拒空标题，PUT 侧同样要拒：否则 PUT {"title":""} 会把任务标题清空
    if (fail(res, req.body?.title !== undefined && badTitle(req.body.title),
        'title must be a non-empty string')) return;
    if (fail(res, badTimeField(req.body, 'dueTime') || badTimeField(req.body, 'reminderTime'),
        'dueTime/reminderTime is not a valid date')) return;
    const tooLong = tooLongError(req.body, 'title', config.textLimits.taskTitle)
        || tooLongError(req.body, 'description', config.textLimits.taskDescription);
    if (fail(res, !!tooLong, tooLong)) return;
    const task = TaskManager.updateTask(req.params.id, req.body);
    task ? res.json(task) : failWith(res, 404, "Task not found", ERROR_CODES.TASK_NOT_FOUND);
});

router.delete('/tasks/:id', (req, res) => {
    const task = TaskManager.deleteTask(req.params.id);
    task ? res.json(task) : failWith(res, 404, "Task not found", ERROR_CODES.TASK_NOT_FOUND);
});

router.get('/tasks/summary', (req, res) => {
    res.json(TaskManager.getSummary());
});

router.get('/tasks/due', (req, res) => {
    res.json(TaskManager.getDueSoonTasks());
});

export default router;
