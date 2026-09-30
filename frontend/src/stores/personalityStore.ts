import { create } from "zustand";
import type { PersonalityDimKey, PersonalityLedgerEntry, PersonalityState } from "@/types";

interface PersonalityStoreState {
  /** 后端公开状态（GET /personality 的返回），null = 尚未拉取 */
  state: PersonalityState | null;
  /** 变化账本（时间升序 ≤200） */
  ledger: PersonalityLedgerEntry[];
  /** 用服务端返回值整体覆盖本地（后端是真源，含 clamp 结果） */
  applyState: (next: PersonalityState) => void;
  applyLedger: (entries: PersonalityLedgerEntry[]) => void;
  /**
   * 拖动滑块时的乐观更新：只改 baseline，让把手立即跟手；
   * current 与 clamp 结果等服务端响应回来后再覆盖。
   */
  patchBaseline: (dim: PersonalityDimKey, value: number) => void;
}

/**
 * 性格运行时状态（真源在后端 personality_state.json）。
 * ⚠️ 不用 persist 中间件、不落 localStorage——后端运行时状态，Tab 挂载时拉取。
 */
export const usePersonalityStore = create<PersonalityStoreState>()((setStore) => ({
  state: null,
  ledger: [],
  applyState: (next) => setStore({ state: next }),
  applyLedger: (entries) => setStore({ ledger: entries }),
  patchBaseline: (dim, value) =>
    setStore((prev) => {
      if (!prev.state) return prev;
      return {
        state: {
          ...prev.state,
          baseline: { ...prev.state.baseline, [dim]: value },
        },
      };
    }),
}));
