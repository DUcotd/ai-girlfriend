import { describe, expect, it, vi } from "vitest";
import { ProactiveDeliveryQueue, defaultTypingDelay } from "../proactiveQueue";

/**
 * 主动消息投递队列（FE-02 / FE-03）。
 *
 * 假定时器 + 显式推进，全程零 sleep；每个用例都断言「消息有没有落地」而不是时序巧合。
 */

interface Harness {
    queue: ProactiveDeliveryQueue<string>;
    delivered: string[];
    typing: boolean[];
    busy: { value: boolean };
    /** 推进到最后一次排定的延时 */
    runAll: () => void;
    tick: (ms: number) => void;
    pending: () => number;
}

function makeHarness(opts: { maxQueueSize?: number; typingDelay?: (t: string) => number } = {}): Harness {
    vi.useFakeTimers();
    const delivered: string[] = [];
    const typing: boolean[] = [];
    const busy = { value: false };
    const queue = new ProactiveDeliveryQueue<string>({
        deliver: (p) => delivered.push(p),
        setTyping: (on) => typing.push(on),
        isBusy: () => busy.value,
        typingDelay: opts.typingDelay ?? (() => 1000),
        maxQueueSize: opts.maxQueueSize,
    });
    return {
        queue,
        delivered,
        typing,
        busy,
        runAll: () => vi.runAllTimers(),
        tick: (ms) => vi.advanceTimersByTime(ms),
        pending: () => queue.size,
    };
}

describe("ProactiveDeliveryQueue", () => {
    it("200ms 内连投 3 条：3 条全部落屏（旧写法会 clearTimeout 顶掉前两条）", () => {
        const h = makeHarness();
        h.queue.enqueue({ key: "1", text: "第一条", payload: "a" });
        h.tick(200);
        h.queue.enqueue({ key: "2", text: "第二条", payload: "b" });
        h.tick(200);
        h.queue.enqueue({ key: "3", text: "第三条", payload: "c" });
        h.runAll();
        expect(h.delivered).toEqual(["a", "b", "c"]);
        expect(h.pending()).toBe(0);
        vi.useRealTimers();
    });

    it("按 FIFO 顺序出场，不打乱她想起事情的顺序", () => {
        const h = makeHarness();
        ["1", "2", "3"].forEach((id, i) => h.queue.enqueue({ key: id, text: `t${i}`, payload: `p${i}` }));
        h.runAll();
        expect(h.delivered).toEqual(["p0", "p1", "p2"]);
        vi.useRealTimers();
    });

    it("流式进行中挂起：一条都不插进来，结束后按原顺序补投", () => {
        const h = makeHarness();
        h.busy.value = true;
        h.queue.enqueue({ key: "1", text: "甲", payload: "a" });
        h.queue.enqueue({ key: "2", text: "乙", payload: "b" });
        h.runAll();
        expect(h.delivered).toEqual([]);
        expect(h.pending()).toBe(2);

        h.busy.value = false;
        h.queue.setPaused(false);
        h.runAll();
        expect(h.delivered).toEqual(["a", "b"]);
        vi.useRealTimers();
    });

    it("挂起发生在「思考中」途中时，那条退回队首而不是被丢弃", () => {
        const h = makeHarness();
        h.queue.enqueue({ key: "1", text: "甲", payload: "a" });
        h.tick(500);                       // 思考中，还没落屏
        h.busy.value = true;
        h.queue.setPaused(true);
        h.runAll();
        expect(h.delivered).toEqual([]);
        expect(h.pending()).toBe(1);
        h.busy.value = false;
        h.queue.setPaused(false);
        h.runAll();
        expect(h.delivered).toEqual(["a"]);
        vi.useRealTimers();
    });

    it("同 id 重复入队是幂等的（轮询可能重复取到同一条）", () => {
        const h = makeHarness();
        expect(h.queue.enqueue({ key: "x", text: "一条", payload: "a" })).toBe(true);
        expect(h.queue.enqueue({ key: "x", text: "一条", payload: "a" })).toBe(false);
        h.runAll();
        expect(h.delivered).toEqual(["a"]);
        vi.useRealTimers();
    });

    it("溢出丢未出场的最旧一条并回调上报；正在「思考中」的那条不受影响", () => {
        vi.useFakeTimers();
        const delivered: string[] = [];
        const dropped: string[] = [];
        const queue = new ProactiveDeliveryQueue<string>({
            deliver: (p) => delivered.push(p),
            setTyping: () => {},
            isBusy: () => false,
            typingDelay: () => 10,
            maxQueueSize: 2,
            onOverflow: (item) => dropped.push(item.key),
        });
        // a 立刻进入「思考中」（占 1 个额度），于是 b、c 里必须有一条被挤掉
        ["a", "b", "c"].forEach((p, i) => queue.enqueue({ key: `k${i}`, text: p, payload: p }));
        vi.runAllTimers();
        expect(dropped).toEqual(["k1"]);
        expect(delivered).toEqual(["a", "c"]);
        vi.useRealTimers();
    });

    it("dropAll 清空未出场的候选，但已经落屏的消息不动", () => {
        const h = makeHarness();
        h.queue.enqueue({ key: "1", text: "甲", payload: "a" });
        h.tick(1000);                      // a 已落屏
        h.queue.enqueue({ key: "2", text: "乙", payload: "b" });
        h.queue.dropAll();
        h.runAll();
        expect(h.delivered).toEqual(["a"]);
        expect(h.pending()).toBe(0);
        vi.useRealTimers();
    });

    it("typing 状态成对出现，最后一轮一定回到 false（不会留下永久「她正在输入」）", () => {
        const h = makeHarness();
        h.queue.enqueue({ key: "1", text: "甲", payload: "a" });
        h.queue.enqueue({ key: "2", text: "乙", payload: "b" });
        h.runAll();
        expect(h.typing[0]).toBe(true);
        expect(h.typing[h.typing.length - 1]).toBe(false);
        expect(h.typing.filter((v) => v).length).toBe(2);
        vi.useRealTimers();
    });

    it("flush 立刻把队列全部落地，不等「思考中」", () => {
        const h = makeHarness();
        h.queue.enqueue({ key: "1", text: "甲", payload: "a" });
        h.queue.enqueue({ key: "2", text: "乙", payload: "b" });
        h.queue.flush();
        expect(h.delivered).toEqual(["a", "b"]);
        vi.useRealTimers();
    });
});

describe("defaultTypingDelay", () => {
    it("短消息不低于 800ms，长消息不越过 2000ms", () => {
        expect(defaultTypingDelay("想你了")).toBe(800);
        expect(defaultTypingDelay("x".repeat(100))).toBe(2000);
        // 30ms/字：40 字 = 1200ms，落在窗口内；20 字 = 600ms 会被抬到下限 800
        expect(defaultTypingDelay("x".repeat(40))).toBe(1200);
        expect(defaultTypingDelay("x".repeat(20))).toBe(800);
    });
});
