/**
 * 任务相关的 prompt 片段。
 *
 * 三段注入文本各司其职：
 *   buildTaskContextText()       —— 让模型**知道**用户有什么待办（含短 id，便于精确引用）
 *   buildTaskActionInstruction() —— 让模型**知道何时该建单**（正向清单 + 反向禁止清单）
 *   buildTaskNudgeText()         —— 让模型在对的话题里**顺口提一句**（P1-2，软提醒）
 *
 * 全部是纯函数：不读写文件、不 new Date() 缓存（调用方传入 now）、不 import TaskManager，
 * 便于单独验证，也方便 prompt 文案集中维护。
 */
import { formatTaskDue, toDate } from '../taskTime.js';

/** 注入给 LLM 的上下文最多几条（多了既费 token 又降低命中率） */
const MAX_CONTEXT_TASKS = 5;

/** 「多久之内到期」在上下文里要单独标出来（毫秒） */
const SOON_WINDOW_MS = 60 * 60 * 1000;

/** 软提醒（对话内提及）最多挑几条 */
const MAX_NUDGE_TASKS = 2;

/** @returns {number|null} */
function toEpoch(value) {
    const d = toDate(value);
    return d ? d.getTime() : null;
}

/** @returns {string} uuid 前 8 位（前后端约定的任务短 id） */
function shortId(id) {
    return typeof id === 'string' ? id.slice(0, 8) : '';
}

/**
 * 列表排序：逾期 → 有到期时间（早的先）→ 无到期时间 → 已完成（沉底）。
 * 与前端 lib/taskView.ts 的 sortTasks 同口径，保证「注入给模型看到的第一条」
 * 就是用户在界面上看到的第一条。
 *
 * @returns {Array<{task:object, dueMs:number|null}>}
 */
function decorateAndSort(tasks, nowMs) {
    const items = (Array.isArray(tasks) ? tasks : [])
        .filter(t => t && typeof t === 'object')
        .map(task => ({ task, dueMs: toEpoch(task.dueTime) }));

    const weight = ({ task, dueMs }) => {
        if (task.completed) return 3;
        if (dueMs === null) return 2;
        if (dueMs <= nowMs) return 0;   // 已逾期
        return 1;
    };

    return items.sort((a, b) => {
        const wa = weight(a);
        const wb = weight(b);
        if (wa !== wb) return wa - wb;
        if (wa === 1) return a.dueMs - b.dueMs;             // 有到期时间：升序
        if (wa === 0) return a.dueMs - b.dueMs;             // 逾期：越早逾期越靠前
        return String(a.task.createdAt || '').localeCompare(String(b.task.createdAt || ''));
    });
}

/**
 * 构建注入给 LLM 的待办上下文。
 *
 * 格式：`- [短id] 标题（今日 18:00 / 10月1日 15:00 / 无时间）`
 * 并对「已逾期」「1 小时内到期」单独打标记，让模型一眼看出优先级。
 *
 * @param {Array<object>} tasks - 任务列表（通常传 TaskManager.getPendingTasks()）
 * @param {Date} [now]
 * @returns {string}
 */
export function buildTaskContextText(tasks = [], now = new Date()) {
    const list = Array.isArray(tasks) ? tasks : [];
    if (list.length === 0) return '用户当前没有待办任务。';

    const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
    const sorted = decorateAndSort(list, nowMs);
    const picked = sorted.slice(0, MAX_CONTEXT_TASKS);

    const lines = picked.map(({ task, dueMs }) => {
        let line = `- [${shortId(task.id)}] ${task.title || '(未命名)'}（${formatTaskDue(task.dueTime, now)}）`;
        if (!task.completed && dueMs !== null) {
            if (dueMs <= nowMs) line += ' ⚠️已逾期';
            else if (dueMs <= nowMs + SOON_WINDOW_MS) line += ' ⏰1小时内到期';
        }
        return line;
    });

    const head = `用户的待办任务共 ${list.length} 条，下面列出最需要关注的 ${picked.length} 条：[短id] 用于在 task_action 里精确引用某条任务`;
    // 围栏（PROMPT-06）：任务标题是用户/模型写的自由文本，属于引述素材
    return `<task_data>\n${head}\n${lines.join('\n')}\n</task_data>`;
}

/** 挑出值得在对话里顺口提一句的任务（逾期 / 1 小时内到期 / 今日到期），最多 2 条 */
export function pickNudgeTasks(tasks = [], now = new Date()) {
    const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
    return decorateAndSort(tasks, nowMs)
        .filter(({ task, dueMs }) => {
            if (task.completed || dueMs === null) return false;
            return dueMs <= nowMs || dueMs <= nowMs + SOON_WINDOW_MS;
        })
        .slice(0, MAX_NUDGE_TASKS)
        .map(({ task }) => task);
}

/**
 * 对话内软提醒指令（P1-2）。没有值得提的任务时返回空串 —— 空串意味着不注入，
 * 不给模型增加无谓约束。
 *
 * @param {Array<object>} tasks
 * @param {Date} [now]
 * @returns {string}
 */
export function buildTaskNudgeText(tasks = [], now = new Date()) {
    const picked = pickNudgeTasks(tasks, now);
    if (picked.length === 0) return '';

    const lines = picked.map(task => `     · ${task.title}（${formatTaskDue(task.dueTime, now)}）`);
    return [
        '5. **Soft Nudge (optional)**:',
        '   - 下面几条待办已经逾期或即将到期：',
        ...lines,
        '   - 只有在和当前话题自然相关时才顺口提一句像"对了，你那个开会快到点了哦"这样的话。',
        '   - 不要生硬播报、不要逐条列举、不要道歉、不要追问细节；话题无关就完全不提。',
    ].join('\n');
}

/**
 * `[Response Instructions]` 第 4 条：task_action 规则。
 *
 * 正反清单同样是硬约束：只有正向清单时，模型会把「我今天开了个会」也当成布置任务，
 * 用户随口感叹一句就凭空多出一条待办——这正是要消灭的痛点 1 的反面。
 *
 * @returns {string}
 */
export function buildTaskActionInstruction() {
    // 从 ~1000 字符压到 ~350（审计 PROMPT-07）：这块此前比整份人物小传还长，
    // 且是英文——它是每轮固定开销里最大的一块，压缩零能力损失。
    return [
        '4. **task_action（可选，写在同一个 <metadata> 里，不要新开标签）**：',
        '   - 他让你**记下 / 提醒 / 安排**某事时给 {"action":"add","title":"…","dueTime":"ISO时间或null"}；否则 {"action":"none"}。',
        '   - title 用名词短语，别带"提醒我"（写"开会"，不写"提醒我开会"）。',
        '   - dueTime 必须是绝对时间（按【当前时间】换算，如 "2026-10-01T15:00:00+08:00"），**不要**写"明天""周五"这类相对词；没给时间就填 null。',
        '   - 引用清单里的某条任务时可带 "taskId"（对应 [短id]）。',
        '   - 该用 add：「明天下午3点提醒我开会」「帮我记一下周五交周报」「别忘了买牛奶」。',
        '   - 必须用 none：陈述过去（「我今天开了个会」）、笼统感叹（「任务好多啊」）、'
        + '回提旧提醒（「你上次提醒我的事」）、询问安排（「我明天有什么安排」）、你自己的提议，'
        + '以及他没让你记的一切内容。',
    ].join('\n');
}
