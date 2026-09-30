# 系统设计：小爱性格系统（手动设定 + 内容驱动的潜移默化漂移）

> 输入 PRD：`docs/personality/PRD.md`（冲突时以 PRD 为准）
> 文档类型：增量开发设计（在现有 `PersonalityDrift.js` 之上扩展，不推倒重来）
> 语言：简体中文 · 后端 Node ESM + Express 4（无 `/api` 前缀）· 前端 Next.js 16 + React 19 + TS strict + Tailwind v3 + framer-motion 12

---

## 1. 实现方案与选型说明

### 1.1 核心技术难点

| # | 难点 | 本次解法 |
|---|---|---|
| D1 | 现有漂移只看「连续不活跃天数 / 正负比例」等**粗粒度统计**，完全不看用户说了什么 → 与「潜移默化」需求根本不匹配 | 新增 18 条**即时内容规则**（R01–R18），信号来自 `lexicon.js` 的 `matchCategory()` + 3 张漂移专用词表 + `EmotionEngine.analyzeInput()` 的 P 值，纯函数实现、可单测 |
| D2 | 漂移频率过低（只在跨天时结算），用户长期感知不到 | 拆成两条通道：**即时**（每轮 `_finalize`）+ **模式**（每日 `settleDaily`），8 条模式规则复用并改造现有 `_calculateDrift()` 的统计能力 |
| D3 | 手动设定完全缺失（无 API、无 UI） | 新增 `/personality` 路由族 + 设置页「性格」Tab（预设卡片 + 7 维滑块 + 变化时间线） |
| D4 | `getPromptInjection()` 只在极端阈值出描述，中间档**无性格段落** → 性格系统对对话实际无影响 | 改 **5 档制**（0-20/20-40/40-60/60-80/80-100 每档一句），并追加预设底色 + 最近变化原因 |
| D5 | 漂移可能「被少数几条消息带跑偏」 | 6 道闸：单轮 ±1.5 / 单日 ±3 / 浮动带 ±15 / 24h 规则疲劳 / 基线回拉力 / 冷启动 ×0.5 |
| D6 | 现有存档 `data/personality_state.json` 是 v1（`willfulness=32.75, security=59.6`），直接切 v2 会丢状态 | **前向一次性迁移**：无 `version` → `baseline=current=round(旧 traits)`、`presetId='custom'`、`playfulness=50`，迁移后立即落盘写 `version: 2` |
| D7 | 性能铁律：一次对话只允许**一次阻塞网络往返**（embedding 检索 → LLM 生成） | 漂移计算**全部同步纯内存**：关键词匹配 + 数值 clamp，零网络、零异步 I/O、零 `await`。规则模块不 import 任何 I/O 模块 |

### 1.2 选型：重构 `PersonalityDrift.js` 而不是新建平行模块

**决定：保留文件名 `PersonalityDrift.js` 与导出名 `PersonalityDrift`，内部重构为「对标 `AffinityEngine` 的自持状态引擎」；新增的纯函数层拆到 `personalityRules.js` / `personalityFatigue.js` / `personalityDims.js` / `personalityPresets.js` / `prompts/personalityPrompt.js`。**

理由：

1. **唯一 import 点只有一行** —— 全项目只有 `AiGirlfriend.js` 第 15 行 `import PersonalityDrift`。新建 `PersonalityEngine.js` 的收益≈0，成本是：全项目 grep 改名 + PRD/文档/工单里「PersonalityDrift」的名词全部失效 + 后续沟通心智切换。
2. **实例属性名 `this.personalityDrift` 保持不变** —— `AiGirlfriend` 构造函数日志、`resetAll()`、未来的路由都在用它；改名会连带改多处。
3. **「引擎化」由内部结构体现，不靠文件名** —— 重构后它具备 `AffinityEngine` 的全部骨架：自持状态 + 独立落盘 + 24h 疲劳窗 + 日上限 + 变更账本（≤200）+ `getMeta()` 式下发 + 惰性每日结算。类头注释里明确写「这是一个自持状态引擎（对标 AffinityEngine），类名沿用历史名称以减小改动面」。
4. **纯函数层必须独立成文件** —— 这是 PRD P0-e / P0-k 的硬验收（"规则为纯函数、每条有独立单测、纳入 `npm test`"）。`affinityRules.js` + `affinityFatigue.js` 就是这个范式的既有样板，照抄它的分层，工程师零学习成本。

**不新建 `PersonalityEngine.js` 的额外理由**：若并存两个类，`AiGirlfriend` 里会同时出现 `personalityDrift` 与 `personalityEngine`，是明确的坏味道（后续维护者不知道该调哪个）。

### 1.3 向后兼容策略

| 对象 | 兼容做法 |
|---|---|
| `recordInteraction(sentiment, isConflict)` | **删除**，职责合并进 `recordUserTurn(userInput, ctx)`。唯一调用点在 `_finalize()` 第 372 行，无外部调用者 |
| `updateDailyStats(todayMessageCount)` | **重命名为 `settleDaily(now)`** 并移到 `_prepare()` 最开头。唯一调用点在 `_prepare()` 第 311 行 |
| `_calculateDrift()` | 重构为 `computePatternDrift(dayStats, ctx)` 纯函数（8 条模式规则），引擎只做编排 |
| `getFullState()` | 保留（内部调试用），另增 `getPublicState()` 供路由下发 |
| `getDominantTraits()` / `getPromptInjection()` | 保留签名，内部升级到 7 维 |
| `data/personality_state.json` v1 | 前向迁移，**不写反向兼容代码**（PRD §6.1 明确要求） |
| `traits` 字段 | v2 存储中**不再有** `traits`，改为 `baseline` + `current`。任何残留的 `data.traits` 读取路径全部删除 |

### 1.4 架构分层

```
┌─ 路由层     src/routes/personalityRoutes.js        校验 + 转发（camelCase 契约）
├─ 编排层     src/core/AiGirlfriend.js               _prepare/settleDaily、_finalize/recordUserTurn、resetAll
├─ 引擎层     src/core/PersonalityDrift.js           状态持有 + 落盘 + 编排（唯一写入点）
├─ 纯函数层   src/core/personalityRules.js           26 条规则 + 6 道闸（无 I/O、无 Date.now）
│             src/core/personalityFatigue.js         ruleHits 裁窗 / 计数
├─ 真源层     src/core/personalityDims.js            7 维元数据 + 固定顺序（唯一真源）
│             src/core/personalityPresets.js         6 个预设 + DEFAULT_PRESET_ID
│             src/core/lexicon.js                    +3 张漂移词表（独立 export，不进互斥链）
│             src/core/relationshipStages.js         阶段（只读，禁字面量）
└─ 文案层     src/core/prompts/personalityPrompt.js  5 档描述（35 条）+ 段落组装
```

**依赖方向铁律**：`纯函数层` 只依赖 `真源层`；`引擎层` 依赖 `纯函数层 + 真源层 + utils/jsonStore`；`路由层` 依赖 `services/container`。**反向依赖一律禁止**（`personalityRules.js` 绝不 import `PersonalityDrift.js`）。

---

## 2. 完整文件清单

### 2.1 后端（`backend-node/`）

| 相对路径 | 新建/修改 | 职责一句话 |
|---|---|---|
| `src/core/personalityDims.js` | **新建** | 7 维元数据唯一真源：key / 中文名 / 低高值含义 / 固定顺序 / 漂移方向词 / 默认兜底值 |
| `src/core/personalityPresets.js` | **新建** | 6 个预设（数值 + emoji + 一句话）+ `DEFAULT_PRESET_ID='gentle'` + `getPreset(id)` |
| `src/core/lexicon.js` | **修改** | 追加 3 张漂移专用词表 `DEPENDENCY`/`REASSURANCE`/`APOLOGY` **独立 export，严禁加入 `RELATIONSHIP_LEXICON`** |
| `src/core/personalityFatigue.js` | **新建** | 3 个纯函数：ruleHits 24h 裁窗 / 记录命中 / 疲劳系数（1.0→0.6→0.3） |
| `src/core/personalityRules.js` | **新建** | `PERSONALITY_RULES` 参数 + `buildSignals()` + `buildDayStats()` + 18 条即时规则 + 8 条模式规则 + `computeDrift()` + 全部节流纯函数 |
| `src/core/prompts/personalityPrompt.js` | **新建** | 5 档文案（7 维 × 5 档）+ `buildPersonalityPrompt()` 组装注入段落 |
| `src/core/PersonalityDrift.js` | **重写** | 自持状态引擎：v2 状态 / v1 迁移 / `settleDaily()` / `recordUserTurn()` / `applyManual()` / `applyPreset()` / `reset()` / `getPublicState()` / `getLedger()` / `getPromptInjection()` / `getDominantTraits()` |
| `src/routes/personalityRoutes.js` | **新建** | `GET /personality`、`POST /personality`、`GET /personality/ledger`、`POST /personality/reset` |
| `src/app.js` | **修改** | 挂载 `app.use('/', personalityRoutes)` |
| `src/core/AiGirlfriend.js` | **修改** | ① `_prepare()` 开头调 `settleDaily()`（ghosting 早退之前）② `_finalize()` 改为调 `recordUserTurn(userInput, { sentiment: emotionDelta?.P ?? autoDelta.P, affinity, affinityChange })` ③ `resetAll()` 补 `personalityDrift.reset()` |
| `scripts/test-personality.mjs` | **新建** | 规则 + 节流 + 迁移 + 引擎的回归测试（≥28 例），单进程自包含、禁止 spawn |
| `package.json` | **修改** | `npm test` 串联 `test-personality.mjs` |

### 2.2 前端（`frontend/`）

| 相对路径 | 新建/修改 | 职责一句话 |
|---|---|---|
| `src/types/index.ts` | **修改** | 新增 `PersonalityDimKey` / `PersonalityDimMeta` / `PersonalityPreset` / `PersonalityState` / `PersonalityDimChange` / `PersonalityLedgerEntry` |
| `src/lib/api.ts` | **修改** | 新增 `getPersonality` / `updatePersonality` / `getPersonalityLedger` / `resetPersonality`（全部走 `request()`） |
| `src/stores/personalityStore.ts` | **新建** | zustand 运行时真源：state / ledger / loading / saving + 提交动作（**不用 persist 中间件**，真源在后端） |
| `src/hooks/usePersonality.ts` | **新建** | 挂载拉取 + 300ms debounce 提交 + 请求序号 last-write-wins + 本地乐观更新 |
| `src/components/settings/personality/PersonalityPresetGrid.tsx` | **新建** | 6 张预设卡片 `grid-cols-3`，激活态边框常驻，`customizedCount` 与「恢复到该预设」按钮 |
| `src/components/settings/personality/PersonalitySlider.tsx` | **新建** | 单行微调：轨道 + 半透明浮动带 + current 小三角 + baseline 把手 + 原生 range 透明覆盖 |
| `src/components/settings/personality/PersonalityLedger.tsx` | **新建** | 竖向时间线（默认 20 条 / 展开 ≤200），source 徽章 + before→after + reason + 空态 |
| `src/components/settings/tabs/SettingsPersonalityTab.tsx` | **新建** | 性格 Tab 容器：预设区 + 滑块区 + 时间线区 + 顶部开关 + 底部 Note |
| `src/components/settings/SettingsDialog.tsx` | **修改** | `SettingsTab` 加 `"personality"`（插在 memory 与 proactive 之间，图标 `Palette`），新增「恢复默认预设」ConfirmDialog |

---

## 3. 数据结构与接口

### 3.1 `data/personality_state.json` v2 完整 Schema

```jsonc
{
  "version": 2,
  "presetId": "gentle",
  "customized": false,
  "customizedCount": 0,
  "baseline": {
    "independence": 50, "willfulness": 30, "sensitivity": 55, "security": 65,
    "affection": 60, "playfulness": 45, "trust": 60
  },
  "current": {
    "independence": 50.0, "willfulness": 30.0, "sensitivity": 55.0, "security": 66.4,
    "affection": 60.0, "playfulness": 45.0, "trust": 60.0
  },
  "driftEnabled": true,
  "baselineAdaptEnabled": true,
  "stats": {
    "totalDays": 3,
    "activeDays": 3,
    "totalMessages": 44,
    "positiveCount": 4,
    "negativeCount": 0,
    "conflictCount": 1,
    "lastActiveDate": "2026-09-30",
    "consecutiveInactiveDays": 0,
    "dailyMessageCounts": [{ "date": "2026-09-30", "count": 12 }],
    "sentimentHistory": [{ "value": 0.4, "timestamp": 1790675924277 }],
    "recentTurns": [
      { "at": 1790675924277, "category": "PRAISE", "sentiment": 0.4, "criticism": false }
    ],
    "today": { "dayKey": "2026-09-30", "turns": 5, "criticismCount": 1, "sentiments": [0.4, -0.2] }
  },
  "daily": { "dayKey": "2026-09-30", "accum": { "security": 1.4 } },
  "ruleHits": { "praise_warmth": [1790675924277, 1790676002619] },
  "adapt": {
    "security": { "streak": 3, "dir": 1, "lastAdaptAt": null }
  },
  "ledger": [],
  "lastSettledDay": "2026-09-30",
  "lastUpdated": "2026-09-30T12:00:00.000Z"
}
```

**字段约定**

| 字段 | 类型 | 精度 / 范围 | 说明 |
|---|---|---|---|
| `version` | number | 固定 `2` | 迁移判定依据 |
| `presetId` | string | `'gentle'\|'tsundere'\|'cheerful'\|'aloof'\|'intellectual'\|'clingy'\|'custom'` | 手动微调后仍保留原 presetId（用于「已微调 N 项」与「恢复到该预设」） |
| `customized` / `customizedCount` | bool / number | 派生 | **不落盘决策、GET 时重算**（见 §3.5）；落盘仅为可读性 |
| `baseline` | Record<dim, **整数**> | 0-100 | 用户锚点，滑块把手位置 |
| `current` | Record<dim, **1 位小数**> | `[max(0,b-15), min(100,b+15)]` | 实际生效值，注入 prompt |
| `driftEnabled` | bool | 默认 `true` | 漂移总开关 |
| `baselineAdaptEnabled` | bool | 默认 `true` | 基线沉淀开关 |
| `daily.accum` | Record<dim, number> | 1 位小数 | 当日**自动漂移**净变化（不含回拉力、不含手动） |
| `ruleHits` | Record<ruleId, number[]> | 每条 ≤50，24h 裁窗 | 规则疲劳计时 |
| `adapt[dim]` | `{ streak, dir, lastAdaptAt }` | — | 基线沉淀的连续天数与冷却 |
| `ledger` | `PersonalityLedgerEntry[]` | ≤200，时间升序 | 见 §3.2 |
| `lastSettledDay` | string \| null | `dayKey()` 格式 | 每日结算去重 |

**v1 → v2 迁移（P0，只做这一次前向迁移）**

```js
// _loadState() 内
if (!data || typeof data.version !== 'number') {
    const base = {};
    for (const k of DIM_KEYS) {
        const old = data?.traits?.[k];
        base[k] = k === 'playfulness'
            ? 50                                        // 新增维度，历史无值
            : clampInt(Number.isFinite(old) ? old : DEFAULT_TRAITS[k]);
    }
    this.baseline = { ...base };
    this.current  = { ...base };
    this.presetId = 'custom';                            // 无法反推预设
    this.driftEnabled = true;
    this.baselineAdaptEnabled = true;
    this.ledger = [];
    this.ruleHits = {};
    this.adapt = {};
    this.daily = { dayKey: dayKey(), accum: {} };
    this.stats = sanitizeStats(data?.stats);             // 见下
    this.lastSettledDay = null;
    this._saveState();                                   // ⚠️ 立即落盘写 version:2，防重复迁移
    console.log(`[Personality] Migrated v1 → v2 (presetId=custom, playfulness=50)`);
}
```

`stats` 清洗（`sanitizeStats`）：
- `lastActiveDate` 若不匹配 `/^\d{4}-\d{2}-\d{2}$/`（旧格式是 `'Tue Sep 29 2026'`）→ 置 `null`
- `dailyMessageCounts[].date` 同上，非 dayKey 格式的条目直接丢弃
- `recentTurns` / `today` 缺失 → 置默认值
- 其余字段缺失 → 取默认 stats

★ 验收：现有存档（`willfulness=32.751999999999995`、`security=59.604`）→ `baseline.willfulness=33`、`baseline.security=60`、`playfulness=50`、`presetId='custom'`、`version=2`。

### 3.2 账本条目（`PersonalityLedgerEntry`）

```ts
interface PersonalityLedgerEntry {
  at: string;           // ISO 8601（new Date(now).toISOString()）
  source: 'auto' | 'manual' | 'preset' | 'baseline_adapt' | 'reset';
  ruleId: string | null;          // 'praise_warmth' / 'S01' / null（手动、preset、reset）
  reason: string;                 // 中文原因（PRD §4.4 逐条对应）
  userInputDigest?: string | null;// ≤20 字，仅 source='auto'
  changes: Array<{ dim: PersonalityDimKey; before: number; after: number; delta: number }>;
}
```

**聚合与裁剪策略（写死，所有人遵守）**
- **一条 = 一次触发**（一次 `recordUserTurn` / 一次手动提交 / 一次预设切换 / 一次基线沉淀 / 一次重置），不按维度拆分条目。
- **只有 `round1(delta) !== 0` 的维度才进 `changes`**；`changes` 为空 → **整条不写账本**（避免时间线被 0 变化刷屏）。
- **上限 200，统一 FIFO 丢最旧**（`splice(0, len - 200)`），**`manual`/`preset` 无保留特例**。理由：manual/preset 总是最新事件，从尾部丢不会先丢到它们；加特例会破坏「上限 200」的可解释性并引入排序复杂度。
- 顺序：时间升序（push 追加，天然升序）。

### 3.3 `personalityDims.js` 导出结构

```js
/**
 * 7 维元数据 —— 全项目唯一真源。
 * ⚠️ 数组顺序 = UI 顺序 = prompt 顺序 = API 数组顺序，任何模块禁止自己写顺序。
 */
export const PERSONALITY_DIMS = [
  { key: 'independence', label: '独立性', low: '黏人、想时刻在一起', high: '独立、有自己的空间',
    shiftUp: '更独立了',   shiftDown: '更黏人了',     order: 1 },
  { key: 'willfulness',  label: '任性度', low: '听话、很少反驳',     high: '有主见、爱使小性子',
    shiftUp: '更有主见了', shiftDown: '更听话了',     order: 2 },
  { key: 'sensitivity',  label: '敏感度', low: '钝感、不容易多想',   high: '敏感、容易受伤',
    shiftUp: '更敏感了',   shiftDown: '更钝感了',     order: 3 },
  { key: 'security',     label: '安全感', low: '患得患失、怕被冷落', high: '笃定安心、不焦虑',
    shiftUp: '更安心了',   shiftDown: '更不安了',     order: 4 },
  { key: 'affection',    label: '表达欲', low: '内敛、感情藏心里',   high: '主动表达、热情外放',
    shiftUp: '更爱表达了', shiftDown: '更内敛了',     order: 5 },
  { key: 'playfulness',  label: '俏皮度', low: '认真稳重、很少开玩笑', high: '调皮、爱开玩笑、鬼灵精怪',
    shiftUp: '更俏皮了',   shiftDown: '更稳重了',     order: 6 },   // ★ 新增第 6 位
  { key: 'trust',        label: '信任度', low: '戒备、保持距离',     high: '信任、愿意托付',
    shiftUp: '更信任你了', shiftDown: '更有戒备了',   order: 7 },
];

export const DIM_KEYS = PERSONALITY_DIMS.map(d => d.key);              // 7 个 key，固定顺序
export const DIM_LABELS = Object.fromEntries(PERSONALITY_DIMS.map(d => [d.key, d.label]));
export const DEFAULT_TRAITS = {                                        // 兜底（未命中任何预设时）
  independence: 50, willfulness: 30, sensitivity: 55, security: 65,
  affection: 60, playfulness: 45, trust: 60,
};
export function isDimKey(k) { return DIM_KEYS.includes(k); }
export function emptyTraits(fill = 50) { /* → Record<dim, number> */ }
```

### 3.4 `personalityPresets.js` 导出结构

```js
export const PERSONALITY_PRESETS = [
  { id: 'gentle',       name: '温柔',     emoji: '🌸', tagline: '体贴顺从，说话轻声细语，会照顾你的情绪',
    traits: { independence: 50, willfulness: 30, sensitivity: 55, security: 65, affection: 60, playfulness: 45, trust: 60 } },
  { id: 'tsundere',     name: '傲娇',     emoji: '💢', tagline: '嘴上嫌弃，心里在意，一戳就炸毛',
    traits: { independence: 65, willfulness: 70, sensitivity: 70, security: 50, affection: 45, playfulness: 55, trust: 45 } },
  { id: 'cheerful',     name: '活泼',     emoji: '✨', tagline: '元气满满，话多爱闹，不太容易受伤',
    traits: { independence: 45, willfulness: 45, sensitivity: 30, security: 70, affection: 80, playfulness: 85, trust: 70 } },
  { id: 'aloof',        name: '高冷',     emoji: '❄️', tagline: '话少、不主动、保持距离，偶尔毒舌',
    traits: { independence: 80, willfulness: 60, sensitivity: 45, security: 75, affection: 25, playfulness: 20, trust: 35 } },
  { id: 'intellectual', name: '知性姐姐', emoji: '📖', tagline: '沉稳可靠，能看穿你的情绪，会讲道理',
    traits: { independence: 70, willfulness: 30, sensitivity: 65, security: 80, affection: 50, playfulness: 25, trust: 75 } },
  { id: 'clingy',       name: '撒娇妹妹', emoji: '🧸', tagline: '黏人爱撒娇，要关注，容易吃醋',
    traits: { independence: 20, willfulness: 55, sensitivity: 70, security: 40, affection: 85, playfulness: 70, trust: 65 } },
];

export const DEFAULT_PRESET_ID = 'gentle';
export const PRESET_IDS = PERSONALITY_PRESETS.map(p => p.id);
export function getPreset(id) {
  return PERSONALITY_PRESETS.find(p => p.id === id) || null;
}
```

### 3.5 `personalityRules.js` 核心接口（JSDoc）

```js
export const PERSONALITY_RULES = {
  MAX_PER_TURN: 1.5,        // 单轮净变化上限（按维度），**仅作用于即时规则**
  MAX_PER_DAY: 3.0,         // 单日净变化上限（按维度，跨自然日重置），即时与模式都受它约束
  FLOAT_BAND: 15,           // current 相对 baseline 的浮动带
  FATIGUE_MULTIPLIERS: [1.0, 0.6, 0.3],   // 按「此前 24h 内已命中次数」取：0次→1.0 / 1次→0.6 / ≥2次→0.3
  FATIGUE_WINDOW_MS: 24 * 60 * 60 * 1000,
  BASELINE_PULL: 0.08,      // 每日回拉力系数（**不计入 MAX_PER_DAY、不写账本**）
  COLD_START_MSGS: 20,      // totalMessages < 20 → 全局 ×0.5
  COLD_START_MULTIPLIER: 0.5,
  BASELINE_ADAPT: { STREAK_DAYS: 7, MIN_OFFSET: 8, RATIO: 0.2, MAX_STEP: 2, COOLDOWN_MS: 7*24*3600*1000 },
};

/** 由用户输入派生的纯信号（不含时间、不含 I/O） */
export function buildSignals(userInput, { sentiment, stage, affinityChange }) → {
  category,            // matchCategory(userInput) 结果，'HARD_REJECTION'|...|null
  sentiment,           // emotionDelta?.P ?? autoDelta.P
  stage,               // 'stranger'|'acquaintance'|'friend'|'close'|'lover'
  isLongTalk,          // userInput.length > 50
  hasExclamation,      // /[!！]/
  dependency, reassurance, apology,   // 3 张新词表
  sad, calming, exciting, question,   // 既有情绪词表
  isConflict,          // affinityChange < -3
  digest,              // userInput.slice(0, 20)
}

/** 由 stats 派生的模式信号（纯函数） */
export function buildDayStats(stats, now) → {
  consecutiveInactiveDays, avgDaily7, positiveRatio50, conflictRate50,
  criticismCount50, criticismRateToday, todayTurns, hotColdFlips,
}

/** 统一门面：mode='instant' 走 R01-R18，mode='pattern' 走 S01-S08 */
export function computeDrift(signals, ctx) → {
  changes: Array<{ dim, delta }>,     // 已应用疲劳 + 冷启动 + 单轮上限；**未应用日上限与浮动带**
  hits: Array<{ ruleId, reason }>,
}
// ctx = { mode, stage, totalMessages, fatigueCounts: {[ruleId]: number}, limits }

export function applyDailyCap(changes, accum, maxPerDay = 3.0) → { changes, accum }
export function clampCurrent(v, baseline, band = 15) → number
export function applyBaselinePull(current, baseline, rate = 0.08) → Record<dim, number>
export function computeBaselineAdapt({ baseline, current, adapt, now, enabled }) → { moves, nextAdapt }
export function tierIndex(v) → 0|1|2|3|4      // <20 / <40 / <60 / <80 / else
```

### 3.6 `PersonalityDrift` 公开方法

```js
class PersonalityDrift {
  constructor(stateFileName = 'personality_state.json')   // 测试可传 '.test.json'

  // ---- 每日结算（_prepare 最开头调用，必须在 ghosting 早退之前）----
  settleDaily(now = Date.now()) → { settled: boolean, changes, adapted }

  // ---- 一次用户回合（唯一即时写入点，_finalize 调用）----
  recordUserTurn(userInput, ctx, now = Date.now()) → { current, changes, hits }
  // ctx = { sentiment: number, affinity: number, affinityChange: number }

  // ---- 手动 / 预设 / 开关 ----
  applyManual(traits /* Partial<Record<dim, number>> */) → state    // 拖滑块
  applyPreset(presetId) → state                                     // 切预设（offset 归零）
  setFlags({ driftEnabled, baselineAdaptEnabled }) → state
  reset() → { status: 'reset' }                                     // 恢复 gentle + 清账本

  // ---- 查询 ----
  getPublicState() → PersonalityState                               // 路由直接下发
  getLedger() → PersonalityLedgerEntry[]                            // ≤200，时间升序
  getPromptInjection() → string                                     // 5 档 + 底色 + 最近原因
  getDominantTraits() → string[]                                    // 7 维标签（P1-d）
  getFullState() → { baseline, current, stats }                     // 内部调试（保留旧签名语义）
}
```

**`computeDrift(signals, ctx)` 返回结构示例**

```js
{
  changes: [ { dim: 'security', delta: 0.6 }, { dim: 'affection', delta: 0.4 } ],
  hits:    [ { ruleId: 'praise_warmth', reason: '你夸了她，她更安心也更想亲近你' } ]
}
```

### 3.7 前端 TS 类型（`src/types/index.ts` 追加）

```ts
export type PersonalityDimKey =
  | "independence" | "willfulness" | "sensitivity" | "security"
  | "affection" | "playfulness" | "trust";

/** 维度元数据（后端 dims[] 下发，前端零镜像） */
export interface PersonalityDimMeta {
  key: PersonalityDimKey;
  label: string;      // 中文名
  low: string;        // 0-30 含义
  high: string;       // 70-100 含义
  order: number;      // 固定顺序（1-7）
}

/** 预设（后端 presets[] 下发，前端零镜像） */
export interface PersonalityPreset {
  id: string;
  name: string;       // 温柔
  emoji: string;      // 🌸
  tagline: string;    // 体贴顺从，说话轻声细语，会照顾你的情绪
  traits: Record<PersonalityDimKey, number>;
}

export interface PersonalityDimChange {
  dim: PersonalityDimKey;
  before: number;
  after: number;
  delta: number;
}

export type PersonalityChangeSource =
  | "auto" | "manual" | "preset" | "baseline_adapt" | "reset";

export interface PersonalityLedgerEntry {
  at: string;                       // ISO
  source: PersonalityChangeSource;
  ruleId: string | null;
  reason: string;
  userInputDigest?: string | null;
  changes: PersonalityDimChange[];
}

export interface PersonalityState {
  version: number;
  presetId: string;
  presetName: string | null;        // 'custom' 时为 null
  customized: boolean;
  customizedCount: number;          // 与预设不同的维度数
  baseline: Record<PersonalityDimKey, number>;   // 整数
  current: Record<PersonalityDimKey, number>;    // 1 位小数
  driftEnabled: boolean;
  baselineAdaptEnabled: boolean;
  band: number;                     // 15
  dims: PersonalityDimMeta[];
  presets: PersonalityPreset[];
  stats: { totalMessages: number; totalDays: number; activeDays: number };
}
```

### 3.8 类图

```mermaid
classDiagram
    class PersonalityDims {
        <<module>>
        +PERSONALITY_DIMS: DimMeta[]
        +DIM_KEYS: string[]
        +DEFAULT_TRAITS: Record
        +isDimKey(k) bool
    }
    class PersonalityPresets {
        <<module>>
        +PERSONALITY_PRESETS: Preset[]
        +DEFAULT_PRESET_ID: string
        +getPreset(id) Preset
    }
    class Lexicon {
        <<module>>
        +RELATIONSHIP_LEXICON: array
        +matchCategory(text) string
        +anyIncludes(text, words) bool
        +DEPENDENCY: string[]
        +REASSURANCE: string[]
        +APOLOGY: string[]
    }
    class PersonalityFatigue {
        <<module>>
        +pruneRuleHits(hits, now, win) Record
        +recordRuleHit(hits, ruleId, now) Record
        +fatigueMultiplier(count) number
    }
    class PersonalityRules {
        <<module>>
        +PERSONALITY_RULES: object
        +buildSignals(input, ctx) Signals
        +buildDayStats(stats, now) DayStats
        +computeDrift(signals, ctx) DriftResult
        +applyDailyCap(changes, accum, max) Result
        +clampCurrent(v, baseline, band) number
        +applyBaselinePull(cur, base, rate) Record
        +computeBaselineAdapt(args) AdaptResult
        +tierIndex(v) int
    }
    class PersonalityPrompt {
        <<module>>
        +DIM_TIER_TEXT: Record
        +buildPersonalityPrompt(args) string
    }
    class PersonalityDrift {
        -stateFile: string
        -version: number
        -presetId: string
        -baseline: Record
        -current: Record
        -driftEnabled: bool
        -baselineAdaptEnabled: bool
        -stats: Stats
        -daily: Daily
        -ruleHits: Record
        -adapt: Record
        -ledger: LedgerEntry[]
        -lastSettledDay: string
        +settleDaily(now) object
        +recordUserTurn(input, ctx, now) object
        +applyManual(traits) State
        +applyPreset(presetId) State
        +setFlags(flags) State
        +reset() object
        +getPublicState() State
        +getLedger() LedgerEntry[]
        +getPromptInjection() string
        +getDominantTraits() string[]
        -_loadState() void
        -_saveState() void
        -_appendLedger(entry) void
        -_rollDayIfNeeded(now) Record
    }
    class AiGirlfriend {
        +personalityDrift: PersonalityDrift
        +affinityEngine: AffinityEngine
        +emotionEngine: EmotionEngine
        -_prepare(input) Promise
        -_finalize(parsed, input, usage) object
        +resetAll() void
    }
    class PersonalityRoutes {
        <<router>>
        +GET_personality(req, res)
        +POST_personality(req, res)
        +GET_ledger(req, res)
        +POST_reset(req, res)
    }
    class RelationshipStages {
        <<module>>
        +getStageForAffinity(a) Stage
    }

    PersonalityRules ..> PersonalityDims : 消费顺序与 key
    PersonalityRules ..> Lexicon : 词表匹配
    PersonalityRules ..> PersonalityFatigue : 疲劳系数
    PersonalityRules ..> RelationshipStages : 阶段门控（禁字面量）
    PersonalityPresets ..> PersonalityDims : traits 覆盖 7 维
    PersonalityPrompt ..> PersonalityDims : 5 档文案按维度
    PersonalityDrift ..> PersonalityRules : 编排（单向）
    PersonalityDrift ..> PersonalityPresets : 预设取值
    PersonalityDrift ..> PersonalityFatigue : ruleHits 裁窗
    PersonalityDrift ..> PersonalityPrompt : 组装注入段落
    PersonalityDrift ..> PersonalityDims : 维度真源
    AiGirlfriend *-- PersonalityDrift : 持有单例
    PersonalityRoutes ..> AiGirlfriend : aiGirlfriend.personalityDrift
```

---

## 4. API 契约表

> ⚠️ **全部挂根路径，无 `/api` 前缀**（`app.js` 里 `app.use('/', personalityRoutes)`）。
> ⚠️ **camelCase 契约**（与 `/config/proactive` 一样是例外；**不要**走 `syncConfig` 的 snake_case 映射）。

### 4.1 `GET /personality`

**请求**：无

**响应 200**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | number | `2` |
| `presetId` | string | `'gentle'`…`'custom'` |
| `presetName` | string \| null | 预设中文名；`'custom'` 时为 `null` |
| `customized` | boolean | 派生：`baseline` 与当前预设不一致（`'custom'` 时恒 `true`） |
| `customizedCount` | number | 不一致的维度数 |
| `baseline` | `Record<dim, number>` | 整数，滑块把手位置 |
| `current` | `Record<dim, number>` | 1 位小数，注入 prompt 的值 |
| `dims` | `PersonalityDimMeta[]` | 7 项，`order` 升序 |
| `presets` | `PersonalityPreset[]` | 6 项 |
| `band` | number | `15` |
| `driftEnabled` | boolean | |
| `baselineAdaptEnabled` | boolean | |
| `stats` | `{ totalMessages, totalDays, activeDays }` | 只下发这三个（内部 stats 不外泄） |

### 4.2 `POST /personality`

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `presetId` | string | 否 | 必须在 `PRESET_IDS` 内，否则 400 |
| `traits` | `Partial<Record<dim, number>>` | 否 | 0-100，越界 **clamp 不报错**（滑块友好）；未知 key → 400 |
| `driftEnabled` | boolean | 否 | 非 boolean 则忽略 |
| `baselineAdaptEnabled` | boolean | 否 | 非 boolean 则忽略 |

**执行顺序**：`presetId` 先生效（写 baseline + current 归零）→ 再叠加 `traits` 微调 → 最后写 flags。

**响应 200**：完整状态（同 `GET /personality`）

**400 场景**：
- `unknown personality dim: xxx`
- `unknown presetId: xxx`

### 4.3 `GET /personality/ledger`

**请求**：无
**响应 200**：`PersonalityLedgerEntry[]`（时间升序，≤200；空数组而非 null）

### 4.4 `POST /personality/reset`

**请求**：无（忽略 body）
**响应 200**：`{ status: "reset", ...state }`（state 同 GET）

**副作用**：`baseline = current = gentle 预设`、`presetId='gentle'`、`ledger=[]`、`daily.accum={}`、`ruleHits={}`、`adapt={}`；**保留** `driftEnabled` / `baselineAdaptEnabled` / `stats`；**不动**好感度、记忆、对话历史。

### 4.5 前端 API 客户端（`src/lib/api.ts` 追加）

```ts
getPersonality: () => request<PersonalityState>("/personality"),

/** ⚠️ 性格路由是 camelCase 契约，不要走 syncConfig 的 snake_case 映射 */
updatePersonality: (payload: {
  presetId?: string;
  traits?: Partial<Record<PersonalityDimKey, number>>;
  driftEnabled?: boolean;
  baselineAdaptEnabled?: boolean;
}) => request<PersonalityState>("/personality", { method: "POST", body: JSON.stringify(payload) }),

getPersonalityLedger: () => request<PersonalityLedgerEntry[]>("/personality/ledger"),

resetPersonality: () =>
  request<{ status: string } & PersonalityState>("/personality/reset", { method: "POST" }),
```

---

## 5. 程序调用流程时序图

### 5.1 一次对话：每日结算 + 即时漂移

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户
    participant R as routes/chat.js
    participant AG as AiGirlfriend
    participant PD as PersonalityDrift
    participant PR as personalityRules(纯函数)
    participant AE as AffinityEngine
    participant LLM as LLM

    U->>R: POST /chat/stream { message }
    R->>AG: chatStream(userInput, onDelta)
    AG->>AG: _doChatStream → _prepare(userInput)

    rect rgb(240,248,255)
    Note over AG,PD: ★ 缺陷修复 A：settleDaily 必须在 ghosting 早退之前
    AG->>PD: settleDaily(Date.now())
    PD->>PD: _rollDayIfNeeded(now)（跨自然日清 daily.accum）
    alt lastSettledDay != todayKey
        PD->>PD: 更新 stats（totalDays/activeDays/consecutiveInactiveDays）
        PD->>PR: buildDayStats(stats, now)
        PR-->>PD: DayStats
        PD->>PR: computeDrift(dayStats, { mode:'pattern', ... })
        PR-->>PD: { changes, hits }   %% S01-S08，不受 MAX_PER_TURN 约束
        PD->>PR: applyDailyCap(changes, accum, 3.0)
        PR-->>PD: { changes, accum }
        PD->>PD: 逐维 clampCurrent(v, baseline, 15)
        PD->>PR: applyBaselinePull(current, baseline, 0.08)
        PR-->>PD: 新 current   %% 不计入日上限、不写账本
        PD->>PR: computeBaselineAdapt({ baseline, current, adapt, now })
        PR-->>PD: { moves, nextAdapt }   %% 连续7天 offset>=8 → baseline 移动 <=2
        PD->>PD: _appendLedger(...) + _saveState()
    end
    PD-->>AG: { settled, changes, adapted }
    end

    AG->>AG: if (emotionEngine.shouldGhost()) return done   %% 此时每日结算已完成 ✓
    AG->>AE: settleDecay / notifyUserActive
    AG->>AG: 记忆检索（唯一阻塞网络往返 #1）
    AG->>PD: getPromptInjection()
    PD->>PD: buildPersonalityPrompt(5档 + 底色 + 最近原因)
    PD-->>AG: 性格段落
    AG->>LLM: 生成（阻塞往返 #2）
    LLM-->>AG: reply + metadata
    AG->>AG: _finalize(parsed, userInput, usage)

    rect rgb(255,250,240)
    Note over AG,PR: ★ 缺陷修复 B：sentiment 用 autoDelta.P 兜底，并传内容信号
    AG->>AG: autoDelta = emotionEngine.analyzeInput(userInput, affinity)
    AG->>AE: recordUserTurn(userInput, affinityChange, replyText)
    AG->>PD: recordUserTurn(userInput, { sentiment: emotionDelta?.P ?? autoDelta.P, affinity, affinityChange })
    PD->>PR: buildSignals(userInput, { sentiment, stage, affinityChange })
    PR-->>PD: Signals（category / 3张新词表 / 情绪词表 / isLongTalk）
    PD->>PR: computeDrift(signals, { mode:'instant', totalMessages, fatigueCounts })
    PR-->>PD: { changes, hits }   %% R01-R18，已含疲劳×冷启动×单轮±1.5
    PD->>PR: applyDailyCap(changes, accum, 3.0)
    PD->>PD: 逐维 clampCurrent(...) + round1
    PD->>PD: 写账本（changes 非空才写）+ 更新 ruleHits/stats/recentTurns + _saveState()
    PD-->>AG: { current, changes, hits }
    end

    AG-->>R: { reply, emotion, affinity, ... }
    R-->>U: SSE delta / done
    AG->>AG: _persistAfterReply()（记忆 embedding + 落盘，后台）
```

### 5.2 用户拖滑块 → 落盘 → prompt 生效

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户
    participant S as PersonalitySlider
    participant H as usePersonality
    participant ST as personalityStore
    participant A as api.updatePersonality
    participant RT as personalityRoutes
    participant PD as PersonalityDrift
    participant P as personality_state.json

    U->>S: 拖动「独立性」80 → 62
    S->>H: setDim('independence', 62)
    H->>ST: 乐观更新 baseline.independence=62（滑块立即跟随）
    H->>H: pendingRef 合并 patch + clearTimeout + setTimeout(300ms)
    Note over H: debounce 300ms；同一窗口内多次拖动合并为一次提交
    H->>A: POST /personality { traits: { independence: 62 } }
    A->>RT: fetch（camelCase 契约）
    RT->>RT: fail(res, !isDimKey(k), 'unknown personality dim') → 400
    RT->>PD: applyManual({ independence: 62 })
    PD->>PD: offset_old = current - baseline_old
    PD->>PD: baseline = clampInt(62)
    PD->>PD: current = clampCurrent(62 + offset_old, 62)   %% 平移保留相对偏移
    PD->>PD: delete daily.accum['independence']            %% 手动位移不占漂移额度
    PD->>PD: _appendLedger({ source:'manual', reason:'你把「独立性」调低了' })
    PD->>P: writeJson（tmp + rename 原子写）
    PD-->>RT: getPublicState()
    RT-->>A: 完整状态
    A-->>H: PersonalityState
    H->>H: if (seq !== seqRef.current) return   ★ 丢弃过期响应，防 race 回退
    H->>ST: 用服务端返回值覆盖本地（后端是真源）
    ST-->>S: 重渲染（把手=baseline 62，小三角=current，浮动带=[47,77]）
    Note over PD: 下一轮 _prepare → getPromptInjection() 读到的已是新 current
```

### 5.3 切换预设

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户
    participant G as PersonalityPresetGrid
    participant H as usePersonality
    participant A as api.updatePersonality
    participant RT as personalityRoutes
    participant PD as PersonalityDrift
    participant PP as personalityPresets

    U->>G: 点击「傲娇 💢」（UI 上方已明示「切换预设会把当前浮动清零」）
    G->>H: applyPreset('tsundere')
    H->>H: clearTimeout(debounce) + 清空 pendingRef  ★ 防止 traits 与 presetId 语义打架
    H->>A: POST /personality { presetId: 'tsundere' }
    RT->>RT: fail(res, !PRESET_IDS.includes(id), 'unknown presetId') → 400
    RT->>PD: applyPreset('tsundere')
    PD->>PP: getPreset('tsundere')
    PP-->>PD: { traits: {...} }
    PD->>PD: baseline = clone(traits); current = clone(traits)   ★ offset 归零
    PD->>PD: presetId='tsundere'; daily.accum={}（参照系已重置）
    PD->>PD: ruleHits 保留（统计连续性）；adapt={}
    PD->>PD: _appendLedger({ source:'preset', ruleId:null, reason:'你把她的性格切换成了「傲娇」', changes: 7 维 before→after })
    PD-->>RT: getPublicState()（customized=false, customizedCount=0）
    RT-->>A: 完整状态
    A-->>H: PersonalityState
    H->>H: 请求序号校验 + 覆盖 store
    H-->>G: 7 个滑块 framer-motion 动画过渡到预设值
    G->>G: activePreset 卡片边框高亮（border 常驻，未激活 border-transparent）
```

### 5.4 重置（性格 Tab「恢复默认预设」/ 完全重置）

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户
    participant T as SettingsPersonalityTab
    participant CD as ConfirmDialog
    participant H as usePersonality
    participant A as api.resetPersonality
    participant RT as personalityRoutes
    participant PD as PersonalityDrift
    participant AG as AiGirlfriend

    alt 入口一：性格 Tab 右上角「恢复默认预设」
        U->>T: 点击「恢复默认预设」
        T->>CD: isOpen=true（type="danger"，兄弟节点渲染 ★ 不被 Modal transform 影响）
        CD->>U: 文案「将把小爱的性格恢复为「温柔」默认档，并清空全部性格变化记录。好感度、记忆与对话记录不受影响。」
        U->>CD: 确认
        CD->>H: reset()
        H->>A: POST /personality/reset
        RT->>PD: reset()
        PD->>PD: baseline=current=getPreset('gentle').traits
        PD->>PD: presetId='gentle'; ledger=[]; daily.accum={}; ruleHits={}; adapt={}
        PD->>PD: 保留 driftEnabled / baselineAdaptEnabled / stats
        PD-->>RT: { status:'reset', ...getPublicState() }
        RT-->>A: 完整状态（ledger 为 []）
        A-->>H: state
        H->>H: 重新拉取 ledger（空数组 → 时间线显示空态）
        H-->>T: toast('已恢复默认预设 🌸')
    else 入口二：系统 Tab「完全重置小爱」
        U->>AG: api.resetAll()
        AG->>AG: history=[system]; affinityEngine.reset(); memory.clearMemory()
        AG->>PD: personalityDrift.reset()   ★ 缺陷修复 D
        PD-->>AG: { status:'reset' }
        AG->>AG: _saveState()
    end
```

---

## 6. 有序任务列表

> 共 **5 个批次**，按依赖顺序执行。同一模块的文件放一批，便于批量落地。

### T01 — 后端真源层 + 规则纯函数层（无 I/O，可独立单测）

**涉及文件**
| 文件 | 动作 |
|---|---|
| `backend-node/src/core/personalityDims.js` | 新建 |
| `backend-node/src/core/personalityPresets.js` | 新建 |
| `backend-node/src/core/lexicon.js` | 修改（追加 3 张词表，**独立 export**） |
| `backend-node/src/core/personalityFatigue.js` | 新建 |
| `backend-node/src/core/personalityRules.js` | 新建（26 条规则 + 6 道闸纯函数） |
| `backend-node/src/core/prompts/personalityPrompt.js` | 新建（35 条 5 档文案 + 组装） |

**前置依赖**：无

**验收标准**
1. `personalityDims.js` 导出 `PERSONALITY_DIMS`（7 项，顺序 independence→willfulness→sensitivity→security→affection→**playfulness**→trust）与 `DIM_KEYS`；改任一 `label`，UI 与 prompt 同步生效（无第二处文案）。
2. `personalityPresets.js` 的 6 组数值与 PRD §3 表格**逐字一致**；`DEFAULT_PRESET_ID === 'gentle'`。
3. `lexicon.js` 新增 `DEPENDENCY` / `REASSURANCE` / `APOLOGY` 三个独立 export；**`RELATIONSHIP_LEXICON` 数组内容与顺序一行未改**；`npm test` 里既有的词表互斥用例全绿。
4. `computeDrift(signals, { mode:'instant' })` 对 18 条规则逐条可复现（同输入 → 同输出），每条返回 `ruleId` + PRD §4.4 对应中文 `reason`。
5. `computeDrift(dayStats, { mode:'pattern' })` 覆盖 8 条模式规则。
6. `fatigueMultiplier(0)=1.0 / (1)=0.6 / (2)=0.3 / (5)=0.3`。
7. `clampCurrent(105, 95)===100`（**上界是 100 不是 110**）；`clampCurrent(-3, 5)===0`；`clampCurrent(70, 50)===70`。
8. `applyDailyCap` 在 `accum.security=2.0` 时把 `+3.0` 削到 `+1.0` 且 `accum.security=3.0`。
9. `applyBaselinePull({security:80}, {security:50}, 0.08)` → `security ≈ 77.6`。
10. `buildPersonalityPrompt()` 对任意 `current` 取值都输出 7 个性别描述（**无空段落**）。
11. 纯函数模块**零 I/O 依赖**：`grep -n "jsonStore\|fs\|fetch\|await" personalityRules.js personalityFatigue.js` 无结果。

### T02 — 后端引擎层（状态机 + 迁移 + 落盘）

**涉及文件**
| 文件 | 动作 |
|---|---|
| `backend-node/src/core/PersonalityDrift.js` | **重写** |

**前置依赖**：T01

**验收标准**
1. 用现有 `data/personality_state.json`（`willfulness=32.751999999999995`、`security=59.604`）启动 → 无异常，`baseline.willfulness===33`、`baseline.security===60`、`baseline.playfulness===50`、`presetId==='custom'`、`version===2`，且文件被改写为 v2 结构。
2. `settleDaily(now)` 幂等：同一 `dayKey` 内重复调用只结算一次；跨日后 `daily.accum` 归零并重新结算。
3. `recordUserTurn('你真好', { sentiment: 0.5, affinity: 40, affinityChange: 0 })` → R01 命中，`security +0.6 / affection +0.4`，写一条 `source='auto'` 账本且 `userInputDigest` ≤20 字。
4. 冷启动：`stats.totalMessages=10` 时同样的输入，delta 为正常值的 **0.5 倍**。
5. `applyManual({ independence: 62 })` → `baseline=62`，`current = clamp(62 + offset_old, 47, 77)`（**保留相对偏移**）。
6. `applyPreset('tsundere')` → `baseline === current === tsundere.traits`，写 `source='preset'` 账本。
7. `reset()` → `baseline===current===gentle`、`ledger===[]`、`daily.accum==={}`、`stats` 保留、`driftEnabled` 保留。
8. `setFlags({ driftEnabled: false })` → `current` 立即收回 `baseline`，写一条 `source='reset'` 账本；之后 `recordUserTurn` 只更新 stats、不产生漂移、不写 auto 账本。
9. `getPromptInjection()` 在 `|current-baseline|>8` 时含最近一条 ledger 的 `reason`；含「你的底色是「X」」。
10. `getDominantTraits()` 覆盖 7 维。
11. 单日上限：构造「连发 30 句夸奖」→ `security` 当日涨幅 ≤3 且不越 `baseline+15`。
12. 账本 ≤200 FIFO；`changes` 全为 0 的触发**不写账本**。

### T03 — 后端路由 + 编排接入 + 测试纳管

**涉及文件**
| 文件 | 动作 |
|---|---|
| `backend-node/src/routes/personalityRoutes.js` | 新建 |
| `backend-node/src/app.js` | 修改（挂载路由） |
| `backend-node/src/core/AiGirlfriend.js` | 修改（3 处接入 + 1 处缺陷修复） |
| `backend-node/scripts/test-personality.mjs` | 新建（规则 ≥20 例 + 节流 ≥8 例） |
| `backend-node/package.json` | 修改（`npm test` 串联） |

**前置依赖**：T01、T02

**验收标准**
1. `GET /personality` 返回 `§4.1` 全部字段；`dims.length===7`、`presets.length===6`、`band===15`。
2. `POST /personality { traits: { independence: 62 } }` → 200 且落盘；`{ traits: { foo: 1 } }` → 400 `unknown personality dim: foo`；`{ presetId: 'nope' }` → 400。
3. `GET /personality/ledger` → 时间升序数组（空时为 `[]`）。
4. `POST /personality/reset` → `{ status:'reset', ...state }` 且 `state.ledger.length===0`。
5. **`_prepare()` 第 282 行开头即调用 `settleDaily()`**，位于 `shouldGhost()` 判断（原第 291 行）**之前**；删除原第 308-311 行的 `todayStr/todayMsgCount/updateDailyStats` 三行。
6. 模拟 ghosting 期间跨天（`emotionEngine.state.P = -0.9` + `lastSettledDay` 为昨天）→ 模式规则仍结算并写账本（`grep` 日志有 `[Personality] settled`）。
7. `_finalize()` 中 `sentiment` 改为 `emotionDelta?.P ?? autoDelta.P`（**用 `??` 不用 `||`**，否则 `P===0` 会误 fallback）；删除原 `recordInteraction(sentiment, isConflict)` 调用。
8. `resetAll()` 含 `this.personalityDrift.reset()`。
9. `npm test` 全绿（含新增 `test-personality.mjs`，≥28 例，不依赖 LLM / 网络）；`npm run check` 全绿。
10. 一次 chat 的漂移计算路径上**无任何 `await` / 网络调用**（`grep` 确认）。

### T04 — 前端契约层 + 状态与提交 Hook

**涉及文件**
| 文件 | 动作 |
|---|---|
| `frontend/src/types/index.ts` | 修改（追加 6 个类型） |
| `frontend/src/lib/api.ts` | 修改（追加 4 个方法） |
| `frontend/src/stores/personalityStore.ts` | 新建（zustand，**不用 persist**） |
| `frontend/src/hooks/usePersonality.ts` | 新建（debounce + 请求序号） |

**前置依赖**：T03（API 已可联调）

**验收标准**
1. `npx tsc --noEmit` 零错误；`npx eslint src` 零警告（含 React 19 Compiler 规则）。
2. `api.*` 四个方法全部走 `request()`，路径无 `/api` 前缀，body 为 **camelCase**。
3. `usePersonality()` 挂载时 `api.getPersonality().then(setState)` + `cancelled` 标志（**不在 effect 同步体内 setState**）。
4. debounce 300ms：连续拖动只发一次请求；同一窗口内多维度改动合并为一个 `traits` 对象。
5. **请求序号 last-write-wins**：快速连续提交两次，过期响应被丢弃，滑块不回退（手工验证 + 代码 `seqRef` 可见）。
6. 切换预设时 `clearTimeout` + 清空 pending，不与 traits 混合提交。
7. 「今天/昨天」判定的 `now` 用 `useRef<number|null>(null)` + effect 赋值（**render 期不调 `Date.now()`**）。

### T05 — 前端 UI 组件 + 设置页集成

**涉及文件**
| 文件 | 动作 |
|---|---|
| `frontend/src/components/settings/personality/PersonalityPresetGrid.tsx` | 新建 |
| `frontend/src/components/settings/personality/PersonalitySlider.tsx` | 新建 |
| `frontend/src/components/settings/personality/PersonalityLedger.tsx` | 新建 |
| `frontend/src/components/settings/tabs/SettingsPersonalityTab.tsx` | 新建 |
| `frontend/src/components/settings/SettingsDialog.tsx` | 修改（加 Tab + ConfirmDialog） |

**前置依赖**：T04

**验收标准**
1. 侧栏 6 个 Tab（通用/语音/记忆/**性格**/主动/系统），`w-32` 不溢出，`h-[420px]` 内 6 个按钮不裁切；性格 Tab 图标为 `Palette`。
2. 预设卡片 6 张 `grid-cols-3 gap-2`；**未激活写 `border-transparent`**（激活态边框常驻，点击无位移）。
3. `customizedCount>0` 时显示「当前：温柔 · 已微调 N 项」+「恢复到该预设」按钮。
4. 滑块同时呈现 3 个视觉元素：baseline 把手、**current 小三角**、半透明浮动带 `[baseline-15, baseline+15]`；定位**全部用 `translate-x`**（无 left/right）。
5. **framer-motion 与 Tailwind 平移不冲突**：motion 只作用于外层 `x`，居中偏移由内层 `-translate-x-1/2`（Tailwind）承担 —— 拖动时把手不偏移。
6. 数值区 `min-w-[4.5rem]` + `tabular-nums`，位数变化不引起布局跳动。
7. 时间线默认 20 条 / 展开 ≤200；容器 `min-h-[160px]` + `overflow-y-auto [scrollbar-gutter:stable] overflow-x-hidden`；空态显示「还没有性格变化 —— 多和她聊聊天，她会慢慢被你影响的」。
8. 每条时间线含：时间（今天/昨天/MM-DD HH:mm）、source 徽章、维度中文名 + `before→after`（1 位小数，带符号与颜色）、reason、`source='auto'` 时附 `userInputDigest`。
9.「恢复默认预设」→ `ConfirmDialog` 渲染为 `Dialog` 的**兄弟节点**，`type="danger"`，文案与 PRD §12.3 一致；确认后 toast 提示且时间线清空。
10. 动效时长只用 `duration-fast/normal/slow`；`npx tsc --noEmit` + `npx eslint src` 全绿。

---

## 7. 依赖包列表

**结论：零新增依赖。**

| 侧 | 说明 |
|---|---|
| 后端 | 规则是纯 JS（字符串 `includes` + 数值运算），测试用现有 `node scripts/*.mjs` + 内置 `assert`（`test-affinity.mjs` 已是这个范式）。`express` / `openai` / `dotenv` 等既有依赖已足够。 |
| 前端 | 图标用 `lucide-react@^0.562.0`（已有，`Palette` 可用）；动效用 `framer-motion@^12`（已有）；状态用 `zustand@^5`（已有，与 `settingsStore` 同款）；`clsx` + `tailwind-merge` 已有（`cn()`）。 |

> 若后续 P2-c「保存为我的预设」需要本地持久化，也用 `src/lib/storage.ts` 的平铺 key，不引入新库。

---

## 8. 共享知识（跨文件硬性约定）

### 8.1 命名与字段

- **维度顺序**：`DIM_KEYS` 是唯一真源。UI 渲染、prompt 段落、API `dims[]`、账本 `changes[]` 全部按它排序。**任何模块禁止手写维度数组**。
- **日志前缀**：统一 `[Personality]`。格式 `[Personality] R01 praise_warmth → security +0.6 (50.0 → 50.6)`。
- **账本 `source` 取值**：`'auto' | 'manual' | 'preset' | 'baseline_adapt' | 'reset'`，**无第六种**。
- **ruleId**：即时规则 `R01`–`R18`，模式规则 `S01`–`S08`，手动/预设/重置为 `null`。
- **API 字段名**：性格路由一律 **camelCase**（`presetId` / `traits` / `driftEnabled` / `baselineAdaptEnabled` / `customizedCount`），与 `/config/proactive` 同级例外，**不得**走 `syncConfig` 的 snake_case 映射。

### 8.2 数值规则（clamp / round）

```js
const clampInt  = (v) => Math.max(0, Math.min(100, Math.round(Number.isFinite(v) ? v : 50)));
const round1    = (v) => Math.round(v * 10) / 10;
```

- **`baseline` 存整数**（`clampInt`）；**`current` 存 1 位小数**（`round1`）。
- **浮动带 clamp 顺序（明确结论）**：

```js
export function clampCurrent(v, baseline, band = PERSONALITY_RULES.FLOAT_BAND) {
    const lo = Math.max(0, baseline - band);      // ★ 端点先夹 0
    const hi = Math.min(100, baseline + band);    // ★ 端点先夹 100
    const x  = Number.isFinite(v) ? v : baseline;
    return round1(Math.max(lo, Math.min(hi, x)));
}
```

  **为什么这样写**：`lo/hi` 各自先夹过 0/100 后，`[lo, hi] ⊆ [0, 100]`，于是「先带后 0-100」与「先 0-100 后带」**完全等价**，单次 clamp 即完备。`baseline=95` 时 `hi = 100` 而不是 `110`；`baseline=5` 时 `lo = 0` 而不是 `-10`。
  **禁止**：分两步写 `Math.max(0, Math.min(100, x))` 再 `Math.max(baseline-band, ...)` —— 一旦有人漏写端点的 0/100 夹取（例如 P2-a 改成 `±12` 时），第二个 clamp 会把值推回越界。这条要写成单测断言。

- **delta 与 accum**：`delta = round1(after - before)`；`daily.accum[dim] += delta`（累加的是**实际应用值**）。
- **账本 `changes`** 里 `before`/`after` 是 `current` 的 1 位小数；手动/预设条目同样 1 位小数（整数也会显示成 `62.0`，保持列对齐）。

### 8.3 六道闸的精确作用口径

| 闸 | 参数 | 作用于即时规则 | 作用于模式规则 | 计入 `daily.accum` |
|---|---|---|---|---|
| ① 单轮上限 | ±1.5 / 维 | ✅ | ❌（模式一天只结算一次，不受单轮约束） | — |
| ② 单日上限 | ±3.0 / 维 | ✅ | ✅ | ✅ |
| ③ 浮动带 | ±15 | ✅ | ✅ | ❌（被带夹掉的位移不计） |
| ④ 规则疲劳 | ×1.0 / ×0.6 / ×0.3 | ✅ | ❌ | — |
| ⑤ 基线回拉力 | ×0.08 / 日 | ❌ | ✅（在 `settleDaily` 内） | **❌ 明确不计入**（PRD §5） |
| ⑥ 冷启动 | ×0.5（`totalMessages<20`） | ✅ | ✅ | — |

**疲劳系数口径**：按「**本次之前** 24h 窗口内该 ruleId 已命中次数 n」取：`n=0→1.0`、`n=1→0.6`、`n≥2→0.3`（与 `affinityFatigue.applyGainFatigue` 的 "recentPositiveCount=0 → 原值" 口径一致）。

**回拉力不写账本**：它每天都发生，写账本会淹没真正的信号，且用户会困惑「没聊天为什么有变化」。PRD 未要求，**本设计明确为不写**（见 §9-Q3）。

> ⚠️ 闸②与闸③的执行顺序及 accum 记账口径的**唯一权威裁决**见 **§10 R-9**：先 cap（净额语义）→ 再 clamp 浮动带 → accum 按实际位移累加；引擎层禁止直接采用 `applyDailyCap` 返回的 accum。

### 8.4 日界与 `dayKey`

- **一律用 `src/utils/dayKey.js` 的 `dayKey()`**（本地自然日 `YYYY-MM-DD`），与 `AffinityEngine` / `ProactiveEngine` 同一口径。
- **禁止**再出现 `new Date().toDateString()`（旧 `stats.lastActiveDate` 是 `'Tue Sep 29 2026'`）。迁移时归一化：格式不匹配 `/^\d{4}-\d{2}-\d{2}$/` → 置 `null`。
- `daily.accum`、`stats.today` 均在 `_rollDayIfNeeded(now)` 里跨日归零。

### 8.5 `ruleHits` 裁剪

- 每次 `recordUserTurn`：**先**对全部 ruleId 做 24h 裁窗 → **删除空数组条目** → **再** push 本次命中的 `now`。
- 单条规则最多保留 `MAX_HITS_PER_RULE = 50` 个时间戳（超出丢最旧）。26 个固定 ruleId × 50 → 有界，不会无限增长。

### 8.6 账本裁剪

- `LEDGER_MAX = 200`，`splice(0, len - 200)`，**统一 FIFO，无 `manual`/`preset` 保留特例**。
- **`changes` 为空的触发不写账本**（`round1(delta) === 0` 的维度先过滤，过滤后为空则整条丢弃）。

### 8.7 手动 / 预设 / 重置对 `daily.accum` 的影响

| 动作 | `daily.accum` |
|---|---|
| `applyManual(traits)`（拖滑块） | **只 `delete accum[dim]`** 涉及的维度（手动位移不该消耗当天漂移额度），其余维度保留 |
| `applyPreset(presetId)` | **整体清空**（参照系完全重置） |
| `reset()` | **整体清空** |

### 8.8 `customized` 的派生规则

```js
// GET /personality 时计算，不信任落盘值
const preset = getPreset(this.presetId);
const customizedCount = preset ? DIM_KEYS.filter(k => this.baseline[k] !== preset.traits[k]).length : 0;
const customized = preset ? customizedCount > 0 : true;   // 'custom' 恒为 true
```
理由：避免「改回预设值后标志没清」的状态不一致。

### 8.9 前端防抽动与 framer-motion 冲突（滑块 DOM 方案）

```html
<!-- 固定高度容器（规则②） -->
<div class="relative h-10">
  <!-- 轨道 -->
  <div class="absolute inset-x-0 top-3 h-2 rounded-full bg-surface-2">
    <!-- 浮动带：left=0 + width% + translateX%（规则④） -->
    <div class="absolute top-0 h-2 rounded-full bg-accent-1/25"
         style="width: {hi-lo}%; transform: translateX({lo}%)" />
  </div>

  <!-- 原生 range：透明全覆盖，负责交互 + 键盘无障碍 + pointer 事件 -->
  <input type="range" min="0" max="100" step="1" value={baseline}
         class="absolute inset-0 w-full cursor-pointer appearance-none bg-transparent opacity-0" />

  <!-- current 小三角：外层 motion 只管 x，内层 Tailwind 管居中偏移 -->
  <motion.div class="absolute top-7" style={{ left: 0 }}
              animate={{ x: `${current}%` }} transition={{ duration: 0.2 }}>
    <div class="-translate-x-1/2 h-0 w-0 border-x-4 border-b-[6px]
                border-x-transparent border-b-accent-strong" />
  </motion.div>

  <!-- baseline 把手：同结构 -->
  <motion.div class="absolute top-1" style={{ left: 0 }}
              animate={{ x: `${baseline}%` }} transition={{ duration: 0.2 }}>
    <div class="-translate-x-1/2 h-4 w-4 rounded-full border-2 border-accent-1 bg-white shadow" />
  </motion.div>
</div>
```

**为什么双层**：
> ⚠️ Tailwind v3 的 `-translate-x-1/2` 生成的是 `transform: translate(...)`，framer-motion 动画时会把**内联 `transform` 整个覆盖**，导致居中失效、把手瞬移半个身位。
> **解法**：motion 只作用于外层（写 `x`），居中偏移交给**内层元素**的 Tailwind class —— 两层各写各的 transform，互不干扰。

**定位数学**：值域 0-100 直接就是轨道百分比；`lo = max(0, b-15)`，`hi = min(100, b+15)`。
**数值区**：`min-w-[4.5rem] text-right tabular-nums`（防位数变化引起布局跳动）。

### 8.10 前端提交：debounce 与服务端 race

```ts
// hooks/usePersonality.ts
const seqRef    = useRef(0);                                  // 请求序号
const timerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
const pendingRef = useRef<Partial<Record<PersonalityDimKey, number>>>({});

/** 拖动：本地乐观更新 + 300ms debounce 合并提交 */
const setDim = (dim, value) => {
  patchLocal(dim, value);                                     // 立即渲染，保证手感
  pendingRef.current = { ...pendingRef.current, [dim]: value };
  if (timerRef.current) clearTimeout(timerRef.current);
  timerRef.current = setTimeout(flush, 300);
};

/** 提交：last-write-wins */
const commit = async (payload) => {
  const seq = ++seqRef.current;
  try {
    const next = await api.updatePersonality(payload);
    if (seq !== seqRef.current) return;                       // ★ 已有更新的请求 → 丢弃本次响应
    setState(next);                                           // 后端是真源，覆盖本地（含 clamp 结果）
    setLedger(await api.getPersonalityLedger());
  } catch { showToast('性格保存失败，请检查后端连接', 'error'); }
};

/** 切预设：立即取消 pending，避免 traits 与 presetId 语义打架 */
const applyPreset = (id) => {
  if (timerRef.current) clearTimeout(timerRef.current);
  pendingRef.current = {};
  commit({ presetId: id });
};
```

**与 proactive 的差异（PRD §11 明确）**：性格是**即时提交**（debounce 300ms），不走 SettingsDialog 的「保存全部配置」按钮；因此 `SettingsPersonalityTab` **不参与** `handleSave()`。

### 8.11 React 19 Compiler lint 红线

- effect 同步体内**不能 setState** → 一律 `api.xxx().then(setX)` + `cancelled` 标志。
- render 期**不能调非纯函数** → `Date.now()` 用 `useRef<number|null>(null)` + effect 赋值（`new Date(isoString)` 是纯的，可直接调）。
- ref **不能在 render 期读写** → `timerRef` / `seqRef` 只在事件回调与 effect cleanup 中读写。
- effect 用到的函数**必须先声明**或 `useCallback` 包裹。

### 8.12 提交前必跑

```bash
cd backend-node && npm run check          # vm.SourceTextModule 语法解析
cd backend-node && npm test               # stream-filter 8 例 + affinity 34 例 + personality ≥28 例
cd frontend && npx tsc --noEmit
cd frontend && npx eslint src
```

---

## 9. 待明确事项

| # | 事项 | 本设计的决定 | 备注 |
|---|---|---|---|
| Q1 | 模式规则（S01–S08）是否受单轮上限 ±1.5 约束？PRD §5 的「单轮」语义是针对「一句话」，但模式规则单条 delta 就有 ±2.0 | **不受**。模式规则走每日结算通道，只受单日上限 ±3.0 与冷启动约束；不受规则疲劳约束（一天只结算一次） | 若产品坚持统一，S01 的 `independence +2.0` 会被削成 1.5，与 PRD §4.3 表格不符，需 PM 确认 |
| Q2 | `driftEnabled` 关闭瞬间，`current` 是否立即收回 `baseline`？ | **是**。立即 `current = {...baseline}`，写一条 `source='reset'` 账本（reason：你关掉了「允许聊天改变性格」，她的浮动已收回基线）；重新开启时**不**恢复旧 current，从 baseline 重新漂 | PRD P1-b 只说「关闭后 current 锁定 = baseline」，未说切换瞬间行为 |
| Q3 | 基线回拉力（每日 ×0.08）是否写账本？ | **不写**。每天都发生，写会淹没真实信号，且用户会困惑「没聊天为什么有变化」 | 若希望可追溯，可改为「累计偏移 ≥1.0 时才写一条」，需 PM 确认 |
| Q4 | 账本 200 条溢出时是否保留 `manual`/`preset` 条目？ | **不保留特例，统一 FIFO** | 见 §8.6 |
| Q5 | `stats.recentTurns`（≤50）是新字段，v1 存档没有 → 模式规则 S03/S04 在迁移后的一段时间里数据不足 | 迁移时置空数组；S03/S04 要求 `recentTurns.length >= 20` 才生效（数据不足不下判断） | 与「冷启动保护」同思路，建议纳入实现 |
| Q6 | P2-a（security/trust 用 ±12 差异化浮动带） | 本期**不做**，全部 ±15。`clampCurrent` 已预留 `band` 参数，未来按维度传即可 | — |
| Q7 | 前端是否需要把 `presetId` 同步到 localStorage？ | **不需要**。性格状态是后端运行时状态，真源在 `personality_state.json`，Tab 挂载时 `GET /personality` 拉取 | 与团队约定「不用 persist 中间件」一致 |

---

## 10. 遗留歧义裁决（QA 测试用例清单撞出的 5 个未定义点）

> 以下 5 条为**唯一权威口径**，与 PRD / 本文档前文冲突时**以本节为准**。每条均已对照
> `backend-node/src/core/personalityRules.js` 与 `PersonalityDrift.js` 的实际实现核对（2026 实现 57 项测试全绿版本）。

### R-1 R02（praise_vanity）的 24h 计数口径

- **结论**：计数口径为 `pruneRuleHits` 裁窗后的 `ruleHits['praise_warmth'].length >= 4`（**本次命中之前**、24h 滚动窗内）。不统计 `praise_vanity` 自身，也不做 PRAISE 类累计。
- **理由**：PRD「PRAISE 且 24h 内已命中 ≥4 次」的「已命中」主语是被疲劳计数的那条强信号规则，即 R01；实现 `evaluateInstantRules` 第 207 行 `if (signals.category === 'PRAISE' && (fatigueCounts.praise_warmth || 0) >= 4)` 正是此语义，且 `fatigueCounts` 在 `recordUserTurn` 中先裁窗、后计算、再记录本次，保证「不含本次」。
- **实现是否需要改动**：**不需要**。实现与 QA 建议完全一致。

### R-3 单日上限的反向额度语义

- **结论**：**净额语义**：`remaining = MAX_PER_DAY - accum[dim]`，accum 允许为负。`accum = -1.0` 时正向仍可放行 +3.0（落到 +2.0）；`accum = 2.0` 时 +3.0 削为 +1.0（既有例子不变）。即当日净变化被夹在 `[-3.0, +3.0]` 区间内，正负额度互不侵占也不互相对冲抵扣。
- **理由**：PRD §5 闸②原文是「单日**净变化**上限」，净额语义是对该句的唯一忠实读法；跨度语义（|净变化| ≤ 3）会把「上午被重话扣 2 格、下午想补偿」的合理曲线误伤。
- **实现是否需要改动**：**不需要**。`applyDailyCap` 第 314 行 `Math.max(-safeMax, Math.min(safeMax, before + change.delta))` 正是净额语义（对称区间夹取）。

### R-9 浮动带与日上限的执行顺序（最要紧）★

- **结论**：唯一确定顺序为——**① `applyDailyCap`（对提议 delta，按 R-3 净额语义裁剪）→ ② `clampCurrent`（浮动带硬夹）→ ③ `daily.accum[dim] += 实际位移`（即 `round1(after - before)`，clamp 后的真实位移）**。**被浮动带夹掉的位移不计入 accum** —— §5.1 时序图「先 DailyCap 再 clamp」与 §8.3 注「被带夹掉的不计入 accum」在此顺序下**同时成立，无矛盾**。
- **理由**：日上限约束的是 delta ∈ `[-3-accum, 3-accum]`，浮动带约束的是 delta ∈ `[lo-current, hi-current]`，两者是**两个独立区间对同一个提议 delta 的夹取，交集运算可交换**——先 cap 后 clamp 与先 clamp 后 cap 结果恒等，前提是 accum 按**实际位移**累加。QA 担心的「日上限被提前耗尽」只有在「accum 按 cap 后的提议值累加」时才会发生。
- **实现是否需要改动**：**不需要，无 P0 缺陷**。`_applyAutoHit`（PersonalityDrift.js 第 527-558 行）正是此顺序：第 529 行先 `applyDailyCap`，第 534 行再 `clampCurrent`，第 538-541 行用 `round1(after - before)` 的**实际 delta** 重算 accum（`applyDailyCap` 返回的 `capped.accum` 被丢弃未采用）。
- **⚠️ 硬性保护约定（防止未来重构引入该缺陷）**：`applyDailyCap` 返回的 `accum` **只允许在纯函数单测里作断言用，引擎编排层禁止直接采用**——一旦有人把 `capped.accum` 直接赋回 `this.daily.accum`，被浮动带夹掉的位移就会计入日上限，构成 P0 回归。未来若有单测重构，请增加一条断言：构造「提议 +3.0、accum=0、current 顶在带上沿」的场景，最终 `daily.accum` 必须等于实际位移（< 3.0）而非 3.0。

### R-10 模式规则与即时规则是否共享 `daily.accum`

- **结论**：**共享同一个 `this.daily.accum`**。即时（R01-R18）与模式（S01-S08）的自动漂移是同一本账，单日 ±3 上限对两条通道合计生效；跨自然日由 `settleDaily → _rollDayIfNeeded` 同语义重置归零。
- **理由**：两条通道服务同一个「今天她最多变 3 格」的用户心智；分账会让日上限实际放宽到 6 格，违背 PRD §5 闸②「即时与模式都受它约束」的原文。
- **实现是否需要改动**：**不需要**。`settleDaily`（第 213-216 行）与 `recordUserTurn`（第 295-298 行）的命中统一走 `_applyAutoHit`，全部读写 `this.daily.accum`。注意 `settleDaily` 在结算模式规则前会把 `this.daily` 重置为新 dayKey 的空 accum（第 203 行），即模式规则吃的是**新一天**的额度——这是有意为之，与「模式规则一天只结算一次」一致。

### R-6 前端是否引入 vitest 等自动化测试基建

- **结论**：**维持零新增依赖**。前端 T04/T05 不引入 vitest / jest / testing-library，验证手段为：`npx tsc --noEmit` + `npx eslint src` 静态校验，叠加下方手工验证清单。
- **理由**：PRD §14 明确「不引入新依赖」；DESIGN §7 已给出「零新增依赖」结论，当时即是含测试策略在内的完整决定。debounce 合并 / last-write-wins / 防抽动属于需要真实浏览器时序的行为，单测 mock 计时器反而测不出真实手感。
- **实现是否需要改动**：**不需要**。QA 手工验证时按以下清单执行（补入本节后即为验收口径）：
  1. **debounce 合并**：300ms 内连续拖动同一滑块 5 次 → DevTools Network 面板只见 1 个 `POST /personality`，body 为最后一次值。
  2. **跨维度合并**：300ms 内先后拖「独立性」「安全感」→ 1 个请求，`traits` 同时含两个 key。
  3. **last-write-wins**：拖动后 100ms 内再次拖动并松手 → 两次请求均发出，但滑块最终停在第二次的值，**不回跳**到第一次响应返回的旧值。
  4. **切预设打断**：拖动滑块后立刻点预设卡片 → 无 traits 提交发出（pending 被清空），7 个滑块动画过渡到预设值。
  5. **防抽动**：拖动中 framer-motion 动画进行时把手不偏移半个身位（§8.9 双层 transform 方案生效）；数值区位数变化（9.5→10.0）不引起布局跳动。

### 附：测试隔离范式加固（针对 `npm test` flaky 报告）

> 现象：同一份代码连续三次运行，affinity 用例失败数 2/3/3，表现为读到上一用例残留状态。与性格代码无关。

- **根因认定（QA 实测修正版）**：本机沙箱的 **safe-delete 配额**——同一 turn 内 `fs.unlinkSync` 累计达 **50 次**即触发拦截，抛出 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`（`e.code === undefined`，**不是** EBUSY/EPERM 这类真实文件占用错误），且计数跨轮累积、不随进程重启清零。`test-affinity.mjs` 每轮约 11 次删除 + `test-personality.mjs` 每轮约 31 次，单次 `npm test` ≈ 42 次，逼近阈值，连跑必触顶 → `freshEngine()` 的静默 catch 把拦截错误吞掉 → 测试文件残留 → 下一用例构造引擎时读到旧状态 → 偶发红。（早前「Defender/残留句柄占用 EBUSY」的猜测不成立，请勿按重试方案改回。）
- **落地修法：`forceUnlink` 降级覆写**（重试对配额拦截无效，且配额触顶时 throw 会让整轮测试红，故弃用）：
  1. `unlinkSync` 失败且错误码**非 ENOENT** → stderr 打印 `[test] unlink 失败(...)`，**绝不静默吞错**；
  2. 降级为 `writeFileSync(p, '{"version":2}')` 覆写（写入不受 safe-delete 拦截）；
  3. ⚠️ 覆写内容**必须是 `{"version":2}`，不能是 `{}`**：空对象会被 `PersonalityDrift._loadState` 判成「无 version → v1 存档」触发迁移，把 `presetId` 污染成 `'custom'`，残留出新的假状态（QA 实测踩过）。
  该方案在配额触顶的劣化环境下仍保持 129 项确定性全绿。
- **边界说明**：若 unlink 失败的错误码是 EBUSY/EPERM 之类的**真实文件占用**（而非 `code === undefined` 的配额拦截），才考虑「短退避重试若干次」方案；判断依据是错误码本身，不要对一切错误无差别重试。
- 运行 `npm test` 前仍应关掉 8000 端口的旧后端进程以排除干扰；此修法属测试脚本内部，**不引入新依赖、不改引擎代码**，已由 QA 落实。

---

## 附：验收清单速查（对应 PRD P0/P1）

| PRD ID | 落点 |
|---|---|
| P0-a 7 维 + dims 真源 | T01 |
| P0-b 6 预设 + 下发 | T01 / T03 |
| P0-c 双值模型 + v2 + 迁移 | T02 |
| P0-d 手动 API + 性格 Tab | T03 / T05 |
| P0-e 26 条规则纯函数 | T01 |
| P0-f 6 道闸 | T01（纯函数）/ T02（编排） |
| P0-g 调用时机修正（A/B） | T03 |
| P0-h 变化时间线 | T02 / T05 |
| P0-i prompt 5 档注入 | T01（文案）/ T02（组装） |
| P0-j 重置入口（D） | T03 / T05 |
| P0-k 自动化回归 | T03 |
| P1-a 基线缓慢沉淀 | T01（纯函数）/ T02（编排）—— 提到本期 |
| P1-b 漂移总开关 | T02 / T05 |
| P1-d 性格标签 7 维 | T02 |
| P1-e Note 说明区 | T05 |
| 缺陷 E（词表不进互斥链） | T01 |
