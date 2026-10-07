"use client";

import { useState, useEffect, useMemo } from "react";
import {
    Brain,
    Trash2,
    Heart,
    User,
    Loader2,
    Plus,
    Pencil,
    Check,
    Search,
    Star,
    Sparkles,
    MessageCircle,
} from "lucide-react";
import Button from "../ui/Button";
import ConfirmDialog from "../ui/ConfirmDialog";
import Dialog from "../ui/Dialog";
import Input from "../ui/Input";
import SegmentedControl from "../ui/SegmentedControl";
import { useToast } from "../ui/Toast";
import { api } from "@/lib/api";
import { toApiError } from "@/lib/apiError";
import { LOCAL_ERROR_CODES } from "@/lib/errorCodes";
import { useChatStore } from "@/stores/chatStore";
import type { EpisodeItem, FactItem, MemoryStats } from "@/types";

interface MemoryDialogProps {
    onClose: () => void;
}

/** 撤销条停留时长：够读完并点一次，又不至于变成永远挂着的幽灵操作（FE-09） */
const UNDO_WINDOW_MS = 6000;

const CATEGORY_LABELS: Record<string, string> = {    identity: "身份",
    preference: "偏好",
    relationship: "人际",
    habit: "习惯",
    promise: "约定",
    event: "事件",
    opinion: "观点",
    other: "其他",
};

/** 重要度 1-5 星选择器（新增/编辑事实共用） */
function ImportancePicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
    return (
        <div className="flex items-center gap-0.5">
            {[1, 2, 3, 4, 5].map((n) => (
                <button
                    key={n}
                    type="button"
                    onClick={() => onChange(n)}
                    aria-label={`重要度 ${n}`}
                    className="p-0.5 transition-transform hover:scale-110"
                >
                    <Star
                        size={13}
                        className={n <= value ? "fill-amber-400 text-amber-400" : "text-content-muted/40"}
                    />
                </button>
            ))}
        </div>
    );
}

/**
 * 记忆弹窗：完整记忆管理。
 * - 事实记忆（小爱了解的）：手动添加 / 编辑 / 删除，含重要度与分类
 * - 情节记忆（对话回忆）：查看 + 单条删除
 * 数据来自后端 schema v2（GET /memories → {facts, episodes, stats}）。
 */
export default function MemoryDialog({ onClose }: MemoryDialogProps) {
    const [facts, setFacts] = useState<FactItem[]>([]);
    const [episodes, setEpisodes] = useState<EpisodeItem[]>([]);
    const [stats, setStats] = useState<MemoryStats | null>(null);
    const [affinity, setAffinity] = useState<number | null>(null);
    const [nickname, setNickname] = useState("");
    const [isLoading, setIsLoading] = useState(true);
    const [loadFailed, setLoadFailed] = useState(false);
    const [activeTab, setActiveTab] = useState<"memories" | "settings">("memories");
    const [showClearConfirm, setShowClearConfirm] = useState(false);

    // 记忆管理本地状态（初始值一律常量，挂载后异步填充，防 hydration mismatch）
    const [search, setSearch] = useState("");
    const [newFactContent, setNewFactContent] = useState("");
    const [newFactImportance, setNewFactImportance] = useState(3);
    const [addingFact, setAddingFact] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editContent, setEditContent] = useState("");
    const [editImportance, setEditImportance] = useState(3);
    const [busyId, setBusyId] = useState<string | null>(null);
    /** 刚删掉、还可以撤销的事实（FE-09 撤销条的数据源） */
    const [undoFact, setUndoFact] = useState<FactItem | null>(null);
    /** 等待二次确认的回忆（不可重建，所以只确认不给撤销） */
    const [pendingEpisodeDelete, setPendingEpisodeDelete] = useState<EpisodeItem | null>(null);
    const [savingSettings, setSavingSettings] = useState(false);

    const showToast = useToast();

    // 挂载后拉取一次数据。
    // setState 全部放进异步回调（而非 effect 同步体），避免触发级联渲染。
    useEffect(() => {
        let cancelled = false;
        Promise.all([api.getMemories(), api.getState()])
            .then(([memories, state]) => {
                if (cancelled) return;
                setFacts(memories.facts);
                setEpisodes(memories.episodes);
                setStats(memories.stats);
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

    /** 搜索过滤：事实按内容，回忆按原文（大小写不敏感的包含匹配） */
    const keyword = search.trim().toLowerCase();
    const filteredFacts = useMemo(
        () => (keyword ? facts.filter((f) => f.content.toLowerCase().includes(keyword)) : facts),
        [facts, keyword]
    );
    const filteredEpisodes = useMemo(
        () => (keyword ? episodes.filter((e) => e.text.toLowerCase().includes(keyword)) : episodes),
        [episodes, keyword]
    );

    const handleAddFact = async () => {
        const content = newFactContent.trim();
        if (!content || addingFact) return;
        setAddingFact(true);
        try {
            const { fact } = await api.addFact(content, newFactImportance);
            setFacts((prev) => [...prev, fact]);
            setNewFactContent("");
            setNewFactImportance(3);
            showToast("小爱记住了！", "success");
        } catch (e) {
            console.error("Add fact failed", e);
            // 按稳定码分支，不再匹配文案（旧写法是 e.message.includes("409")，
            // 后端把状态码写进别处或改文案就会静默失效，用户对着「添加失败」一头雾水）
            const err = toApiError(e);
            const isDuplicate = err.code === LOCAL_ERROR_CODES.DUPLICATE_FACT;
            showToast(err.userMessage || "添加失败", isDuplicate ? "info" : "error");
        } finally {
            setAddingFact(false);
        }
    };

    const handleStartEdit = (fact: FactItem) => {
        setEditingId(fact.id);
        setEditContent(fact.content);
        setEditImportance(fact.importance);
    };

    const handleSaveEdit = async () => {
        if (!editingId) return;
        const content = editContent.trim();
        if (!content) return;
        setBusyId(editingId);
        try {
            const { fact } = await api.updateFact(editingId, { content, importance: editImportance });
            setFacts((prev) => prev.map((f) => (f.id === fact.id ? fact : f)));
            setEditingId(null);
        } catch (e) {
            // 后端为什么拒（内容太长？id 已不存在？）只有它知道，照抄它的中文 detail
            showToast(`保存失败：${toApiError(e).userMessage}`, "error");
        } finally {
            setBusyId(null);
        }
    };

    /**
     * 删除一条记忆。
     *
     * FE-09 分级：事实删除给**撤销条**（能重建：内容 + 重要度重新入库），
     * 情节回忆删除改**二次确认**——后端没有「重新写回一条回忆」的入口，
     * 给一个做不到的撤销比不给更糟（按了撤销却发现什么也没回来）。
     */
    const handleDelete = async (id: string, kind: "fact" | "episode") => {
        setBusyId(id);
        const factSnapshot = kind === "fact" ? facts.find((f) => f.id === id) ?? null : null;
        try {
            await api.deleteMemory(id);
            if (kind === "fact") {
                setFacts((prev) => prev.filter((f) => f.id !== id));
                if (factSnapshot) setUndoFact(factSnapshot);
            } else {
                setEpisodes((prev) => prev.filter((e) => e.id !== id));
            }
        } catch (e) {
            showToast(`删除失败：${toApiError(e).userMessage}`, "error");
        } finally {
            setBusyId(null);
        }
    };

    /** 撤销删除：把刚删掉的事实重新教给小爱（id 会变，内容和重要度原样恢复） */
    const handleUndoDeleteFact = async () => {
        if (!undoFact) return;
        const snapshot = undoFact;
        setUndoFact(null);
        try {
            const { fact } = await api.addFact(snapshot.content, snapshot.importance);
            setFacts((prev) => (prev.some((f) => f.id === fact.id) ? prev : [...prev, fact]));
            showToast("已经找回来了", "success");
        } catch (e) {
            const err = toApiError(e);
            // 撤销撞在「重复事实」上说明这条其实还在库里，直接把列表刷新成真值
            showToast(
                err.code === LOCAL_ERROR_CODES.DUPLICATE_FACT
                    ? "这条记忆还在，没被删掉"
                    : `撤销失败：${err.userMessage}`,
                err.code === LOCAL_ERROR_CODES.DUPLICATE_FACT ? "info" : "error"
            );
        }
    };

    // 撤销条超时自动收起：过了这几秒就不再承诺可撤销（避免幽灵操作）
    useEffect(() => {
        if (!undoFact) return;
        const id = setTimeout(() => setUndoFact(null), UNDO_WINDOW_MS);
        return () => clearTimeout(id);
    }, [undoFact]);

    const handleClearMemories = async () => {
        try {
            await api.clearMemories();
            setFacts([]);
            setEpisodes([]);
            showToast("记忆已清除！", "success");
        } catch {
            showToast("清除失败", "error");
        }
        setShowClearConfirm(false);
    };

    const handleSaveSettings = async () => {
        if (affinity === null || savingSettings) return;
        setSavingSettings(true);
        // 同步到会话状态（好感度心心/进度条立即刷新），再落后端
        const prevAffinity = useChatStore.getState().affinity;
        useChatStore.getState().setAffinity(affinity);
        try {
            await api.updateState({ affinity, nickname });
            onClose();
        } catch (e) {
            // FE-07 乐观更新回滚：后端没收下这个数，界面就必须退回原来的数。
            // 不回滚的后果是「心心显示 88、后端其实还是 52」，而且本地镜像已经被
            // setAffinity 写成 88，用户刷新前完全看不出这是假的。
            useChatStore.getState().setAffinity(prevAffinity);
            console.error("Save failed", e);
            const err = toApiError(e);
            showToast(`保存失败：${err.userMessage || "请检查后端连接"}`, "error");
        } finally {
            setSavingSettings(false);
        }
    };

    const formatTime = (timestamp: number) => {
        return new Date(timestamp * 1000).toLocaleString("zh-CN");
    };

    const hasSearchResults = filteredFacts.length > 0 || filteredEpisodes.length > 0;

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
                        loadFailed ? (
                            <div className="py-8 text-center text-status-danger">加载失败，请检查后端连接后重开弹窗</div>
                        ) : (
                            <div className="space-y-4">
                                {/* 撤销条：刚删掉的事实还能原样找回（FE-09） */}
                                {undoFact && (
                                    <div
                                        role="status"
                                        aria-live="polite"
                                        className="flex items-center justify-between gap-2 rounded-xl border border-accent-1/30 bg-accent-1/10 px-3 py-2 text-xs"
                                    >
                                        <span className="min-w-0 flex-1 truncate text-content-secondary">
                                            已删除「{undoFact.content}」
                                        </span>
                                        <button
                                            onClick={handleUndoDeleteFact}
                                            className="shrink-0 rounded-lg px-2 py-1 font-bold text-accent-strong transition-colors hover:bg-accent-1/15 dark:text-accent-1"
                                        >
                                            撤销
                                        </button>
                                        <button
                                            onClick={() => setUndoFact(null)}
                                            aria-label="收起撤销提示"
                                            className="shrink-0 rounded-lg px-1.5 py-1 text-content-muted transition-colors hover:bg-surface-2"
                                        >
                                            ×
                                        </button>
                                    </div>
                                )}
                                {/* 搜索 */}
                                <div className="relative">
                                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-content-muted" />
                                    <Input
                                        type="text"
                                        value={search}
                                        onChange={(e) => setSearch(e.target.value)}
                                        placeholder="搜索记忆..."
                                        className="py-2 pl-8 text-sm"
                                    />
                                </div>

                                {!hasSearchResults ? (
                                    <div className="py-8 text-center text-content-secondary">
                                        {keyword ? "没有匹配的记忆" : "暂无记忆"}
                                    </div>
                                ) : (
                                    <>
                                        {/* ===== 事实记忆 ===== */}
                                        {filteredFacts.length > 0 && (
                                            <section className="space-y-2">
                                                <h4 className="flex items-center gap-1.5 text-xs font-bold text-content-muted">
                                                    <Sparkles size={13} className="text-accent-1" />
                                                    小爱了解的（{filteredFacts.length}）
                                                </h4>
                                                {filteredFacts
                                                    .slice()
                                                    .sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt)
                                                    .map((fact) =>
                                                        editingId === fact.id ? (
                                                            /* 编辑态 */
                                                            <div key={fact.id} className="rounded-xl border border-accent-1/40 bg-accent-1/5 p-3">
                                                                <Input
                                                                    type="text"
                                                                    value={editContent}
                                                                    onChange={(e) => setEditContent(e.target.value)}
                                                                    className="py-2 text-sm"
                                                                    autoFocus
                                                                />
                                                                <div className="mt-2 flex items-center justify-between">
                                                                    <ImportancePicker value={editImportance} onChange={setEditImportance} />
                                                                    <div className="flex gap-1.5">
                                                                        <Button
                                                                            onClick={handleSaveEdit}
                                                                            disabled={busyId === fact.id}
                                                                            className="px-3 py-1.5 text-xs"
                                                                        >
                                                                            {busyId === fact.id ? (
                                                                                <Loader2 size={14} className="animate-spin" />
                                                                            ) : (
                                                                                <Check size={14} />
                                                                            )}
                                                                            保存
                                                                        </Button>
                                                                        <button
                                                                            onClick={() => setEditingId(null)}
                                                                            className="rounded-xl px-3 py-1.5 text-xs text-content-muted transition-colors hover:bg-surface-2"
                                                                        >
                                                                            取消
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            /* 展示态 */
                                                            <div key={fact.id} className="group rounded-xl bg-accent-1/10 p-3 text-sm">
                                                                <div className="mb-1 flex items-center justify-between gap-2">
                                                                    <div className="flex items-center gap-1.5">
                                                                        <span className="rounded-full bg-accent-1/15 px-2 py-0.5 text-[10px] font-bold text-accent-strong dark:text-accent-1">
                                                                            {CATEGORY_LABELS[fact.category] || "其他"}
                                                                        </span>
                                                                        {fact.source === "manual" && (
                                                                            <span className="rounded-full bg-surface-2/80 px-2 py-0.5 text-[10px] text-content-muted">
                                                                                手动
                                                                            </span>
                                                                        )}
                                                                        <ImportancePicker value={fact.importance} onChange={() => {}} />
                                                                    </div>
                                                                    <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                                                                        <button
                                                                            onClick={() => handleStartEdit(fact)}
                                                                            aria-label="编辑"
                                                                            className="rounded-lg p-1.5 text-content-muted transition-colors hover:bg-surface-2 hover:text-accent-1"
                                                                        >
                                                                            <Pencil size={13} />
                                                                        </button>
                                                                        <button
                                                                            onClick={() => handleDelete(fact.id, "fact")}
                                                                            disabled={busyId === fact.id}
                                                                            aria-label="删除"
                                                                            className="rounded-lg p-1.5 text-content-muted transition-colors hover:bg-status-danger/10 hover:text-status-danger disabled:opacity-40"
                                                                        >
                                                                            {busyId === fact.id ? (
                                                                                <Loader2 size={13} className="animate-spin" />
                                                                            ) : (
                                                                                <Trash2 size={13} />
                                                                            )}
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                                <p className="whitespace-pre-wrap text-content-primary">{fact.content}</p>
                                                            </div>
                                                        )
                                                    )}
                                            </section>
                                        )}

                                        {/* ===== 情节记忆 ===== */}
                                        {filteredEpisodes.length > 0 && (
                                            <section className="space-y-2">
                                                <h4 className="flex items-center gap-1.5 text-xs font-bold text-content-muted">
                                                    <MessageCircle size={13} className="text-accent-1" />
                                                    对话回忆（{filteredEpisodes.length}）
                                                </h4>
                                                {filteredEpisodes.map((mem) => (
                                                    <div key={mem.id} className="group rounded-xl bg-surface-2/60 p-3 text-sm">
                                                        <p className="whitespace-pre-wrap text-content-secondary">{mem.text}</p>
                                                        <div className="mt-2 flex items-center justify-between">
                                                            <p className="text-xs text-content-muted">{formatTime(mem.timestamp)}</p>
                                                            <button
                                                                onClick={() => setPendingEpisodeDelete(mem)}
                                                                disabled={busyId === mem.id}
                                                                aria-label="删除这条回忆"
                                                                className="rounded-lg p-1 text-content-muted opacity-0 transition-all hover:bg-status-danger/10 hover:text-status-danger group-hover:opacity-100 disabled:opacity-40"
                                                            >
                                                                {busyId === mem.id ? (
                                                                    <Loader2 size={13} className="animate-spin" />
                                                                ) : (
                                                                    <Trash2 size={13} />
                                                                )}
                                                            </button>
                                                        </div>
                                                    </div>
                                                ))}
                                            </section>
                                        )}
                                    </>
                                )}

                                {/* ===== 手动添加事实 ===== */}
                                <div className="rounded-xl border border-dashed border-line-subtle p-3">
                                    <p className="mb-2 text-xs font-bold text-content-muted">教小爱记住一件事</p>
                                    <Input
                                        type="text"
                                        value={newFactContent}
                                        onChange={(e) => setNewFactContent(e.target.value)}
                                        placeholder="例如：我喜欢在周末睡懒觉"
                                        className="py-2 text-sm"
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") void handleAddFact();
                                        }}
                                    />
                                    <div className="mt-2 flex items-center justify-between">
                                        <ImportancePicker value={newFactImportance} onChange={setNewFactImportance} />
                                        <Button onClick={handleAddFact} disabled={addingFact || !newFactContent.trim()} className="px-3 py-1.5 text-xs">
                                            {addingFact ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                                            添加
                                        </Button>
                                    </div>
                                </div>

                                {stats && (
                                    <p className="text-center text-[10px] text-content-muted">
                                        共 {stats.factCount} 条事实 · {stats.episodeCount} 条回忆 · 检索方式：
                                        {stats.retrievalMode === "embedding" ? "语义" : "关键词"}
                                    </p>
                                )}
                            </div>
                        )
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

                            <Button onClick={handleSaveSettings} disabled={savingSettings} className="w-full py-2.5">
                                {savingSettings ? "保存中..." : "保存设置"}
                            </Button>
                        </div>
                    )}
                </div>
            </Dialog>

            <ConfirmDialog
                isOpen={showClearConfirm}
                title="清除记忆"
                message="确定清除所有记忆（包括事实与对话回忆）？聊天记录将保留。"
                confirmText="确认"
                cancelText="取消"
                type="warning"
                onConfirm={handleClearMemories}
                onCancel={() => setShowClearConfirm(false)}
            />

            {/* 回忆删除的二次确认：情节记忆删掉就重建不回来（后端没有「写回一条回忆」的入口），
                所以这里只给确认、不给撤销（FE-09） */}
            <ConfirmDialog
                isOpen={pendingEpisodeDelete !== null}
                title="删除这条回忆"
                message={
                    `确定让小爱忘掉这段回忆？\n\n「${(pendingEpisodeDelete?.text ?? "").slice(0, 60)}」\n\n` +
                    "回忆删除后无法找回（事实记忆删除可以在 6 秒内撤销）。"
                }
                confirmText="确认删除"
                cancelText="取消"
                type="danger"
                onConfirm={async () => {
                    const target = pendingEpisodeDelete;
                    setPendingEpisodeDelete(null);
                    if (target) await handleDelete(target.id, "episode");
                }}
                onCancel={() => setPendingEpisodeDelete(null)}
            />
        </>
    );
}
