import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api";
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
  /** 拖动滑块：乐观更新 + 300ms debounce 合并提交 */
  setDim: (dim: PersonalityDimKey, value: number) => void;
  /** 切换预设：取消 pending 的滑块改动，单独一拍提交 { presetId } */
  applyPreset: (presetId: string) => void;
  /** 漂移 / 基线沉淀开关（即时提交） */
  setFlags: (flags: Pick<PersonalityUpdatePayload, "driftEnabled" | "baselineAdaptEnabled">) => void;
  /** 恢复默认预设（POST /personality/reset）；返回是否成功 */
  reset: () => Promise<boolean>;
}

/**
 * 性格状态与提交 Hook。
 *
 * - 挂载时拉取状态 + 账本（setState 全部在异步回调里，effect 同步体零 setState）
 * - 拖滑块：本地乐观更新 baseline → 300ms debounce 合并成一个 traits 对象提交
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

  const showToast = useToast();

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
        const entries = await api.getPersonalityLedger();
        if (seq !== seqRef.current) return;
        applyLedger(entries);
        setNow(Date.now());
      } catch {
        showToast("性格保存失败，请检查后端连接", "error");
      }
    },
    [applyState, applyLedger, showToast]
  );

  /** 拖动：本地乐观更新（把手立即跟手）+ debounce 合并提交 */
  const setDim = useCallback(
    (dim: PersonalityDimKey, value: number) => {
      patchBaseline(dim, value);
      pendingRef.current = { ...pendingRef.current, [dim]: value };
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const traits = pendingRef.current;
        pendingRef.current = {};
        if (Object.keys(traits).length > 0) void commit({ traits });
      }, DEBOUNCE_MS);
    },
    [patchBaseline, commit]
  );

  /** 切预设：取消尚未提交的滑块改动（防止 traits 与 presetId 语义打架），独立一拍 */
  const applyPreset = useCallback(
    (presetId: string) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      pendingRef.current = {};
      void commit({ presetId });
    },
    [commit]
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
      setNow(Date.now());
      return true;
    } catch {
      showToast("性格重置失败，请检查后端连接", "error");
      return false;
    }
  }, [applyState, applyLedger, showToast]);

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

  // 卸载时清理未触发的 debounce 定时器
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { state, ledger, now, loading, loadFailed, setDim, applyPreset, setFlags, reset };
}
