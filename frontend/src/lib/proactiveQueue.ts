/**
 * 主动消息投递队列（FE-02 / FE-03）。
 *
 * 旧写法每条主动消息都用同一个 `proactiveTimer`，新消息进来先 `clearTimeout` 旧的
 * ——「思考中」还没结束就被下一条顶掉，前一条**永远不会出现在屏幕上**（丢消息）。
 * 这里改成严格 FIFO：
 *  - 入队永不取消已排队的条目，只可能整体延后；
 *  - 流式回复进行中（`isBusy`）时挂起出队，等这一轮说完再按原顺序补投，
 *    这样主动消息不会插进正在逐字流出的气泡中间；
 *  - 队列有上限（默认 20）：她是「想起一件事」，不是把整个 backlog 一次倒给用户，
 *    溢出时丢最旧的一条并计数上报（丢的只是尚未出场的候选，不是已生成的消息）。
 *
 * 定时器与「是否忙碌」都从外部注入，因此测试不需要 sleep 也能确定性推进。
 */

export interface ProactiveQueueItem<T> {
    /** 消息 id，用于同 id 重复入队时幂等（后端轮询可能重复取到同一条） */
    key: string;
    /** 「思考中」时长按正文长度计算所需的文本 */
    text: string;
    /** 交给上层真正投递的载荷 */
    payload: T;
}

export interface ProactiveQueueDeps<T> {
    /** 真正落屏：上层在这里 push 气泡 */
    deliver: (payload: T) => void;
    setTyping: (on: boolean) => void;
    /** 忙碌 = 流式回复进行中，出队挂起 */
    isBusy: () => boolean;
    /** 按字数算的「思考中」时长 */
    typingDelay: (text: string) => number;
    setTimeoutFn?: (fn: () => void, ms: number) => unknown;
    clearTimeoutFn?: (handle: unknown) => void;
    maxQueueSize?: number;
    /** 溢出丢弃时的回调（只用于日志，绝不静默丢） */
    onOverflow?: (dropped: ProactiveQueueItem<T>) => void;
}

/** 默认打字时长：与改造前 page.tsx 的编排一致（0.8~2s，随字数线性） */
export const defaultTypingDelay = (text: string) =>
    Math.min(2000, Math.max(800, text.length * 30));

export class ProactiveDeliveryQueue<T> {
    private deps: ProactiveQueueDeps<T>;
    private queue: ProactiveQueueItem<T>[] = [];
    private timer: unknown = null;
    private typingTimer: unknown = null;
    private keys = new Set<string>();
    /** 挂起计数：>0 时绝不出队（流式进行中 / 页面主动暂停） */
    private paused = 0;
    private disposed = false;
    /** 已出队但尚未落屏（正在「思考中」）的那条，挂起时回到队首不算丢 */
    private inFlight: ProactiveQueueItem<T> | null = null;

    constructor(deps: ProactiveQueueDeps<T>) {
        // 不注入定时器就等于用真的 setTimeout：调用方（chatStore）确实不该关心这件事，
        // 但队列**必须**能跑起来 —— 少一层默认值就是「主动消息永远不上屏」。
        this.deps = {
            setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
            clearTimeoutFn: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
            ...deps,
        };
    }

    get size(): number {
        return this.queue.length + (this.inFlight ? 1 : 0);
    }

    /** 入队：同 key 幂等；溢出丢**未出场的**最旧一条并回调上报（正在「思考中」的那条不动） */
    enqueue(item: ProactiveQueueItem<T>): boolean {
        if (this.disposed) return false;
        if (this.keys.has(item.key)) return false;
        this.keys.add(item.key);
        this.queue.push(item);
        const max = this.deps.maxQueueSize ?? 20;
        // 上限算的是「总共还欠用户几条」= 队列 + 正在思考中的那条；
        // 只约束 array 会让实际上限变成 max+1，那条差别在长会话里就是「她多说了一句」
        while (this.size > max) {
            const dropped = this.queue.shift();
            if (!dropped) break;
            this.keys.delete(dropped.key);
            this.deps.onOverflow?.(dropped);
        }
        this.scheduleNext();
        return true;
    }

    /** 忙碌/暂停时调用；多次 pause 由 resume 配平 */
    pause(): void {
        this.paused += 1;
        // 正在「思考中」的那条退回队首，等恢复后继续投 —— 不是取消投递
        this.recallInFlight();
        this.cancelTimer();
    }

    resume(): void {
        if (this.paused > 0) this.paused -= 1;
        if (this.paused === 0) this.scheduleNext();
    }

    /** 外部探到「流式结束了」但没走 resume 配对时的复位（例如发送流程异常退出） */
    setPaused(busy: boolean): void {
        if (busy) {
            this.paused = Math.max(1, this.paused);
            this.recallInFlight();
            this.cancelTimer();
        } else {
            this.paused = 0;
            this.scheduleNext();
        }
    }

    /**
     * 丢弃全部未出场的候选（「新对话」用）：这些消息说的是已经被清掉的那段对话，
     * 补投进空白聊天只会让人以为她还在聊刚才的事。**已落屏的消息不动。**
     */
    dropAll(): void {
        this.cancelTimer();
        if (this.typingTimer !== null) {
            this.clearTypingTimer();
            this.deps.setTyping(false);
        }
        this.queue = [];
        this.inFlight = null;
        this.keys.clear();
    }

    /** 页面卸载/切走：清空未出场的候选并停掉所有定时器（已落屏的消息不动） */
    dispose(): void {
        this.disposed = true;
        this.dropAll();
    }

    /** 立即把队列里的东西全部投完（测试与「用户主动要求立刻看」用） */
    flush(): void {
        this.cancelTimer();
        this.recallInFlight();
        while (this.queue.length > 0) {
            const item = this.queue.shift();
            if (!item) break;
            this.keys.delete(item.key);
            this.deps.setTyping(false);
            this.deps.deliver(item.payload);
        }
    }

    private recallInFlight(): void {
        if (this.typingTimer !== null) {
            this.clearTypingTimer();
            this.deps.setTyping(false);
        }
        if (this.inFlight) {
            this.queue.unshift(this.inFlight);
            this.inFlight = null;
        }
    }

    private cancelTimer(): void {
        if (this.timer !== null) {
            this.deps.clearTimeoutFn?.(this.timer);
            this.timer = null;
        }
    }

    private clearTypingTimer(): void {
        if (this.typingTimer !== null) {
            this.deps.clearTimeoutFn?.(this.typingTimer);
            this.typingTimer = null;
        }
    }

    private scheduleNext(): void {
        if (this.disposed || this.paused > 0 || this.timer !== null) return;
        if (this.deps.isBusy()) {
            // 流式中不出队；等 resume/setPaused(false) 再排
            this.recallInFlight();
            return;
        }
        const next = this.queue.shift();
        if (!next) return;
        this.inFlight = next;
        this.deps.setTyping(true);
        // 先排下一场的定时器，出队链不会因为一次交付异常而断掉
        this.timer = this.deps.setTimeoutFn?.(() => {
            this.timer = null;
            this.inFlight = null;
            this.deps.setTyping(false);
            this.keys.delete(next.key);
            this.deps.deliver(next.payload);
            this.scheduleNext();
        }, this.deps.typingDelay(next.text));
    }
}
