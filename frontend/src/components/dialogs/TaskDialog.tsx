"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Circle, Plus, Trash2, Calendar, ClipboardList } from "lucide-react";
import Button from "../ui/Button";
import Dialog from "../ui/Dialog";
import Input from "../ui/Input";
import ProgressBar from "../ui/ProgressBar";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { Task } from "@/types";

interface TaskDialogProps {
    onClose: () => void;
}

export default function TaskDialog({ onClose }: TaskDialogProps) {
    const [tasks, setTasks] = useState<Task[]>([]);
    const [newTitle, setNewTitle] = useState("");
    const [newDue, setNewDue] = useState("");
    const [isLoading, setIsLoading] = useState(false);

    /** 拉取任务列表。setState 放在 Promise 回调里，避免 effect 同步体内 setState */
    const fetchTasks = useCallback(() => {
        return api
            .getTasks()
            .then(setTasks)
            .catch(() => {
                console.error("Failed to fetch tasks");
            });
    }, []);

    useEffect(() => {
        void fetchTasks();
    }, [fetchTasks]);

    const handleAddTask = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newTitle.trim()) return;

        setIsLoading(true);
        try {
            await api.addTask({ title: newTitle, dueTime: newDue || undefined });
            setNewTitle("");
            setNewDue("");
            await fetchTasks();
        } catch {
            alert("添加失败");
        } finally {
            setIsLoading(false);
        }
    };

    const toggleTask = async (id: string, completed: boolean) => {
        try {
            await api.updateTask(id, { completed: !completed });
            await fetchTasks();
        } catch (e) {
            console.error("Failed to update task", e);
        }
    };

    const deleteTask = async (id: string) => {
        if (!confirm("确定要删除这个任务吗？")) return;
        try {
            await api.deleteTask(id);
            await fetchTasks();
        } catch (e) {
            console.error("Failed to delete task", e);
        }
    };

    const completedCount = tasks.filter(t => t.completed).length;
    const progress = tasks.length > 0 ? (completedCount / tasks.length) * 100 : 0;

    return (
        <Dialog
            title="小爱的任务清单"
            icon={<ClipboardList size={22} />}
            onClose={onClose}
            widthClassName="w-[400px]"
        >
            {/* Progress Bar */}
            {tasks.length > 0 && (
                <div className="mb-6 space-y-2">
                    <div className="flex justify-between text-xs font-semibold uppercase text-content-secondary">
                        <span>今日进度</span>
                        <span>{completedCount}/{tasks.length}</span>
                    </div>
                    <ProgressBar value={progress} />
                </div>
            )}

            {/* Task List */}
            <div className="mb-6 max-h-[40vh] space-y-3 overflow-y-auto pr-2">
                {tasks.length === 0 ? (
                    <div className="py-10 text-center text-sm italic text-content-muted">
                        暂时没有任务哦，亲爱的快去添加吧~ ✨
                    </div>
                ) : (
                    tasks.map(task => (
                        <div
                            key={task.id}
                            className={cn(
                                "flex items-center gap-3 rounded-2xl border-2 p-3 transition-all",
                                task.completed
                                    ? "border-transparent bg-surface-2/50 opacity-60"
                                    : "border-line-subtle bg-surface-1 shadow-sm hover:border-accent-1/30"
                            )}
                        >
                            <button
                                onClick={() => toggleTask(task.id, task.completed)}
                                className={cn(
                                    "transition-colors",
                                    task.completed
                                        ? "text-status-success"
                                        : "text-accent-1/50 hover:text-accent-1"
                                )}
                            >
                                {task.completed ? <CheckCircle2 size={24} /> : <Circle size={24} />}
                            </button>

                            <div className="min-w-0 flex-1">
                                <p className={cn(
                                    "truncate text-sm font-medium",
                                    task.completed
                                        ? "text-content-muted line-through"
                                        : "text-content-primary"
                                )}>
                                    {task.title}
                                </p>
                                {task.dueTime && (
                                    <p className="mt-0.5 flex items-center gap-1 text-[10px] text-content-muted">
                                        <Calendar size={10} /> {new Date(task.dueTime).toLocaleString()}
                                    </p>
                                )}
                            </div>

                            <button
                                onClick={() => deleteTask(task.id)}
                                className="p-1 text-content-muted/50 transition-colors hover:text-status-danger"
                            >
                                <Trash2 size={16} />
                            </button>
                        </div>
                    ))
                )}
            </div>

            {/* Add Task Form */}
            <form onSubmit={handleAddTask} className="space-y-3 border-t border-line-subtle pt-4">
                <Input
                    type="text"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="新任务计划..."
                    className="py-2 text-sm"
                    disabled={isLoading}
                />
                <div className="flex gap-2">
                    <Input
                        type="datetime-local"
                        value={newDue}
                        onChange={(e) => setNewDue(e.target.value)}
                        className="flex-1 py-2 text-xs"
                        disabled={isLoading}
                    />
                    <Button
                        type="submit"
                        disabled={isLoading || !newTitle.trim()}
                        className="flex aspect-square h-[42px] items-center justify-center p-2"
                    >
                        <Plus size={20} />
                    </Button>
                </div>
            </form>
        </Dialog>
    );
}
