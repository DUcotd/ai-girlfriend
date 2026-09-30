"use client";

import { Calendar, CheckCircle2, Circle, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { isOverdue } from "@/lib/taskView";
import type { Task } from "@/types";

interface TaskItemProps {
  task: Task;
  now: Date;
  onToggle: (id: string, completed: boolean) => void;
  onRequestDelete: (id: string) => void;
}

/** Formats a task due time in the user's local timezone. */
function formatTaskDue(dueTime: string | null | undefined, now: Date): string {
  if (!dueTime) return "无时间";

  const due = new Date(dueTime);
  if (!Number.isFinite(due.getTime())) return "无时间";

  const time = `${String(due.getHours()).padStart(2, "0")}:${String(
    due.getMinutes()
  ).padStart(2, "0")}`;
  const sameDay = (left: Date, right: Date): boolean =>
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate();

  if (sameDay(due, now)) return `今日 ${time}`;

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (sameDay(due, tomorrow)) return `明天 ${time}`;

  const date = `${due.getMonth() + 1}月${due.getDate()}日`;
  return due.getFullYear() === now.getFullYear()
    ? `${date} ${time}`
    : `${due.getFullYear()}年${date} ${time}`;
}

/** A single task card with completion, timing, source, and deletion controls. */
export default function TaskItem({
  task,
  now,
  onToggle,
  onRequestDelete,
}: TaskItemProps) {
  const overdue = isOverdue(task, now);

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-2xl border-2 p-3 transition-all duration-[var(--duration-normal)]",
        task.completed
          ? "border-transparent bg-surface-2/50 opacity-60"
          : "border-line-subtle bg-surface-1 shadow-sm hover:border-accent-1/30"
      )}
    >
      <button
        type="button"
        onClick={() => onToggle(task.id, !task.completed)}
        className={cn(
          "shrink-0 rounded-full transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-1/50",
          task.completed
            ? "text-status-success"
            : "text-accent-1/50 hover:text-accent-1"
        )}
        aria-label={task.completed ? `将“${task.title}”标记为未完成` : `完成“${task.title}”`}
        aria-pressed={task.completed}
      >
        {task.completed ? <CheckCircle2 size={24} /> : <Circle size={24} />}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <p
            className={cn(
              "truncate text-sm font-medium",
              task.completed
                ? "text-content-muted line-through"
                : "text-content-primary"
            )}
          >
            {task.title}
          </p>
          {task.source === "ai" && (
            <span
              className="shrink-0 text-xs"
              title="小爱帮你记的"
              aria-label="小爱帮你记的"
            >
              ✨
            </span>
          )}
        </div>
        <p
          className={cn(
            "mt-0.5 flex min-h-4 items-center gap-1 text-[10px]",
            overdue ? "text-status-danger" : "text-content-muted"
          )}
        >
          <Calendar size={10} className="shrink-0" />
          <span>{formatTaskDue(task.dueTime, now)}</span>
          {overdue && (
            <span className="rounded-full bg-status-danger/10 px-1.5 py-0.5 font-semibold text-status-danger">
              已逾期
            </span>
          )}
        </p>
      </div>

      <button
        type="button"
        onClick={() => onRequestDelete(task.id)}
        className="shrink-0 rounded-full p-1 text-content-muted/50 transition-colors duration-[var(--duration-fast)] hover:text-status-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-status-danger/40"
        aria-label={`删除“${task.title}”`}
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}
