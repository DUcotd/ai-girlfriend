import { describe, expect, it } from "vitest";
import { toBackendConfigPayload } from "@/lib/api";

/**
 * /config 下发契约（审计 HTTP-10 / B9-3）。
 *
 * 后端 configRoutes 只解构 snake_case，且陪伴感三开关此前**从来没有**被前端发出去过：
 * README 把它们写成用户可配的契约，实际只有环境变量能改。这里把契约钉死。
 */
describe("toBackendConfigPayload 的陪伴感开关", () => {
  it("三个开关都映射成后端认识的 snake_case", () => {
    const payload = toBackendConfigPayload({
      userEmotionEnabled: false,
      narrativeEnabled: true,
      triggerEnabled: false,
    });
    expect(payload).toMatchObject({
      user_emotion_enabled: false,
      narrative_enabled: true,
      trigger_enabled: false,
    });
  });

  it("false 必须原样发出（写成 || undefined 会被吞成「没传」，后端就永远关不掉）", () => {
    const payload = toBackendConfigPayload({ userEmotionEnabled: false });
    expect("user_emotion_enabled" in payload).toBe(true);
    expect(payload.user_emotion_enabled).toBe(false);
  });

  it("调用方没带开关时值为 undefined，序列化后整项省略（后端保留当前值）", () => {
    const payload = toBackendConfigPayload({ apiKey: "sk-x" });
    expect(payload.user_emotion_enabled).toBeUndefined();
    expect(payload.narrative_enabled).toBeUndefined();
    expect(payload.trigger_enabled).toBeUndefined();
    // 真正决定「后端收不到该字段」的是 JSON 序列化会丢掉 undefined
    const wire = JSON.parse(JSON.stringify(payload));
    expect("user_emotion_enabled" in wire).toBe(false);
    expect("narrative_enabled" in wire).toBe(false);
    expect("trigger_enabled" in wire).toBe(false);
  });

  it("启动同步（getChatConfig 形状）会把三开关一起回灌给后端", async () => {
    const { getChatConfig } = await import("@/lib/storage");
    const cfg = getChatConfig();
    expect(cfg).toHaveProperty("userEmotionEnabled");
    expect(cfg).toHaveProperty("narrativeEnabled");
    expect(cfg).toHaveProperty("triggerEnabled");
    // 缺省全为 true（与后端 config 默认一致）
    expect(cfg.userEmotionEnabled).toBe(true);
  });
});
