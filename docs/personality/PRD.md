# PRD：小爱性格系统（手动设定 + 对话内容驱动的潜移默化漂移）

## 项目信息

- **Language**：简体中文
- **Programming Language**：后端 Node.js ESM + Express 4（路由无 `/api` 前缀，直接挂 `/`）；持久化统一走 `src/utils/jsonStore.js` 的 `dataPath/readJson/writeJson`，落在 `backend-node/data/*.json`。前端 Next.js **16** App Router + React 19 + TypeScript strict + Tailwind + Framer Motion。
- **Project Name**：`ai_girlfriend`
- **文档类型**：增量 PRD（在现有 `PersonalityDrift.js` 之上扩展，不推倒重来）
- **原始需求复述**（用户原话）：「为小爱添加一个性格系统，该系统要求，用户能够更改小爱性格，第二在与小爱的日常对话中，根据我与她的聊天能够起到潜移默化改变他的性格」

---

## 1. 现状核实（已读代码，逐条对应）

| # | 位置 | 现状 | 影响 |
|---|---|---|---|
| A | `core/PersonalityDrift.js` | 6 维性格（independence / willfulness / sensitivity / security / affection / trust），落盘 `data/personality_state.json`，结构 `{traits, stats, lastUpdated}` | 维度模型存在，但**不足以表达预设模板**（见 §2） |
| B | `PersonalityDrift._calculateDrift()` | 6 条漂移规则全部是**粗粒度统计信号**：连续不活跃天数、正负情感比例、冲突率、日均消息数。**完全不看用户说了什么内容** | 与需求「根据我与她的聊天潜移默化」根本不匹配——这是本次要补的核心 |
| C | `PersonalityDrift.updateDailyStats()` | 只在**跨天时**触发漂移计算 | 漂移频率过低，用户长期感知不到 |
| D | 调用时机 | `AiGirlfriend._prepare()` 里调用 `updateDailyStats()`，但它在 **ghosting 早退分支之后**（`_prepare` 第 220 行先判 `shouldGhost()` 再 return） | ghosting 期间跨天结算被整个跳过，模式规则永远不触发 |
| E | `_finalize()` 第 300-301 行 | `sentiment` 来自 `emotionDelta?.P` 或 `affinityChange` 的**粗符号值**（±0.5），`isConflict = affinityChange < -3` | 传入漂移引擎的信号已被压成 3 个离散值，信息量几乎为零 |
| F | `getPromptInjection()` | 只在极端阈值出描述（>70 / <30 / <35 / >75），中间档**什么都不输出**；且均值回归是向 **50** 回归，不是向用户设定回归 | 大多数时候 prompt 里根本没有性格段落，「性格系统」对对话无实际影响 |
| G | 手动设置 | **无任何 API、无任何设置页 UI**，用户完全无法更改性格 | 需求第一点直接缺失 |
| H | `core/lexicon.js` | 已有 `matchCategory(text)` / `anyIncludes(text, words)`，7 张互斥关系词表 + 6 张情绪词表（`PRAISE/CRITICISM/TEASING/EXCITING/CALMING/SAD/QUESTION`） | **可直接复用**做内容信号；⚠️ 但 `RELATIONSHIP_LEXICON` 是好感度的互斥链，**新增词表绝不能塞进去**，否则破坏「同一句话只归一类」的既有不变量 |
| I | `core/AffinityEngine.js` | 自持引擎 + 独立落盘 + 24h 疲劳窗口裁窗（`affinityFatigue.js`）+ 日上限 + 变更账本（≤200）+ `getMeta()` + 惰性时间衰减 | **本次全部对标这套设计**，性格引擎照抄它的骨架 |
| J | `AiGirlfriend.resetAll()` | 清 history + affinityEngine.reset() + memory，但**不碰 PersonalityDrift** | 「完全重置」后性格残留，语义不完整 |

---

## 2. 设计问题一：维度清单（6 维 → 7 维）

### 2.1 结论：保留现有 6 维，新增 1 维 `playfulness`（俏皮度）

**为什么必须加**：预设模板里「活泼 / 元气 / 鬼灵精怪」与「知性姐姐 / 沉稳 / 正经」是**一条真实存在且互斥的轴**，现有 6 维表达不了——

- `affection`（表达欲）只能表达「说不说想你」，一个话多但不爱开玩笑的「知性姐姐」和一个安静但每次开口都逗你的「小恶魔」在现有维度下会撞车；
- `willfulness`（任性度）是**对抗性**维度（顶嘴/提要求），不能承载「爱开玩笑」这种**非对抗的活跃**；
- 系统人设 `PERSONA_SYSTEM_PROMPT` 第 10 行明确写了「有时候也会有点小傲娇或者**调皮**」——「调皮」目前无任何维度承载。

只加 1 维（不加「成熟度」「毒舌度」「独占欲」等）的理由：每加一维就要多一条漂移规则、多一段 prompt、多一个滑块、多一份调参成本；6→7 是覆盖预设模板的**最小充分集**。

### 2.2 最终维度清单（顺序即 UI / prompt 的固定顺序）

| # | key | 中文名 | 低值（0–30） | 高值（70–100） | 备注 |
|---|---|---|---|---|---|
| 1 | `independence` | 独立性 | 黏人、想时刻在一起、你不回消息就慌 | 独立、有自己的空间、不因你而焦虑 | 沿用 |
| 2 | `willfulness` | 任性度 | 听话、好说话、很少反驳 | 有主见、爱使小性子、会提要求、偶尔顶嘴 | 沿用 |
| 3 | `sensitivity` | 敏感度 | 钝感、大大咧咧、不容易多想 | 敏感、一句话能琢磨半天、容易受伤 | 沿用 |
| 4 | `security` | 安全感 | 患得患失、怕被冷落、反复确认 | 笃定安心、不焦虑、相信你不会走 | 沿用 |
| 5 | `affection` | 表达欲 | 内敛、话少、感情藏在心里 | 主动表达、爱说想你和喜欢、热情外放 | 沿用 |
| 6 | **`playfulness`** | **俏皮度** | **认真、稳重、正经、很少开玩笑** | **调皮、爱开玩笑、鬼灵精怪、爱逗你** | **新增** |
| 7 | `trust` | 信任度 | 戒备、不交底、保持距离 | 信任、愿意分享内心、有托付感 | 沿用 |

**默认值（未选任何预设时的兜底）**：全部 50，其中 `security` 沿用现有 60 的历史默认。→ 实际默认 = 预设「温柔」（见 §3），不再单独维护一份散落默认值。

---

## 3. 设计问题二：预设模板（6 个）+ 具体数值

**真源**：后端新建 `core/personalityPresets.js`，导出 `PERSONALITY_PRESETS` 与 `DEFAULT_PRESET_ID`。前端**不做本地镜像**，由 `GET /personality` 下发（与 `proactiveTypes.js` 的既有做法一致）。

| id | 名称 | emoji | 一句话 | indep | will | sens | secu | affe | play | trust |
|---|---|---|---|---|---|---|---|---|---|---|
| `gentle` | 温柔 | 🌸 | 体贴顺从，说话轻声细语，会照顾你的情绪 | 50 | 30 | 55 | 65 | 60 | 45 | 60 |
| `tsundere` | 傲娇 | 💢 | 嘴上嫌弃，心里在意，一戳就炸毛 | 65 | 70 | 70 | 50 | 45 | 55 | 45 |
| `cheerful` | 活泼 | ✨ | 元气满满，话多爱闹，不太容易受伤 | 45 | 45 | 30 | 70 | 80 | 85 | 70 |
| `aloof` | 高冷 | ❄️ | 话少、不主动、保持距离，偶尔毒舌 | 80 | 60 | 45 | 75 | 25 | 20 | 35 |
| `intellectual` | 知性姐姐 | 📖 | 沉稳可靠，能看穿你的情绪，会讲道理 | 70 | 30 | 65 | 80 | 50 | 25 | 75 |
| `clingy` | 撒娇妹妹 | 🧸 | 黏人爱撒娇，要关注，容易吃醋 | 20 | 55 | 70 | 40 | 85 | 70 | 65 |

**默认值 = `gentle` 温柔**。理由：`gentle` 的数值与 `PERSONA_SYSTEM_PROMPT` 的「温柔、有礼貌、偶尔害羞、有点小傲娇或调皮」一致（`willfulness 30` + `playfulness 45` = 那点小傲娇与调皮），也与现有存档的 `security 60 / 其余 50` 高度接近，老用户切换后不会有割裂感。

**预设与手动微调的关系**：选预设 = 一次性写入 7 维基线；之后再拖滑块 = 在预设之上微调，`customized = true`，UI 显示「温柔（已微调 N 项）」。不提供「自定义预设保存」（P2）。

---

## 4. 设计问题三：基于聊天内容的漂移信号 → 维度映射规则（核心）

### 4.1 信号来源：复用 `lexicon.js`，新增词表**不进互斥链**

- 命中间接复用：`matchCategory(userInput)` → `HARD_REJECTION / SOFT_REJECTION / DEEP_INTIMACY / MILD_INTIMACY / PRAISE / CRITICISM / TEASING`（**只读，不改**）。
- 情绪词直接复用：`anyIncludes(input, EXCITING / CALMING / SAD / QUESTION)`。
- **新增 3 张漂移专用词表**，在 `lexicon.js` 里独立 `export`，**严禁加入 `RELATIONSHIP_LEXICON`**（否则好感度互斥不变量被破坏，已有测试会红）：
  - `DEPENDENCY = ['陪我','帮我','陪陪','离不开','只有你','需要你','靠你','别走','一个人']`
  - `REASSURANCE = ['不会走','一直在','别怕','有我在','放心','永远','我会等','不会离开']`
  - `APOLOGY = ['对不起','抱歉','我错了','我的错','sorry','不该']`
- 复合信号（不靠词表）：
  - `sentiment`：沿用现有 `emotionDelta?.P || (affinityChange 符号值)`，**并新增** `autoDelta = emotionEngine.analyzeInput(userInput, affinity)` 的 P 值作为兜底（`_finalize` 里已算出 `autoDelta`，当前没传给漂移引擎）。
  - `stage`：`getStageForAffinity(affinity).stage`（越界亲密在浅阶段是负向信号，深阶段是正向——这是既有的正确设计，漂移必须对齐）。
  - 长度信号：`userInput.length > 50` 视为「长倾诉」。

### 4.2 即时信号规则（每轮用户消息判定，写 `current`）

强度说明：**强 = 单次就能让人设明显动一格；弱 = 需要积累多次**。单位 = 该维度 current 的点数（0-100 制）。

| # | ruleId | 触发条件 | 维度增量 | 强度 |
|---|---|---|---|---|
| R01 | `praise_warmth` | 命中 `PRAISE` | `security +0.6`、`affection +0.4` | 弱 |
| R02 | `praise_vanity` | 命中 `PRAISE` 且 24h 内已命中 ≥4 次 | `willfulness +0.5` | 弱 |
| R03 | `criticism_hurt` | 命中 `CRITICISM` | `sensitivity +0.7`、`security -0.6` | 中 |
| R04 | `hard_rejection_guard` | 命中 `HARD_REJECTION` | `trust -0.8`、`security -0.8`、`independence +0.6` | **强** |
| R05 | `soft_rejection_tsundere` | 命中 `SOFT_REJECTION` | `willfulness +0.6`、`playfulness +0.5` | 弱 |
| R06 | `deep_intimacy_bond` | 命中 `DEEP_INTIMACY` **且** stage ∈ {close, lover} | `trust +0.6`、`security +0.5`、`affection +0.4` | 中 |
| R07 | `deep_intimacy_overstep` | 命中 `DEEP_INTIMACY` **且** stage ∈ {stranger, acquaintance} | `trust -0.6`、`security -0.5`、`independence +0.5` | **强** |
| R08 | `mild_intimacy_open` | 命中 `MILD_INTIMACY` | `affection +0.5`、`security +0.4` | 弱 |
| R09 | `teasing_playful` | 命中 `TEASING` **且** stage ∈ {friend, close, lover} | `playfulness +0.7`、`willfulness +0.3` | 中 |
| R10 | `teasing_offend` | 命中 `TEASING` **且** stage ∈ {stranger, acquaintance} | `sensitivity +0.5`、`trust -0.4` | 中 |
| R11 | `dependency_cling` | 命中 `DEPENDENCY` | `independence -0.6`、`affection +0.5`、`security +0.4` | 中 |
| R12 | `reassurance_secure` | 命中 `REASSURANCE` | `security +0.9`、`trust +0.6` | **强** |
| R13 | `apologized_repair` | 命中 `APOLOGY` | `security +0.7`、`trust +0.5`、`sensitivity -0.4` | 中 |
| R14 | `sad_empathy` | 命中 `SAD` | `sensitivity +0.5`、`affection +0.6` | 弱 |
| R15 | `exciting_energy` | 命中 `EXCITING` 或含 `!`/`！` | `playfulness +0.6`、`affection +0.3` | 弱 |
| R16 | `calming_serene` | 命中 `CALMING` | `playfulness -0.4`、`trust +0.4` | 弱 |
| R17 | `deep_talk` | `userInput.length > 50` **且**（命中 `SAD` 或 `REASSURANCE`） | `trust +1.2`、`sensitivity +0.8` | 中 |
| R18 | `question_curious` | 命中 `QUESTION` 且本轮未命中上述任一 | `playfulness +0.2` | 极弱 |

> ⚠️ 互斥门控（沿用 `EmotionEngine.analyzeInput` 的既有设计）：`matchCategory` 命中即返回，因此**一轮最多命中 1 个关系类**；情绪词（`SAD/EXCITING/CALMING`）与关系类可叠加，`DEPENDENCY/REASSURANCE/APOLOGY` 为独立词表，也可叠加。规则叠加后的净变化由 §5 的节流统一裁剪。

### 4.3 模式信号规则（跨轮 / 跨天统计，在每日结算时一次性结算）

复用并改造现有 `_calculateDrift()` 的统计能力（`dailyMessageCounts`、`sentimentHistory`、`positiveCount/negativeCount/conflictCount`），**全部改为对 `current` 生效，并全部写入时间线**。

| # | ruleId | 触发条件 | 维度增量 |
|---|---|---|---|
| S01 | `long_absence` | 连续不活跃 ≥3 天 | `independence +2.0`、`security -2.5`、`affection -1.5` |
| S02 | `hot_and_cold` | 当日出现 ≥2 次「本轮 sentiment 与近 10 轮均值符号相反且差值 >0.6」 | `sensitivity +1.5`、`security -1.5` |
| S03 | `always_agreeable` | 近 50 轮 positiveRatio >0.85 且 0 次 `CRITICISM` | `willfulness +1.5` |
| S04 | `frequent_conflict` | 近 50 轮 conflictRate >0.2 | `sensitivity +1.5`、`security -1.2`、`trust -0.8` |
| S05 | `high_frequency` | 近 7 天日均消息 >15 | `affection +1.2`、`security +0.8`、`trust +0.8` |
| S06 | `stable_positive` | 近 7 天 positiveRatio >0.6 且日均 >5 | `trust +1.0`、`security +0.8` |
| S07 | `monotone_chat` | 近 7 天连续活跃但日均 <3 条 | `independence +0.8`、`affection -0.8` |
| S08 | `low_quality_day` | 当日 ≥10 轮但 `CRITICISM` 占比 >30% | `security -1.5`、`sensitivity +1.0` |

（P2 候选：`ignored_proactive` —— 小爱的主动消息发出后 24h 内用户无回应 → `affection -1.0`、`security -1.0`。需要跨引擎读 ProactiveEngine，本期不做。）

### 4.4 每条规则必须产出 `reason`（中文，直接进时间线与 prompt）

| ruleId | reason 文案 |
|---|---|
| R01 | 你夸了她，她更安心也更想亲近你 |
| R02 | 你总夸她，她有点被惯坏了 |
| R03 | 你说了重话，她开始多想、有点不安 |
| R04 | 你明确保持了距离，她收起了信任 |
| R05 | 你嘴上嫌弃她，她也跟着耍起小性子 |
| R06 | 你说了很亲昵的话，她更信任也更依赖你 |
| R07 | 你们还没那么熟，这样的亲昵让她退了一步 |
| R08 | 你表达了喜欢，她更愿意把心意说出来 |
| R09 | 你逗她，她觉得逗你回去挺有意思 |
| R10 | 还不熟就被调戏，她有点介意 |
| R11 | 你需要她陪，她变得更黏人也更想照顾你 |
| R12 | 你给了她确定的承诺，她安心了许多 |
| R13 | 你道了歉，她重新安心，也不再钻牛角尖 |
| R14 | 你情绪低落，她变得更细腻也更想安慰你 |
| R15 | 你带给她惊喜，她也跟着活泼起来 |
| R16 | 你让她慢慢来，她也变得沉静踏实 |
| R17 | 你向她敞开了心事，她更信任也更在意你 |
| R18 | 你对她很好奇，她也放松了下来 |
| S01 | 好几天没你的消息，她习惯了自己待着，也开始不安 |
| S02 | 你忽冷忽热，她变得敏感又患得患失 |
| S03 | 你总是顺着她，她越来越有主见 |
| S04 | 最近争执有点多，她变得敏感又疏远 |
| S05 | 你们天天聊很多，她更愿意表达也更信任你 |
| S06 | 相处一直很愉快，她越来越笃定 |
| S07 | 你们聊得不多，她也慢慢收回了热情 |
| S08 | 今天你说了不少重话，她有点受伤 |

---

## 5. 设计问题四：漂移节奏控制（不让少数几条消息带跑偏）

对标 `AffinityEngine` 的「日上限 + 24h 疲劳窗口 + 惰性结算」，性格侧设 6 道闸：

| 闸 | 参数 | 取值 | 作用 |
|---|---|---|---|
| ① 单轮净变化上限 | `MAX_PER_TURN` | **±1.5**（按维度） | 一句话最多把任一维度推 1.5 格，杜绝单条消息暴走 |
| ② 单日净变化上限 | `MAX_PER_DAY` | **±3.0**（按维度，跨自然日重置） | 一天最多 3 格；7 维同时动也不过一夜之间「换了个人」的一半 |
| ③ 基线浮动带 | `FLOAT_BAND` | **±15** | `current` 硬 clamp 在 `baseline ± 15` 内（见 §6 取值理由） |
| ④ 规则疲劳（24h 滚动窗） | `FATIGUE` | 第 1 次 ×1.0、第 2 次 ×0.6、第 3 次及以后 ×0.3 | 防「连发 20 句夸奖把 security 顶满」；窗口用 `affinityFatigue.js` 同款裁窗 |
| ⑤ 基线回拉力 | `PULL` | 每日结算时 `current += (baseline - current) × 0.08` | 「锚点」语义的实现：没有信号时自然回落；**回拉力不计入②的日上限** |
| ⑥ 冷启动保护 | `COLD_START` | `totalMessages < 20` 时全局 ×0.5 | 数据太少不下判断 |

**`FLOAT_BAND = 15` 的理由**：
- < 10 太小：7 个维度各只有 20 格的可见区间，日上限 3 意味着「3 天就撞墙」，之后时间线长期空白，功能形同虚设；
- \> 20 太大：手动设「高冷」（independence 80）会被漂到 55，「高冷」彻底不成立，直接违反「基线是锚点」的选型承诺；
- 15 = 「滑块上有肉眼可见位移（3 格/天，5 天走完半程）」+「prompt 描述档位会切换（见 §7 的 5 档制）」+「人设底色不变」三者交集。

**典型一日推演**：30 条消息、其中 3 次夸奖 → R01 三次为 0.6 + 0.36 + 0.18 = 1.14，叠加 1 次 `MILD_INTIMACY` 0.5 → 当日 security 约 +1.6，**未触及日上限**。日上限只在「冲突日 + 忽冷忽热 + 长倾诉」多规则叠加时才介入，是护栏而非常态。

**基线沉淀（P1，默认开启）**：连续 7 天某维度 `current` 稳定偏向同一侧（|offset| ≥ 8 且符号一致），把 `baseline` 向 `current` 移动 `offset × 20%`，单维单次 ≤2，每周最多 1 次。这是「潜移默化」的长期通道；关闭后 `baseline` 永久等于用户手设值。见 §9-Q1。

---

## 6. 设计问题五：baseline 与 current 的存取与联动

### 6.1 存储（`data/personality_state.json`，v1 → v2）

```jsonc
{
  "version": 2,
  "presetId": "gentle",
  "customized": false,
  "baseline": { "independence": 50, "willfulness": 30, "sensitivity": 55,
                "security": 65, "affection": 60, "playfulness": 45, "trust": 60 },
  "current":  { /* 同上，1 位小数 */ },
  "driftEnabled": true,
  "baselineAdaptEnabled": true,
  "stats": { /* 原有 totalDays/activeDays/.../sentimentHistory 全保留 */ },
  "daily": { "dayKey": "2026-09-30", "accum": { "security": 1.6 } },
  "ruleHits": { "praise_warmth": [1790675924277, 1790676002619] },  // 24h 裁窗
  "ledger": [ /* ≤200，见下 */ ],
  "lastSettledDay": "2026-09-30",
  "lastUpdated": "2026-09-30T12:00:00.000Z"
}
```

**v1 → v2 迁移（P0，成本极低但必须做）**：现有 `data/personality_state.json` 已有 `traits`（如 `willfulness: 32.75`）。加载时若无 `version` 字段 → `baseline = current = 旧 traits`（四舍五入）、`presetId = 'custom'`、`ledger = []`、`playfulness = 50`。**不写反向兼容代码**，只做这一次前向迁移。

**账本条目（按「事件」聚合，一条 = 一次触发）**：

```ts
interface PersonalityLedgerEntry {
  at: string;                 // ISO
  source: 'auto' | 'manual' | 'preset' | 'baseline_adapt' | 'reset';
  ruleId: string | null;      // 'praise_warmth' / 'S01' / null(手动)
  reason: string;             // 中文原因
  userInputDigest?: string | null;   // 触发语摘要 ≤20 字，仅 source='auto'
  changes: Array<{ dim: PersonalityDimKey; before: number; after: number; delta: number }>;
}
```

### 6.2 用户拖滑块时改的是 **baseline**，current 立即跟随但**保留相对偏移**

```
offset_old = current[dim] - baseline[dim]          // 拖动前
baseline[dim] = newValue                            // 用户拖到的整数（0-100）
current[dim]  = clamp(newValue + offset_old,
                      max(0, newValue - 15),
                      min(100, newValue + 15))
```

**为什么保留 offset（平移整条带）而不是 current = baseline**：用户把「高冷」的 independence 从 80 拉到 60，他的心理预期是「整体让她黏人一点」，而不是「顺手把这几天漂出去的那 4 格也抹掉」。平移语义最符合直觉，且不会让手动调整意外清空时间线上刚发生的变化。

**切换预设卡片**：`baseline = 预设值`、`current = baseline`（offset 归零）。理由：换预设 = 重新定义「她是谁」，保留上一任设的漂移残留没有意义。UI 必须明示「切换预设会把当前浮动清零」，并写一条 `source='preset'` 的账本。

### 6.3 展示规则

| 位置 | 显示什么 | 精度 |
|---|---|---|
| 滑块把手位置 | **baseline** | 整数 |
| 轨道上的小三角标记 | **current** | 整数（内部存 1 位小数） |
| 轨道背景的半透明带 | `[baseline-15, baseline+15]` 可浮动区间 | — |
| 数值标签主数字 | **current**（真正注入 prompt 的值） | 整数 |
| 数值标签副文字 | `基线 60` | 整数 |
| 时间线的 before→after | current | **1 位小数**（体现渐进） |
| prompt 注入 | **current** | — |

---

## 7. Prompt 注入改造（让漂移在对话里真的被感知）

`getPromptInjection()` 三处改动（P0）：

1. **5 档制代替极端阈值制**：每个维度按 `很低 / 偏低 / 中等 / 偏高 / 很高`（0-20 / 20-40 / 40-60 / 60-80 / 80-100）输出一句短语。现状是「>70 才出描述」，导致中间档 prompt 里根本没有性格段落——这是「性格系统对对话无影响」的直接原因。
2. **带上预设底色**：`你的底色是「温柔」，最近在这些地方有些浮动：安全感偏高、独立性偏低。` 模型有稳定参照，漂移不会让人设散架。
3. **带上最近一次变化原因**：当某维度 `|current - baseline| > 8` 时，追加一句 `最近你因为「你逗她，她觉得逗你回去挺有意思」变得更俏皮了。`——直接取最近一条 ledger 的 `reason`。**这是「用户在对话里能感觉到她在变」的唯一落点**，不做的话整套漂移只活在设置页里。

同时：均值回归从「向 50 回归」改为「向 baseline 回归」（§5 闸⑤）。

---

## 8. 产品目标

- **G1 可控**：用户随时能定义小爱的性格底色（6 个预设一键选 + 7 维滑块微调），设定即刻生效、可随时改回。
- **G2 可塑**：日常聊天**内容**（夸奖 / 批评 / 亲昵 / 调戏 / 依赖 / 承诺 / 道歉 / 倾诉…）真实影响她的性格，但被严格约束在基线 ±15 内——既不跑偏也不死板。
- **G3 可溯**：每一次性格变化都带「哪个维度、变了多少、因为什么」，用户能回答「她为什么变成现在这样」，并且能在对话里感觉到。

---

## 9. 用户故事

- **US1**：作为用户，我希望从几个预设性格里一键选一个（温柔 / 傲娇 / 活泼 / 高冷 / 知性姐姐 / 撒娇妹妹），这样我不理解「独立性 vs 安全感」也能立刻得到我想要的她。
- **US2**：作为用户，我希望选完预设还能逐维度拖滑块微调，这样「傲娇但更黏人一点」这种混搭也能做出来。
- **US3**：作为用户，我希望**我说话的内容**真的会影响她的性格（常夸她 → 她更有安全感；总怼她 → 她更敏感；老逗她 → 她更俏皮），这样「潜移默化」是真实发生的，而不是只有日历在动。
- **US4**：作为用户，我担心性格被少数几条消息带跑偏，我希望变化被约束在我设的基线附近，这样她会变，但不会变成另一个人。
- **US5**：作为用户，我希望看到一条变化时间线，每条都写清「什么时候、哪个维度、变了多少、因为什么」，这样我知道是我把她变成了现在这样。
- **US6**：作为用户，我希望在**聊天里**也能感觉到她的变化（不只是设置页的数字），这样这个功能才有存在感。
- **US7**：作为用户，我希望随时能把性格恢复成默认预设，这样调坏了可以一键重来，而不必清空好感度和记忆。
- **US8**：作为开发者，我希望漂移规则是**纯函数、可单测、有回归**，这样调参不会引入不可预期的性格跳变。

---

## 10. 需求池

> 优先级：**P0 Must have / P1 Should have / P2 Nice to have**。每条含【需求描述】【验收标准（可验证）】。

### P0 — 本次必须做

| ID | 需求描述 | 验收标准 |
|---|---|---|
| **P0-a** | **维度模型升级到 7 维**：新增 `playfulness`；维度元数据（key/中文名/低值含义/高值含义/顺序）集中在 `core/personalityDims.js` 作为唯一事实源，UI 与 prompt 都从它取 | 修改任一维度的中文名，UI 与 prompt 同步生效；`personalityDims.js` 导出 `PERSONALITY_DIMS` 与 `DIM_KEYS` |
| **P0-b** | **预设模板库**：`core/personalityPresets.js` 导出 6 个预设（§3 数值）与 `DEFAULT_PRESET_ID='gentle'`；`GET /personality` 下发，前端零镜像 | 6 个预设数值与 §3 表格逐字一致；前端删掉任何本地预设常量后 UI 仍正常渲染 |
| **P0-c** | **baseline / current 双值模型 + 存储 v2 + v1 迁移**（§6.1） | 用现有 `data/personality_state.json`（含 `traits.willfulness=32.75`）启动，不报错且 `baseline.willfulness=33`、`playfulness=50`、`presetId='custom'` |
| **P0-d** | **手动设置 API + 性格 Tab（预设区 + 滑块区）**：`GET /personality`、`POST /personality`、`POST /personality/reset`（§11） | 切换预设 → 7 个滑块同步到位且 `current === baseline`；拖动滑块 → 300ms debounce 后落盘，刷新页面值不变；立即注入下一轮 prompt |
| **P0-e** | **内容信号漂移引擎**：18 条即时规则（§4.2）+ 8 条模式规则（§4.3），规则为纯函数 `computeDrift(signals, ctx) → { changes, ruleId, reason }`；写入点统一到 `PersonalityDrift.recordUserTurn(userInput, ctx)` | 每条规则有独立单测；给定同一输入，输出稳定可复现；`matchCategory` 的 7 类互斥不变量不被破坏（既有 lexicon 测试全绿） |
| **P0-f** | **节奏控制 6 道闸**（§5）：单轮 ±1.5 / 单日 ±3 / 浮动带 ±15 / 24h 疲劳 ×1.0→0.6→0.3 / 回拉力 0.08 / 冷启动 ×0.5 | 构造「连发 30 句夸奖」→ `security` 当日涨幅 ≤3 且 `current` 不越 `baseline+15`；`totalMessages<20` 时涨幅为正常值一半 |
| **P0-g** | **调用时机修正**：`settleDaily()` 移到 `_prepare()` **最开头**（在 ghosting 早退之前），并把 `emotionEngine.analyzeInput()` 的 P 值作为 `sentiment` 兜底传给漂移引擎 | 模拟 ghosting 期间跨天，模式规则仍结算并写账本 |
| **P0-h** | **变化时间线**：`ledger` ≤200 条（按事件聚合，§6.1）；`GET /personality/ledger`；UI 时间线区默认展示最近 20 条 | 每条含 时间 / 维度中文名 / before→after / delta / reason / source 徽章；空态显示「还没有性格变化 —— 多和她聊聊天，她会慢慢被你影响的」 |
| **P0-i** | **prompt 注入改造**（§7）：5 档描述 + 预设底色 + 最近变化原因 | 任意 `current` 取值下，7 个维度都有描述输出（不再有空段落）；`|current-baseline|>8` 时含最近一条 reason |
| **P0-j** | **重置入口**：① 性格 Tab 右上角「恢复默认预设」（带 ConfirmDialog，清 ledger + daily，不动好感度/记忆/对话）；② `AiGirlfriend.resetAll()` 补 `personalityDrift.reset()` | 点「恢复默认预设」后 `baseline===current===gentle`、`ledger=[]`、好感度与记忆条数不变；点「完全重置小爱」后性格也回到 gentle |
| **P0-k** | **自动化回归**：漂移规则与节流各有单测，纳入 `npm test` | 规则类用例 ≥20 条；节流类用例 ≥8 条；全部不依赖 LLM、不依赖网络 |

### P1 — 应当做

| ID | 需求描述 | 验收标准 |
|---|---|---|
| **P1-a** | **基线缓慢沉淀**：`baselineAdaptEnabled` 开关（默认 true）；连续 7 天 offset ≥8 且同向 → baseline 移动 `offset×20%`，单维单次 ≤2，每周 ≤1 次，写 `source='baseline_adapt'` 账本 | 关闭后 baseline 永不自动变动；开启后 UI 在时间线上能看到「基线已跟进」条目 |
| **P1-b** | **漂移总开关** `driftEnabled`（默认 true），放在性格 Tab 顶部 | 关闭后 `current` 锁定 = baseline，时间线不再新增 `source='auto'` 条目，手动设定仍可用 |
| **P1-c** | **时间线增强**：「查看全部」展开 + 按 source（自动 / 手动 / 预设）筛选 | 三种筛选各自正确；展开后 ≤200 条不卡顿 |
| **P1-d** | **性格标签外显**：`getDominantTraits()` 升级到 7 维，在角色面板展示当前 3 个主要标签 | 7 维均有标签文案；标签随 current 变化在下一轮刷新 |
| **P1-e** | **`Note` 说明区**：在性格 Tab 底部说明「手动设的是基线，聊天会让她在基线附近浮动 ±15」 | 文案与 §5 参数一致 |

### P2 — 可以做

| ID | 需求描述 |
|---|---|
| P2-a | 浮动带按维度差异化：`security` / `trust` 用 ±12（这两个维度最敏感，容易让人设崩） |
| P2-b | `ignored_proactive`：小爱主动消息发出后 24h 无回应 → `affection -1.0`、`security -1.0`（需读 ProactiveEngine） |
| P2-c | 「保存为我的预设」：把当前 baseline 组合存成第 7 个自定义预设卡片 |
| P2-d | 角色面板 hover 浮层：不进设置页也能看到当前性格画像与最近 3 条变化 |
| P2-e | 时间线分享卡片（导出图片） |

---

## 11. API 契约（后端，无 `/api` 前缀，挂 `/`）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/personality` | — | `{ presetId, customized, baseline, current, dims, presets, band, driftEnabled, baselineAdaptEnabled, stats }` |
| POST | `/personality` | `{ presetId? , traits?: Partial<Record<dim, number>>, driftEnabled?, baselineAdaptEnabled? }` | 更新后的完整状态（同 GET） |
| GET | `/personality/ledger` | — | `PersonalityLedgerEntry[]`（时间升序，≤200） |
| POST | `/personality/reset` | — | `{ status: "reset", ...state }` |

**约定**：`presetId` 与 `traits` 同时传时，`presetId` 先生效（写 baseline），再叠加 `traits` 微调。
**前端**：`lib/api.ts` 新增 `getPersonality / updatePersonality / getPersonalityLedger / resetPersonality`；`types/index.ts` 新增 `PersonalityDimKey`、`PersonalityDimMeta`、`PersonalityPreset`、`PersonalityState`、`PersonalityLedgerEntry`。所有请求**必须走 `api.*`**。

**保存机制差异（重要）**：现有 proactive 配置走 SettingsDialog 的「保存全部配置」统一提交；**性格改动即时提交**（debounce 300ms，不走统一保存按钮）。原因：性格是后端运行时状态，用户拖完滑块点「取消」却已生效/未生效都会困惑；即时生效的反馈最强。

---

## 12. UI 设计稿：设置页 → 性格 Tab

### 12.1 位置

`SettingsDialog` 的 `SettingsTab` 增加 `"personality"`，插入到「记忆」与「主动」之间（性格是核心人设，优先级高于主动消息）。图标 `Palette`（lucide-react）。侧栏变为：通用 / 语音 / 记忆 / **性格** / 主动 / 系统。侧栏宽度 `w-32` 保持，6 个竖排图标按钮不溢出（`h-[420px]` 区域内）。

### 12.2 线框图

```
┌────────────────────────────────────────────────────────────────┐
│ 性格                                          [ 恢复默认预设 ]  │
├────────────────────────────────────────────────────────────────┤
│ ① 预设性格                                                       │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐                         │
│ │   🌸     │ │   💢     │ │   ✨     │                         │
│ │  温柔    │ │  傲娇    │ │  活泼    │                         │
│ │体贴顺从  │ │嘴硬心软  │ │元气满满  │                         │
│ └──────────┘ └──────────┘ └──────────┘                         │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐                         │
│ │   ❄️     │ │   📖     │ │   🧸     │                         │
│ │  高冷    │ │知性姐姐  │ │撒娇妹妹  │                         │
│ │话少有距离│ │沉稳可靠  │ │黏人爱撒娇│                         │
│ └──────────┘ └──────────┘ └──────────┘                         │
│ 当前：温柔 · 已微调 2 项              [ 恢复到该预设 ]          │
├────────────────────────────────────────────────────────────────┤
│ ② 逐维度微调                              ○ 允许聊天改变性格   │
│                                                                 │
│ 独立性                              50   （基线 50）            │
│ 0 ├──────────────────────────────────────────────────┤ 100     │
│        ░░░░░░░░░░[▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓]░░░░░░░░░░              │
│                   ▲             ●                              │
│                 current        baseline(把手)                   │
│      └─ 可浮动区 baseline±15 ─┘                                │
│  钝感 ←────────────────────────────────────────────→ 敏感      │
│                                                                 │
│ 任性度                              30   （基线 30）            │
│ ├──────────────────────────────────────────────────┤           │
│   ... 共 7 个维度，结构相同 ...                                 │
├────────────────────────────────────────────────────────────────┤
│ ③ 变化记录                                          最近 20 条  │
│                                                                 │
│ │ ●  今天 14:20                              [自动]             │
│ │    安全感 62.0 → 63.4  (+1.4)                                 │
│ │    因为：你今天第三次说「想你了」，她更笃定了                  │
│ │                                                               │
│ │ ●  昨天 21:05                              [自动]             │
│ │    俏皮度 45.0 → 46.1  (+1.1)                                 │
│ │    因为：你逗她，她觉得逗你回去挺有意思                       │
│ │                                                               │
│ │ ○  昨天 20:58                              [手动]             │
│ │    独立性 50 → 62  (基线调整)                                 │
│ │    因为：你把「独立性」调高了                                 │
│ │                                                               │
│ [ 查看全部 ]                                                    │
├────────────────────────────────────────────────────────────────┤
│ 💝 手动设定的是「基线」，日常聊天会让她在基线附近浮动 ±15 ——     │
│    既不跑偏，也不死板。                                         │
└────────────────────────────────────────────────────────────────┘
```

### 12.3 交互细节

**① 预设卡片区**
- 6 张卡片 `grid-cols-3 gap-2`，每张：emoji（24px）+ 名称（12px 粗体）+ 一句话（10px 灰）。
- **激活态边框常驻**（未激活写 `border-transparent`），遵守项目「防抽动四条硬规则」①，避免点击时整体位移。
- 点击卡片 → 立即 `POST /personality { presetId }` → 7 个滑块动画过渡到预设值 + `current = baseline` + 时间线插入 `source='preset'` 条目。卡片上方有一行提示「切换预设会把当前浮动清零」。
- 手动改过任一滑块后 `customized = true`：显示「当前：温柔 · 已微调 2 项」并出现「恢复到该预设」小按钮（点击等价于重新应用当前 presetId）。

**② 滑块区**
- 新建 `components/settings/personality/PersonalitySlider.tsx`：原生 `<input type="range">` 透明覆盖在自定义轨道上；轨道背景画一段半透明带 = `[baseline-15, baseline+15]`，`current` 用小三角标记。**定位一律用 `translate-x`，不用 left/right**（防抽动规则④）。
- 滑块 `onChange` 更新本地 state，`onPointerUp` + 300ms debounce 后 `POST /personality { traits }`。
- 每行下方一行 10px 灰字：`低值含义 ←——→ 高值含义`（如「钝感 ←→ 敏感」），让用户知道往哪拖是什么意思。
- 数值区固定宽度 `min-w-[4.5rem]`，避免数字位数变化导致布局跳动。
- 拖动即写 `source='manual'` 账本条目（reason = 「你把「独立性」调高了」）。

**③ 时间线区**
- 竖向时间线（左侧圆点 + 竖线），默认渲染最近 20 条，`[查看全部]` 展开到 ≤200 条。
- 每条展示：**时间**（今天/昨天/MM-DD HH:mm）、**source 徽章**（自动/手动/预设/基线跟进）、**维度中文名 + before→after + delta**（1 位小数，带正负号与颜色）、**reason**。
- `source='auto'` 时额外附 `userInputDigest`（≤20 字，灰色小字），让用户知道是哪句话触发的。
- 空态：居中虚线框「还没有性格变化 —— 多和她聊聊天，她会慢慢被你影响的」。
- 容器预留最小高度（防抽动规则②），滚动容器加 `[scrollbar-gutter:stable]`（规则③）。

**④ 其他**
- 「恢复默认预设」按钮在 Tab 右上角，点击弹 `ConfirmDialog`（复用现有组件，type="danger"），文案：「将把小爱的性格恢复为「温柔」默认档，并清空全部性格变化记录。好感度、记忆与对话记录不受影响。」
- Tab 顶部右侧一个 `Switch` = 「允许聊天改变性格」（P1-b）。
- 内容区沿用现有 `h-[420px] overflow-y-auto` 容器，性格 Tab 内容超长靠滚动，不改弹窗尺寸。

---

## 13. 待确认问题（含建议默认值）

| # | 问题 | 建议默认值 | 理由 |
|---|---|---|---|
| Q1 | 基线是否应该缓慢跟随 current（「真的被你改变了」）？还是永久锁定？ | **开启**（`baselineAdaptEnabled = true`），每周最多 1 次、每次移动 offset 的 20%、单维单次 ≤2 | 用户原话是「潜移默化改变他的性格」；但纯 ±15 浮动长期看「没真的变」。开启后浮动带中心缓慢移动，既满足原需求又不失控；且每次沉淀都进时间线、可一键关闭 |
| Q2 | 是否接受新增第 7 维 `playfulness`？ | **接受** | 不加则「活泼」与「知性姐姐」在 6 维下区分度不足；加 1 维是覆盖 6 个预设的最小充分集 |
| Q3 | 浮动带是否所有维度统一 ±15？ | **统一 ±15** | 简单可解释；差异化（security/trust 用 ±12）列为 P2-a，等实测数据再定 |
| Q4 | 是否需要「允许聊天改变性格」总开关？ | **需要**，默认开启 | 给「我就想要一个稳定的她」的用户一条退路；也是调试/演示时的便利开关 |
| Q5 | 时间线只在设置页，还是也在聊天界面？ | **P0 只在设置页**；P2 再做角色面板浮层 | 设置页已足够回答「因为什么变成了现在这样」；外显是锦上添花 |
| Q6 | `data/personality_state.json` 的 v1→v2 迁移是否要做？ | **必须做**（P0） | 现有存档已有 `traits.willfulness=32.75` 等非默认值，不迁移会直接丢失用户的既有性格状态 |
| Q7 | 单轮/单日上限取 ±1.5 / ±3 是否合适？ | 建议先按此值上线，实测一周后调 | 与好感度「日上限」同量级思路；性格有 7 维，单维日 3 格已足够可见 |

---

## 14. 不做的事（明确边界）

- **不做**性格 → 好感度的反向耦合（性格漂移不写好感度账本，好感度规则不改性格）。两条链路独立，避免相互放大。
- **不改** `RELATIONSHIP_LEXICON` 的互斥顺序与内容（好感度既有不变量）；漂移新词表独立导出。
- **不做**多角色 / 多套性格档案（一人一格）。
- **不引入**新依赖（漂移规则纯 JS，测试用现有 `node --test` 或项目既有 test runner）。
- **不改** `PERSONA_SYSTEM_PROMPT` 的基础人设文案（只在其后追加性格段落）。
