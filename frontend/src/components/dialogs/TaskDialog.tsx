"use client";

import { useEffect, useState } from "react";
import { ClipboardList, Plus } from "lucide-react";
import { pickTodayTasks, sortTasks } from "@/lib/taskView";
import { useTaskStore } from "@/stores/taskStore";
import { toast } from "@/stores/uiStore";
import Button from "../ui/Button";
import ConfirmDialog from "../ui/ConfirmDialog";
import Dialog from "../ui/Dialog";
import Input from "../ui/Input";
import ProgressBar from "../ui/ProgressBar";
import TaskItem from "./TaskItem";

interface TaskDialogProps {
  onClose: () => void;
}

const CLOCK_REFRESH_MS = 60_000;

/** Task list dialog backed by the shared in-memory task store. */
export default function TaskDialog({ onClose }: TaskDialogProps) {
  const tasks = useTaskStore((state) => state.tasks);
  const loading = useTaskStore((state) => state.loading);
  const fetchTasks = useTaskStore((state) => state.fetchTasks);
  const addTask = useTaskStore((state) => state.addTask);
  const toggleTask = useTaskStore((state) => state.toggleTask);
  const removeTask = useTaskStore((state) => state.removeTask);

  const [newTitle, setNewTitle] = useState("");
  const [newDue, setNewDue] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(0);

  useEffect(() => {
    void fetchTasks().catch((error: unknown) => {
      console.error("Failed to fetch tasks", error);
      // 拉取失败必须有反馈：空列表与「真的没有任务」不可区分，会误导用户任务全没了
      toast("任务加载失败，请检查后端连接", "error");
    });
  }, [fetchTasks]);

  useEffect(() => {
    let cancelled = false;
    const updateClock = (): void => {
      if (!cancelled) setNowTick(Date.now());
    };
    const initialTimerId = window.setTimeout(updateClock, 0);
    const intervalId = window.setInterval(updateClock, CLOCK_REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(initialTimerId);
      window.clearInterval(intervalId);
    };
  }, []);

  const handleAddTask = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = newTitle.trim();
    if (!title) return;

    setIsSubmitting(true);
    try {
      await addTask({ title, dueTime: newDue || undefined });
      setNewTitle("");
      setNewDue("");
    } catch {
      toast("添加任务失败", "error");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggleTask = async (
    id: string,
    completed: boolean
  ): Promise<void> => {
    try {
      await toggleTask(id, completed);
    } catch (error: unknown) {
      console.error("Failed to update task", error);
      toast("更新任务失败", "error");
    }
  };

  const performDelete = async (): Promise<void> => {
    if (!pendingDeleteId) return;
    try {
      await removeTask(pendingDeleteId);
    } catch (error: unknown) {
      console.error("Failed to delete task", error);
      toast("删除任务失败", "error");
    } finally {
      setPendingDeleteId(null);
    }
  };

  const now = new Date(nowTick);
  const todayTasks = pickTodayTasks(tasks, now);
  const completedToday = todayTasks.filter((task) => task.completed).length;
  const todayProgress =
    todayTasks.length > 0 ? (completedToday / todayTasks.length) * 100 : 0;
  const pendingCount = tasks.filter((task) => !task.completed).length;
  const visibleTasks = sortTasks(tasks, now);
  const isBusy = loading || isSubmitting;

  return (
    <>
      <Dialog
        title="小爱的任务清单"
        icon={<ClipboardList size={22} />}
        onClose={onClose}
        widthClassName="w-[400px]"
      >
        <div className="mb-6 min-h-[42px]">
          {todayTasks.length > 0 ? (
            <div className="space-y-2">
              <div className="flex justify-between text-xs font-semibold uppercase text-content-secondary">
                <span>今日进度</span>
                <span>
                  {completedToday}/{todayTasks.length}
                </span>
              </div>
              <ProgressBar value={todayProgress} />
            </div>
          ) : (
            <p className="py-2 text-xs text-content-muted">
              今日没有安排，另有 {pendingCount} 条待办
            </p>
          )}
        </div>

        <div className="mb-6 max-h-[40vh] space-y-3 overflow-x-hidden overflow-y-auto pr-2 [scrollbar-gutter:stable]">
          {visibleTasks.length === 0 ? (
            <div className="py-10 text-center text-sm italic text-content-muted">
              暂时没有任务哦，亲爱的快去添加吧~ ✨
            </div>
          ) : (
            visibleTasks.map((task) => (
              <TaskItem
                key={task.id}
                task={task}
                now={now}
                onToggle={(id, completed) => {
                  void handleToggleTask(id, completed);
                }}
                onRequestDelete={setPendingDeleteId}
              />
            ))
          )}
        </div>

        <form
          onSubmit={handleAddTask}
          className="space-y-3 border-t border-line-subtle pt-4"
        >
          <Input
            type="text"
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            placeholder="新任务计划..."
            className="py-2 text-sm"
            disabled={isBusy}
          />
          <div className="flex gap-2">
            <Input
              type="datetime-local"
              value={newDue}
              onChange={(event) => setNewDue(event.target.value)}
              className="flex-1 py-2 text-xs"
              disabled={isBusy}
            />
            <Button
              type="submit"
              disabled={isBusy || !newTitle.trim()}
              className="flex aspect-square h-[42px] items-center justify-center p-2"
            >
              <Plus size={20} />
            </Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        isOpen={pendingDeleteId !== null}
        title="删除任务"
        message="确定要删除这个任务吗？删除后无法恢复。"
        confirmText="删除"
        cancelText="取消"
        type="danger"
        onConfirm={performDelete}
        onCancel={() => setPendingDeleteId(null)}
      />
    </>
  );
}
