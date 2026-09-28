"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Circle, Plus, Trash2, Calendar, ClipboardList } from "lucide-react";
import { api } from "@/lib/api";
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
        <div className="modal-glass p-6 w-[400px] max-h-[80vh] flex flex-col">
            {/* Header */}
            <div className="flex justify-between items-center mb-6">
                <h3 className="font-bold text-lg flex items-center gap-2 text-pink-600">
                    <ClipboardList size={22} /> 小爱的任务清单
                </h3>
                <button
                    onClick={onClose}
                    className="text-gray-400 hover:text-gray-600 transition-colors"
                >
                    ✕
                </button>
            </div>

            {/* Progress Bar */}
            {tasks.length > 0 && (
                <div className="mb-6 space-y-2">
                    <div className="flex justify-between text-xs font-semibold text-gray-500 uppercase">
                        <span>今日进度</span>
                        <span>{completedCount}/{tasks.length}</span>
                    </div>
                    <div className="h-2 w-full bg-pink-100 rounded-full overflow-hidden">
                        <div
                            className="h-full bg-gradient-to-r from-pink-400 to-rose-400 transition-all duration-500"
                            style={{ width: `${progress}%` }}
                        />
                    </div>
                </div>
            )}

            {/* Task List */}
            <div className="flex-1 overflow-y-auto pr-2 space-y-3 mb-6 scrollbar-cute">
                {tasks.length === 0 ? (
                    <div className="text-center py-10 text-gray-400 italic text-sm">
                        暂时没有任务哦，亲爱的快去添加吧~ ✨
                    </div>
                ) : (
                    tasks.map(task => (
                        <div
                            key={task.id}
                            className={`flex items-center gap-3 p-3 rounded-2xl border-2 transition-all ${task.completed
                                    ? "bg-gray-50 border-transparent opacity-60"
                                    : "bg-white border-pink-50 hover:border-pink-100 shadow-sm"
                                }`}
                        >
                            <button
                                onClick={() => toggleTask(task.id, task.completed)}
                                className={`transition-colors ${task.completed ? "text-green-500" : "text-pink-300 hover:text-pink-400"}`}
                            >
                                {task.completed ? <CheckCircle2 size={24} /> : <Circle size={24} />}
                            </button>

                            <div className="flex-1 min-w-0">
                                <p className={`text-sm font-medium truncate ${task.completed ? "line-through text-gray-400" : "text-gray-700"}`}>
                                    {task.title}
                                </p>
                                {task.dueTime && (
                                    <p className="text-[10px] text-gray-400 flex items-center gap-1 mt-0.5">
                                        <Calendar size={10} /> {new Date(task.dueTime).toLocaleString()}
                                    </p>
                                )}
                            </div>

                            <button
                                onClick={() => deleteTask(task.id)}
                                className="text-gray-300 hover:text-red-400 transition-colors p-1"
                            >
                                <Trash2 size={16} />
                            </button>
                        </div>
                    ))
                )}
            </div>

            {/* Add Task Form */}
            <form onSubmit={handleAddTask} className="space-y-3 pt-4 border-t border-pink-100">
                <input
                    type="text"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="新任务计划..."
                    className="input-cute py-2 text-sm"
                    disabled={isLoading}
                />
                <div className="flex gap-2">
                    <input
                        type="datetime-local"
                        value={newDue}
                        onChange={(e) => setNewDue(e.target.value)}
                        className="input-cute py-2 text-xs flex-1"
                        disabled={isLoading}
                    />
                    <button
                        type="submit"
                        disabled={isLoading || !newTitle.trim()}
                        className="btn-cute p-2 h-[42px] aspect-square flex items-center justify-center disabled:opacity-50"
                    >
                        <Plus size={20} />
                    </button>
                </div>
            </form>
        </div>
    );
}
