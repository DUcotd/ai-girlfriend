"use client";

import { useState, useEffect } from "react";
import { Brain, Trash2, Heart, User, Loader2 } from "lucide-react";
import Button from "../ui/Button";
import ConfirmDialog from "../ui/ConfirmDialog";
import Dialog from "../ui/Dialog";
import Input from "../ui/Input";
import SegmentedControl from "../ui/SegmentedControl";
import { useToast } from "../ui/Toast";
import { api } from "@/lib/api";
import { useChatStore } from "@/stores/chatStore";
import type { MemoryItem } from "@/types";

interface MemoryDialogProps {
    onClose: () => void;
}

export default function MemoryDialog({ onClose }: MemoryDialogProps) {
    // 注意：本组件使用共享类型 MemoryItem（见 @/types），不再本地重复定义
    const [memories, setMemories] = useState<MemoryItem[]>([]);
    const [affinity, setAffinity] = useState<number | null>(null);
    const [nickname, setNickname] = useState("");
    const [isLoading, setIsLoading] = useState(true);
    const [loadFailed, setLoadFailed] = useState(false);
    const [activeTab, setActiveTab] = useState<"memories" | "settings">("memories");
    const [showClearConfirm, setShowClearConfirm] = useState(false);

    const showToast = useToast();

    const handleClearMemories = async () => {
        try {
            await api.clearMemories();
            setMemories([]);
            showToast("记忆已清除！", "success");
        } catch {
            showToast("清除失败", "error");
        }
        setShowClearConfirm(false);
    };

    const handleSaveSettings = async () => {
        if (affinity === null) return;
        // 同步到会话状态（好感度心心/进度条立即刷新），再落后端
        useChatStore.getState().setAffinity(affinity);
        try {
            await api.updateState({ affinity, nickname });
            onClose();
        } catch (e) {
            // 保存失败必须可见：此前先关弹窗再静默吞错，用户误以为已保存，
            // 本地 UI 与后端持久化分叉直到刷新才暴露
            console.error("Save failed", e);
            showToast("保存失败，请检查后端连接", "error");
        }
    };

    // 挂载后拉取一次数据。
    // setState 全部放进异步回调（而非 effect 同步体），避免触发级联渲染。
    useEffect(() => {
        let cancelled = false;
        Promise.all([api.getMemories(), api.getState()])
            .then(([list, state]) => {
                if (cancelled) return;
                setMemories(list);
                // ?? 而非 ||：0 是合法好感度，|| 会把它显示成 35，保存时再把 0 覆写成 35
                setAffinity(typeof state.affinity === "number" ? state.affinity : 35);
                setNickname(state.nickname || "");
                setIsLoading(false);
            })
            .catch((e) => {
                if (cancelled) return;
                console.error("Failed to fetch data", e);
                setLoadFailed(true);
                setIsLoading(false);
                // 拉取失败必须可见：否则网络错误被渲染成「暂无记忆」，误导用户记忆已空
                showToast("记忆加载失败，请检查后端连接", "error");
            });
        return () => {
            cancelled = true;
        };
    }, [showToast]);

    const formatTime = (timestamp: number) => {
        return new Date(timestamp * 1000).toLocaleString("zh-CN");
    };

    return (
        <>
            <Dialog
                title="记忆"
                icon={<Brain size={20} />}
                onClose={onClose}
                widthClassName="w-[450px]"
                footer={
                    <button
                        onClick={() => setShowClearConfirm(true)}
                        className="flex w-full items-center justify-center gap-2 rounded-xl py-2 text-sm text-status-warning transition-colors hover:bg-status-warning/10"
                    >
                        <Trash2 size={16} /> 清除记忆（保留聊天记录）
                    </button>
                }
            >
                <SegmentedControl
                    className="mb-4"
                    options={[
                        { value: "memories", label: "记忆" },
                        { value: "settings", label: "设置" },
                    ]}
                    value={activeTab}
                    onChange={setActiveTab}
                />

                <div className="max-h-[50vh] overflow-y-auto">
                    {isLoading ? (
                        <div className="flex items-center justify-center py-8 text-content-secondary">
                            <Loader2 className="mr-2 animate-spin" size={20} /> 加载中...
                        </div>
                    ) : activeTab === "memories" ? (
                        <div className="space-y-3">
                            {loadFailed ? (
                                <div className="py-8 text-center text-status-danger">加载失败，请检查后端连接后重开弹窗</div>
                            ) : memories.length === 0 ? (
                                <div className="py-8 text-center text-content-secondary">暂无记忆</div>
                            ) : (
                                memories.map((mem) => (
                                    <div key={mem.id} className="rounded-xl bg-accent-1/10 p-3 text-sm">
                                        <p className="whitespace-pre-wrap text-content-primary">{mem.text}</p>
                                        <p className="mt-2 text-xs text-content-muted">{formatTime(mem.timestamp)}</p>
                                    </div>
                                ))
                            )}
                        </div>
                    ) : affinity === null ? (
                        <div className="py-8 text-center text-status-danger">状态加载失败，请检查后端连接后重开弹窗</div>
                    ) : (
                        <div className="space-y-4">
                            <div className="rounded-xl bg-surface-2/60 p-4">
                                <label className="mb-3 flex items-center gap-2 text-sm font-medium">
                                    <Heart size={16} className="text-accent-1" /> 好感度: {affinity}
                                </label>
                                <input
                                    type="range"
                                    min="0"
                                    max="100"
                                    value={affinity}
                                    onChange={(e) => setAffinity(Number(e.target.value))}
                                    className="w-full accent-accent-1"
                                />
                                <div className="mt-1 flex justify-between text-xs text-content-muted">
                                    <span>陌生</span><span>恋人</span>
                                </div>
                            </div>

                            <div className="rounded-xl bg-surface-2/60 p-4">
                                <label className="mb-3 flex items-center gap-2 text-sm font-medium">
                                    <User size={16} className="text-accent-1" /> 昵称
                                </label>
                                <Input
                                    type="text"
                                    value={nickname}
                                    onChange={(e) => setNickname(e.target.value)}
                                    className="py-2 text-sm"
                                    placeholder="例如：宝贝、亲爱的..."
                                />
                            </div>

                            <Button onClick={handleSaveSettings} className="w-full py-2.5">
                                保存设置
                            </Button>
                        </div>
                    )}
                </div>
            </Dialog>

            <ConfirmDialog
                isOpen={showClearConfirm}
                title="清除记忆"
                message="确定清除所有记忆？聊天记录将保留。"
                confirmText="确认"
                cancelText="取消"
                type="warning"
                onConfirm={handleClearMemories}
                onCancel={() => setShowClearConfirm(false)}
            />
        </>
    );
}
