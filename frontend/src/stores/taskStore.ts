import { create } from "zustand";
import { api } from "@/lib/api";
import type { Task, TaskActionResult } from "@/types";

export interface AddTaskPayload {
  title: string;
  dueTime?: string;
}

interface TaskState {
  tasks: Task[];
  loading: boolean;
  fetchTasks: () => Promise<void>;
  addTask: (payload: AddTaskPayload) => Promise<Task>;
  toggleTask: (id: string, completed: boolean) => Promise<Task>;
  removeTask: (id: string) => Promise<void>;
  applyTaskResult: (result: TaskActionResult | null | undefined) => void;
}

/** Inserts a new task or replaces the matching task without disturbing list order. */
function upsertTask(tasks: Task[], nextTask: Task): Task[] {
  const existingIndex = tasks.findIndex((task) => task.id === nextTask.id);
  if (existingIndex < 0) return [...tasks, nextTask];

  return tasks.map((task) => (task.id === nextTask.id ? nextTask : task));
}

/**
 * In-memory task source of truth shared by chat results and the task dialog.
 * Persistence is intentionally owned by the backend; opening the dialog refreshes it.
 */
export const useTaskStore = create<TaskState>()((set) => ({
  tasks: [],
  loading: false,

  fetchTasks: () => {
    set({ loading: true });
    return api
      .getTasks()
      .then((tasks) => {
        set({ tasks, loading: false });
      })
      .catch((error: unknown) => {
        set({ loading: false });
        throw error;
      });
  },

  addTask: (payload) => {
    const title = payload.title.trim();
    if (!title) return Promise.reject(new Error("任务标题不能为空"));

    return api
      .addTask({
        title,
        dueTime: payload.dueTime || undefined,
      })
      .then((task) => {
        set((state) => ({ tasks: upsertTask(state.tasks, task) }));
        return task;
      });
  },

  toggleTask: (id, completed) =>
    api.updateTask(id, { completed }).then((task) => {
      set((state) => ({ tasks: upsertTask(state.tasks, task) }));
      return task;
    }),

  removeTask: (id) =>
    api.deleteTask(id).then(() => {
      set((state) => ({
        tasks: state.tasks.filter((task) => task.id !== id),
      }));
    }),

  applyTaskResult: (result) => {
    if (!result?.ok || !result.task) return;
    const task = result.task;

    if (result.action === "delete") {
      set((state) => ({
        tasks: state.tasks.filter((item) => item.id !== task.id),
      }));
      return;
    }

    if (result.action === "add" || result.action === "complete") {
      set((state) => ({ tasks: upsertTask(state.tasks, task) }));
    }
  },
}));
