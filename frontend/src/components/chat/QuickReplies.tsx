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

export default function QuickReplies({ onSend, disabled }: QuickRepliesProps) {
    return (
        <div className="flex gap-2 flex-wrap justify-center py-3 px-4">
            {quickReplies.map((reply, idx) => (
                <button
                    key={idx}
                    onClick={() => onSend(reply.text)}
                    disabled={disabled}
                    className="quick-reply-btn hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed"
                    title={reply.text}
                >
                    <span className="mr-1">{reply.emoji}</span>
                    {reply.label}
                </button>
            ))}
        </div>
    );
}
