"use client";

import { useState } from "react";
import Badge from "@/components/ui/Badge";
import type { PersonalityChangeSource, PersonalityDimMeta, PersonalityLedgerEntry } from "@/types";

/** 默认展示条数；「查看全部」最多 200（后端账本上限） */
const DEFAULT_VISIBLE = 20;
const MAX_VISIBLE = 200;

/** source 徽章文案与色调（涨跌色不适用于性格，统一用主题色） */
const SOURCE_BADGE: Record<
  PersonalityChangeSource,
  { label: string; tone: "accent" | "info" | "neutral" }
> = {
  auto: { label: "自动", tone: "accent" },
  manual: { label: "手动", tone: "info" },
  preset: { label: "预设", tone: "accent" },
  baseline_adapt: { label: "基线跟进", tone: "info" },
  reset: { label: "重置", tone: "neutral" },
};

/**
 * 时间格式化：今天/昨天显示相对日期，更早显示 MM-DD HH:mm。
 * now 为 null（首个 effect 尚未跑完）时退化为绝对日期——纯字符串/日期运算，可安全在 render 期调用。
 */
function formatTime(iso: string, now: number | null): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => n.toString().padStart(2, "0");
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (now === null) return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hm}`;

  const dayMs = 24 * 60 * 60 * 1000;
  const startOfDay = (t: number) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const diffDays = Math.floor((startOfDay(now) - startOfDay(date.getTime())) / dayMs);
  if (diffDays === 0) return `今天 ${hm}`;
  if (diffDays === 1) return `昨天 ${hm}`;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hm}`;
}

interface PersonalityLedgerProps {
  /** 时间升序账本（后端保证 ≤200，空时为 []） */
  entries: PersonalityLedgerEntry[];
  /** 维度元数据（用于 dim → 中文名映射） */
  dims: PersonalityDimMeta[];
  /** 「今天/昨天」判定用的时间戳；null = 未初始化，退化为绝对日期 */
  now: number | null;
}

/**
 * 性格变化时间线：默认最近 20 条，可展开至全部（≤200）。
 * ⚠️ 防抽动规则②③：容器预留 min-h，滚动条槽位常驻（scrollbar-gutter: stable），
 * 滚动条出现/消失不会让内容区宽度跳变。
 */
export default function PersonalityLedger({ entries, dims, now }: PersonalityLedgerProps) {
  const [expanded, setExpanded] = useState(false);

  // 后端时间升序 → 展示 newest-first
  const visibleCount = expanded ? MAX_VISIBLE : DEFAULT_VISIBLE;
  const visible = entries.slice(-visibleCount).reverse();

  const dimLabels = new Map(dims.map((d) => [d.key, d.label]));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="block pl-1 text-[10px] font-bold uppercase tracking-widest text-content-muted">
          变化时间线
        </label>
        {entries.length > DEFAULT_VISIBLE && (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="text-[10px] text-content-muted transition-colors duration-fast hover:text-accent-1"
          >
            {expanded ? "收起" : `查看全部（${entries.length} 条）`}
          </button>
        )}
      </div>

      {entries.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line-subtle p-6 text-center text-[11px] text-content-muted">
          还没有性格变化 —— 多和她聊聊天，她会慢慢被你影响的
        </div>
      ) : (
        <div className="min-h-[160px] max-h-[240px] space-y-2 overflow-y-auto overflow-x-hidden pr-1 [scrollbar-gutter:stable]">
          {visible.map((entry, index) => {
            const badge = SOURCE_BADGE[entry.source];
            return (
              <div
                key={`${entry.at}-${index}`}
                className="rounded-2xl border border-line-subtle bg-surface-1/50 p-3"
              >
                {/* 首行：时间 + 来源徽章 */}
                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-[10px] tabular-nums text-content-muted">
                    {formatTime(entry.at, now)}
                  </span>
                  <Badge tone={badge.tone} className="px-2 py-0.5 text-[10px]">
                    {badge.label}
                  </Badge>
                </div>

                {/* 变化明细：维度中文名 + before→after（1 位小数）+ 带符号 delta */}
                {entry.changes.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                    {entry.changes.map((change) => (
                      <span key={change.dim} className="text-[11px] text-content-secondary">
                        {dimLabels.get(change.dim) ?? change.dim}
                        <span className="ml-1 tabular-nums">
                          {change.before.toFixed(1)}→{change.after.toFixed(1)}
                        </span>
                        <span
                          className={
                            change.delta >= 0
                              ? "ml-1 font-bold tabular-nums text-accent-strong dark:text-accent-1"
                              : "ml-1 font-bold tabular-nums text-content-muted"
                          }
                        >
                          {change.delta > 0 ? `+${change.delta.toFixed(1)}` : change.delta.toFixed(1)}
                        </span>
                      </span>
                    ))}
                  </div>
                )}

                {/* 原因 */}
                <p className="mt-1 text-[11px] leading-relaxed text-content-secondary">
                  {entry.reason}
                </p>

                {/* 自动漂移附用户输入摘录（≤20 字） */}
                {entry.source === "auto" && entry.userInputDigest && (
                  <p className="mt-0.5 truncate text-[10px] text-content-muted">
                    「{entry.userInputDigest}」
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
