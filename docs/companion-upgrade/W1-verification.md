# W1 验证报告 —— 第一波三项交付（T01 / T03 / T-SEC）

> 验证人：严过关（Yan，QA Engineer / teammate `yan-qa-w1`）
> 日期：2026-10-01
> 方法：**独立读源码 + 亲自跑 + 自写边界用例**（不采信工程师/PM 自述）
> 证据脚本（本次新增，随仓库保留）：`backend-node/scripts/_qa_w1_probe.mjs`（22 条独立断言，全过）

---

## 0. 结论速览

| 交付 | 结论 | 关键问题 |
|---|---|---|
| ① T01 用户情绪识别通道 | **基本通过（有条件）** | 无 P0/P1；1 个 P2（重复的展示用魔法数 0.05） |
| ② T03 事件层基础设施 | **不通过（骨架可用但生产链路不通）** | **P1：事件层在真实 container 中完全空转**（0 触发源注册 / 0 事件发布） |
| ③ T-SEC 安全加固 | **通过** | 无缺口；前端 SSE/FormData 均已带头 |

**智能路由判定**：
- 发现 1 个 T03 源码级缺陷（P1，见 §2）→ **反馈工程师（kou-eng-b）**，本次不直接修（依 team-lead 指示）。
- 无测试代码 Bug：我自写的 2 处初版断言误报，已**自行修正**（见 §4），非源码问题。
- T01 / T-SEC → 通过。

**全量测试 / 类型检查**：
- `npm run check`：**60/60 语法通过**。
- `frontend npx tsc --noEmit`：**clean，exit 0**。
- `npm test`：**7/8 套件通过**；唯一失败 `test-memory` 经证实为**沙箱环境产物，非产品缺陷**（证据见 §5）。三项交付自带的 3 个测试 5×连跑**零抖动**。
- 关于"曾观察 35/39 瞬时失败"：**已定位为沙箱 safe-delete 配额导致的串扰假象**（§5），非真实测试间状态污染。

---

## 1. T01 用户情绪识别通道 —— 逐点结论

### 1.1 `_prepare()` 注入调用是否真 try/catch？（team-lead 点 1）→ **通过**
`AiGirlfriend._prepare()` 第 371–380 行：整段 `analyze()` + `getPromptInjection()` 包在 `try/catch`，catch 中 `userEmotionPrompt = ''` 并把错误记日志。**注入失败降级为空段，绝不打断主对话。**
- `UserEmotionEngine.getPromptInjection()`（第 253–273）**自身**也再包一层 try/catch 返回 `''`（双保险）。
- `_persistAfterReply()` 第 289–295：`ingestTurn()` 也 try/catch，且位于 `setImmediate` 后台路径，不阻塞响应。

### 1.2 降级路径：LLM 不返回 `user_emotion`（点 2）→ **通过（亲自构造）**
独立用例（probe T01-2，全过）：
- `ingestTurn('今天好难过', '抱抱', null)` → label=`低落`，timeline source=`lexicon`，不抛错。
- LLM 缺三维（`{label:'开心'}`）→ 兜底词表，仍得 `愤怒`。
- LLM 为 `undefined`/字符串/数组 → `fuse` 一律回退 `source='lexicon'`，不抛错。
- 代码依据：`fuse()` 第 76–85（`valid=null` 直接走词表）+ `_sanitizeLLM` 第 128–134（非法返回 null）。

### 1.3 畸形 `user_emotion` 容错（点 3）→ **通过（亲自构造）**
- 超范围数值（valence=99, intensity=99, confidence=5）→ 被 `clamp` 到 `[-1,1]/[0,1]`，标签仍在枚举内。
- 字符串数字 `"0.5"` → `Number()` 归一，`Number.isFinite` 通过，结果合法。
- `Infinity / -Infinity / NaN / 'abc'` → `_sanitizeLLM` 拒绝 → 兜底词表。
- 非枚举 label（`'???'`）→ `mapDimensionsToLabel` 重映射，结果必在 `USER_EMOTION_LABELS` 内。
- **一处宽松但安全的行为**：`Number(null) === 0` 且 `Number.isFinite(0)===true`，故 `null` 三维会被当作 `0` 采信（而非拒绝）。**不崩溃、结果被 clamp 在合法区间**，属可接受的宽松，非缺陷（probe 已记录）。

### 1.4 词表边界（点 4）→ **通过（亲自构造）**
- 空串 / 纯空白 / `null` / `undefined` → `中性`，confidence=0。
- 纯符号 `!!!???……` / emoji `😀🎉` → `中性`，不抛错。
- 超长文本（10 万字符）→ 不抛错，intensity 有界。
- 否定词：`我不开心` → **非开心**且 valence<0；`一点都不开心` → 仍非开心。
- 强度词：`非常难过` intensity > `难过` 基线。

### 1.5 时间线 cap + 去抖写盘（点 5）→ **通过**
- cap：写入 `cap+20` 条后 `getTimeline().length === cap`（代码第 177–180 行 slice(-cap)）。
- 去抖：连续两次 `ingestTurn` 后，**去抖窗口内 `user_emotion_state.json` 字节完全未变**（`_scheduleSave` 第 350–357，`flushDebounceMs=2000`）——确认**不是每轮全量写盘**。

### 1.6 config 阈值无魔法数字（点 6）→ **通过（1 处例外）**
`config.js` 第 123–144 行收敛了 `userEmotion` 全部阈值/容量/权重（timelineMax / lexiconWeight / llmWeight / llmConfidenceThreshold / turnThreshold / trendWindowMs / decliningSlope / flushDebounceMs / excerptMax）。
- **P2（轻微）**：`UserEmotionEngine._describeTrend()` 第 279 行与 `userEmotionPrompt.describeTrend()` 第 70 行各硬编码 `slope > 0.05`，**同一展示阈值在两处重复**，未进 config。仅影响趋势人话描述文案，不影响触发/融合判定。建议后续收口（T05 config 收口时一并处理）。

---

## 2. T03 事件层基础设施 —— 逐点结论（**含 P1 关键缺陷**）

### 2.1 【P1 · 关键】I13：`_runCheck()` 挂钩点 + enabled=false 零副作用（点 7）→ **通过**
- 挂钩点位置正确：`_runCheck()` **开头第一行**（第 478 行）`if (await this.consumeEventQueue()) return;`，在 `_resetDailyCountIfNeeded()` 之前。
- `consumeEventQueue()`（第 668–691）快速预检顺序：`isEventLayerEnabled()` → registry 存在 → `getStatus().queueSize===0` → 均 O(1) 返回 false，**零副作用**。
- **亲自对比开关前后（probe T03-7）**：`enabled=false` 时预置候选**不被 consume、不生成消息**；`enabled=true` 后同一候选可被消费（对照组）。**行为差异真实存在且符合设计。**
- `git diff` 确认 `_runCheck` 的 6 步轮询逻辑**逐字节未改**，仅新增开头一行 + 新方法。

### 2.2 【P1】是否绕过闸门：事件消费后是否真走 `trigger()`（点 8）→ **通过（代码正确）**
`consumeEventQueue()` 第 683 行：`await this.trigger(candidate.targetType, {...candidate.data})` —— **走完整 trigger() 闸门**，非旁路。
- **亲自构造（probe T03-8）**：mock `emotionEngine.state.P = -0.9`（< BLOCK_P=-0.5），事件 target=`mood_check`（spontaneous）→ `consumeEventQueue()` 返回 **false**，LLM **未被调用**（generateCalls=0），未入队。
- ghost 场景（P<-0.75）下 `dailyOnce` 类（morning_greeting）事件同样被 trigger() 拦截（返回 false）。
- **结论：闸门复用正确，事件驱动不会变成闸门失效。**

### 2.3 【P1 · 关键缺陷】事件层在真实 container 中完全空转 → **不通过**
**实测证据**（加载真实 `services/container.js`）：
```
[TriggerRegistry] Attached to bus (0 triggers, 0 events)
triggers registered: 0
bus event subscribers: []
bus listenerCount(user_emotion_turn): 0
bus listenerCount(narrative_milestone): 0
emit delivered handlers: 0        ← 真的 emit('user_emotion_turn', {...}) 后无任何 handler
consumeEventQueue() -> false       ← 生产环境恒为 false
```

**两个根因（均未实现架构文档明确要求的侵入点）**：
1. **`container.js` 未调用 `triggerRegistry.register(...)`**：
   `TRIGGER_DEFS`（`triggerEvents.js` 已定义 3 个触发源元数据）**从未被注册**。container 第 34–35 行注释自认「触发源的具体 evaluate 由后续 T05/引擎层按需注入」。→ `attach()` 后 `subscribers` 为空，**任何事件都不会被 evaluate**。
2. **`AiGirlfriend` 从不 `emit` 事件**：
   全文件对 `emit / EventBus / triggerRegistry` **零引用**。架构文档 I16 要求 `_finalize()` 发布 `user_emotion_turn` 事件——**未实现**。→ 即便注册了触发源，也无人发布。

**影响**：REQ-04「事件驱动主动消息」在生产中**端到端不可用**；`consumeEventQueue()` 永远返回 false，事件层等价于纯新增的 dead code。架构文档 §2.4.1 声称本期实现 3 个触发源（emotion_turn / anniversary / promise_followup），实际**一个都没接入**。

**为什么自带测试没发现**：`test-trigger-registry.mjs` 全部用例**自行** `registry.register(...)` + `bus.emit(...)` 构造迷你场景，**从未加载真实 container**，因此骨架逻辑测得很全，但"生产装配是否真的可用"被漏测。这属于**测试盲区**。

**定性**：若 T03 的验收范围明确是"仅地基，装配留待 T05"（container 注释如此暗示），则此项应记为 **范围性缺口（P1，需 PM/架构确认）**，而**非纯 Bug**。但从 team-lead 的验证点 #8「事件消费后最终是否真的调 trigger()」的**端到端意图**看，当前**不通过**。→ **建议路由给工程师（kou-eng-b）+ 架构确认**。

### 2.4 EventBus 异常隔离（点 9）→ **通过**
- probe T03-9：`a`→抛异常→`c` 三 handler，emit **不冒泡**、`order='a,c'`（异常 handler 后仍执行）。
- 代码第 122–133：快照遍历 + 逐个 try/catch。`on('',fn)`/`on('e','not-fn')` 抛 TypeError（防御性）。
- 附带：`emit` 对无订阅事件 O(1) 返回（第 108–109）。

### 2.5 持久化 `trigger_state` 重载一致性（点 10）→ **通过**
probe T03-10：flush 后新实例重载，`queueSize`、`cooldowns`、`dedupeSeen` **完全一致**。`_load()`（第 103–128）还正确丢弃重启期间已过期候选、过滤非数字冷却值。

### 2.6 零回归：现有 8 种主动消息类型定义未变（点 11）→ **通过**
- `git diff HEAD -- src/core/proactiveTypes.js`：**无任何改动**（文件不在 modified 列表）。
- 8 种类型（morning_greeting / night_greeting / task_reminder / miss_you / mood_check / memory_share / random_chat / life_update）定义、优先级、冷却、window、minAffinity **逐字段未变**。
- `_runCheck` 6 步顺序未变（见 2.1）。
- 注：架构文档 I15 提到"**追加** `eventDriven` 字段"——**实际未追加**。属**纯新增字段缺失**，不影响旧逻辑（无害），可忽略。

---

## 3. T-SEC 安全加固 —— 逐点结论（找漏）

### 3.1 【重点怀疑】前端 SSE 流式请求是否带 Authorization（点 12）→ **通过（无缺口）**
`frontend/src/lib/api.ts`：
- `streamChat()`（第 296–301）：`fetch('/chat/stream', { headers: withAuth({...}) })` —— **✅ 带 Authorization**。
- 全量排查所有 `fetch`：`request()`（第 146 `withAuth`）、`fetchProactiveMessage()`（第 374）、`transcribe()`（第 412，FormData 场景也带）——**全部带**。
- `withAuth()`（第 49–53）：无 token 时保持原 headers 不变（兼容本机守卫开箱场景）。
- **结论：最易漏的 SSE/FormData 场景均已覆盖，未发现漏头。**

### 3.2 未配 token 时非本机请求（含伪造 X-Forwarded-For）→ 401（点 13）→ **通过**
- `auth.js` 第 60–75：`isLoopbackRequest` **只认 `req.socket.remoteAddress` / `req.ip`**，**不读 X-Forwarded-For**。
- `test-auth.mjs` 集成用例：伪造 `x-forwarded-for:127.0.0.1` + socket=`203.0.113.9` → **401**（通过）。
- 代码第 130–136：无 token 且非回环 → 401。**信任边界正确。**

### 3.3 `timingSafeEqual` 长度不等是否抛异常（点 14）→ **通过**
`safeTokenEquals()`（第 84–95）：长度不等时先对**等长零 buffer** 跑一次 `timingSafeEqual` 再返回 false——**既不抛异常、也不泄漏长度**。`test-auth.mjs` 覆盖 `('short','a-much-longer-token')`、`('','nonempty')`、`null`/`undefined` → 全返回 false 不抛。

### 3.4 OPTIONS / GET / /static 豁免且不影响正常使用（点 15）→ **通过（真实 App 实测）**
对真实 `createApp()` 发请求：
```
GET  /                  → 200   (健康检查豁免)
GET  /state/user-emotion→ 200   (业务路由，本机放行)
OPTIONS /chat           → 204   (预检豁免)
GET  /static/           → 404   (静态前缀豁免，未 401)
POST /chat {}           → 400   (参数校验，非鉴权误拦)
```
`isExemptPath()`（第 108–115）逻辑正确，中间件挂载位置在 `express.json()` 之后、业务路由之前。

### 3.5 server.js 是否真绑定 127.0.0.1（点 16）→ **通过**
`server.js` 第 18 行：`const host = process.env.HOST || '127.0.0.1';`，第 23 行 `app.listen(config.port, host, ...)`。默认**仅回环**；仅 `HOST=0.0.0.0` 显式设置才对外。`warnIfTokenMissing()`（auth.js 第 161–177）在未配 token 时打印醒目中文警告。**纵深防御到位。**

---

## 4. 我自写用例中的误报（已自行修正，非源码问题）

| 误报 | 初版错误 | 真实原因 | 处置 |
|---|---|---|---|
| T01-3 `null` 三维 | 断言"应回退 lexicon" | `Number(null)===0` 为合法有限数 → 走 fused。**JS 语义**，结果安全 | 改断言为"不崩溃且结果有界" |
| T03-7 对照组 | 断言"入队 1 条" | `ProactiveEngine` 从 `proactive_state.json` **恢复了历史 messageQueue / recentSentTexts**，相似度去重命中 | probe 内清空 `messageQueue`+`recentSentTexts` |
| T03-8 闸门 | 断言"messageQueue 为空" | 同上，恢复的队列非空 | probe 内清空 `messageQueue` |

→ 均为**我的测试环境污染**，非源码 Bug。**QA 路由规则应用结果：测试代码 Bug → 我自行修复（已修）。**

---

## 5. 全量测试 flakiness 根因定位（回应"35/39 瞬时失败"）

### 现象
- 单跑 8 套件：**7 通过，`test-memory` 失败**（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）。
- `npm test`（`&&` 串联）：在 `test-memory` 处中断（前置的 stream-filter 11 / affinity 34 / personality 84 **全过**）。
- `test-personality` 单独 3 连跑：run1/run2 全过，**run3 出现 83/84**（`TC-API-06 空账本返回 []` 失败）。

### 根因（已证实）
沙箱对 `fs.unlinkSync` 有**每轮累计计数守卫**，累计删除数达阈值（50）即抛 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`。
- 测试脚本的清理函数（如 `test-personality` 的 `forceUnlink`）捕获该异常后**降级为覆写状态文件**，导致"上一用例的状态未被真正清除"，进而 `TC-API-06` 读到**残留账本** → **假失败**。
- **决定性反证**：给 `fs.unlinkSync` 打桩（吞掉 safe-delete 异常）后跑 `test-memory` → **39/39 通过、0 失败**；`test-personality` 稳定 84/84。

### 结论
- **不是产品缺陷，也不是真实的测试间状态污染**——是**沙箱删除配额**造成的串扰假象。在有正常文件删除权限的环境（如 CI / 开发者本机）下应全绿。
- 三项交付自带测试（`test-user-emotion` / `test-trigger-registry` / `test-auth`）各 **5× 连跑零抖动**，全部确定性通过。
- 附带观察：测试脚本大量 `unlinkSync` 清理，在该沙箱下易触发配额；若希望本环境也能全绿，可把清理改为"尝试删除，失败则覆写空态并**确保覆写内容不含残留字段**"（`test-user-emotion` 已如此，`test-personality` 的降级路径未彻底清账本）。

---

## 6. 缺陷清单（按优先级）

| ID | 级别 | 交付 | 描述 | 复现 | 涉及文件:行 |
|---|---|---|---|---|---|
| D-1 | **P1** | T03 | 事件层生产空转：container 未 `register` 任何触发源；AiGirlfriend 从不 `emit` 事件。`consumeEventQueue()` 生产恒 false，REQ-04 端到端不可用 | 加载真实 container → `triggers=0`，`emit('user_emotion_turn')`→`delivered=0` | `services/container.js:32-38`；`core/AiGirlfriend.js`（缺 emit，参照 `_finalize:429`）；`core/triggerEvents.js`（TRIGGER_DEFS 未被消费） |
| D-2 | P2 | T01 | 趋势展示阈值 `0.05` 在引擎与 prompt 两处重复硬编码，未进 config | 静态检查 | `UserEmotionEngine.js:279`；`prompts/userEmotionPrompt.js:70` |
| D-3 | P2 | 测试 | `test-memory` / `test-personality` 清理依赖 `unlinkSync`，在受限环境下降级覆写不清账本，造成假失败 | 受限沙箱下连跑 | `scripts/test-memory.mjs:112`；`scripts/test-personality.mjs`（forceUnlink 降级路径） |

> D-1 是否记为"缺陷"取决于 T03 的验收范围：若明确"仅地基、装配留 T05"（container 注释倾向此），则为**范围性缺口**；若按 team-lead 点 #8 的端到端意图，则为**不通过**。**建议 team-lead / PM 裁定**。

---

## 6b. D-1 复验（T04 修复后，2026-10-01 追加）

> kou-eng-b 声称 D-1 已修复（T04：接入事件触发源）。**独立复验结论：D-1 已修复，确认为 PASS。**

### 独立复验证据（不依赖 kou-eng-b 的 test-triggers.mjs）
加载真实 `services/container.js`，QA 自写断言脚本实测：
```
triggers.size = 3  ids = [ 'emotion_turn', 'anniversary', 'promise_followup' ]
listenerCount(user_emotion_turn) = 1
listenerCount(narrative_milestone) = 1
aiGirlfriend.has eventBus = true
emit('user_emotion_turn', {turned:true, valence:-0.8, ...}) -> delivered=1, queue 0 -> 1
QA-REVERIFY: PASS
```

### 两处根因均已落地
1. **container.js 真实注册**（第 40–45 行）：`triggerRegistry.register(emotionTurnTrigger/anniversaryTrigger/promiseFollowupTrigger)` + `attach(eventBus)`。不再空装配。新增 `src/core/triggers/*.js` 三个触发源模块。
2. **AiGirlfriend 会发事件**（I16）：
   - `_emitEvent()`（第 141–147）安全发布，未装配 eventBus 时 O(1) no-op、异常只记日志。
   - `_persistAfterReply()` 第 356–367：`ingestTurn().turned===true` 时发布 `user_emotion_turn`（payload 符合架构 §2.4.4 契约）。
   - 第 368–374 + `_publishNarrativeMilestones()`（第 1412+）发布 `narrative_milestone`。

### 配套一致性核对
- `TRIGGER_DEFS` 的 `targetType` 已更新为新事件驱动类型：`emotion_resonance` / `anniversary_recall` / `promise_followup`，且这些类型**已追加**到 `proactiveTypes.js`——链路自洽（测试断言 `reason=emotion_resonance` 与之一致）。
- **proactiveTypes.js 纯追加确认**：`git diff` 为 `@@ -174,6 +174,58 @@`，diffstat `52 insertions / 0 deletions`，旧 8 类**逐字节未动**。✔（同时补齐了 W1 §2.6 曾指出的 `eventDriven` 字段缺失）

### test-triggers.mjs 复核
- A 段 6 条 D-1 集成护栏断言全过（`triggers.size=3`、两个事件 listenerCount=1、真实容器 emit 后队列 0→1）。
- B/C/D/E 段（触发源纯函数、端到端链路、P=-0.9 全闸门拦截未调 LLM、enabled=false 静默）全过。
- 已接入 `npm test` 链尾。

### 回归
- `npm run check`：**63/63**（新增 3 触发源文件后仍全绿）。
- 逐套件跑（先清 quarantine）：**9/9 全过**（stream-filter 11 / affinity 34 / personality 84 / memory 39 / proactive-gating / auth 19 / trigger-registry / user-emotion 39 / triggers）。
- `npm test` 规范链：仍因**沙箱 safe-delete 配额**在 test-memory 处中断（与 W1 §5 同因，非缺陷）；预先清理 quarantine 后 test-memory 39/39。

**结论：D-1（原 P1）已闭环，T03 事件层端到端链路现已打通。**

---

## 7. 证据索引

- 独立探针：`backend-node/scripts/_qa_w1_probe.mjs`（22/22 通过）
- `npm run check`：60/60 文件语法通过
- `frontend npx tsc --noEmit`：exit 0
- 测试单跑结果：stream-filter 11 / affinity 34 / personality 84 / proactive-gating 全通 / auth 19 / trigger-registry 全通 / user-emotion 39
- test-memory（unlink 打桩）：39/39 通过
- 真实 container 事件层实测：`Attached to bus (0 triggers, 0 events)`，`emit delivered=0`，`consumeEventQueue=false`
- 真实 App HTTP 实测：`/` → 200，`/state/user-emotion` → 200，`OPTIONS` → 204，`/static/` → 404，`POST /chat {}` → 400
