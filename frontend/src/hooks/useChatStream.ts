import { api } from "@/lib/api";
import { useTaskStore } from "@/stores/taskStore";
import { toast, useUiStore } from "@/stores/uiStore";
import type { ChatResponse } from "@/types";

const REQUEST_TIMEOUT_MS = 60_000;

/**
 * 全局朗读者桥：useSpeech（组件 hook）注册实现，
 * 发送管线/主动消息轮询（非组件环境）经此调用，避免 store 反向依赖组件。
 */
let speakFn: ((text: string) => void) | null = null;
export const speakBus = {
  register(fn: ((text: string) => void) | null) {
    speakFn = fn;
  },
  speak(text: string) {
    speakFn?.(text);
  },
};

export interface StreamHandlers {
  /** 流式增量：往占位气泡追加文本 */
  appendDelta: (chunk: string) => void;
  /** 收尾：把占位替换成最终内容并挂内心独白 */
  finishWith: (content: string, thought?: string | null) => void;
  /** Ghosting：把占位换成系统提示 */
  markGhosting: () => void;
  /** 应用情绪/好感度/PAD 元数据 */
  applyMeta: (data: Partial<ChatResponse>) => void;
}

/** Applies a task action returned with the completed chat response. */
function settleTaskResult(data: ChatResponse): void {
  const result = data.taskResult;
  if (result === null || result === undefined) return;

  if (result.ok) {
    useTaskStore.getState().applyTaskResult(result);
    const title = result.task?.title?.trim() || "新任务";
    const timeHint =
      result.reason === "bad_due_time" ? "（时间没听清，先不设提醒）" : "";
    toast(`小爱帮你记下了：${title} ✨${timeHint}`, "success");
    return;
  }

  if (result.action !== "none") {
    toast("小爱没太听清，你再说一次？", "info");
  }
}

/**
 * 发送管线：SSE 流式优先，非超时错误回退 /chat；60s AbortController 超时。
 * 行为契约与原 useChat.sendMessage 逐行一致（占位气泡由调用方提前放好）；
 * inner_thought / model_reasoning 字段映射不可丢。
 */
export async function streamSendMessage(
  text: string,
  handlers: StreamHandlers
): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const settle = (data: ChatResponse): void => {
    handlers.applyMeta(data);
    settleTaskResult(data);
    if (data.special_action === "ghosting") {
      handlers.markGhosting();
      return;
    }
    const reply = data.reply || "";
    handlers.finishWith(reply, data.inner_thought ?? null);
    if (useUiStore.getState().voiceMode && reply) speakBus.speak(reply);
  };

  try {
    // 优先流式：模型一边生成，界面一边渲染，首字时间大幅提前
    const data = await api.streamChat(text, handlers.appendDelta, controller.signal);
    clearTimeout(timeoutId);
    settle(data);
    return;
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "AbortError";
    clearTimeout(timeoutId);

    // 超时不必重试；其余情况（后端不支持流式等）回退到非流式
    if (!isTimeout) {
      try {
        const data = await api.sendChat(text);
        settle(data);
        return;
      } catch {
        // 两条路都失败，落到下面的统一提示
      }
    }

    handlers.finishWith(
      isTimeout ? "⏰ 响应时间过长，请重试..." : "⚠️ 连接中断..."
    );
  }
}
