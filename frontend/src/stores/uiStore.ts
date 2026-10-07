import { create } from "zustand";
import type { DialogName } from "@/app/dialogs";
import type { BackendState } from "@/lib/backendWatcher";

export type ToastType = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

let toastSeq = 0;

interface UiState {
  dialog: DialogName | null;
  voiceMode: boolean;
  autoSendVoice: boolean;
  isSidebarOpen: boolean;
  isTypingProactive: boolean;
  /**
   * 后端可达性（B7-3）。`unknown` 是「还没探过」，故意不与 `offline` 混为一谈：
   * 页面刚打开就弹「后端未就绪」会在正常慢启动场景里骗人。
   */
  backendState: BackendState;
  toasts: ToastItem[];
  openDialog: (name: DialogName) => void;
  closeDialog: () => void;
  toggleVoiceMode: () => void;
  toggleAutoSendVoice: () => void;
  setSidebarOpen: (open: boolean) => void;
  setTypingProactive: (value: boolean) => void;
  setBackendState: (state: BackendState) => void;
  pushToast: (message: string, type?: ToastType) => void;
  dismissToast: (id: number) => void;
}

/** 界面状态（不持久化）。toast 全局唯一，由 ToastViewport 渲染。 */
export const useUiStore = create<UiState>()((set) => ({
  dialog: null,
  voiceMode: false,
  autoSendVoice: true,
  isSidebarOpen: false,
  isTypingProactive: false,
  backendState: "unknown",
  toasts: [],
  openDialog: (name) => set({ dialog: name }),
  closeDialog: () => set({ dialog: null }),
  toggleVoiceMode: () => set((s) => ({ voiceMode: !s.voiceMode })),
  toggleAutoSendVoice: () => set((s) => ({ autoSendVoice: !s.autoSendVoice })),
  setSidebarOpen: (open) => set({ isSidebarOpen: open }),
  setTypingProactive: (value) => set({ isTypingProactive: value }),
  setBackendState: (state) => set({ backendState: state }),
  pushToast: (message, type = "info") =>
    set((s) => ({ toasts: [...s.toasts, { id: ++toastSeq, message, type }] })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** 非组件环境（store action、轮询回调）也能调用的全局 toast 入口 */
export const toast = (message: string, type: ToastType = "info"): void => {
  useUiStore.getState().pushToast(message, type);
};
