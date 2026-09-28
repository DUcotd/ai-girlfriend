/**
 * 任务路由：/tasks CRUD + 摘要 + 到期查询
 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { fail } from '../middleware/validate.js';
import TaskManager from '../core/TaskManager.js';

const router = Router();

router.get('/tasks', (req, res) => {
    res.json(TaskManager.getTasks());
});

router.post('/tasks', (req, res) => {
    if (fail(res, !req.body?.title?.trim(), 'title is required')) return;
    const task = TaskManager.addTask({ ...req.body, title: req.body.title.trim() });
    res.json(task);
});

router.put('/tasks/:id', (req, res) => {
    const task = TaskManager.updateTask(req.params.id, req.body);
    task ? res.json(task) : res.status(404).json({ detail: "Task not found" });
});

router.delete('/tasks/:id', (req, res) => {
    const task = TaskManager.deleteTask(req.params.id);
    task ? res.json(task) : res.status(404).json({ detail: "Task not found" });
});

router.get('/tasks/summary', (req, res) => {
    res.json(TaskManager.getSummary());
});

router.get('/tasks/due', (req, res) => {
    res.json(TaskManager.getDueSoonTasks());
});

export default router;
