import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeEmotion, EMOTION_ORDER } from "@/components/character/emotionMap";

/**
 * 引擎情绪标签 ↔ 前端映射表的一致性守卫（审计 FE-01 / B3-10）。
 *
 * 起因：ghosting 路径曾硬编码下发 "冷漠"，而前端 emotionMap 没有这个键，
 * 于是回落到 default —— 而 default 的中文标签是「开心」、立绘是笑脸。
 * 结果就是「她在冷暴力你，界面显示她在笑」。这类 bug 只要有一张表没同步就会复发，
 * 所以直接从后端源码读 EMOTION_LABELS 交叉断言，而不是在前端再抄一份清单。
 */
function backendEmotionLabels(): string[] {
  const src = readFileSync(
    resolve(process.cwd(), "../backend-node/src/core/EmotionEngine.js"),
    "utf-8"
  );
  const block = src.match(/export const EMOTION_LABELS = Object\.freeze\(\[([\s\S]*?)\]\)/);
  if (!block) throw new Error("后端 EMOTION_LABELS 结构变了，请同步这个测试");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** 设计上就落到 default 立绘的中性标签（其余标签都不许掉回 default） */
const INTENTIONAL_DEFAULT = new Set(["满足", "平静"]);

describe("情绪标签跨端一致性", () => {
  const labels = backendEmotionLabels();

  it("后端标签集合为 17 档", () => {
    expect(labels.length).toBe(17);
  });

  it("每个引擎标签都被显式映射（不允许靠 default 兜底混过去）", () => {
    const leaked = labels.filter(
      (label) => normalizeEmotion(label) === "default" && !INTENTIONAL_DEFAULT.has(label)
    );
    expect(leaked).toEqual([]);
  });

  it("映射结果都是真实存在的立绘种类", () => {
    for (const label of labels) {
      expect(EMOTION_ORDER).toContain(normalizeEmotion(label));
    }
  });

  it("负向情绪不会显示成正向立绘", () => {
    const negative = ["愤怒", "暴躁", "抑郁", "低落", "烦躁"];
    const wrong = negative.filter((label) => {
      const key = normalizeEmotion(label);
      return key === "default" || key === "happy" || key === "shy";
    });
    expect(wrong).toEqual([]);
  });

  it("旧版硬编码的 ghosting 标签「冷漠」不再出现在后端", async () => {
    const src = readFileSync(
      resolve(process.cwd(), "../backend-node/src/core/AiGirlfriend.js"),
      "utf-8"
    );
    expect(src).not.toMatch(/emotion:\s*"冷漠"/);
  });
});
