# W2 独立验证报告 — T04 触发源接入 + D-1 修复闭环 + T02 叙事层复验

- **验证人**：严过关（Yan），QA 工程师（第二轮独立验证）
- **任务 ID**：#8
- **验证日期**：2026-10-01
- **验证环境**：Node v22.22.2 / Windows Git Bash / Sandbox with safe-delete guard
- **核心问题**：**D-1（事件层「接好线没通电」）是否真的闭环？**

---

## 0. 结论速览

| 编号 | 验证项 | 结论 |
|---|---|---|
| A | **D-1 闭环** | ✅ **通过（已闭环）** |
| B | 闸门与降级（全闸门不绕过 / enabled=false 零副作用） | ✅ 通过 |
| C | 零回归（旧 8 类未改 / 新类型规格完整 / 非旁路） | ✅ 通过 |
| D | T02 叙事层复验（节流/注入长度/去重/cap/纪念日） | ✅ 通过 |
| E | 全量检查（check / test / tsc） | ⚠️ 部分（见 E 节：1 项已知 P2 测试卫生问题） |

**独立验证脚本**：`backend-node/scripts/_qa_w2_verify.mjs`（自建，不 import 工程师断言），共 **39 项断言，39 通过，0 失败**。

**路由判定：D-1 修复无源码 Bug，路由 = NoOne（就本轮改动而言）。** `npm test` 出现的 1 项失败为**已知 P2 测试卫生问题（沙箱 safe-delete 拦截测试清理的 unlink）**，非本轮改动引入、非源码缺陷，不计为本轮回归失败。

---

## A. D-1 闭环（最高优先级）— ✅ 通过

### A1. 亲自 grep 生产代码 `register()` / `emit()`

命令：
```
grep -rn "\.register\(" backend-node/src
grep -rn "\.emit\("     backend-node/src
```

生产代码（排除 EventBus/TriggerRegistry/triggerEvents 定义文件与测试脚本）**确实存在**调用：

| 调用 | 文件:行号 | 原文 |
|---|---|---|
| `register()` ×3 | `src/services/container.js:40-42` | `triggerRegistry.register(emotionTurnTrigger);` / `register(anniversaryTrigger);` / `register(promiseFollowupTrigger);` |
| `attach()` | `src/services/container.js:45` | `triggerRegistry.attach(eventBus);` |
| `emit()` | `src/core/AiGirlfriend.js:144` | `this.eventBus.emit(event, payload);`（在 `_emitEvent` 内，安全发布） |
| 发布点 | `src/core/AiGirlfriend.js:358`（user_emotion_turn）、`1418/1431`（narrative_milestone） | 生产发布路径真实存在 |

> 结论：上一轮 D-1 的「零 register()、零 emit()」已**彻底消除**。

### A2. 亲自加载**真实 container** 并独立断言

脚本 `_qa_w2_verify.mjs` 通过 `import('../src/services/container.js')` 加载真实装配（**未使用任何自造迷你场景**）：

```
PASS | A4 triggerRegistry.triggers.size > 0            :: size=3
PASS | A5 注册了 emotion_turn/anniversary/promise_followup :: ids=["emotion_turn","anniversary","promise_followup"]
PASS | A6 listenerCount('user_emotion_turn') > 0       :: count=1
PASS | A7 listenerCount('narrative_milestone') > 0     :: count=1
PASS | A8 aiGirlfriend.eventBus 已注入
```

真实装配日志（原文）：
```
[TriggerRegistry] Attached to bus (3 triggers, 2 events)
```

### A3. 「通电」实证：真实 emit 后事件队列 0→1

```
PASS | A9 真实 emit 后队列 0→1  :: before=0 after=1 delivered=1
PASS | A10 emit 派发到订阅者     :: delivered=1
```

日志原文：
```
[TriggerRegistry] Queued candidate from 'emotion_turn' (target=emotion_resonance, size=1)
```
→ **事件确实从发布方流到订阅方并入了队列，事件层真的「通电」了**（上一轮空转的根因已修复）。

### A4. 端到端：强转折 → 事件 → 消费 → 候选 → trigger() 全闸门 → 入队

```
PASS | A11 强转折事件成功入事件队列
PASS | A12 端到端消费返回 true         :: consumed=true llmCalled=1
PASS | A13 端到端产出候选 reason=emotion_resonance
PASS | A14 端到端真实调用了 LLM 生成    :: llmCalled=1
```
```
[ProactiveEngine] Event-driven consume: trigger=emotion_turn → emotion_resonance (delivered=true)
[Proactive] Message recorded to history (emotion_resonance)
```
→ 端到端打通，产出 reason 为新增的 **`emotion_resonance`**，并真实调用了一次 LLM 生成。

### **➜ D-1 是否真的闭环？—— 是。**

生产代码存在 `register()`×3 + `emit()`；真实 container 装配下触发源 size=3、事件有订阅者；真实 emit 后队列 0→1；端到端走通并真实发电。**独立复现，不依赖修复者自述。**

---

## B. 闸门与降级 — ✅ 通过

### B1. 全闸门不被绕过（AI 情绪 P=-0.9，block 档）

先经真实 `eventBus.emit` 使事件入队，再调 `consumeEventQueue()`：

```
PASS | B1 P=-0.9 时事件确已入事件队列（前置）     :: queue=1
PASS | B2 P=-0.9 时 consumeEventQueue 返回 false  :: consumed=false
PASS | B3 P=-0.9 时未调用 LLM                     :: llmCalled=0
PASS | B4 P=-0.9 时未入主动消息队列               :: queue=[]
PASS | B5 getEmotionGate()=block                  :: P=-0.9
```
```
[ProactiveEngine] Blocked emotion_resonance: ghosting (P=-0.90)
```
→ 事件触发被闸门拦下，**未调 LLM、未入队**。事件驱动**必须**经 `trigger()` 全闸门，无法旁路。

### B2. `enabled=false` 零副作用（独立对比开关前后）

同构事件（P=0.2、有配额、好感度 60），仅切换 `config.enabled`：

```
PASS | B6 enabled=true ：consume=true  queue=1  llm=1   （真实发电）
PASS | B7 enabled=false：consume=false queue=0  llm=0   （整体静默）
```
→ 关闭总开关后，事件层整体静默，**零 LLM 调用、零入队**。零副作用成立。

---

## C. 零回归与新类型规格 — ✅ 通过

### C1. `git diff` 确认旧 8 类「一字未改」

```
git diff --stat backend-node/src/core/proactiveTypes.js
  proactiveTypes.js | 52 +++++++++++++++++++++++   (52 insertions, 0 deletions)
```
diff 原文仅含 `@@ -174,6 +174,58 @@` 一处纯追加块（新增 3 个事件驱动类型），**旧 8 类定义逐字节保留**。

`proactivePrompts.js` diff 同为纯追加（35 insertions，0 deletions）：新增 3 个 prompt 分支 + 3 个 builder 函数，旧分支 `prompts[reason]` 映射未改动。独立断言：
```
PASS | C-旧 8 类全部保留 :: missing=（空）
```

### C2. 3 个新类型属性完整性（与既有类型规格一致）

```
PASS | C-新类型 emotion_resonance  :: {"priority":75,"baseCooldown":1800000,"ttl":1200000,"minAffinity":16,"spontaneous":true,"eventDriven":true}
PASS | C-新类型 anniversary_recall :: {"priority":58,"baseCooldown":21600000,"ttl":7200000,"minAffinity":50,"spontaneous":true,"eventDriven":true}
PASS | C-新类型 promise_followup   :: {"priority":62,"baseCooldown":7200000,"ttl":3600000,"minAffinity":16,"spontaneous":true,"eventDriven":true}
```
三者均含 `priority / baseCooldown(冷却) / ttl / minAffinity / spontaneous / eventDriven / labelZh`，规格与既有 8 类一致。`minAffinity` 与触发源/规格一致（emotion_resonance=16、anniversary_recall=50、promise_followup=16）。

### C3. **特别检查：新类型走 `trigger()` 全闸门，非旁路直接入队**

```
PASS | C-新类型走 trigger() 全闸门（P=-0.9 被拦，非旁路直接入队） :: r=false
```
→ 新类型为 `spontaneous=true`，即使事件已入事件队列，P=-0.9 时经 `consumeEventQueue()` → `trigger()` 仍被拦（r=false、未入主动队列）。**确无旁路。**

---

## D. T02 叙事层复验 — ✅ 通过

| 项 | 断言 | 结果 |
|---|---|---|
| D1 轮次节流 | turnCount=3（≠5）→ `reason=turn-gate`、`extracted=false`、**未调 LLM（llm=0）** | ✅ |
| D2 时间窗节流 | 距上次抽取 <10min → `reason=interval-gate` | ✅ |
| D3 信号节流 | 无关键信号词且无 ctx 信号 → `reason=no-signal` | ✅ |
| D4 三条件全满足 | → `reason=ok`（signal=keyword） | ✅ |
| D5 注入段整体长度 | 构建 10 条长叙事 → 段落 `len=226 ≤ 300` (`injectMaxChars`) | ✅ |
| D5b 单条长度 | `entries=2, lens=[81,81]`（≤ `injectEntryMaxChars=80`+省略号 1 字符） | ✅ |
| D6 topK | retriever 返回 `hits=3 ≤ injectTopK=3` | ✅ |
| D7 cap 60 淘汰 | 70 条 → 裁到 60，**优先丢重要度最低**（低重要度保留数=0） | ✅ |
| D8 写入去重 | 标题包含判定：重复→dup=true；不重复→false（无漏判误判） | ✅ |
| D9 临近纪念日 | 2026-06-10 视角，06-13 纪念日 → `daysUntil=3` 命中 | ✅ |
| D9b 远处不误召 | 12-25 纪念日不在 7 天窗内 → 不命中 | ✅ |
| D10 once 类型 | `anniversaryType='once'` → `daysUntilAnniversary` 返回 null（不重复纪念） | ✅ |

节流为「三者全满足才调 LLM」的**与逻辑**得到证实：任一条件不满足即 `extracted=false` 且不触发 LLM。

---

## E. 全量检查 — ⚠️ 1 项已知 P2

### E1. `npm run check` — ✅ 通过
```
63/63 files passed syntax check
```
（含 `services\container.js`、`core\TriggerRegistry.js`、`core\triggers\*.js` 等全部新增/改动文件）

### E2. `cd frontend && npx tsc --noEmit` — ✅ 通过
Exit code = 0，无类型错误。

### E3. `npm test` — ⚠️ 出现 1 项**已知 P2 测试卫生问题**（非本轮回归）

连跑 3 次，均退出码 1，且**每次都固定失败在同一处**：

```
[test-memory] 未捕获异常: Error: [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]
  {"count":50,"threshold":50,"scope":"turn",
   "targets":[".../data/jsonstore_quarantine_test.json.corrupt-1790864731005"],"targetCount":1}
```

**根因定位（精确到行）**：
- `backend-node/scripts/test-memory.mjs:99-115` 的「jsonStore 损坏隔离」用例：
  - 105-110 行断言 **全部通过**（损坏文件已正确改名隔离，`.corrupt-` 副本存在）；
  - **112 行 `fs.unlinkSync(dataPath(quarantined))`** —— 清理隔离副本的调用**未包 try/catch**；
  - 沙箱的 `safe-delete` 批量确认护栏（`threshold=50`，累积删除计数已达 `count=50`）拦截该 unlink → 抛错 → 成为未捕获异常，中断 npm test 批处理。
- 对照：`test-personality.mjs` 命中**同一个护栏**时做的是「降级为覆写」（`[test] unlink 失败(...)，降级为覆写 v2 空状态`），其 84 项全过。证明这是**清理调用未容错**的问题，而非业务断言失败。

**判定：已知 P2，不计为本轮回归失败。** 依据：
1. `test-memory.mjs` 与 `src/utils/jsonStore.js` 本轮 **git status 未修改**（`git status --porcelain` 为空）；
2. 命中护栏的是**测试脚本的清理 unlink**，不是 T04/D-1 任何改动文件；
3. 主理人预先声明的已知问题即此（沙箱下 unlink 被拦导致残留）；
4. 隔离逻辑本身正确，`readJson` 按**精确文件名**读取（`jsonStore.js:60,71` `path.join(DATA_DIR, filename)`），残留 `.corrupt-*` 文件**不会被误读**。

**残留证据**（沙箱拦截导致未被清理，符合已知问题描述）：
```
data/jsonstore_quarantine_test.json.corrupt-1790864731005
data/jsonstore_quarantine_test.json.corrupt-1790864736137
data/jsonstore_quarantine_test.json.corrupt-1790864736956
```

**T04/D-1 相关套件均干净通过**：`test-triggers.mjs`（末行 `test-triggers: 全部通过`）、`test-trigger-registry.mjs`、`test-user-emotion.mjs`、`test-narrative.mjs` 等。

---

## F. 缺陷分级与路由判定

### 缺陷清单

| 级别 | 缺陷 | 复现步骤 | 文件:行号 | 归属 |
|---|---|---|---|---|
| **P2（已知，非本轮）** | `npm test` 因沙箱 `safe-delete` 护栏拦截测试清理 unlink 而中断 | `cd backend-node && npm test`（累积删除计数达 50 时稳定复现） | `scripts/test-memory.mjs:112` | 测试卫生问题 / 沙箱工具链，**非源码缺陷** |

**无 P0 / P1 缺陷。**

### 智能路由判定

- **源码 Bug？→ 否。** D-1 修复、闸门、零回归、T02 叙事层全部独立验证通过，未发现源码缺陷。
- **测试代码 Bug（本轮改动相关）？→ 否。** 唯一的失败在 `test-memory.mjs`（本轮未修改的既有测试）的清理调用，且为用户预先声明的已知 P2；不属本轮改动引入。
- **路由结论：NoOne** —— 就本轮 T04 / D-1 修复而言，**验证通过，无源码 Bug 需回退工程师**。

### 对主理人的直答

> **D-1 是否真的闭环？—— 是，已闭环。**
> 生产代码真实存在 `register()`×3（container.js:40-42）与 `emit()`（AiGirlfriend.js:144）；独立加载真实 container 确认触发源 size=3、`user_emotion_turn`/`narrative_milestone` 各有 1 个订阅者；真实 emit 后事件队列 0→1（通电实证）；端到端强转折→事件→消费→`trigger()` 全闸门→入队 `emotion_resonance` 全链打通，并真实调用一次 LLM。闸门不可绕过、`enabled=false` 零副作用、旧 8 类零回归、T02 叙事层节流/注入/去重/cap/纪念日全部生效。

---

## G. 验证方法学说明

- 所有断言由本轮**独立编写**（`_qa_w2_verify.mjs`），**未** import 工程师的 `test-triggers.mjs` 断言，避免「复用被测方断言」的循环依赖。
- A/B 组**强制加载真实 container**（`src/services/container.js`），杜绝上一轮「测试自造迷你场景掩盖生产装配缺陷」的失效模式。
- LLM 生成以 stub 隔离（避免真实网络），但**闸门判定、事件派发、队列流转均为真实代码路径**。
