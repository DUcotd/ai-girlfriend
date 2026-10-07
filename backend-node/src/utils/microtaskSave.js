/**
 * microtaskSave —— 引擎级「微任务去抖落盘」（B8-5，审计 CORE-23）。
 *
 * 一轮成功对话原本触发 **9-13 次同步 writeJson + JSON.stringify(…, null, 2)**：
 * emotion_state.json 一轮写 4 次（updateBaselineForAffinity / applyDelta / decay /
 * setState 各自落盘），affinity_state.json 1-2 次，personality_state.json 1-2 次 ——
 * 其中 6 次卡在「最后一个 delta 帧」与 `done` 帧之间，用户等的那段时间里
 * 有几十毫秒纯粹花在同步写盘上（一次全量 stringify 就是几十毫秒）。
 *
 * 做法：状态变更只标脏 + 排一个微任务（微任务在**本轮同步执行结束后**就跑，
 * 不引入定时器，也就不引入任何「等一等再看」的测试），于是一轮之内同一引擎最多写一次；
 * `AiGirlfriend._finalize` 收尾再显式 flush 全部引擎一次，
 * 保证「响应返回时磁盘已经是本轮的真值」。
 *
 * ⚠️ 契约**逐字照抄** MemoryStore 的 scheduleSave/flush（B0-6 后半）：
 *   - flushSave() 返回布尔：false = 真的没落盘，调用方必须计入失败面，不许当成功；
 *   - 写失败时**保持脏标记**，下一次 flush / 下一轮还会重试；
 *   - 无待写数据时 flush 视为已完成（返回 true，不产生多余写盘）。
 *
 * 为什么是微任务而不是 setTimeout 去抖：引擎的落盘目标是「本轮结束即一致」，
 * 不是「跨请求合并」——跨请求合并会让 resetAll / 档案导出读到中间态。
 *
 * 重置纪律（B0-7 / B0-12）：引擎的 reset() 一律**同步**落盘（写的是重置后的真值），
 * 之后残留在微任务里的那次 flush 要么因为不脏而 no-op、要么再写一次同样的真值 ——
 * 两种都不会把重置前的旧状态写回去。
 */

/**
 * 给引擎装上 scheduleSave / flushSave / saveNow。
 * @param {object} engine 必须有 `_saveState(): boolean`
 * @param {string} label 日志用的引擎名（不含任何用户内容）
 * @returns {object} 同一个 engine（便于链式写法）
 */
export function withDebouncedSave(engine, label) {
    engine._saveDirty = false;
    engine._saveQueued = false;
    engine._saveLabel = label;

    /** 标脏 + 排一个微任务（同一轮内重复调用只排一次）。@returns {boolean} 是否新排了任务 */
    engine.scheduleSave = function scheduleSave() {
        this._saveDirty = true;
        if (this._saveQueued) return false;
        this._saveQueued = true;
        queueMicrotask(() => {
            this._saveQueued = false;
            // 微任务里写失败也保持脏：下一轮或停机 flush 会再试（B0-6）
            this.flushSave();
        });
        return true;
    };

    /** 立即落盘（幂等）。@returns {boolean} 是否已经把当前真值写到磁盘 */
    engine.flushSave = function flushSave() {
        if (!this._saveDirty) return true;
        this._saveDirty = false;
        let ok = false;
        try {
            ok = this._saveState() !== false;
        } catch (e) {
            console.error(`[Save] ${this._saveLabel} 落盘抛错：${e?.message || e}`);
            ok = false;
        }
        if (!ok) {
            this._saveDirty = true;         // 没写成功就仍然算脏，下次继续尝试
            console.error(`[Save] ${this._saveLabel} 落盘失败，本次修改未持久化（保持脏标记待重试）`);
        }
        return ok;
    };

    /** 是否有未落盘的变更（观测/断言用） */
    engine.isSaveDirty = function isSaveDirty() {
        return !!this._saveDirty;
    };

    /** 同步落盘并清脏标记（reset / 导出前用：写的必须是重置后的真值） */
    engine.saveNow = function saveNow() {
        this._saveDirty = false;
        return this._saveState() !== false;
    };

    return engine;
}
