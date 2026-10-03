import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// api 是唯一的网络出口，整体 mock 掉：本测试只验证「什么时候才允许回退非流式」
vi.mock("@/lib/api", () => ({
  api: {
    streamChat: vi.fn(),
    sendChat: vi.fn(),
  },
}));

import { api } from "@/lib/api";
import { streamSendMessage } from "@/hooks/useChatStream";
import type { ChatResponse } from "@/types";

const mockedStream = vi.mocked(api.streamChat);
const mockedSend = vi.mocked(api.sendChat);

function makeResponse(overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    reply: "完整回复",
    emotion: "平静",
    affinity: 40,
    token_usage: {},
    context_count: 2,
    ...overrides,
  } as ChatResponse;
}

/** 记录每个 handler 被调用的顺序，用于断言 settle 的先后关系 */
function makeHandlers() {
  const log: string[] = [];
  return {
    log,
    appendDelta: vi.fn((chunk: string) => {
      log.push(`delta:${chunk}`);
    }),
    finishWith: vi.fn((content: string) => {
      log.push(`finish:${content.slice(0, 12)}`);
    }),
    markGhosting: vi.fn(() => {
      log.push("ghost");
    }),
    applyMeta: vi.fn((data: Partial<ChatResponse>) => {
      log.push(`meta:${data.affinity}`);
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("streamSendMessage 的回退契约（审计 FE-04）", () => {
  it("收到过 delta 之后失败：绝不回退 /chat（否则同一轮在服务端被结算两次）", async () => {
    mockedStream.mockImplementation(async (_text, onDelta) => {
      (onDelta as (t: string) => void)("第一段");
      throw new Error("SSE 帧解析失败");
    });
    const handlers = makeHandlers();

    await streamSendMessage("你好", handlers);

    expect(mockedSend).not.toHaveBeenCalled();
    // 已经流出来的那一轮不能再用非流式重跑一遍，只能给中断提示
    expect(String(handlers.finishWith.mock.calls[0]?.[0])).toContain("连接中断");
  });

  it("一个 delta 都没收到才回退 /chat（后端不支持流式的场景）", async () => {
    mockedStream.mockRejectedValue(new Error("404 Not found"));
    mockedSend.mockResolvedValue(makeResponse({ reply: "非流式回复" }));
    const handlers = makeHandlers();

    await streamSendMessage("你好", handlers);

    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(handlers.finishWith.mock.calls[0]?.[0]).toBe("非流式回复");
  });

  it("超时不回退，且把 AbortSignal 透传给后端", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    mockedStream.mockRejectedValue(abortError);
    const handlers = makeHandlers();

    await streamSendMessage("你好", handlers);

    expect(mockedSend).not.toHaveBeenCalled();
    expect(String(handlers.finishWith.mock.calls[0]?.[0])).toContain("响应时间过长");
    // 第三个参数必须是 AbortSignal，路由靠它把断开传给上游
    const signal = mockedStream.mock.calls[0][2] as AbortSignal;
    expect(signal).toBeTruthy();
    expect(typeof signal.aborted).toBe("boolean");
  });

  it("正常流式：meta 先落地，再收尾正文", async () => {
    mockedStream.mockResolvedValue(
      makeResponse({ reply: "完整回复", affinity: 42 })
    );
    const handlers = makeHandlers();

    await streamSendMessage("你好", handlers);

    expect(handlers.log).toEqual(["meta:42", "finish:完整回复"]);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("ghosting 走系统提示分支，不覆盖成正文", async () => {
    mockedStream.mockResolvedValue(
      makeResponse({ reply: "", special_action: "ghosting" })
    );
    const handlers = makeHandlers();

    await streamSendMessage("你好", handlers);

    expect(handlers.markGhosting).toHaveBeenCalledTimes(1);
    expect(handlers.finishWith).not.toHaveBeenCalled();
  });
});
