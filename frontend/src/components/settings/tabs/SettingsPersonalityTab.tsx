"use client";

import Button from "@/components/ui/Button";
import Note from "@/components/ui/Note";
import Switch from "@/components/ui/Switch";
import type { PersonalityController } from "@/hooks/usePersonality";
import PersonalityLedger from "../personality/PersonalityLedger";
import PersonalityPresetGrid from "../personality/PersonalityPresetGrid";
import PersonalitySlider from "../personality/PersonalitySlider";

interface SettingsPersonalityTabProps {
  /** 性格状态与提交控制器（usePersonality 实例，由 SettingsDialog 持有） */
  personality: PersonalityController;
  /** 请求打开「恢复默认预设」确认框——ConfirmDialog 必须渲染在 Dialog 兄弟层级，由 SettingsDialog 持有 */
  onRequestReset: () => void;
}

/**
 * 设置 → 性格页签：预设卡片区 → 七维滑块区 → 开关 → 变化时间线 → Note。
 *
 * ⚠️ 与 proactive 不同：性格改动是**即时提交**（usePersonality 内 debounce 300ms），
 * 不参与 SettingsDialog 的「保存全部配置」按钮——性格是后端运行时状态，
 * 拖完点取消却已生效/未生效都会困惑。
 */
export default function SettingsPersonalityTab({
  personality,
  onRequestReset,
}: SettingsPersonalityTabProps) {
  const { state, loading, loadFailed } = personality;

  // 拉取失败：显示错误态与重试指引，而不是把失败渲染成永久的「正在读取」
  if (loadFailed) {
    return (
      <p className="min-h-[160px] pt-10 text-center text-[11px] text-status-danger">
        性格状态读取失败，请检查后端连接后重新打开设置
      </p>
    );
  }

  // 尚未拉取到后端状态（首次打开弹窗的短暂瞬间）
  if (!state || loading) {
    return (
      <p className="min-h-[160px] pt-10 text-center text-[11px] text-content-muted">
        正在读取性格状态…
      </p>
    );
  }

  return (
    <>
      {/* 顶部：标题 + 恢复默认预设入口（确认框在 Dialog 兄弟层级弹出） */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-content-primary">性格</h3>
          <p className="mt-0.5 text-[10px] text-content-muted">
            共聊了 {state.stats.totalMessages} 句 · 活跃 {state.stats.activeDays}/
            {state.stats.totalDays} 天
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onRequestReset}>
          恢复默认预设
        </Button>
      </div>

      {/* ① 预设卡片区 */}
      <PersonalityPresetGrid
        presets={state.presets}
        activePresetId={state.presetId}
        presetName={state.presetName}
        customized={state.customized}
        customizedCount={state.customizedCount}
        onSelect={personality.applyPreset}
        onRestore={() => personality.applyPreset(state.presetId)}
      />

      {/* ② 七维滑块区（顺序以后端 dims 的 order 为准；拖的是 baseline，current 由后端跟随） */}
      <div className="space-y-4">
        <label className="block pl-1 text-[10px] font-bold uppercase tracking-widest text-content-muted">
          七维微调
        </label>
        {[...state.dims]
          .sort((a, b) => a.order - b.order)
          .map((meta) => (
            <PersonalitySlider
              key={meta.key}
              meta={meta}
              baseline={state.baseline[meta.key]}
              current={state.current[meta.key]}
              band={state.band}
              onChange={(value) => personality.setDim(meta.key, value)}
            />
          ))}
      </div>

      {/* ③ 漂移开关（即时提交；关闭漂移时后端会立即把 current 收回基线） */}
      <div className="space-y-2">
        <div className="flex items-center justify-between rounded-2xl border border-line-subtle bg-surface-1/50 p-3">
          <div>
            <h4 className="text-xs font-bold text-content-primary">允许聊天改变性格</h4>
            <p className="mt-0.5 text-[10px] text-content-muted">
              夸她、陪她、惹她生气都会让她在基线附近浮动（±{state.band}）
            </p>
          </div>
          <Switch
            checked={state.driftEnabled}
            onChange={(value) => personality.setFlags({ driftEnabled: value })}
            label="允许聊天改变性格"
          />
        </div>
        <div className="flex items-center justify-between rounded-2xl border border-line-subtle bg-surface-1/50 p-3">
          <div>
            <h4 className="text-xs font-bold text-content-primary">基线沉淀</h4>
            <p className="mt-0.5 text-[10px] text-content-muted">
              长期稳定的偏移会缓慢固化成新基线（基线本身也会被你改变）
            </p>
          </div>
          <Switch
            checked={state.baselineAdaptEnabled}
            onChange={(value) => personality.setFlags({ baselineAdaptEnabled: value })}
            label="基线沉淀"
          />
        </div>
      </div>

      {/* ④ 变化时间线 */}
      <PersonalityLedger entries={personality.ledger} dims={state.dims} now={personality.now} />

      <Note tone="accent">
        💬 日常对话会让性格在基线附近浮动：拖动滑块设定她的「底色」，聊天中的点点滴滴则让她慢慢被你影响。
        切换预设会把当前浮动清零；关闭「允许聊天改变性格」会立即收回全部浮动。
      </Note>
    </>
  );
}
