/**
 * backendWatcher.ts —— 「后端在不在」的状态机（B7-3）。
 *
 * 为什么需要它：后端是本机可独立开关的进程，而页面开着的时候它随时可能没起来 ——
 * 重启后端、改完代码热重启、端口被别的程序占掉。旧版表现是「对话框一片空白 +
 * 发消息报一句不明所以的失败」，而且**恢复之后不会自己回来**，用户必须刷新页面
 * 才会重新拉到历史、才会把浏览器里的 API Key 回灌给后端。
 *
 * 这里只做决策、不碰 DOM、不 import store/React：定时器与 ping 都从外面注入，
 * 于是能用假定时器写成完全确定性的测试（本项目一条硬规矩：新写的异步断言
 * 不许靠 sleep 撑，靠等待的断言在慢机器上会假失败）。
 */

export type BackendState = "unknown" | "online" | "offline";

export interface WatcherTimings {
    /** 在线时的巡检间隔（发现用户把后端关掉了） */
    onlineMs: number;
    /** 离线后的重试间隔 */
    offlineMs: number;
}

export const DEFAULT_TIMINGS: WatcherTimings = {
    // 在线时不必打得太密：/health 很轻，但它仍然是一次真实请求
    onlineMs: 60_000,
    // 计划里的验收口径就是 30 秒
    offlineMs: 30_000,
};

export interface BackendWatcherDeps {
    /** 返回 true = 后端活着。实现必须是「不发业务请求」的探活（GET /health） */
    ping: () => Promise<boolean>;
    /** 仅在 offline → online 的跳变上调用（恢复重同步就挂在这里） */
    onOnline: () => void;
    /** 仅在 → offline 的跳变上调用（横幅出现） */
    onOffline: () => void;
    /** 注册一次延时执行，返回取消函数。回调可以是 async（测试里要能 await 完那一轮） */
    schedule: (fn: () => void | Promise<void>, ms: number) => () => void;
    timings?: Partial<WatcherTimings>;
    /** 状态变化通知（给 store 用；每次探活结束都会调用，与跳变回调不同） */
    onStateChange?: (state: BackendState) => void;
}

export interface BackendWatcher {
    /** 启动并立刻探一次；返回那一轮的 promise（测试要能 await 到它落定，不靠等时间） */
    start: () => Promise<void>;
    stop: () => void;
    /** 任何请求撞上网络层失败时调用：立刻认定离线并提前重试 */
    notifyFailure: () => void;
    /** 手动「立即重试」 */
    checkNow: () => Promise<void>;
    state: () => BackendState;
}

export function createBackendWatcher(deps: BackendWatcherDeps): BackendWatcher {
    const timings: WatcherTimings = { ...DEFAULT_TIMINGS, ...(deps.timings ?? {}) };
    let state: BackendState = "unknown";
    let cancelTick: (() => void) | null = null;
    let started = false;
    /**
     * 每一轮探活发一个号。回包时要对上号才认：
     * 否则「用户点了立即重试」和「30 秒定时器到点」同时在跑，
     * 慢的那次回来会把新状态覆盖回旧的（stale 回写，跟 _stateGeneration 同一类坑）。
     */
    let generation = 0;

    const setState = (next: BackendState) => {
        if (state === next) return;
        const prev = state;
        state = next;
        deps.onStateChange?.(next);
        // 恢复回调只在 offline → online 上触发：首次进页面那一次连接成功不算「恢复」，
        // 否则会和 useBootstrap 刚做完的同步重复一遍（多一次 syncConfig + 两次拉取）。
        if (next === "online" && prev === "offline") deps.onOnline();
        // 进入离线（包括第一次探活就失败）都要告知：那时候用户确实正被挡在门外
        if (next === "offline") deps.onOffline();
    };

    const clearTick = () => {
        if (cancelTick) {
            cancelTick();
            cancelTick = null;
        }
    };

    const armNextTick = () => {
        clearTick();
        const ms = state === "offline" ? timings.offlineMs : timings.onlineMs;
        cancelTick = deps.schedule(() => probe(), ms);
    };

    async function probe(): Promise<void> {
        if (!started) return;
        const epoch = ++generation;
        let alive: boolean;
        try {
            alive = await deps.ping();
        } catch {
            // ping 自己抛异常（连不上、超时、非 2xx）都算「不在线」，
            // 绝不能让它把 watcher 打断 —— 探针坏了不等于后端在线
            alive = false;
        }
        // 这一轮已经被更新的一轮（或 stop）取代，丢弃结果
        if (!started || epoch !== generation) return;
        // unknown 探活失败也算离线：页面开着而后端没起来，本来就该显示横幅
        setState(alive ? "online" : "offline");
        armNextTick();
    }

    return {
        start() {
            if (started) return Promise.resolve();
            started = true;
            return probe();
        },
        stop() {
            started = false;
            // 让所有在途回包作废
            generation++;
            clearTick();
        },
        notifyFailure() {
            if (!started) return;
            // 请求层面的网络失败比探活更权威：立刻离线，并把下一次重试提前
            if (state !== "offline") {
                setState("offline");
            }
            armNextTick();
        },
        async checkNow() {
            await probe();
        },
        state: () => state,
    };
}

/** 横幅文案：只有「确认离线」才说「后端未就绪」，unknown 阶段不吓人 */
export function offlineBannerText(state: BackendState): string | null {
    if (state !== "offline") return null;
    return "后端没有响应（默认 8000 端口）。小爱听不到你说话，但你的聊天记录都还在本机；"
        + "启动后端后这里会自动恢复，不需要刷新页面。";
}
