import { describe, expect, it } from "vitest";
import {
    DEFAULT_TIMINGS,
    createBackendWatcher,
    offlineBannerText,
    type BackendState,
} from "@/lib/backendWatcher";

/**
 * backendWatcher 的确定性测试（B7-3）。
 *
 * 全部用注入的假定时器 + 可控 ping，**没有一个「等一会儿」** —— 靠等待撑起来的断言
 * 验证的是本机调度器而不是代码（本项目在 CI 的 2 核 runner 上为这个吃过亏）。
 * `start()` / `checkNow()` 都把那一轮的 promise 交出来，就是为了这里能 await 到落定。
 */

interface Pending {
    ms: number;
    run: () => Promise<void>;
}

function makeHarness(initialAlive = true) {
    const pending: Pending[] = [];
    const states: BackendState[] = [];
    const waiters: ((v: boolean) => void)[] = [];
    let onlineCalls = 0;
    let offlineCalls = 0;
    let alive = initialAlive;
    /** 手动模式：ping 不自动返回，由测试决定谁先回（用来造「旧回包晚到」的竞态） */
    let manual = false;
    let rejecting = false;

    const ping = () => {
        if (rejecting) return Promise.reject(new Error("探针自己炸了"));
        if (manual) return new Promise<boolean>((resolve) => waiters.push(resolve));
        return Promise.resolve(alive);
    };

    const watcher = createBackendWatcher({
        ping,
        onOnline: () => { onlineCalls++; },
        onOffline: () => { offlineCalls++; },
        onStateChange: (s) => { states.push(s); },
        schedule: (fn, ms) => {
            const entry: Pending = { ms, run: async () => { await fn(); } };
            pending.push(entry);
            return () => {
                const i = pending.indexOf(entry);
                if (i >= 0) pending.splice(i, 1);
            };
        },
    });

    return {
        watcher,
        pending,
        states,
        counts: () => ({ onlineCalls, offlineCalls }),
        setAlive: (v: boolean) => { alive = v; },
        setManual: (v: boolean) => { manual = v; },
        setRejecting: (v: boolean) => { rejecting = v; },
        resolveAll(value: boolean) {
            alive = value;
            while (waiters.length) waiters.shift()?.(value);
        },
        /** 只回第 index 个在途探活（0 是 start() 那一轮） */
        resolveAt(index: number, value: boolean) {
            const waiter = waiters.splice(index, 1)[0];
            if (!waiter) throw new Error(`没有在途的第 ${index} 轮探活`);
            alive = value;
            waiter(value);
        },
        /** 跑掉最近排定的那一次定时器（等于「时间到了」） */
        async runLast() {
            const entry = pending.pop();
            if (!entry) throw new Error("没有排定的探活（定时器被取消或从未安排）");
            await entry.run();
        },
        nextDelay: () => pending[pending.length - 1]?.ms,
    };
}

describe("启动与首次探活", () => {
    it("start() 立刻探一次；第一次就连上不算「恢复」", async () => {
        const h = makeHarness(true);
        await h.watcher.start();
        expect(h.watcher.state()).toBe("online");
        expect(h.counts()).toEqual({ onlineCalls: 0, offlineCalls: 0 });
        expect(h.states).toEqual(["online"]);
    });

    it("start() 幂等：重复调用不会再排一份定时器", async () => {
        const h = makeHarness(true);
        await h.watcher.start();
        await h.watcher.start();
        expect(h.pending).toHaveLength(1);
    });

    it("页面打开时后端还没起 → 判离线并告知一次", async () => {
        const h = makeHarness(false);
        await h.watcher.start();
        expect(h.watcher.state()).toBe("offline");
        expect(h.counts().offlineCalls).toBe(1);
    });

    it("在线按 onlineMs 巡检，离线按 offlineMs 重试", async () => {
        const h = makeHarness(true);
        await h.watcher.start();
        expect(h.nextDelay()).toBe(DEFAULT_TIMINGS.onlineMs);
        h.setAlive(false);
        await h.runLast();                       // 在线巡检发现后端没了
        expect(h.watcher.state()).toBe("offline");
        expect(h.nextDelay()).toBe(DEFAULT_TIMINGS.offlineMs);
    });

    it("验收口径就是「离线 30 秒重试一次」", () => {
        expect(DEFAULT_TIMINGS.offlineMs).toBe(30_000);
    });
});

describe("离线 → 恢复", () => {
    it("恢复时只回调一次（重同步就挂在这个跳变上）", async () => {
        const h = makeHarness(false);
        await h.watcher.start();
        h.setAlive(true);
        await h.runLast();                       // 30 秒到点，后端回来了
        expect(h.watcher.state()).toBe("online");
        expect(h.counts()).toEqual({ onlineCalls: 1, offlineCalls: 1 });
    });

    it("恢复之后继续成功，不会反复触发恢复回调", async () => {
        const h = makeHarness(false);
        await h.watcher.start();
        h.setAlive(true);
        await h.runLast();
        await h.runLast();                       // 在线巡检
        await h.runLast();
        expect(h.counts().onlineCalls).toBe(1);
        expect(h.watcher.state()).toBe("online");
    });

    it("恢复后立刻挂回在线节奏，而不是继续 30 秒一探", async () => {
        const h = makeHarness(false);
        await h.watcher.start();
        expect(h.nextDelay()).toBe(DEFAULT_TIMINGS.offlineMs);
        h.setAlive(true);
        await h.runLast();
        expect(h.nextDelay()).toBe(DEFAULT_TIMINGS.onlineMs);
    });

    it("掉线 → 恢复 → 再掉线，跳变各计两次", async () => {
        const h = makeHarness(true);
        await h.watcher.start();
        h.setAlive(false);
        await h.runLast();
        h.setAlive(true);
        await h.runLast();
        h.setAlive(false);
        await h.runLast();
        expect(h.counts()).toEqual({ onlineCalls: 1, offlineCalls: 2 });
        expect(h.states).toEqual(["online", "offline", "online", "offline"]);
    });
});

describe("请求层失败提前判定离线（notifyFailure）", () => {
    it("在途请求撞上网络失败 → 不等定时器立刻离线，并把旧定时器换成 30 秒那一轮", async () => {
        const h = makeHarness(true);
        await h.watcher.start();
        expect(h.pending).toHaveLength(1);

        h.watcher.notifyFailure();
        expect(h.watcher.state()).toBe("offline");
        expect(h.counts().offlineCalls).toBe(1);
        // 旧的 60 秒巡检必须被取消，只留新的那一个（否则会两条时间线并行探活）
        expect(h.pending).toHaveLength(1);
        expect(h.nextDelay()).toBe(DEFAULT_TIMINGS.offlineMs);
    });

    it("已经离线时再撞失败不重复告知（不然每条消息都弹一次）", async () => {
        const h = makeHarness(false);
        await h.watcher.start();
        expect(h.counts().offlineCalls).toBe(1);
        h.watcher.notifyFailure();
        h.watcher.notifyFailure();
        expect(h.counts().offlineCalls).toBe(1);
    });

    it("没启动时 notifyFailure 什么都不做（组件卸载后不许再改状态）", () => {
        const h = makeHarness(false);
        h.watcher.notifyFailure();
        expect(h.watcher.state()).toBe("unknown");
        expect(h.pending).toHaveLength(0);
    });
});

describe("竞态与清理", () => {
    it("慢回包不能覆盖新状态：旧那轮即使回「在线」也必须作废", async () => {
        const h = makeHarness(true);
        h.setManual(true);
        const startProbe = h.watcher.start();    // 第 1 轮在途（最终会回 true）
        expect(h.pending).toHaveLength(0);

        const secondProbe = h.watcher.checkNow();  // 第 2 轮
        h.resolveAt(1, false);                     // 第 2 轮先回 → 判离线
        await secondProbe;
        expect(h.watcher.state()).toBe("offline");

        h.resolveAt(0, true);                      // 现在才回的第 1 轮
        await startProbe;
        expect(h.watcher.state()).toBe("offline");
        // 真正抓 bug 的是这两条：状态机只要被旧回包污染过一次，就会出现 online 跳变
        expect(h.states).toEqual(["offline"]);
        expect(h.counts().onlineCalls).toBe(0);
    });

    it("stop() 之后在途回包被丢弃，且不再有排定的探活", async () => {
        const h = makeHarness(true);
        h.setManual(true);
        const startProbe = h.watcher.start();
        h.watcher.stop();
        h.resolveAll(true);
        await startProbe;
        expect(h.watcher.state()).toBe("unknown");
        expect(h.pending).toHaveLength(0);
        expect(h.states).toEqual([]);
    });

    it("ping 自己抛异常 = 判离线，绝不把 watcher 打断", async () => {
        const h = makeHarness(true);
        h.setRejecting(true);
        await h.watcher.start();
        expect(h.watcher.state()).toBe("offline");
        expect(h.counts().offlineCalls).toBe(1);
        expect(h.nextDelay()).toBe(DEFAULT_TIMINGS.offlineMs);
    });

    it("checkNow() 立刻探一次，不用等定时器", async () => {
        const h = makeHarness(false);
        await h.watcher.start();
        h.setAlive(true);
        await h.watcher.checkNow();
        expect(h.watcher.state()).toBe("online");
    });
});

describe("横幅文案只在确认离线时出现", () => {
    it("unknown / online 不给文案（否则每次刷新都会闪一下假故障）", () => {
        expect(offlineBannerText("unknown")).toBeNull();
        expect(offlineBannerText("online")).toBeNull();
    });

    it("offline 的文案同时说明「数据没丢」和「不用刷新」", () => {
        const text = offlineBannerText("offline") ?? "";
        expect(text).toContain("后端");
        expect(text).toContain("不需要刷新");
    });
});
