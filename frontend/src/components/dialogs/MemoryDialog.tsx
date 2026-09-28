"use client";

import { useState, useEffect } from "react";
import { Brain, Trash2, Heart, User, Loader2 } from "lucide-react";
import { useToast } from "../ui/Toast";
import ConfirmDialog from "../ui/ConfirmDialog";
import { api } from "@/lib/api";
import { useChatStore } from "@/stores/chatStore";
import type { MemoryItem } from "@/types";

interface MemoryDialogProps {
    onClose: () => void;
}

export default function MemoryDialog({ onClose }: MemoryDialogProps) {
    // 注意：本组件使用共享类型 MemoryItem（见 @/types），不再本地重复定义
    const [memories, setMemories] = useState<MemoryItem[]>([]);
    const [affinity, setAffinity] = useState(35);
    const [nickname, setNickname] = useState("");
    const [isLoading, setIsLoading] = useState(true);
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
        // 同步到会话状态（好感度心心/进度条立即刷新），再落后端
        useChatStore.getState().setAffinity(affinity);
        onClose();
        try {
            await api.updateState({ affinity, nickname });
        } catch (e) {
            console.error("Save failed", e);
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
                setAffinity(state.affinity || 35);
                setNickname(state.nickname || "");
                setIsLoading(false);
            })
            .catch((e) => {
                if (cancelled) return;
                console.error("Failed to fetch data", e);
                setIsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const formatTime = (timestamp: number) => {
        return new Date(timestamp * 1000).toLocaleString("zh-CN");
    };

    return (
        <>
            <div className="modal-glass p-6 w-[450px] max-h-[80vh] flex flex-col">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="font-bold text-lg flex items-center gap-2">
                        <Brain size={20} className="text-pink-500" /> 记忆
                    </h3>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">✕</button>
                </div>

                <div className="flex gap-2 mb-4">
                    <button onClick={() => setActiveTab("memories")}
                        className={`flex-1 py-2 rounded-xl text-sm font-medium transition-all ${activeTab === "memories" ? "bg-pink-100 text-pink-600" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                        记忆
                    </button>
                    <button onClick={() => setActiveTab("settings")}
                        className={`flex-1 py-2 rounded-xl text-sm font-medium transition-all ${activeTab === "settings" ? "bg-pink-100 text-pink-600" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                        设置
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto">
                    {isLoading ? (
                        <div className="flex items-center justify-center py-8 text-gray-500">
                            <Loader2 className="animate-spin mr-2" size={20} /> 加载中...
                        </div>
                    ) : activeTab === "memories" ? (
                        <div className="space-y-3">
                            {memories.length === 0 ? (
                                <div className="text-center text-gray-500 py-8">暂无记忆</div>
                            ) : (
                                memories.map((mem) => (
                                    <div key={mem.id} className="bg-pink-50/50 rounded-xl p-3 text-sm">
                                        <p className="text-gray-700 whitespace-pre-wrap">{mem.text}</p>
                                        <p className="text-xs text-gray-400 mt-2">{formatTime(mem.timestamp)}</p>
                                    </div>
                                ))
                            )}
                        </div>
                    ) : (
                        <div className="space-y-4">
                            <div className="bg-pink-50/50 rounded-xl p-4">
                                <label className="flex items-center gap-2 text-sm font-medium mb-3">
                                    <Heart size={16} className="text-pink-500" /> 好感度: {affinity}
                                </label>
                                <input type="range" min="0" max="100" value={affinity}
                                    onChange={(e) => setAffinity(Number(e.target.value))}
                                    className="w-full accent-pink-500" />
                                <div className="flex justify-between text-xs text-gray-400 mt-1">
                                    <span>陌生</span><span>恋人</span>
                                </div>
                            </div>

                            <div className="bg-pink-50/50 rounded-xl p-4">
                                <label className="flex items-center gap-2 text-sm font-medium mb-3">
                                    <User size={16} className="text-pink-500" /> 昵称
                                </label>
                                <input type="text" value={nickname}
                                    onChange={(e) => setNickname(e.target.value)}
                                    className="input-cute py-2 text-sm" placeholder="例如：宝贝、亲爱的..." />
                            </div>

                            <button onClick={handleSaveSettings} className="btn-cute w-full py-2.5">
                                保存设置
                            </button>
                        </div>
                    )}
                </div>

                <div className="mt-4 pt-4 border-t border-pink-100">
                    <button onClick={() => setShowClearConfirm(true)}
                        className="w-full py-2 text-sm text-orange-500 hover:bg-orange-50 rounded-xl transition-colors flex items-center justify-center gap-2">
                        <Trash2 size={16} /> 清除记忆（保留聊天记录）
                    </button>
                </div>
            </div>

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
