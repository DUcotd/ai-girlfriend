import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api";
import { toApiError } from "@/lib/apiError";
import { createOptimisticTracker } from "@/lib/optimisticTracker";
import { usePersonalityStore } from "@/stores/personalityStore";
import type {
  PersonalityDimKey,
  PersonalityLedgerEntry,
  PersonalityState,
  PersonalityUpdatePayload,
} from "@/types";

/** 拖动滑块的 debounce 窗口：同一窗口内多维度改动合并为一次提交 */
const DEBOUNCE_MS = 300;

/** usePersonality 的返回值（供 SettingsDialog 持有后下发给性格 Tab） */
export interface PersonalityController {
  state: PersonalityState | null;
  ledger: PersonalityLedgerEntry[];
  /**
   * 「今天 / 昨天」判定的当前时间戳。
   * ⚠️ Date.now() 非纯函数，禁止在 render 期调用——只在数据到达的异步回调里刷新，
   * 与 ledger 的更新节奏保持一致。
   */
  now: number | null;
  loading: boolean;
  /** 挂载拉取失败：Tab 据此显示错误态，而不是把失败渲染成永久的「正在读取」 */
  loadFailed: boolean;
  /** 拖动滑块：乐观更新 + 300ms debounce 合并提交（失败时回滚到拖之前的值） */
  setDim: (dim: PersonalityDimKey, value: number) => void;
  /** 切换预设：取消 pending 的滑块改动，单独一拍提交 { presetId } */
  applyPreset: (presetId: string) => void;
  /** 漂移 / 基线沉淀开关（即时提交） */
  setFlags: (flags: Pick<PersonalityUpdatePayload, "driftEnabled" | "baselineAdaptEnabled">) => void;
  /** 恢复默认预设（POST /personality/reset）；返回是否成功 */
  reset: () => Promise<boolean>;
  /**
   * 立刻提交 debounce 窗口里攒着的滑块改动。
   * 关窗前与卸载前都必须调一次：否则「拖完滑块马上关设置页」会把这次改动
   * 留在内存里被 clearTimeout 掉，界面显示的是新值、后端记的是旧值（FE-07）。
   */
  flush: () => void;
}

/**
 * 性格状态与提交 Hook。
 *
 * - 挂载时拉取状态 + 账本（setState 全部在异步回调里，effect 同步体零 setState）
 * - 拖滑块：本地乐观更新 baseline → 300ms debounce 合并成一个 traits 对象提交
 * - **提交失败就回滚**：把乐观改过的维度恢复成改动前的值（FE-07）。
 *   不回滚的后果是「界面显示她已经变得很黏人，后端其实没存上」——
 *   下一次成功提交会把没落盘的期望当成现状，用户完全看不出哪里错了。
 * - 请求序号 last-write-wins：快速连续提交时过期响应直接丢弃，防止滑块回退
 * - 切预设独立一拍：clearTimeout + 清空 pending，不与 traits 混合提交
 */
export function usePersonality(): PersonalityController {
  const state = usePersonalityStore((s) => s.state);
  const ledger = usePersonalityStore((s) => s.ledger);
  const applyState = usePersonalityStore((s) => s.applyState);
  const applyLedger = usePersonalityStore((s) => s.applyLedger);
  const patchBaseline = usePersonalityStore((s) => s.patchBaseline);

  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [now, setNow] = useState<number | null>(null);

  // ⚠️ ref 只在事件回调 / effect 中读写，不在 render 期访问（React 19 Compiler 红线）
  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Partial<Record<PersonalityDimKey, number>>>({});
  /**
   * 乐观更新前记住的**原值**（规则见 lib/optimisticTracker）：
   * 提交失败时按这份回滚，用户看到的就是后端真实值。
   */
  const trackerRef = useRef(createOptimisticTracker<PersonalityDimKey>());
  const tracker = trackerRef.current;

  const showToast = useToast();

  /** 把乐观改动的维度恢复成原值 */
  const rollback = useCallback(() => {
    for (const [dim, value] of tracker.entries()) {
      patchBaseline(dim, value);
    }
    tracker.clear();
  }, [patchBaseline, tracker]);

  /**
   * 统一提交：请求序号 last-write-wins——响应回来时若已有更新的提交（seq 不匹配），
   * 整体丢弃，避免旧响应把新状态顶回去。
   */
  const commit = useCallback(
    async (payload: PersonalityUpdatePayload) => {
      const seq = ++seqRef.current;
      try {
        const next = await api.updatePersonality(payload);
        if (seq !== seqRef.current) return;
        applyState(next);
        // 服务端已确认：这批乐观改动的原值不再需要（此后失败要回滚的是更新的拖动）
        tracker.clear();
        const entries = await api.getPersonalityLedger();
        if (seq !== seqRef.current) return;
        applyLedger(entries);
        setNow(Date.now());
      } catch (error) {
        if (seq !== seqRef.current) return;
        rollback();
        const err = toApiError(error);
        showToast(`性格保存失败：${err.userMessage || "请检查后端连接"}`, "error");
      }
    },
    [applyState, applyLedger, rollback, showToast, tracker]
  );

  /** 立即提交 debounce 窗口里攒着的改动（关窗 / 卸载 / 切预设前调用） */
  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const traits = pendingRef.current;
    pendingRef.current = {};
    if (Object.keys(traits).length > 0) void commit({ traits });
  }, [commit]);

  /** 拖动：本地乐观更新（把手立即跟手）+ debounce 合并提交 */
  const setDim = useCallback(
    (dim: PersonalityDimKey, value: number) => {
      // 记下原值（同一轮里只有第一次有效），失败时靠它回滚
      const current = usePersonalityStore.getState().state?.baseline?.[dim];
      if (typeof current === "number") tracker.note(dim, current);
      patchBaseline(dim, value);
      pendingRef.current = { ...pendingRef.current, [dim]: value };
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, DEBOUNCE_MS);
    },
    [patchBaseline, flush, tracker]
  );

  /** 切预设：取消尚未提交的滑块改动（防止 traits 与 presetId 语义打架），独立一拍 */
  const applyPreset = useCallback(
    (presetId: string) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      pendingRef.current = {};
      tracker.clear();
      void commit({ presetId });
    },
    [commit, tracker]
  );

  /** 开关即时提交 */
  const setFlags = useCallback(
    (flags: Pick<PersonalityUpdatePayload, "driftEnabled" | "baselineAdaptEnabled">) => {
      void commit(flags);
    },
    [commit]
  );

  /** 恢复默认预设 + 清空账本（后端保留漂移开关与统计） */
  const reset = useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      const next = await api.resetPersonality();
      if (seq !== seqRef.current) return false;
      applyState(next);
      applyLedger(next.ledger ?? []);
      tracker.clear();
      setNow(Date.now());
      return true;
    } catch (error) {
      const err = toApiError(error);
      showToast(`性格重置失败：${err.userMessage || "请检查后端连接"}`, "error");
      return false;
    }
  }, [applyState, applyLedger, showToast, tracker]);

  // 挂载拉取：setState 全在 .then 里（effect 同步体零 setState）
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getPersonality(), api.getPersonalityLedger()])
      .then(([nextState, entries]) => {
        if (cancelled) return;
        applyState(nextState);
        applyLedger(entries);
        setNow(Date.now());
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoading(false);
        setLoadFailed(true);
        console.error("Failed to fetch personality:", e);
        // 失败必须可见：否则 Tab 对 state===null 一律渲染「正在读取…」，
        // 用户看到的是永不结束的假加载
        showToast("性格状态读取失败，请检查后端连接", "error");
      });
    return () => {
      cancelled = true;
    };
  }, [applyState, applyLedger, showToast]);

  /**
   * 卸载前 flush：把 debounce 窗口里攒着的滑块改动**真的发出去**。
   * fetch 一旦发出就不依赖组件还活着，所以这里不需要 `await` 也保证不丢改动；
   * 反过来如果只 clearTimeout（旧写法），拖完滑块立刻关设置页就是静默丢弃。
   */
  useEffect(() => flush, [flush]);

  return { state, ledger, now, loading, loadFailed, setDim, applyPreset, setFlags, reset, flush };
}
