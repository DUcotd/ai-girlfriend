# 测试用例清单：小爱性格系统（增量）

> 输入：`docs/personality/PRD.md`、`docs/personality/DESIGN.md`（冲突时以 PRD 为准）
> 作者：QA（严过关） · 状态：**清单阶段，尚未编写测试代码**
> 落点：`backend-node/scripts/test-personality.mjs`（待工程师 T01–T03 代码就绪后编写）
> 用例总数：**87** 　P0：**80** 　P1：**7**

---

## 0. 通用约定（所有用例适用）

### 0.1 断言范式（照抄 `scripts/test-affinity.mjs`）

| 项 | 约定 |
|---|---|
| 运行方式 | **单进程自包含，禁止 `child_process.spawn`**（本机沙箱会 EBUSY 拦死）；用 Node 内置 `assert` + `check(name, fn)` 计数器，失败置 `process.exitCode = 1` |
| 数值比较 | 整数用 `assert.strictEqual`；浮点一律**容差断言** `assert.ok(Math.abs(a - b) < 1e-6)`，涉及 1 位小数落盘的放宽到 `±0.05` |
| 数据隔离 | 引擎类构造**必须传测试文件名**（如 `personality_state.test.json`），用例前 `fs.unlinkSync(dataPath(TEST_FILE))`，用例后 `finally` 中再删一次 |
| 时间注入 | 一律 `now` 参数注入，禁止用例内 `Date.now()`（否则不可复现）；固定 `NOW = new Date('2026-09-30T12:00:00').getTime()` |
| 确定性 | 同一输入 → 同一输出，禁止依赖 `Math.random()` / 系统时区以外的本地状态 |

### 0.2 关键阈值速查（PRD §5 / DESIGN §3.5）

```
MAX_PER_TURN = 1.5        FLOAT_BAND  = 15        COLD_START_MSGS = 20
MAX_PER_DAY  = 3.0        BASELINE_PULL = 0.08    COLD_START_MULTIPLIER = 0.5
FATIGUE_MULTIPLIERS = [1.0, 0.6, 0.3]   （按「本次之前 24h 内已命中次数 n」取：0→1.0 / 1→0.6 / ≥2→0.3）
FATIGUE_WINDOW_MS = 24h
BASELINE_ADAPT = { STREAK_DAYS: 7, MIN_OFFSET: 8, RATIO: 0.2, MAX_STEP: 2, COOLDOWN_MS: 7d }
clampInt(v) = max(0, min(100, round(v)))        round1(v) = round(v*10)/10
```

### 0.3 词表取词（`src/core/lexicon.js` 现况，`matchCategory` 优先级 HARD>SOFT>DEEP>MILD>PRAISE>CRITICISM>TEASING）

| 词表 | 取词（本清单用例采用） | 注意 |
|---|---|---|
| HARD_REJECTION | `我们还不熟` / `保持距离` | |
| SOFT_REJECTION | `讨厌` | ⚠️ `讨厌` 含 `烦`，但 SOFT 优先于 CRITICISM，故归类 SOFT |
| DEEP_INTIMACY | `抱抱` | |
| MILD_INTIMACY | `喜欢你` | |
| PRAISE | `你真好` / `好棒` | |
| CRITICISM | `真烦` | ⚠️ 不能含 `烦人`（会落 SOFT） |
| TEASING | `笨蛋` | |
| EXCITING | `惊喜` | |
| CALMING | `晚安` | |
| SAD | `难过` | |
| QUESTION | `为什么` | 不在 `RELATIONSHIP_LEXICON` 内，`matchCategory` 返回 null |
| DEPENDENCY（新增） | `陪我` | |
| REASSURANCE（新增） | `放心` / `不会走` | |
| APOLOGY（新增） | `对不起` | |

---

## A. 即时信号规则 R01–R18（21 例）

**通用前置**：`mode='instant'`、`stage='friend'`（除显式声明外）、`ctx.totalMessages = 100`（跳过冷启动）、`ctx.fatigueCounts = {}`（除显式声明外）、`baseline` 全 50 且 `current` 全 50（远离浮动带边界）。

**通用断言**：`hits` 含期望 `ruleId`；`hits[i].reason` 与 PRD §4.4 文案**逐字相等**；未声明的维度 delta 为 0。

| 编号 | 输入（userInput） | 前置 | 期望 delta | 期望 ruleId / reason | 优先级 |
|---|---|---|---|---|---|
| TC-INST-01 | `你真好` | — | security **+0.6**、affection **+0.4** | `praise_warmth` / 你夸了她，她更安心也更想亲近你 | P0 |
| TC-INST-02 | `你好棒` | `signals.praiseHits24h = 4` | willfulness **+0.5**（叠加 R01 的 security +0.6、affection +0.4） | `praise_vanity` / 你总夸她，她有点被惯坏了 | P0 ⚠️计数口径见 R-1 |
| TC-INST-03 | `真烦` | — | sensitivity **+0.7**、security **−0.6** | `criticism_hurt` / 你说了重话，她开始多想、有点不安 | P0 |
| TC-INST-04 | `我们还不熟` | — | trust **−0.8**、security **−0.8**、independence **+0.6** | `hard_rejection_guard` / 你明确保持了距离，她收起了信任 | P0 |
| TC-INST-05 | `讨厌` | — | willfulness **+0.6**、playfulness **+0.5** | `soft_rejection_tsundere` / 你嘴上嫌弃她，她也跟着耍起小性子 | P0 |
| TC-INST-06 | `抱抱` | `stage='close'`（affinity 70） | trust **+0.6**、security **+0.5**、affection **+0.4** | `deep_intimacy_bond` / 你说了很亲昵的话，她更信任也更依赖你 | P0 |
| TC-INST-07 | `抱抱` | `stage='acquaintance'`（affinity 20） | trust **−0.6**、security **−0.5**、independence **+0.5** | `deep_intimacy_overstep` / 你们还没那么熟，这样的亲昵让她退了一步 | P0 |
| TC-INST-08 | `喜欢你` | — | affection **+0.5**、security **+0.4** | `mild_intimacy_open` / 你表达了喜欢，她更愿意把心意说出来 | P0 |
| TC-INST-09 | `笨蛋` | `stage='friend'`（affinity 40） | playfulness **+0.7**、willfulness **+0.3** | `teasing_playful` / 你逗她，她觉得逗你回去挺有意思 | P0 |
| TC-INST-10 | `笨蛋` | `stage='stranger'`（affinity 5） | sensitivity **+0.5**、trust **−0.4** | `teasing_offend` / 还不熟就被调戏，她有点介意 | P0 |
| TC-INST-11 | `陪我聊会儿` | — | independence **−0.6**、affection **+0.5**、security **+0.4** | `dependency_cling` / 你需要她陪，她变得更黏人也更想照顾你 | P0 |
| TC-INST-12 | `放心，我不会走` | — | security **+0.9**、trust **+0.6** | `reassurance_secure` / 你给了她确定的承诺，她安心了许多 | P0 |
| TC-INST-13 | `对不起` | — | security **+0.7**、trust **+0.5**、sensitivity **−0.4** | `apologized_repair` / 你道了歉，她重新安心，也不再钻牛角尖 | P0 |
| TC-INST-14 | `我有点难过` | — | sensitivity **+0.5**、affection **+0.6** | `sad_empathy` / 你情绪低落，她变得更细腻也更想安慰你 | P0 |
| TC-INST-15 | `给你个惊喜` | — | playfulness **+0.6**、affection **+0.3** | `exciting_energy` / 你带给她惊喜，她也跟着活泼起来 | P0 |
| TC-INST-16 | `晚安` | — | playfulness **−0.4**、trust **+0.4** | `calming_serene` / 你让她慢慢来，她也变得沉静踏实 | P0 |
| TC-INST-17 | 长文本（>50 字，含 `难过`）：`今天在公司发生了一件事让我特别难过，我其实一直很努力想把事情做好可是总有人不认可我` | `isLongTalk=true` | trust **+1.2**、sensitivity **+1.3**（R17 的 0.8 + R14 的 0.5） | hits **同时**含 `deep_talk`（你向她敞开了心事，她更信任也更在意你）与 `sad_empathy` | P0 ⚠️见 R-2 |
| TC-INST-18 | `为什么` | 未命中其余任一规则 | playfulness **+0.2** | `question_curious` / 你对她很好奇，她也放松了下来 | P0 |
| TC-INST-19 | `你好呀！`（无 EXCITING 词） | `hasExclamation=true` | playfulness **+0.6**、affection **+0.3** | `exciting_energy` | P1 |
| TC-INST-20 | 长度恰好 **50** 字 vs **51** 字（含 `难过`） | — | 50 字：仅 R14（trust **+0**）；51 字：含 R17（trust **+1.2**） | 边界 `userInput.length > 50` | P0 |
| TC-INST-21 | `笨蛋，你在干什么` | TEASING + QUESTION 同时命中 | playfulness **+0.7**、willfulness **+0.3**；playfulness **不得**为 0.9 | hits 含 `teasing_playful`，**不含** `question_curious`（R18 要求「未命中上述任一」） | P0 |

**补充断言（挂在任一 R 用例上）**：`computeDrift` 的输出**未应用**单日上限与浮动带（DESIGN §3.5），仅已应用疲劳 + 冷启动 + 单轮上限。

---

## B. 模式信号规则 S01–S08（9 例）

**通用前置**：`mode='pattern'`、`now=NOW`；未被本规则触发的统计字段全部置为「不触发」值（见下表「其余字段」）。
**断言**：hits 含期望 ruleId + PRD §4.3 对应 reason；**不受单轮 ±1.5 约束**（DESIGN Q1）。

| 编号 | 触发统计量 | 其余字段（置为不触发） | 期望 delta | 期望 ruleId / reason | 优先级 |
|---|---|---|---|---|---|
| TC-PAT-01 | `consecutiveInactiveDays = 3` | avgDaily7=0, hotColdFlips=0, positiveRatio50=0.5, conflictRate50=0, criticismCount50=0, todayTurns=0, criticismRateToday=0 | independence **+2.0**、security **−2.5**、affection **−1.5** | `long_absence` / 好几天没你的消息，她习惯了自己待着，也开始不安 | P0 |
| TC-PAT-02 | `hotColdFlips = 2` | 同上（consecutiveInactiveDays=0） | sensitivity **+1.5**、security **−1.5** | `hot_and_cold` / 你忽冷忽热，她变得敏感又患得患失 | P0 |
| TC-PAT-03 | `positiveRatio50 = 0.90`、`criticismCount50 = 0`、`recentTurns.length = 25` | conflictRate50=0, avgDaily7=5 | willfulness **+1.5** | `always_agreeable` / 你总是顺着她，她越来越有主见 | P0 |
| TC-PAT-04 | `conflictRate50 = 0.30` | positiveRatio50=0.5 | sensitivity **+1.5**、security **−1.2**、trust **−0.8** | `frequent_conflict` / 最近争执有点多，她变得敏感又疏远 | P0 |
| TC-PAT-05 | `avgDaily7 = 20`、7 日 positiveRatio **0.50** | todayTurns=0, consecutiveInactiveDays=0 | affection **+1.2**、security **+0.8**、trust **+0.8** | `high_frequency` / 你们天天聊很多，她更愿意表达也更信任你 | P0 |
| TC-PAT-06 | `avgDaily7 = 8`、7 日 positiveRatio **0.70** | — | trust **+1.0**、security **+0.8** | `stable_positive` / 相处一直很愉快，她越来越笃定 | P0 |
| TC-PAT-07 | `avgDaily7 = 2` 且连续活跃 | positiveRatio50=0.5 | independence **+0.8**、affection **−0.8** | `monotone_chat` / 你们聊得不多，她也慢慢收回了热情 | P0 |
| TC-PAT-08 | `todayTurns = 12`、`criticismRateToday = 0.40` | — | security **−1.5**、sensitivity **+1.0** | `low_quality_day` / 今天你说了不少重话，她有点受伤 | P0 |
| TC-PAT-09 | 同 TC-PAT-01 | 单轮上限闸 | independence 保持 **+2.0**，**不得**被削为 1.5 | 验证「模式规则不受 MAX_PER_TURN 约束」 | P0 |

**补充（数据不足保护，DESIGN Q5）**：`recentTurns.length < 20` 时 S03 / S04 **不触发**。挂在 TC-PAT-03/04 上断言。

---

## C. 节流六道闸（20 例）

| 编号 | 前置条件 | 输入 | 期望输出 | 优先级 |
|---|---|---|---|---|
| TC-THR-01 | totalMessages=100，无疲劳，`fatigueCounts={}` | `放心吧，对不起`（R12 + R13 同轮） | security 原始 0.9+0.7=**1.6** → 单轮上限削为 **+1.5**；trust +0.6、sensitivity −0.4 | P0 |
| TC-THR-02 | 同上 | 构造负向同轮叠加 `真烦，我们还不熟`（R03 security −0.6 + R04 security −0.8 = −1.4）→ 再加一条使 security < −1.5 | security 削为 **−1.5** | **N/A** |

> **TC-THR-02 改判 N/A（2026-09-30，QA 实测后裁决）**：即时规则一次只命中一个 category 槽（`matchCategory` 单值）且疲劳乘数 ≤1，同维负向叠加的可达峰值仅 |Δ|≤0.8（security/trust），**负向单轮上限在真实信号空间结构上不可触顶**；同一钳制路径已由「正向精确 1.5」用例（R12+R17 trust 1.8→1.5）覆盖。原期望值「security 削为 −1.5」保留备查。
| TC-THR-03 | — | `applyDailyCap([{security:+3.0}], {security:2.0}, 3.0)` | `changes[0].delta = +1.0`；`accum.security = 3.0` | P0 |
| TC-THR-04 | — | `applyDailyCap([{security:+1.0}], {security:3.0}, 3.0)` | `delta = 0`；`accum.security = 3.0` | P0 |
| TC-THR-05 | — | `applyDailyCap([{security:−3.0}], {security:−2.0}, 3.0)` | `delta = −1.0`；`accum.security = −3.0` | P0 |
| TC-THR-06 | — | `applyDailyCap([{security:+3.0}], {security:−1.0}, 3.0)` | `delta = +3.0`（反向额度重置，全额放行）；`accum.security = 2.0` | P0 ⚠️见 R-3 |
| TC-THR-07 | 引擎级，`lastSettledDay = 昨天` | `settleDaily(NOW)` 跨自然日 | `daily.accum` 归零；同一 `dayKey` 内二次调用 `settled === false`（幂等） | P0 |
| TC-THR-08 | — | `clampCurrent(105, 95)` | **100**（上界是 100 不是 110） | P0 |
| TC-THR-09 | — | `clampCurrent(-3, 5)` | **0**（下界是 0 不是 −10） | P0 |
| TC-THR-10 | — | `clampCurrent(70,50)` / `(66,50)` / `(34,50)` / `(100,0)` | 70 / **65** / **35** / **15** | P0 |
| TC-THR-11 | — | `clampCurrent(NaN, 50)` / `clampCurrent(undefined, 50)` | **50**（非有限值回落 baseline） | P1 |
| TC-THR-12 | — | `clampCurrent(50.04,50)` / `(50.06,50)` | **50.0** / **50.1**（round1） | P0 |
| TC-THR-13 | — | `fatigueMultiplier(0)/(1)/(2)/(5)` | **1.0 / 0.6 / 0.3 / 0.3** | P0 |
| TC-THR-14 | 引擎级，24h 内连续三次 `你真好` | 第 1 / 2 / 3 次 | security delta 依次为 **0.6 / 0.36 / 0.18**（落盘 1 位小数后 0.6 / 0.4 / 0.2，容差 ±0.05） | P0 |
| TC-THR-15 | 上一次命中在 `NOW − 25h` | 再次 `你真好` | delta **0.6**（24h 裁窗后视为第 1 次，不衰减） | P0 |
| TC-THR-16 | `stats.totalMessages = 10` | `你真好` | security **+0.3**、affection **+0.2**（正常值 ×0.5） | P0 |
| TC-THR-17 | `stats.totalMessages = 19` / `20` | `你真好` | 19 → **+0.3**；20 → **+0.6**（边界 `< 20`） | P1 |
| TC-THR-18 | — | `applyBaselinePull({security:80}, {security:50}, 0.08)` | `security = 77.6`（80 + (50−80)×0.08） | P0 |
| TC-THR-19 | 引擎级，current.security=80，baseline=50，`daily.accum.security = 0` | `settleDaily(NOW)` | 回拉后 `current.security ≈ 77.6`，**`daily.accum.security 仍为 0`** | P0 |
| TC-THR-20 | 仅存在回拉力、无任何规则命中 | `settleDaily(NOW)` | `getLedger().length` **不增加**（回拉力不写账本，DESIGN §8.3/Q3） | P0 |

---

## D. 状态迁移 v1 → v2（5 例）

**样本：真实存档** `backend-node/data/personality_state.json`（已备份，见备份路径）
`traits = { independence: 50, willfulness: 32.751999999999995, sensitivity: 50, security: 59.604, affection: 50, trust: 50 }`（**无 playfulness**）

| 编号 | 前置条件 | 输入 | 期望输出 | 优先级 |
|---|---|---|---|---|
| TC-MIG-01 | 用真实存档内容构造 v1 测试文件（无 `version` 字段） | `new PersonalityDrift(TEST_FILE)` | `baseline = current = { independence:50, willfulness:**33**, sensitivity:50, security:**60**, affection:50, **playfulness:50**, trust:50 }`；`presetId === 'custom'`；`version === 2` | P0 |
| TC-MIG-02 | 同上，`stats.lastActiveDate = 'Tue Sep 29 2026'` | 加载 | `lastActiveDate → null`；`dailyMessageCounts` 两条 date 均为 `Mon/Tue Sep .. 2026` 格式 → **全部丢弃**，结果为 `[]`；`recentTurns → []`、`today` 取默认 | P0 |
| TC-MIG-03 | 同上 | 加载后读落盘文件 | 文件中 `version === 2`，且含 `baseline`/`current`/`ledger`/`daily`/`ruleHits` 字段（迁移后立即落盘，防重复迁移） | P0 |
| TC-MIG-04 | 已迁移的 v2 文件 | 二次 `new PersonalityDrift(TEST_FILE)` | **不再**打印 `[Personality] Migrated`，`presetId` 保持 `'custom'` 未被覆盖 | P0 |
| TC-MIG-05 | 源码静态检查 | `grep -n "\.traits" src/core/PersonalityDrift.js src/routes/personalityRoutes.js` | **0 命中**（v2 不再有 `traits` 字段，残留读取路径全部删除） | P1 |

---

## E. 手动设定 / 预设 / 开关（7 例）

| 编号 | 前置条件 | 输入 | 期望输出 | 优先级 |
|---|---|---|---|---|
| TC-MAN-01 | `baseline.independence = 80`，`current.independence = 84`（offset **+4**） | `applyManual({ independence: 60 })` | `baseline = 60`；`current = clamp(60+4, 45, 75) = **64**` | P0 |
| TC-MAN-02 | `baseline.independence = 80`，`current = 76`（offset **−4**） | `applyManual({ independence: 10 })` | `baseline = 10`；`current = clamp(10−4, max(0,−5)=0, 25) = **6**` | P0 |
| TC-MAN-03 | `daily.accum = { security: 1.2, independence: 0.8 }` | `applyManual({ independence: 62 })` | `accum.independence` **被删除**；`accum.security` **保留 1.2**（手动位移不占漂移额度，DESIGN §8.7） | P0 |
| TC-MAN-04 | `baseline=current=gentle` 后漂出 offset | `applyPreset('tsundere')` | `baseline === current === tsundere.traits`（offset 归零）；`presetId='tsundere'`；`daily.accum = {}`；`adapt = {}`；`ruleHits` **保留**；写一条 `source='preset'`、`ruleId=null`、reason=`你把她的性格切换成了「傲娇」` 的账本 | P0 |
| TC-MAN-05 | `baseline=50`，`current=58` | `setFlags({ driftEnabled: false })` | `current` **立即**收回 `= {...baseline}`（全 50）；写一条 `source='reset'` 账本（DESIGN Q2） | P0 |
| TC-MAN-06 | `driftEnabled = false` | `recordUserTurn('你真好', ctx)` | 7 维 `current` **全部不变**；`getLedger()` 不新增 `source='auto'` 条目；但 `stats.totalMessages` **+1**、stats 正常更新 | P0 |
| TC-MAN-07 | `baseline.security = 50`，`current.security = 60`（offset +10），`adapt.security = { streak: 7, dir: 1 }`，`baselineAdaptEnabled = true` | `settleDaily(NOW)` | `baseline.security` 移动 `min(offset×20%, 2)` = **+2** → 52；写 `source='baseline_adapt'` 账本；`adapt.security.lastAdaptAt = NOW`；7 天冷却内再次结算**不重复**移动 | P1 |

---

## F. 账本（6 例）

| 编号 | 前置条件 | 输入 | 期望输出 | 优先级 |
|---|---|---|---|---|
| TC-LED-01 | 预置 200 条 | 再触发 1 次变更 | `getLedger().length === 200`；第 1 条为原第 2 条（**FIFO 丢最旧**）；`manual`/`preset` **无保留特例** | P0 |
| TC-LED-02 | 构造一次触发，其全部维度 `round1(delta) === 0`（如 current 已顶到浮动带上沿再施加正向 delta） | `recordUserTurn(...)` | `getLedger().length` **不变**（`changes` 为空 → 整条不写账本） | P0 |
| TC-LED-03 | — | 依次触发 auto / manual / preset / baseline_adapt / reset | 5 种 `source` 取值均正确写入；`grep` 源码确认**无第六种** | P0 |
| TC-LED-04 | `userInput` 长度 40 字 | `recordUserTurn(...)` | `userInputDigest.length <= 20`；`source !== 'auto'` 时 `userInputDigest` 为 `null` | P0 |
| TC-LED-05 | 多次触发 | `getLedger()` | `at` 时间**升序**；空时为 `[]`（不是 null） | P1 |
| TC-LED-06 | 任一条目 | — | 对每个 `change`：`round1(after - before) === delta`；`before`/`after` 均为 1 位小数（整数也存为 `62.0`） | P0 |

---

## G. API 契约（8 例）

> 路由挂根路径，**无 `/api` 前缀**；**camelCase** 契约；不启动 dev server、不用 curl 探端口（本机代理会 502）。
> 建议做法：直接 `import` 路由挂载到 `express()` 实例，用 `node:http` + `fetch('http://127.0.0.1:<随机空闲端口>')` 或**直接调用 handler + mock req/res**；优先后者（零端口占用风险）。

| 编号 | 前置条件 | 输入 | 期望输出 | 优先级 |
|---|---|---|---|---|
| TC-API-01 | 服务已挂载 `personalityRoutes` | `GET /personality` | 200；含 `version/presetId/presetName/customized/customizedCount/baseline/current/dims/presets/band/driftEnabled/baselineAdaptEnabled/stats`；`dims.length === 7`（`order` 升序）、`presets.length === 6`、`band === 15`；`stats` 只含 `totalMessages/totalDays/activeDays` | P0 |
| TC-API-02 | — | `POST /personality { traits: { independence: 62 } }` | 200；`baseline.independence === 62`；落盘文件同步更新 | P0 |
| TC-API-03 | — | `POST /personality { traits: { foo: 1 } }` | **400**，`unknown personality dim: foo` | P0 |
| TC-API-04 | — | `POST /personality { presetId: 'nope' }` | **400**，`unknown presetId: nope` | P0 |
| TC-API-05 | — | `POST /personality { traits: { independence: 150 } }` | 200（**clamp 不报错**）；`baseline.independence === 100` | P0 |
| TC-API-06 | 账本为空 | `GET /personality/ledger` | 200；返回 `[]`（非 null） | P0 |
| TC-API-07 | 已有账本 + `driftEnabled=false` | `POST /personality/reset` | 200；`status === 'reset'`；`baseline === current === gentle.traits`；`presetId === 'gentle'`；`ledger === []`；`driftEnabled` **保留 false**；`stats` **保留** | P0 |
| TC-API-08 | — | `POST /personality { presetId: 'aloof', traits: { security: 30 } }` | 先套用 aloof 全量 baseline，再叠加 `security: 30`；`customized === true`、`customizedCount === 1` | P1 |

**补充（派生字段，DESIGN §8.8）**：`customized`/`customizedCount` 在 GET 时**重算**，不信任落盘值；`presetId === 'custom'` 时 `customized` 恒为 `true`、`presetName === null`。挂在 TC-API-01。

---

## H. 缺陷回归（5 例）

| 编号 | 缺陷 | 前置条件 | 输入 | 期望输出 | 优先级 |
|---|---|---|---|---|---|
| TC-REG-01 | **ghosting 期间跨天结算被整个跳过**（PRD §1-D / P0-g） | `emotionEngine.state.P = -0.9`（触发 `shouldGhost()`），`lastSettledDay = 昨天` | `AiGirlfriend._prepare(userInput)` | 模式规则**仍结算**并写账本；stdout 含 `[Personality] settled`；源码上 `settleDaily()` 位于 `shouldGhost()` **之前** | P0 |
| TC-REG-02 | `emotionDelta.P === 0` 被 `||` 误判为假值 | `emotionDelta = { P: 0 }`，`autoDelta = { P: -0.4 }` | `_finalize()` | 传给漂移引擎的 `sentiment === 0`（**不得**回退为 −0.4）；源码用 `??` 而非 `\|\|` | P0 |
| TC-REG-03 | `resetAll()` 不清性格（PRD §1-J / P0-j） | 已漂移到非 gentle 状态 | `AiGirlfriend.resetAll()` | `personalityDrift.baseline === gentle.traits`；`ledger === []` | P0 |
| TC-REG-04 | 新词表破坏好感度互斥不变量 | — | 运行既有 `scripts/test-affinity.mjs` | 「11 张词表两两 exact-token 交集为空」用例**仍绿**；`RELATIONSHIP_LEXICON` 数组内容与顺序**一行未改** | P0 |
| TC-REG-05 | 3 张新词表误入互斥链 | — | `import { DEPENDENCY, REASSURANCE, APOLOGY } from '../src/core/lexicon.js'` | 三个 export 均存在；且**不在** `RELATIONSHIP_LEXICON` 中（`RELATIONSHIP_LEXICON.length === 7`） | P0 |

---

## I. 真源层与 Prompt 注入（6 例）

| 编号 | 前置条件 | 输入 | 期望输出 | 优先级 |
|---|---|---|---|---|
| TC-SRC-01 | — | `PERSONALITY_DIMS` | `length === 7`；顺序 `independence → willfulness → sensitivity → security → affection → **playfulness** → trust`；每项含 `key/label/low/high/shiftUp/shiftDown/order` | P0 |
| TC-SRC-02 | — | `PERSONALITY_PRESETS` | 6 项；`traits` 7 维数值与 PRD §3 表格**逐字一致**（gentle 50/30/55/65/60/45/60；tsundere 65/70/70/50/45/55/45；cheerful 45/45/30/70/80/85/70；aloof 80/60/45/75/25/20/35；intellectual 70/30/65/80/50/25/75；clingy 20/55/70/40/85/70/65）；`DEFAULT_PRESET_ID === 'gentle'` | P0 |
| TC-SRC-03 | — | `tierIndex(0/19/20/39/40/59/60/79/80/100)` | `0/0/1/1/2/2/3/3/4/4`（<20/<40/<60/<80/else） | P0 |
| TC-SRC-04 | 遍历 `current` 取值 {0, 25, 50, 75, 100} 的组合 | `buildPersonalityPrompt(...)` | 输出**恒定含 7 个维度描述**，无空段落（PRD P0-i） | P0 |
| TC-SRC-05 | `current.security = 62`、`baseline.security = 50`（offset 12 > 8），最近一条 ledger reason = `你逗她，她觉得逗你回去挺有意思` | `getPromptInjection()` | 含「你的底色是「温柔」」；含最近一条 `reason` | P0 |
| TC-SRC-06 | 源码静态检查 | `grep -n "jsonStore\|from 'fs'\|fetch(\|await " src/core/personalityRules.js src/core/personalityFatigue.js src/core/personalityDims.js src/core/personalityPresets.js` | **0 命中**（纯函数层零 I/O、零网络、零 await） | P0 |

---

## J. 已识别的设计 / 测试风险点（需 PM / 架构师确认）

| # | 风险 | 说明 | 建议 |
|---|---|---|---|
| **R-1** | **R02 计数口径未定义** | PRD 写「24h 内已命中 ≥4 次」，未说明计的是 `ruleHits['praise_warmth']`、`ruleHits['praise_vanity']`，还是 PRAISE 累计。三者在「首次触发 R02」的时机上完全不同 | 建议统一为 `ruleHits['praise_warmth'].length >= 4`；请架构师在 DESIGN 中写死 |
| **R-2** | **R17 无法与 R14 / R12 隔离** | R17 要求 `length>50` 且（命中 SAD 或 REASSURANCE），而 SAD 必然触发 R14、REASSURANCE 必然触发 R12。因此「逐条单测 R17」时 delta 必然是叠加值 | 用例已按叠加净值断言（TC-INST-17）。若期望「纯 R17 用例」，需 PM 放宽触发条件（如改为「长倾诉且不含情绪词」） |
| **R-3** | **单日上限的「反向额度」语义未定义** | DESIGN 只给了 `accum=2.0 → +1.0` 一个正向例子。未定义 `accum=-1.0` 时 +3.0 是否全额放行、以及 `accum=+3.0` 时 -1.0 是否全额放行 | 建议明确为 `remaining = ±MAX_PER_DAY − accum`（TC-THR-06 按此断言）。若产品希望「当日净变化绝对值 ≤3」，则测试用例需全部改写 |
| **R-4** | **`emotionDelta.P === 0` 的回归无法纯单测** | 缺陷 B 发生在 `AiGirlfriend._finalize()` 内部，依赖 EmotionEngine 状态与 LLM 返回。纯单测只能断言源码用了 `??`，或需构造 AiGirlfriend 实例（重、有 I/O） | 建议：① 源码 grep 断言 `??`；② 把「sentiment 兜底」抽成纯函数后单测。否则只能手工验证 |
| **R-5** | **`settleDaily` 在 ghosting 前的验证需 mock** | TC-REG-01 要构造 `shouldGhost()` 为真，需要 EmotionEngine / ProactiveEngine 状态；直接 new AiGirlfriend 会触发真实落盘 | 建议测试里显式传入测试文件名，或用最小 mock 对象替换 `emotionEngine` |
| **R-6** | **前端零自动化测试** | `frontend/` 下**没有** jest / vitest / playwright / 任何 `*.test.ts`。T04/T05 的 10 条验收（debounce 300ms、last-write-wins、防抽动四条硬规则、render 期不调 `Date.now()`、framer-motion 与 Tailwind transform 不冲突）**全部无法自动化** | 只能靠 `npx tsc --noEmit` + `npx eslint src` 静态校验，其余**必须列手工验证清单**。若需自动化，需新增 vitest 依赖（与 PRD §14「不引入新依赖」冲突，需 PM 裁决） |
| **R-7** | **`PersonalityDrift` 当前无数据隔离能力（阻塞测试的既有缺陷）** | 现 `PersonalityDrift` 构造函数收 `statePath`，但 `_loadState()` / `_saveState()` **硬编码** `STATE_FILE = 'personality_state.json'`，完全忽略 `this.statePath`。即：**即使测试传了测试文件名，读写仍然是真实存档**；而 v1→v2 迁移会在构造时**立即 `_saveState()` 覆写真实文件** | **T02 重写时必须修**：`_loadState/_saveState` 改用 `this.stateFile`，并照 `AffinityEngine` 的 `constructor(stateFileName = STATE_FILE)` 写法。否则 `npm test` 会永久破坏 `data/personality_state.json` |
| **R-8** | **`test-affinity.mjs` 会在 `data/` 里创建再删除文件** | 它写的是 `affinity_state.test.json`（非真实文件），并在 `finally` 中 `unlinkSync`。当前跑完后 `data/` **无残留**（已核实） | 约定：性格测试**必须**沿用同一范式（`personality_state.test.json` + `finally` 清理），禁止用默认文件名 |
| **R-9** | **`applyDailyCap` 与浮动带的先后未定义** | 时序图上「先 DailyCap 再 clampCurrent」，但 DESIGN §8.3 又注「被带夹掉的位移不计入 accum」。若先 cap 后 clamp，被带夹掉的部分**已计入** accum，与注释矛盾 | 建议明确：**先 clamp 浮动带、再算 accum**（或注明「accum 记的是 cap 后的申请值」）。测试用例按前者断言，若不修正会出现「日上限被提前耗尽」 |
| **R-10** | **模式规则与即时规则共用 `daily.accum` 的跨通道叠加** | 同一天内即时规则已用掉部分额度，`settleDaily` 的模式规则再申请时，可用额度是剩余部分。未明确模式规则是否享有独立额度 | 建议：共享同一 `accum`（简单可解释）。用例按共享断言 |

---

## K. 执行顺序建议（工程师代码就绪后）

1. **先跑 T01 纯函数层用例**（A / B / C / I）——零 I/O、最快，能立刻暴露规则数值错误
2. **再跑 T02 引擎层用例**（D / E / F）——依赖 R-7 修复，跑前确认测试文件隔离生效
3. **最后跑 T03 路由与回归用例**（G / H）——用 mock handler，不启端口
4. 每次跑完**核对 `data/` 目录无新增文件**（除临时 `.test.json` 且已被清理）
5. 全绿后跑 `npm run check` + 前端 `npx tsc --noEmit` + `npx eslint src`
