import { beforeEach, describe, expect, it, vi } from "vitest";

const { streamMock, apiMock } = vi.hoisted(() => ({
    streamMock: vi.fn(),
    apiMock: {
        getHistory: vi.fn(async () => []),
        clearHistory: vi.fn(async () => ({ status: "ok" })),
        getState: vi.fn(async () => ({})),
        updateState: vi.fn(async () => ({})),
        addFact: vi.fn(async () => ({ status: "ok", fact: {} })),
        deleteMemory: vi.fn(async () => ({ status: "ok", type: "fact" })),
    },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/hooks/useChatStream", () => ({
    streamSendMessage: streamMock,
    speakBus: { speak: vi.fn(), register: vi.fn() },
}));

/* 顶层 await：store 必须在两个 vi.mock 生效之后才被求值 */
const { useChatStore } = await import("@/stores/chatStore");

/**
 * 会话 store 的两条健壮性契约（FE-02 / FE-03）：
 * ① 流式写入按 `streamingMessageId` 点名，主动消息插进来也不会串气泡；
 * ② 主动消息在流式期间挂起，结束后按 FIFO 补投，且不残留空气泡。
 */

interface Handlers {
    appendDelta: (chunk: string) => void;
    finishWith: (content: string, thought?: string | null) => void;
    markGhosting: () => void;
    applyMeta: (data: unknown) => void;
}

const proactive = (id: number, content: string) =>
    ({ id, content, reason: "miss_you", createdAt: Date.now() }) as never;

function contents(): { role: string; content: string }[] {
    return useChatStore.getState().messages.map((m) => ({ role: m.role, content: m.content }));
}

describe("chatStore 流式定位与主动消息", () => {
    let handlers: Handlers;
    let resolveStream: (v: unknown) => void;

    beforeEach(() => {
        vi.useFakeTimers();
        useChatStore.setState({ messages: [], isLoading: false });
        handlers = undefined as unknown as Handlers;
        resolveStream = () => {};
        streamMock.mockImplementation((_text: string, h: Handlers) => {
            handlers = h;
            return new Promise((resolve) => {
                resolveStream = resolve;
            });
        });
    });

    /** 让 sendMessage 里 await 之后的 microtask 走完 */
    const flushMicro = () => Promise.resolve().then(() => Promise.resolve());

    it("发送后建立占位，且 delta 只写进本轮气泡", async () => {
        const p = useChatStore.getState().sendMessage("你好");
        await flushMicro();
        expect(contents()).toEqual([
            { role: "user", content: "你好" },
            { role: "assistant", content: "" },
        ]);

        handlers.appendDelta("在的");
        handlers.appendDelta("，想你");
        expect(contents()[1].content).toBe("在的，想你");

        resolveStream({});
        await p;
        expect(useChatStore.getState().isLoading).toBe(false);
        vi.useRealTimers();
    });

    it("流式途中收到主动消息：不污染本轮气泡、结束后各自成条（FE-03）", async () => {
        const p = useChatStore.getState().sendMessage("在吗");
        await flushMicro();
        const streamingBefore = contents()[1];

        // 她主动插一句 —— 流式期间必须被挂起
        useChatStore.getState().appendProactiveMessage(proactive(1, "我在想你"));
        vi.advanceTimersByTime(5000);
        expect(contents()).toHaveLength(2);
        expect(contents()[1].content).toBe(streamingBefore.content);

        handlers.appendDelta("在呀");
        resolveStream({});
        await p;
        // 收尾后不留空占位
        expect(contents()[1].content).toBe("在呀");

        // 主动消息这才出场，内容一字不差
        vi.runAllTimers();
        expect(contents()).toEqual([
            { role: "user", content: "在吗" },
            { role: "assistant", content: "在呀" },
            { role: "assistant", content: "我在想你" },
        ]);
        vi.useRealTimers();
    });

    it("200ms 内连到 3 条主动消息 → 3 条全部落屏（FE-02，旧写法只留最后一条）", () => {
        useChatStore.setState({ isLoading: false });
        useChatStore.getState().appendProactiveMessage(proactive(1, "甲"));
        vi.advanceTimersByTime(200);
        useChatStore.getState().appendProactiveMessage(proactive(2, "乙"));
        vi.advanceTimersByTime(200);
        useChatStore.getState().appendProactiveMessage(proactive(3, "丙"));
        vi.runAllTimers();
        expect(contents().map((m) => m.content)).toEqual(["甲", "乙", "丙"]);
        vi.useRealTimers();
    });

    it("「新对话」清空后，队列里没出场的主动消息不会再冒出来", async () => {
        useChatStore.getState().appendProactiveMessage(proactive(1, "还没出场的话"));
        await useChatStore.getState().newConversation();
        vi.runAllTimers();
        expect(contents()).toEqual([]);
        vi.useRealTimers();
    });

    it("找不到本轮气泡时不退回「改最后一条」：delta 被丢弃而不是写进别人的气泡", async () => {
        const p = useChatStore.getState().sendMessage("喂");
        await flushMicro();
        // 模拟历史被整体重拉，本轮占位已经不在了
        useChatStore.setState({ messages: [{ id: "other", role: "assistant", content: "旧的一条" }] });
        handlers.appendDelta("不该出现");
        expect(contents()).toEqual([{ role: "assistant", content: "旧的一条" }]);
        resolveStream({});
        await p;
        vi.useRealTimers();
    });
});
