import { api } from "@/lib/api";
import { toApiError } from "@/lib/apiError";
import { CLIENT_ONLY_ERROR_CODES } from "@/lib/errorCodes";
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
 * 发送管线：SSE 流式优先；**只有在收到第一个 delta 之前**失败才回退非流式 /chat。
 * 60s AbortController 超时（signal 同时透传给后端，断开即中止上游生成）。
 * 行为契约与原 useChat.sendMessage 一致（占位气泡由调用方提前放好）；
 * inner_thought / model_reasoning 字段映射不可丢。
 *
 * ⚠️ 为什么不能无条件回退（审计 FE-04）：SSE 那一轮在服务端**已经走完**了 ——
 * 历史、好感度、性格、记忆都已结算。此时再发一次 /chat 等于把同一句话聊两遍：
 * 分数加两次、性格漂两次、模型钱付两遍。半路断流只能报错，不能重跑。
 */
export async function streamSendMessage(
  text: string,
  handlers: StreamHandlers
): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let gotDelta = false;

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
    const data = await api.streamChat(
      text,
      (chunk: string) => {
        gotDelta = true;
        handlers.appendDelta(chunk);
      },
      controller.signal
    );
    clearTimeout(timeoutId);
    settle(data);
    return;
  } catch (error) {
    const err = toApiError(error);
    const isTimeout = err.code === CLIENT_ONLY_ERROR_CODES.ABORTED;
    clearTimeout(timeoutId);

    // 只在「一个 delta 都没收到」时回退非流式：那种情况下服务端确实什么都没做。
    // 已收到 delta 说明这一轮已经在服务端结算过了，重发就是重复计费与重复加分。
    if (!isTimeout && !gotDelta) {
      try {
        const data = await api.sendChat(text);
        settle(data);
        return;
      } catch {
        // 两条路都失败，落到下面的统一提示
      }
    }

    // 气泡里优先给后端那句中文分类文案（稳定码那套），而不是不分青红皂白一句「连接中断」：
    // 「没配 Key」「Key 过期」「上游限流」「后端没起来」用户要做的事完全不同（B7-①）
    handlers.finishWith(
      isTimeout
        ? "⏰ 响应时间过长，请重试..."
        : err.isNetworkError
          ? "⚠️ 连不上后端（默认 8000 端口），小爱暂时听不到你说话"
          : err.userMessage || "⚠️ 连接中断..."
    );
  }
}
