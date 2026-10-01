import { describe, expect, it } from "vitest";
import type { Task } from "@/types";
import { isOverdue, isTodayTask, pickTodayTasks, sortTasks } from "../taskView";

/** Builds a Task with sensible defaults; override only what a test cares about. */
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? "t1",
    title: overrides.title ?? "test task",
    completed: overrides.completed ?? false,
    source: overrides.source ?? "manual",
    dueTime: overrides.dueTime ?? null,
    createdAt: overrides.createdAt ?? undefined,
    ...overrides,
  };
}

// Reference "now": 2024-06-15 12:00 local time. Built with local components so
// it stays stable regardless of the machine timezone.
const NOW = new Date(2024, 5, 15, 12, 0, 0);

describe("isOverdue", () => {
  it("returns false for a completed task even when its due time has passed", () => {
    const task = makeTask({ completed: true, dueTime: new Date(2024, 5, 1).toISOString() });
    expect(isOverdue(task, NOW)).toBe(false);
  });

  it("returns true for an unfinished task past its due time", () => {
    const task = makeTask({ dueTime: new Date(2024, 5, 1).toISOString() });
    expect(isOverdue(task, NOW)).toBe(true);
  });

  it("returns false when the due time is in the future", () => {
    const task = makeTask({ dueTime: new Date(2024, 5, 20).toISOString() });
    expect(isOverdue(task, NOW)).toBe(false);
  });

  it("returns false when there is no due time", () => {
    expect(isOverdue(makeTask({ dueTime: null }), NOW)).toBe(false);
    expect(isOverdue(makeTask({ dueTime: undefined }), NOW)).toBe(false);
    expect(isOverdue(makeTask({ dueTime: "" }), NOW)).toBe(false);
  });

  it("returns false when the due time is an invalid date string", () => {
    expect(isOverdue(makeTask({ dueTime: "not-a-date" }), NOW)).toBe(false);
  });
});

describe("isTodayTask", () => {
  it("returns true when the due time falls on the same local day", () => {
    const task = makeTask({ dueTime: new Date(2024, 5, 15, 9, 0).toISOString() });
    expect(isTodayTask(task, NOW)).toBe(true);
  });

  it("returns false when the due time is on a different day even if same month", () => {
    const task = makeTask({ dueTime: new Date(2024, 5, 16, 9, 0).toISOString() });
    expect(isTodayTask(task, NOW)).toBe(false);
  });

  it("falls back to createdAt when there is no due time (created today -> true)", () => {
    const task = makeTask({ dueTime: null, createdAt: new Date(2024, 5, 15, 8, 0).toISOString() });
    expect(isTodayTask(task, NOW)).toBe(true);
  });

  it("falls back to createdAt when there is no due time (created earlier -> false)", () => {
    const task = makeTask({ dueTime: null, createdAt: new Date(2024, 5, 10).toISOString() });
    expect(isTodayTask(task, NOW)).toBe(false);
  });

  it("returns false when both due time and createdAt are missing or invalid", () => {
    expect(isTodayTask(makeTask({ dueTime: null, createdAt: undefined }), NOW)).toBe(false);
    expect(isTodayTask(makeTask({ dueTime: "bad", createdAt: "bad" }), NOW)).toBe(false);
  });

  it("returns false when due time exists but is invalid and createdAt is not today", () => {
    const task = makeTask({ dueTime: "bad", createdAt: new Date(2024, 5, 10).toISOString() });
    expect(isTodayTask(task, NOW)).toBe(false);
  });
});

describe("pickTodayTasks", () => {
  it("keeps only today's tasks without mutating the input array", () => {
    const today = makeTask({ id: "today", dueTime: new Date(2024, 5, 15, 9).toISOString() });
    const yesterday = makeTask({ id: "old", dueTime: new Date(2024, 5, 14, 9).toISOString() });
    const input = [today, yesterday];

    const result = pickTodayTasks(input, NOW);

    expect(result.map((t) => t.id)).toEqual(["today"]);
    expect(input).toHaveLength(2); // input untouched
  });

  it("returns an empty array for an empty input", () => {
    expect(pickTodayTasks([], NOW)).toEqual([]);
  });
});

describe("sortTasks", () => {
  it("returns a new array and does not mutate the input", () => {
    const tasks = [makeTask({ id: "a", dueTime: new Date(2024, 5, 20).toISOString() })];
    const sorted = sortTasks(tasks, NOW);
    expect(sorted).not.toBe(tasks);
  });

  it("orders overdue first, then timed, then untimed, with completed last", () => {
    const overdue = makeTask({ id: "overdue", dueTime: new Date(2024, 5, 1).toISOString() });
    const timed = makeTask({ id: "timed", dueTime: new Date(2024, 5, 20).toISOString() });
    const untimed = makeTask({ id: "untimed", dueTime: null });
    const completed = makeTask({ id: "completed", completed: true, dueTime: new Date(2024, 5, 1).toISOString() });

    const sorted = sortTasks([completed, untimed, timed, overdue], NOW);
    expect(sorted.map((t) => t.id)).toEqual(["overdue", "timed", "untimed", "completed"]);
  });

  it("sorts two timed tasks by due time ascending", () => {
    const later = makeTask({ id: "later", dueTime: new Date(2024, 5, 25).toISOString() });
    const sooner = makeTask({ id: "sooner", dueTime: new Date(2024, 5, 20).toISOString() });
    const sorted = sortTasks([later, sooner], NOW);
    expect(sorted.map((t) => t.id)).toEqual(["sooner", "later"]);
  });

  it("keeps the relative order of same-priority tasks (stable)", () => {
    const first = makeTask({ id: "first", dueTime: null });
    const second = makeTask({ id: "second", dueTime: null });
    const sorted = sortTasks([first, second], NOW);
    expect(sorted.map((t) => t.id)).toEqual(["first", "second"]);
  });
});
