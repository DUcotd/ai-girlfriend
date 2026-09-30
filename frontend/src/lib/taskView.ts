import type { Task } from "@/types";

/** Converts an ISO-like task timestamp to epoch milliseconds when valid. */
function parseTaskTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** Returns whether two dates fall on the same local calendar day. */
function isSameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/** Returns true when an unfinished task has passed its due time. */
export function isOverdue(task: Task, now: Date): boolean {
  if (task.completed) return false;
  const dueTimestamp = parseTaskTime(task.dueTime);
  return dueTimestamp !== null && dueTimestamp < now.getTime();
}

/**
 * Returns true for tasks due today, or tasks created today without a due time.
 * All comparisons use the browser's local calendar day.
 */
export function isTodayTask(task: Task, now: Date): boolean {
  if (task.dueTime) {
    const dueTimestamp = parseTaskTime(task.dueTime);
    return dueTimestamp !== null && isSameLocalDay(new Date(dueTimestamp), now);
  }

  const createdTimestamp = parseTaskTime(task.createdAt);
  return (
    createdTimestamp !== null && isSameLocalDay(new Date(createdTimestamp), now)
  );
}

/** Selects tasks belonging to the current local day without mutating the input. */
export function pickTodayTasks(tasks: readonly Task[], now: Date): Task[] {
  return tasks.filter((task) => isTodayTask(task, now));
}

/**
 * Sorts unfinished tasks as overdue, timed, then untimed, with completed tasks last.
 * Tasks with the same priority retain their existing relative order.
 */
export function sortTasks(tasks: readonly Task[], now: Date): Task[] {
  const priority = (task: Task): number => {
    if (task.completed) return 3;
    if (isOverdue(task, now)) return 0;
    if (parseTaskTime(task.dueTime) !== null) return 1;
    return 2;
  };

  return [...tasks].sort((left, right) => {
    const priorityDifference = priority(left) - priority(right);
    if (priorityDifference !== 0) return priorityDifference;

    const leftDue = parseTaskTime(left.dueTime);
    const rightDue = parseTaskTime(right.dueTime);
    if (leftDue !== null && rightDue !== null) return leftDue - rightDue;
    return 0;
  });
}
