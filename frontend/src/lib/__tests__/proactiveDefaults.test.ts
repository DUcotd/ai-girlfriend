import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ENABLED_PROACTIVE_TYPES } from "@/lib/storage";

/**
 * 主动消息「默认勾选」清单的跨端一致性守卫（B6-α② 顺带修的历史坑）。
 *
 * 起因有两层：
 * 1. 后端 `_applyConfig` 只会「过滤未知 id」，老用户磁盘上的 8 类永远只有 8 类 ——
 *    REQ-04 之后新增的事件驱动类型永远进不了他们的 enabledTypes，
 *    事件层辛苦命中，最后被 canTrigger() 一句「该类型未启用」静默拦死；
 * 2. 设置弹窗在离线兜底时用自己抄的一份清单，保存一次就把新类型关掉。
 * 后端已经加了「新增默认开启类型自动补全」，这里守住前端那份抄写不再漂移。
 */
function backendDefaultEnabledTypes(): string[] {
  const src = readFileSync(
    resolve(process.cwd(), "../backend-node/src/core/proactiveTypes.js"),
    "utf-8"
  );
  const block = src.match(/export const PROACTIVE_TYPES = \[([\s\S]*?)\n\];/);
  if (!block) throw new Error("后端 PROACTIVE_TYPES 结构变了，请同步这个测试");
  const ids: string[] = [];
  // 每个类型对象里 id 在前、defaultEnabled 在后，逐块配对即可
  for (const item of block[1].split(/\n    \},?\n/)) {
    const id = item.match(/id:\s*'([a-z_]+)'/)?.[1];
    const enabled = item.match(/defaultEnabled:\s*(true|false)/)?.[1];
    if (id && enabled === "true") ids.push(id);
  }
  return ids;
}

describe("主动消息默认勾选跨端一致性", () => {
  const backend = backendDefaultEnabledTypes();

  it("后端默认开启的类型数量为 12", () => {
    expect(backend).toHaveLength(12);
  });

  it("前端兜底清单与后端 defaultEnabled 集合完全一致", () => {
    expect([...DEFAULT_ENABLED_PROACTIVE_TYPES].sort()).toEqual([...backend].sort());
  });

  it("关系跃迁（stage_transition）在两侧都是默认开启的", () => {
    expect(backend).toContain("stage_transition");
    expect(DEFAULT_ENABLED_PROACTIVE_TYPES).toContain("stage_transition");
  });

  it("前端清单没有重复项", () => {
    expect(new Set(DEFAULT_ENABLED_PROACTIVE_TYPES).size).toBe(
      DEFAULT_ENABLED_PROACTIVE_TYPES.length
    );
  });
});
