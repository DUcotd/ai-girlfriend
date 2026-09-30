"use client";

interface QuickRepliesProps {
    onSend: (message: string) => void;
    disabled?: boolean;
}

const quickReplies = [
    { emoji: "🌅", text: "早上好～今天也要元气满满哦！", label: "早安" },
    { emoji: "💤", text: "晚安小爱，做个好梦～", label: "晚安" },
    { emoji: "🍱", text: "我要去吃饭啦，想你呢～", label: "吃饭" },
    { emoji: "💕", text: "小爱，我想你了...", label: "撒娇" },
    { emoji: "🤗", text: "给我一个抱抱好不好？", label: "抱抱" },
    { emoji: "🎵", text: "给我唱首歌吧～", label: "唱歌" },
    { emoji: "😘", text: "么么哒～爱你哦！", label: "亲亲" },
    { emoji: "🎮", text: "我要去玩游戏啦，陪我聊天嘛～", label: "游戏" },
];

/**
 * 快捷回复 chips。
 *
 * 单行宽度预算（桌面端）：容器 max-w-3xl(768) - px-4*2(32) = 736px 内宽；
 * 单枚约 72px（px-3*2 + 1px 边框*2 + emoji ~16 + mr-1 + 2 个汉字 @13px ~26），
 * 8 枚 + 7 个 gap(md: 8px) ≈ 632px < 736px，故桌面端稳定单行；
 * 窄容器（<md 或侧栏占位后不足 736px）由 flex-wrap 回退换行并 justify-center。
 *
 * hover 只做 -translate-y-0.5，不用 scale（避免触发布局抖动感知）。
 */
export default function QuickReplies({ onSend, disabled }: QuickRepliesProps) {
    return (
        <div className="flex flex-wrap justify-center gap-1.5 px-4 pb-3 pt-1 md:gap-2">
            {quickReplies.map((reply, idx) => (
                <button
                    key={idx}
                    onClick={() => onSend(reply.text)}
                    disabled={disabled}
                    className="whitespace-nowrap rounded-full border border-accent-1/25 bg-surface-1/90 px-3 py-1.5 text-[13px] font-medium text-content-primary transition-all duration-fast hover:-translate-y-0.5 hover:border-accent-1 hover:bg-accent-1/15 disabled:cursor-not-allowed disabled:opacity-50"
                    title={reply.text}
                >
                    <span className="mr-1">{reply.emoji}</span>
                    {reply.label}
                </button>
            ))}
        </div>
    );
}
