# 小爱 · 全面修改计划

- **文档类型**：实施计划（批次 / 任务 / 验收 / 回退）
- **日期**：2026-10-02
- **依据**：缺陷清单见 [`01-analysis.md`](./01-analysis.md)，条目编号（`HTTP-01` 等）与本文一一对应
- **总原则**：沿用项目既有纪律 —— ① 数值一律进 `config.js`（`envNumber`）；② 新增能力必须「关闭态安全」（关掉即字节级回到改造前）；③ 单一真源（阈值/词表/类型表只有一处）；④ 每批都要有可跑断言，不接受「看着对」。

## 优先级原则（2026-10-03 用户拍板，覆盖本文所有条目）

**目标函数是「最大程度拟人化」，成本（token / 调用次数 / 金钱）不作为削减功能的理由。**

- ❌ 取消 B1-1「事实提取节流」与「省钱模式」：每轮都提取才能让她的记忆真的长出来，这是特性不是缺陷。
- ✅ B1 其余条目重新定理由：嵌入熔断（B1-4）、query 嵌入 memoize（B1-5）、后台队列合并（B1-6）都保留，但目标是**首字延迟与进程不卡死**，且 B1-6 不得丢弃任何待提取的信息（合并为「一次提取覆盖最近若干轮」）。
- ✅ 凡是「写了但没接线」的拟人化残件一律**接上**，不许按"减少困惑"删除：`followupCount`（约定追问闭环）、`getRandomStory`/`markRecalled`（她主动回顾共同经历）、`metadata.emotion`（主动消息的情绪回灌她的 PAD）、`EmotionEngine.history`（情绪时间线可视化 REQ-10）。
- ✅ B8 性能批次全部保留，理由统一写成「一条消息冻结整个进程 / 首字变慢」，与钱无关。
- ⬆️ B4（prompt 层）与 B6（陪伴感 REQ-02/05~09）优先级上调：B2 之后先做 B4 与 B9，因为它们直接决定「她说的话像不像一个有连续人格的人」。

## 实施进度

| 批次 | 状态 | 说明 |
|---|---|---|
| **B0** | ✅ 已完成（B0-6 部分） | 13 项里 12 项落地并有回归测试：新增 `scripts/test-audit-b0.mjs`（40 断言）与 `scripts/test-audit-b0-http.mjs`（18 断言，真实起服务打接口）、`frontend/src/hooks/__tests__/useChatStream.test.ts`（5 例）。<br>**B0-6 只做到一半**：`jsonStore` 已加 fsync / 随机 tmp / EPERM 退化写，`state.json` 与四个引擎的 `_saveState()` 已回传布尔值并计入 `resetAll().failed`；但 `MemoryStore`/`NarrativeStore`/`UserEmotionEngine` 的去抖 flush 仍不回传结果。 |
| B2 前置 | ✅ 顺手做掉 | `EmotionEngine._loadState` 逐轴校验（损坏状态文件不再能打死对话链路）；`DEFAULT_AFFINITY` 导出为单一真源；`Memory.addFact` 不再返回错的事实；`_applyFactOps` 判重前置到嵌入之前。 |
| B2 | ✅ 已完成 | 新增 `scripts/test-audit-b2.mjs`（73 断言）：情绪增量强类型+逐轴裁剪+两路加权混合、`"+3"` 不再冻结好感度、ghost 不再被误判失联、约定追问计数自增、纪念日两窗分离、否定判定改邻域窗口（「今天不开会…超开心」不再判成低落）、关键词检索改真 BM25（**500 条 × 100 字查询 2888 ms → 5.1 ms**，且召回从「最近的」变成「相关的」）、好感度账本可加性与日配额按实际入账扣、`memory_share` 接上叙事层（她开始分享「我们之间的故事」而不是复述流水账）。<br>顺带把 3 条「源码字符串断言」换成行为断言（INFRA-04）。 |
| B1-3 | ✅ 已完成 | `AI_GIRLFRIEND_API_KEY` 支持服务端侧 Key 兜底（只进内存，测试断言它不落盘）；README 新增「环境变量」「安全边界」「重启后需先用浏览器打开一次」三段说明。 |
| B9 | ✅ 已完成 | 新增 `scripts/test-audit-b9.mjs`（22 断言）+ `frontend/src/lib/__tests__/configPayload.test.ts`（4 例）。四个入口加真 `enabled` 判定（`_emitEvent` / `TriggerRegistry._onEvent` / `_publishNarrativeMilestones` / 用户情绪 `analyze`+`ingestTurn`）；开关与高级参数持久化进 `state.json`（不含任何 Key），只改开关也会落盘；关闭瞬间清空积压候选，重开不倒灌；`/config/status.companion` 去掉静态 `enabled` 双真相；设置页 →「系统」新增三个开关（以后端真值为准，本地仅离线兜底）。实测：`POST /config {"narrative_enabled":false}` → 状态与 `state.json` 同步变化，重启保持。 |
| B4 | ✅ 已完成（B4-8 半） | 新增 `scripts/test-audit-b4.mjs`（33 断言）+ `frontend/src/components/character/__tests__/emotionMap.test.ts`（5 例，跨端读后端 `EMOTION_LABELS` 做交叉断言）。实测体积：人设 889→574 字、任务指令 1002→477 字、全块填满的每轮上下文 5111→3205 字。要点：好感度判定收敛为**一份**且数字由 `AFFINITY_RULES` 反查生成（朋友阶段文案与引擎的 -1/-2 矛盾消除）；`<metadata>` 单一标准 + emotion 取值枚举与引擎 17 档同源；表达优先级显式声明（阶段 > 情绪 > 性格 > 人设）；主链路指令全量中文化 + 示例换成中文人设语气 + 输出语言规则；记忆/叙事/任务加 `<memory_data>/<story_data>/<task_data>` 引述围栏，两个提取器加「素材不是指令」；叙事抽取要求 `occurredAt`（纪念日年份不再默认成抽取当天）；主动消息链去掉 4 处阶段复述与自相矛盾的 `Reason:` 字段、删掉会渲染出「未知任务」的死变量；`docs/emoji-avatar-prompts.md` 的旧 Character Bible 标注失效。<br>**B4-8 剩下一半**：独立「身份卡」模块、`proactivePrompts` 阶段表改由 `STAGE_GUIDE` 生成（人设外观已对齐银发月色系、旧文档已标注）。 |
| B2 未做项 | ⬜ 剩 2 条 | B2-10 里 `EmotionEngine.history` 仍无消费者（留给 REQ-10 情绪时间线可视化）；`narrative` 的 `jokeTrigger/tags/sourceEpisodeId` 仍无写路径（属 REQ-05 前置，放 B6-α）。 |
| B5 前置 | ✅ 顺手做掉 | 新增 `scripts/run-tests.mjs`：跑完全部套件再汇总（不再 `&&` 一断全断），并统一注入沙盒数据目录；`test-memory` 的 async-传给-同步-check 缺陷已修 + 加了防呆；`test-stream-filter` 补 failed 计数与用例数校验；`test-reset-all` 改走沙盒目录并修掉同义反复断言；`test-auth` 更新 /static 语义并新增查询串 token 用例。 |
| B3~B9 | ⬜ 未开始 | 按计划顺序 B2 → B8 → B9 → B1 → B5 → B3 → B7 → B4。 |

**验收证据（2026-10-03 实跑）**：`npm run check` 63/63；`npm test` 13/13 套通过；跑完整套测试后 `backend-node/data/` 全部文件 mtime **零变化**（B0-3 的核心验收）；前端 `tsc --noEmit` 与 `eslint src` 无输出、`vitest run` 76 例通过。

## 批次总览

| 批次 | 主题 | 对应缺陷 | 规模 | 前置 |
|---|---|---|---|---|
| **B0** | 数据安全与状态一致性 | HTTP-01/02/03/06/07/08、CORE-01/06/17、FE-04/06 | 大 | 无（最先做） |
| **B1** | 模型调用成本与可观测 | CORE-02、HTTP-05、CORE-18 | 中 | B0-3 |
| **B2** | 数值模型与解析边界 | CORE-03/04/05/11/12/13/14/15/16、CORE-20 部分 | 中 | 无 |
| **B7** | 前端健壮性与体验 | FE-01/02/03/05/07/08/09/10/11 | 大 | B0、B3 |
| **B8** | 性能与容量 | CORE-07/08/09/20/23、CORE-21 | 大 | B0-3 |
| **B9** | 开关与配置持久化 | CORE-10、HTTP-10 | 中 | B0 |
| **B3** | 接口契约与安全 | HTTP-09~HTTP-20、FE-14 部分 | 中 | B0 |
| **B4** | prompt 层重构 | PROMPT-01~08 | 中 | B2 |
| **B5** | 工程基建 | INFRA-01~12 | 大 | B0-3 |
| **B6** | 陪伴感路线图（REQ-02/05~09） | ROAD（§7） | 大 | B0~B2、B4、B9 |

## B0 · 数据安全与状态一致性（P0 优先）

> 这一批不做，后面任何改动都在「可能悄悄毁数据」的地基上。

| # | 任务 | 涉及文件 | 验收标准 | 回退 |
|---|---|---|---|---|
| B0-1 | `POST /system_prompt` 不再清空历史：就地替换 `history[0]` 并落盘；同时决定「要不要保留这个人设编辑接口」（无前端调用点，若产品不要则连同路由+README 行一并删除） | `core/AiGirlfriend.js:1064-1067`、`routes/state.js:51-56` | 新增 `scripts/test-system-prompt.mjs`：预置 3 轮历史 → 改人设 → `historyCount` 不变、`state.json` 中 system 条目已更新；挂进 `npm test` | 纯修复，无需开关 |
| B0-2 | 客户端断开即中止上游生成：`res.on('close')` → `AbortController` 透传给 SDK；明确「半轮」处理策略（推荐：已生成正文入库、跳过情绪/好感度结算） | `routes/chat.js:94-148`、`core/AiGirlfriend.js:650-719` | 用 `scripts/mock-llm-server.mjs` 起慢速流，客户端 1s 后断开，断言：上游收到 abort、`state.json` 无该轮 assistant 半截文本、好感度未变 | 保留旧行为常量 `chat.abortOnClose`（默认 true，可 env 关闭） |
| B0-3 | 数据目录可重定位：`dataPath()` 支持 `AI_GIRLFRIEND_DATA_DIR`（缺省不变）；所有测试改为写临时目录，删除「备份/还原真实文件」的写法；清掉 `data/affinity_test_tmp.json` 残留 | `utils/jsonStore.js`、`scripts/test-*.mjs`（10 个） | `npm test` 全程 `data/` 目录 mtime 零变化（新增 `scripts/test-isolation.mjs` 断言这一点） | env 不设时行为与现在完全一致 |
| B0-4 | ghosting 早退不再丢消息：早退前把用户消息写入 history 并落盘；`notifyUserActive` 与 ghost 判定的先后关系重做（冷暴力期间用户消息不应重置她的闲置计时） | `core/AiGirlfriend.js:419-442` | 单测：P=-0.9 时发 3 条 → `getHistory()` 含 3 条 user、无 assistant；`lastUserActiveTime` 不被刷新；情绪回正后下一轮 prompt 能看到被忽略的消息 | 常量 `chat.ghostRecordsInput`（默认 true） |
| B0-5 | `resetAll()` 补全：新增 `ProactiveEngine.resetState()`（配额/冷却/队列/`recentSentTexts`，保留用户配置）与 `LifeSimulator.resetLog()`，纳入步骤表；`{reset,failed}` 契约不变 | `core/AiGirlfriend.js:1002-1044`、`core/ProactiveEngine.js`、`core/LifeSimulator.js` | 扩展 `scripts/test-reset-all.mjs`：重置后 `proactive_state.json` 计数归零、`life_log.json` 清空、配置段仍在；`GET /reset` 返回 `failed: []` | 无 |
| B0-6 | **落盘失败必须可见**：`writeJson` 返回值向上传播并计入 `failed`；tmp 写完 `fsyncSync` 再 rename；rename 遇 `EPERM` 时退化为覆盖写并保留 tmp | `utils/jsonStore.js:89-101` + 全部调用点 | 单测：把 `data/` 设为只读后 `POST /state` 返回 `failed` 含 `state`，而不是 200 静默成功 | 无 |
| B0-7 | **重置与在途对话串行化**：`resetAll` 改 async，先 `await this._chatQueue`；引入 `stateGeneration`，`_finalize`/`_persistAfterReply` 写前校验世代号 | `core/AiGirlfriend.js:1002,544,347` | 集成测试：生成中发 `POST /reset` → 重置后 `GET /history` 为空且 3s 后仍为空（不被回写） | 无 |
| B0-8 | 部分重置对前端可读：207 改 200 + `{status:'partial', failed}`，或让 `api.request()` 支持按路由解析非 2xx JSON；UI 列出「已清空 / 失败」两栏 | `routes/state.js:38-45`、`frontend/src/lib/api.ts:149-152`、`SettingsDialog.tsx` | 人为让一个引擎抛错 → UI 显示「好感度已清空，记忆清空失败（原因）」而不是「重置失败」 | 无 |
| B0-9 | 全局异常兜底：`server.js` 补 `unhandledRejection`/`uncaughtException` 处理；SSE 两处回调加 `res.writableEnded` 守卫；`notifyUserActive` 包 try/catch；加 15s SSE 心跳 | `src/server.js:28-40`、`routes/chat.js:110-147` | 在 `.then` 内人为抛错 → 进程不退出、客户端不挂死；`node scripts/…` 冒烟脚本验证 | 无 |
| B0-10 | `/static` 不再免鉴权（改为带签名查询串或要求 token），且 `HOST !== 127.0.0.1` 而缺 token 时**拒绝启动** | `middleware/auth.js:35,113`、`server.js:18-21` | 无 token + `HOST=0.0.0.0` 启动直接报错退出；带 token 时 `GET /static/x.mp3` 无凭证返回 401 | 提供 `ALLOW_INSECURE_STATIC=1` 显式退回 |
| B0-11 | **修好对话串行保证**：catch 内不再改写 `_chatQueue`；`_prepare` 纳入 try；`EmotionEngine._loadState` 对 P/A/D 做 `Number.isFinite` 校验并回落 | `core/AiGirlfriend.js:405-410,651-662,623,669`、`core/EmotionEngine.js:398` | 新增并发测试：A 抛错后立刻并发 B/C，断言 `_doChat` 不重叠执行（用进入/退出计数断言互斥）；损坏 `emotion_state.json` 启动后仍能正常对话 | 无 |
| B0-12 | **世代号覆盖补全**：episode 嵌入/写入、`_applyFactOps`/`_applyNarrativeOps` 每次 await 之后、用户情绪 `ingestTurn` 全部加校验；`clearHistory/clearMemoriesOnly/resetAll` 统一走 `_chatQueue` | `core/Memory.js:64-86,106-146`、`AiGirlfriend.js:1345-1388`、`core/UserEmotionEngine.js:158,309-325` | 集成测试：在嵌入 await 期间触发 `clearMemory()`，断言重置后 `episodes.length===0` 且 3 s 后仍为 0（不复活） | 无 |
| B0-13 | 流式失败的「不重跑」保护：前端仅在**未收到任何 delta** 时回退 `/chat`；SSE 每帧 `JSON.parse` 加保护 | `frontend/src/hooks/useChatStream.ts:82-95`、`frontend/src/lib/api.ts:330` | 单测：delta 后抛错 → 不再发 `/chat`；后端账本只 +1 次好感度（与 FE-04 同一条测试覆盖） | 无 |

## B1 · 调用链路的健康度（**不以省钱为目标**）

> 用户已明确否决「为省 token 而节流」的方向（见上文优先级原则）。本批只做两件事：
> 让慢的地方不卡、让看不见的地方看得见。每轮都提取事实是**有意保留的行为**。

| # | 任务 | 涉及文件 | 验收标准 | 回退 |
|---|---|---|---|---|
| ~~B1-1~~ | ~~事实提取节流 / 省钱模式~~ | — | ❌ **已取消**（用户否决：成本不作为取舍理由，每轮提取才能让记忆真的长出来） | — |
| B1-2 | 每轮模型调用计数可见：`GET /config/status` 增加 `llmCalls`（本轮 / 近 1h 各通道次数），设置页展示 —— 目的是**排障与理解行为**，不是压成本 | `AiGirlfriend.js`、`routes/configRoutes.js`、`frontend/src/components/settings/tabs/SettingsAdvancedTab.tsx` | 前端能看到「本轮：主对话 1 + 事实 1 + 嵌入 0 + 叙事 0」 | 只读展示，无风险 |
| B1-3 | Key 来源兜底：`AI_GIRLFRIEND_API_KEY` env（只进内存不落盘）+ README 启动约束 | `AiGirlfriend.js`、`README.md` | ✅ **已完成**（测试断言 env 可读、`state.json` 里 grep 不到 Key） | 不设 env 时行为不变 |
| B1-4 | 嵌入通道加**熔断**：连续 N 次失败后冷却 M 分钟并强制走 keyword；`available` 从「配了没」改成「配了且健康」 | `core/memory/EmbeddingClient.js:52-54`、`MemoryRetriever.js:28-35`、`config.js:74-78` | 坏 Key 时首字不再被两次 2500 ms 超时拖住（计时断言）；`config.js` 注释承诺的「慢就快速降级」变成真的 | 不设 env 时行为不变 |
| B1-5 | 同一轮 query 嵌入 memoize（记忆与叙事共用一次）；`Memory.js:133` 判重前置到嵌入之前（已做） | `core/Memory.js:120,158`、`narrative/NarrativeRetriever.js:106` | 单轮检索嵌入从 2 次降到 1 次（计数断言），少一次网络往返 = 首字更快 | 无 |
| B1-6 | 后台队列加**上限与合并**（不丢信息）：积压超阈值时把最旧若干轮合并成一次提取，而不是丢弃 | `core/Memory.js:93`、`AiGirlfriend.js:1315` | 连发 10 条时队列长度有界，且断言「10 轮内容都出现在某次提取的输入里」 | `memory.facts.enabled=false` 时天然不生效 |

## B2 · 数值模型与解析边界

| # | 任务 | 涉及文件 | 验收标准 | 回退 |
|---|---|---|---|---|
| B2-1 | `EmotionEngine.applyDelta` 增加每轮幅度裁剪（默认 ±0.5，进 config），词表 delta 与 LLM delta 分别裁剪后混合，trace 记录生效值 | `core/EmotionEngine.js:97-131`、`AiGirlfriend.js:569-575`、`config.js` | 模型给 `{"P":0.9}` 时实际生效 ≤0.5；不变量测试：单轮 \|ΔP\| ≤ 上限 | `emotion.clipLlmDelta=false` 退回 |
| B2-2 | `promise_followup` 的 `followupCount` 真正自增（投递成功后写回叙事库），并加「第 4 次不再追问」单测 | `core/ProactiveEngine.js:668-691`、`narrative/NarrativeStore.js`、`triggers/promiseFollowupTrigger.js` | 同一 promise 连续命中 4 次，只有前 3 次入队 | 无 |
| B2-3 | 纪念日窗口收敛为单一真源：触发阈值只读 `config.narrative.anniversaryWithinDays`，删 `triggerEvents.js` 内重复常量 | `core/triggerEvents.js`、`triggers/anniversaryTrigger.js` | 改 env 为 1 天，7 天外的纪念日不再产生候选；`test-trigger-registry.mjs` 增断言 | 无 |
| B2-4 | **metadata 解析边界统一强类型**：`affinity_change`/`emotion_delta`/`user_emotion` 全部 `Number()` 强转 + 引号/全角负号剥离，失败 `console.warn` 并在响应里透出 `parse_warnings` | `AiGirlfriend.js:822-835`、`affinityRules.js:76` | 模型输出 `{"affinity_change":"+3"}` 时好感度正常 +3；坏值时 `/chat` 响应能看到告警而不是静默为 0 | 无 |
| B2-5 | **ghosting 不再被性格系统误判为失联**：把 `_recordStats`/`lastActiveTime` 的更新移到 `_prepare`（收到消息即算活跃） | `AiGirlfriend.js:419-442`、`PersonalityDrift.js:589-590`、`personalityRules.js:231` | 单测：连续 5 天每天发消息但全程 ghost → `consecutiveInactiveDays` 保持 0、S01 不触发、security 不掉 | 无 |
| B2-6 | 情绪增量改为**加权混合**（词表 w1 + LLM w2，和 ≤1）并逐轴裁剪 LLM delta；`decay()` 补 clamp；引擎内多次落盘合并为一次 | `EmotionEngine.js:97-136`、`AiGirlfriend.js:569-575` | 「我今天好难过」单轮 |ΔP| ≤ 0.15；`{"P":-5}` 被裁到 −0.5；`emotion_state.json` 每轮写盘从 4 次降到 1 次 | `emotion.blend=false` 退回叠加 |
| B2-7 | 用户情绪否定判定改**邻域窗口** + 词形排除（不错/没什么/无语），并补真实语料回归集 | `core/userEmotionLexicon.js:108,245` | 「今天不开会，和朋友聚了聚，超开心」判为正效价；≥20 条语料用例全绿 | 无 |
| B2-8 | 关键词检索修成真 BM25 变体：tf 用未去重词频、df 预计算、归一化不再除词数、recency 降为小幅加分；两处阈值统一；拒绝判定改词组级且排除引述片段 | `textSim.js:21-37`、`KeywordScorer.js:33-55`、`MemoryRetriever.js:93`、`NarrativeRetriever.js:130`、`affinityRules.js:92,100-116` | 构造「100 条无关近因 + 1 条相关远因」的库，断言选中的是相关那条；`sorry` 中英文路径一致 | 无 |
| B2-9 | 好感度账本可加性：非有限值不再混写、`finalChange` 与 `after-before` 严格一致、日配额按实际入账分扣、衰减条目加 `kind` 字段 | `affinityRules.js:76,88-90`、`AffinityEngine.js:120-124,153-159,210` | 表驱动测试锁死不变量；好感度 99 时 `change=+3` 只扣 1 点日预算 | 无 |
| B2-10 | 惰性字段二选一（接线或删除）：`followupCount` 自增、`getRandomStory`/`markRecalled` 接入 `memory_share`、`_recentStoryIds` 真正 add、`lastExtractTurn` 要么用要么删、`EmotionEngine.history` 无消费者则删 | 见 CORE-19/CORE-20 清单 | 每个字段都有「写点 + 读点」或被删除；`grep` 不再出现只读不写的计数器 | 无 |

## B3 · 接口契约与安全（HTTP P1 群）

| # | 任务 | 对应缺陷 | 涉及文件 | 验收标准 |
|---|---|---|---|---|
| B3-1 | CORS 补 `PATCH`，并加一条「已注册路由方法 ⊆ CORS 允许方法」的启动断言 | HTTP-09 | `app.js:24`、`routes/state.js:91` | 浏览器里编辑事实记忆可保存；断言测试能抓到未来新增的漏网方法 |
| B3-2 | `POST /config` 全字段 schema 校验（类型/长度/URL scheme/布尔严格类型），`initOpenAI` 失败改 400；空串语义统一为「清空」 | HTTP-11、HTTP-12 | `routes/configRoutes.js`、`AiGirlfriend.js:1090-1223` | 传 `{api_key:{}}`/`{"temperature":"false"}` 返回 400；传 `''` 能真的清空 Key；`base_url` 非 http(s) 被拒 |
| B3-3 | `baseUrl` 主机白名单/私网拦截 + `/config/status` 与设置页高亮当前 baseUrl | HTTP-12 | 同上 + `frontend/src/components/ui/ApiConfigForm.tsx` | 指向 `169.254.169.254` 被拒并在 UI 显示告警 |
| B3-4 | 消费型 GET 改 POST：`GET /chat/proactive` → `POST /chat/proactive/consume`；`GET /life/current` 变纯读 | HTTP-13 | `routes/chat.js:150-154`、`core/LifeSimulator.js:245-248`、`frontend/src/lib/api.ts:372-379` | 任意页面 `<img src=…/chat/proactive>` 不再消耗队列；前端轮询照常工作 |
| B3-5 | 上游错误映射为稳定码 + 中文文案，细节只进日志；`errorHandler` 不再回显 4xx 原文 | HTTP-14 | `AiGirlfriend.js:636,713`、`middleware/errorHandler.js` | 429/401 场景下气泡是「模型暂时不可用」，响应体不含模型名/上游主机 |
| B3-6 | 上传与 TTS 入参收紧：扩展名白名单 + `fileFilter`、超限返回 413、`text` 必须是非空字符串、开机清扫 `temp_uploads/` | HTTP-16 | `routes/audio.js:19-33`、`Voice.js:87` | 上传 `.exe` 被拒；超长扩展名不再 500；`/audio/speak` 传数字返回 400 |
| B3-7 | 自由文本入库前截断（任务 title 200 / description 2000 / fact content 500），注入时再兜一层 | HTTP-18 | `routes/tasks.js:29-32`、`routes/state.js:65-74`、`prompts/taskPrompt.js:82`、`Memory.js:179` | 建一条 100KB 标题的任务后，每轮 prompt 字符数不增（用 B1-2 的计数器验证） |
| B3-8 | 一致性小修打包：读时 roll 日界、`setAffinity` 写账本、`context_count`/`historyCount` 统一、情绪哨兵值统一、`DEFAULT_AFFINITY` 提取、昵称默认统一、`config.js` 三处改用 `envNumber`、`getCompanionStatus` 去掉双真相、`/chat` 与 `/chat/stream` done 合成一个 builder、`lifeSimulatorOr404` 改名、`validate.js` 注释与 `fail` API 重做 | HTTP-19 | 见分析条目清单 | 每项一条断言；`/chat` 与 `/chat/stream` 的 done 字段集合用同一份 schema 测试锁定 |
| B3-9 | 隐私：`AiGirlfriend.js:806,813,834` 的独白/CoT/metadata 全文日志降级为 debug 级或长度截断；`app.disable('x-powered-by')`；`_chatQueue` 加长度上限（超出直接 429） | HTTP-19 | `AiGirlfriend.js`、`app.js` | 默认日志不再出现对话原文；队列长度可配 |
| B3-10 | 修 ghosting 标签穿帮：`emotionMap.ts` 补 `冷漠` 等缺失映射，后端改下发 `getEmotionLabel()`，并加「引擎标签集合 ⊆ 前端映射表」一致性测试 | FE-01、PROMPT-04 | `AiGirlfriend.js:437`、`frontend/src/components/character/emotionMap.ts` | ghost 时面板显示生气/低落而非「开心」；新增标签未映射时测试红 |
| B3-11 | 前端补三个陪伴感开关（或改文档）：`toBackendConfigPayload` 增加 `user_emotion_enabled/narrative_enabled/trigger_enabled` 并在设置页给 UI | HTTP-10 | `frontend/src/lib/api.ts:100-128`、`SettingsAdvancedTab.tsx` | 关掉开关后 `/config/status.companion` 立即变化，且行为退回改造前（关闭态安全） |

## B4 · prompt 层（依赖 B2 的数值口径先落地）

| # | 任务 | 对应缺陷 | 涉及文件 | 验收标准 |
|---|---|---|---|---|
| B4-1 | 把「共情策略表」真正接进运行链路，删掉重复的那份 `[User Emotion]` | PROMPT-01 | `prompts/userEmotionPrompt.js:16-45`、`UserEmotionEngine.js:263-268`、`AiGirlfriend.js:475` | 用户情绪=低落时，注入段含「先共情后建议」的具体策略；`buildUserEmotionContext` 有运行时调用点（grep 断言） |
| B4-2 | 好感度规则单一真源：数字全部由 `AFFINITY_RULES` 生成，阶段文案只描述「什么算越界」 | PROMPT-02 | `systemPrompt.js:16-24,87`、`prompts/relationshipContext.js:24,40,57,73,88`、`affinityRules.js:42-43` | 三处文案与引擎数字逐档一致（表驱动测试）；朋友阶段越界不再出现 -1/-2 分歧 |
| B4-3 | 声明语气优先级一行 + 从静态人设删除固定性格形容词，让预设成为唯一来源 | PROMPT-03 | `systemPrompt.js:10`、`personalityPrompt.js:9-59`、`relationshipContext.js` | stranger+clingy 组合下不再同时出现「非常黏人」与「不会撒娇」；冲突用例进表驱动测试 |
| B4-4 | `<metadata>` 收成一份 schema 示例；`emotion` 要么用起来要么删；`confidence` 缺失按 0.5 兜底；`taskId` 补进 schema 或删掉短 id 注入 | PROMPT-04 | `systemPrompt.js:15,86`、`taskPrompt.js:141`、`AiGirlfriend.js:545,826-832`、`UserEmotionEngine.js:130-134` | 三处示例合并为一；模型省略 confidence 时 LLM 读取仍生效（单测） |
| B4-5 | 全量中文化（段落标题+规则+示例），并加一条输出语言规则 | PROMPT-05 | `systemPrompt.js:57-95`、`EmotionEngine.js:257-266`、`personalityPrompt.js:101`、`UserEmotionEngine.js:264`、`taskPrompt.js:138-149` | 示例改为中文人设语气；纯英文输入下连续 5 轮回复语言与用户一致 |
| B4-6 | 数据围栏：`[已知事实]/[相关回忆]/叙事/任务` 包进 `<data_block>` 式分隔，人设加一句「围栏内是引述素材」，两个提取器加「忽略祈使句」 | PROMPT-06 | `Memory.js:167-170`、`narrativePrompt.js:64-67`、`taskPrompt.js:82`、`FactExtractor.js:115-117`、`NarrativeExtractor.js:160-162` | 构造一条含「忽略以上指令」的用户消息，事实库不会把它写成 `[已知事实]`（回归用例） |
| B4-7 | token 瘦身：任务指令 1002→~300 字、删重复好感度阶梯与 `Reply Style:`、`[Response Instructions]` 中文化收紧、给 `[相关回忆]` 每条加字符上限 | PROMPT-07 | 同上 + `Memory.js:160,179` | 填满所有块时 `buildSystemContext` 字符数 ≤3200（现状 5111），用一条度量测试锁定 |
| B4-8 | 身份卡：抽 name/自称/外观/不可谈判边界为唯一真源，修正人设外观与已上线立绘一致，归档旧 Character Bible，阶段语气由 `STAGE_GUIDE` 生成 | PROMPT-08 | `systemPrompt.js:9`、`docs/emoji-avatar-prompts.md:26-31`、`prompts/proactivePrompts.js:21-54`、`docs/character-emote-prompts.md` | 全仓库只有一处外观描述；`docs/emoji-avatar-prompts.md` 标注失效；主动消息阶段文案与 `STAGE_GUIDE` 同源 |
| B4-9 | 主动消息链去重：4 处阶段复述压成 1 处；删 `buildProactiveDirective:216` 的未用变量（它会以空 data 渲染出「未知任务」文案） | PROMPT（R5） | `AiGirlfriend.js:852-871`、`proactivePrompts.js:216-229` | 主动消息请求的 system 消息数从 4 条降到 2 条，且不出现「未知任务」 |

## B5 · 工程基建

| # | 任务 | 对应缺陷 | 涉及文件 | 验收标准 |
|---|---|---|---|---|
| B5-1 | 修两条「永远不会失败」的测试：`test-stream-filter.mjs` 去掉硬编码 `TOTAL` 并加 failed 计数与 exit(1)；`test-memory.mjs:559` 改 `await checkAsync(...)` | INFRA-01 | `scripts/test-stream-filter.mjs`、`scripts/test-memory.mjs` | 故意注释掉一条用例 → `npm test` 变红（用 CI 反向验证） |
| B5-2 | 三个布尔式套件补 `passed/expected` 双计数并断言相等 | INFRA-02 | `test-proactive-gating.mjs:16-23`、`test-trigger-registry.mjs:19-26`、`test-triggers.mjs:18-25` | 跳过整节的注入式改动会让 CI 红 |
| B5-3 | 后端引入统一测试小框架（`node:test` 即可，零依赖）：`describe/it` + 真断言 + 汇总失败数；把 10 个脚本迁过去并让 `&&` 链改为「全跑再汇总」 | INFRA-01/02/06 | `package.json:11`、`scripts/test-*.mjs` | 单个套件失败不再阻断其余 9 个；失败总数在 CI 摘要里可见 |
| B5-4 | 把 `test-reset-all.mjs` 挂进 `npm test`（依赖 B0-3 数据隔离），并修掉同义反复断言 `:50` | INFRA-03 | `package.json`、`test-reset-all.mjs` | 重置路径有 CI 覆盖；跑完 `data/` mtime 不变 |
| B5-5 | 删掉「源码字符串断言」，改行为断言 | INFRA-04 | `test-personality.mjs:468-495` | 把 `sentiment` 那行改名不再影响测试；把调用删掉测试会红 |
| B5-6 | 补路由层 HTTP 测试（`node:test` + 内存 fetch，或 supertest）：优先 `chat`（done 字段集合）、`config`（校验）、`state`（reset/system_prompt 语义）、`tasks` | INFRA-05 | 新增 `scripts/test-routes-*.mjs` | 18 个零覆盖文件里先降到 ≤8；本次审计的 HTTP-01/09/11/13 都有回归用例 |
| B5-7 | 前端补 5 个高价值单测：`api.request`（401/204/HTML 404/非 2xx JSON 解析）、`api` SSE 解析（delta/done/error/缺 done）、`chatStore.applyMeta`、`useProactivePolling`（定时器与隐藏态）、`emotionMap.normalizeEmotion`（引擎标签全覆盖） | INFRA-05、FE-01 | `frontend/src/lib/__tests__/` | vitest 用例数从 71 起增；`emotionMap` 用例先红（缺 `冷漠`）后绿 |
| B5-8 | CI 补：后端 eslint、`next build`、boot smoke（起服务 + `GET /health` + `GET /config/status`）、改调 `npm run` 脚本；`node-version` 与 engines 对齐（后端 `>=20.9`） | INFRA-06 | `.github/workflows/ci.yml`、两个 `package.json` | 一次 PR 里能同时看到 lint/build/boot/test 四类失败；`npm run lint` 本地与 CI 等价 |
| B5-9 | `check-syntax` 之后加「真导入冒烟」（`await import('./src/services/container.js')`），并把 `scripts/` 纳入语法检查 | INFRA-07 | `scripts/check-syntax.mjs:12,29-30` | 故意写错一个 import 路径 → `npm run check` 红 |
| B5-10 | 补 `GET /health`（免鉴权，只回 `{ok,version,model,dataDirWritable,llmConfigured}`）+ 极简 logger（时间戳/level/堆栈），`errorHandler` 输出堆栈 | INFRA-11 | `app.js`、`middleware/errorHandler.js`、新增 `utils/logger.js` | `start_services.py` 改为探 `/health` 而非 TCP；500 能在日志里看到堆栈 |
| B5-11 | `.env.example`（37 个旋钮分组注释）+ README 校正（Node 版本、启动脚本、成本口径、缺失的两个 memories 端点、`npm test` 注释、middleware「参数校验」措辞）+ `docs/README.md` 索引 + `frontend/README.md` 重写 + 文档命名统一 | INFRA-09/10 | `.env.example`、`README.md`、`docs/` | 新人只读 README + `.env.example` 能在无浏览器条件下起后端并 chat |
| B5-12 | 全量档案导出/导入（`data/` 全部 JSON + 校验和 + 导入前备份），设置页一个按钮 | INFRA-12 | 新增 `routes/backup.js`、`SettingsAdvancedTab.tsx` | 导出→改坏 `memory.json`→导入可完整恢复；`POST /reset` 前自动做一次快照 |
| B5-13 | 依赖与仓库：`multer` 升 2.x（1.x 为历史 CVE 线）、评估 `openai` 4→5、`express` 4→5 的迁移成本并记录决策；`.gitignore` 补 `.workbuddy-ai/`；加 `.gitattributes`；`diag-*.mjs` 要么声明 `playwright-core` 要么删除；`_qa_*.mjs` 若要作为验收证据就提交；清理 1.6MB `diag-*.png` 与备份目录并在 README 说明可删 | INFRA-10、依赖审计 | 两个 `package.json`、`.gitignore`、`scripts/diag-*.mjs` | `npm audit` 无高危或已记录豁免理由；`git status` 干净 |
| B5-14 | `start_services.py` 去硬编码（由脚本所在仓库根推导路径）+ 明确 POSIX 不支持的早退提示 + 超时后回收自己起的子进程 | INFRA-10 | `scripts/start_services.py:11-12,14-18,56-57` | 换目录/换机器仍可用；失败不留孤儿进程 |

## B7 · 前端健壮性与体验

| # | 任务 | 对应缺陷 | 涉及文件 | 验收标准 |
|---|---|---|---|---|
| B7-1 | 主动消息投递改 FIFO 队列，禁止 `clearTimeout` 取消待投递消息 | FE-02 | `stores/chatStore.ts:227-240` | 单测：200 ms 内连投 3 条 → 3 条全部落屏 |
| B7-2 | 流式写入按 `streamingMessageId` 定位；流式期间挂起主动消息 | FE-03 | `chatStore.ts:101-128,227-240`、`ChatPage.tsx:134` | 单测：delta 中途插入主动消息 → 两个气泡内容互不污染、无空占位残留 |
| B7-3 | 引入 `backendOnline` 状态 + 常驻离线横幅；失败时 30 s 重试、恢复后自动 `syncState()+fetchHistory()` | FE-05、FE-08 | `stores/uiStore.ts`、`chatStore.ts:175-225`、`hooks/useBootstrap.ts`、新增横幅组件 | 后端后起时，无需刷新页面即恢复历史；断网时界面明确说「后端未就绪」而不是空白对话 |
| B7-4 | 乐观更新统一带回滚：好感度、性格 baseline、主动配置；防抖中的编辑在卸载前 flush | FE-07 | `MemoryDialog.tsx:201-210`、`hooks/usePersonality.ts:75-97,165-169`、`SettingsDialog.tsx:78-170` | 单测：请求失败后 UI 回到原值；拖完滑块立刻关页不丢改动 |
| B7-5 | 设置弹窗加 dirty 检查（有未保存改动时 Esc/遮罩不关闭，改为提示） | FE-07 | `components/ui/Modal.tsx:18-35`、`SettingsDialog.tsx` | 输入框有内容时点遮罩不丢数据 |
| B7-6 | 401/未配置 token 的可操作提示 + **设置页加 token 输入框**（写 `ai-girlfriend-token`） | FE-08、HTTP-05 | `api.ts:28-53`、`useBootstrap.ts:50`、`SettingsAdvancedTab.tsx` | 配错 token 时界面直接说「后端要求访问令牌，请在设置里填写」，而不是「确认后端已启动」 |
| B7-7 | 错误文案分流：`API Key not configured` → 引导去设置；503 主动消息 → 说明开关/队列；超时后强制重同步一次 | FE-08 | `useChatStream.ts:97-99`、`ProactiveStatusStrip.tsx:88`、`api.ts:240-251` | 三类错误各有一条单测断言文案 key |
| B7-8 | 文案与流程纠错：`ApiConfigStep` 的「不会上传到任何服务器」改为准确表述；向导在 `syncConfig` 成功后才置 `hasCompletedSetup`；导出改为向服务器要全量历史 | FE-09 | `wizard/steps/ApiConfigStep.tsx:74-76`、`FirstRunWizard.tsx:38-44`、`dialogs/ExportDialog.tsx:22-62` | 断网完成向导后会停留在向导；导出文件与 `/history` 一致 |
| B7-9 | 破坏性操作分级：单条记忆删除/切预设加二次确认或撤销条 | FE-09 | `MemoryDialog.tsx:342,375`、`PersonalityPresetGrid.tsx:53` | 误点后 5 s 内可撤销 |
| B7-10 | a11y 基线：`Modal` 加 `role/aria-modal`+焦点移动与归还+陷阱+滚动锁；`Field` 关联 `htmlFor`；抽屉加标签与 Esc；hover-only 操作在触屏常显；`aria-live` 流式区；`SegmentedControl/ThemeDialog` 加选中语义；reduced-motion 下修掉卡住的立绘覆盖层 | FE-10 | `ui/Modal.tsx`、`ui/Field.tsx`、`ChatPage.tsx:96-118`、`MemoryDialog.tsx:333,378`、`personality/PersonalitySlider.tsx`、`character/CharacterAvatar.tsx:74` | axe/手动键盘走查一遍可完成「发消息、开设置、删记忆、确认重置」；`prefers-reduced-motion` 下表情切换正常 |
| B7-11 | 对比度与字号：`--text-muted` 在 10-12px 场景换色或加大字号；`.gradient-text` 用在标题上的渐变调整到 AA | FE-10 | `styles/themes.css:56,83`、`styles/utilities.css:117-127` | 文本对比度 ≥4.5:1（小字）/3:1（大字） |
| B7-12 | 类型收口：`emotionalState` 解构加保护、localStorage 读取值做枚举校验、`types/index.ts` 可选性统一、SSE done 字段用同一份 schema | FE-11、FE-14 | `PadStateBars.tsx:19,71`、`SettingsDialog.tsx:56-97`、`types/index.ts:52-95`、`api.ts:334-360` | 老 payload（缺字段）下不再白屏；脏 localStorage 值被回落 |
| B7-13 | 性能：`DialogLayer` 不订阅 `messages`；`useAutoScroll` 缓存 matchMedia；`AudioVisualizer` 渐变复用 + dpr 缩放；reduced-motion 下停樱花；`useVoiceRecorder` 计时不再整页重渲染 | FE-12 | `DialogLayer.tsx:19`、`useAutoScroll.ts:30-38`、`voice/AudioVisualizer.tsx:62-97`、`useSakuraEffect.ts:14-31`、`ChatPage.tsx:130-141` | 流式期间 React 提交次数显著下降（Performance 面板对比）|
| B7-14 | 移动端修正：`h-screen`→`h-dvh`、加 `viewport.viewportFit='cover'`、EmojiPicker 动态锚点、TypingIndicator 改 `[animation-delay]`、触控目标 ≥44px | FE-13 | `ChatPage.tsx:89,146`、`app/layout.tsx`、`EmojiPicker.tsx:50`、`TypingIndicator.tsx`、`ChatToolbar.tsx:44`、`ui/Switch.tsx:22` | 真机/375px 模拟器下 safe-area 生效、表情面板不被裁、三个点错开跳动 |
| B7-15 | CSS 顺序依赖修掉：`themes.css` 亮/暗与四主题改特异度或改 `@layer`；`.message-bubble` 与 framer-motion 二选一 | FE-14 | `styles/themes.css:48-99`、`utilities.css:60` | 调换 `layout.tsx` import 顺序后深色模式仍正确 |
| B7-16 | 语音与输入：录音单实例化 + 失败分型文案 + `transcribe` 返回错误对象；`ChatInput` 加 `isComposing` 守卫、回复后自动聚焦 | FE-15 | `useVoiceRecorder.ts:38-77`、`api.ts:415-417`、`ChatInput.tsx:56-64` | 中文 IME 上屏回车不再误发；录音失败提示区分「无设备/被拒绝/转写失败」 |
| B7-17 | 通知隐私：桌面通知内容可配（只显示「小爱给你发来一条消息」），朗读可单独静音 | FE-15 | `useProactivePolling.ts:77-84`、`settingsStore.ts` | 锁屏通知不含正文（默认开） |

## B8 · 性能与容量

| # | 任务 | 对应缺陷 | 涉及文件 | 验收标准 |
|---|---|---|---|---|
| B8-1 | 关键词检索建索引：episode 变更时增量维护分词与 df，idf 提到文档循环外；请求路径上对 query 词数截断 | CORE-07 | `memory/KeywordScorer.js`、`MemoryStore.js`、`MemoryRetriever.js` | 基准：500 条库 + 91 词查询 ≤20 ms（现 2 888 ms）；8000 字消息不阻塞事件循环（用定时器抖动断言） |
| B8-2 | `memory.json` 瘦身：向量旁路存储（或 base64/TypedArray），写盘去掉缩进 | CORE-08 | `MemoryStore.js:132-154`、`jsonStore.js:98` | 500 条含向量的库文件 ≤3 MB（现 14.6 MB）；单次写盘 ≤10 ms |
| B8-3 | 注入预算护栏：每条回忆 ≤300 字、每条事实 ≤120 字、`_buildPromptMessages` 前做总预算裁剪（按优先级丢块） | CORE-09 | `Memory.js:160,179`、`AiGirlfriend.js:322-339` | 最坏情况单请求 ≤24k 字符（现 ≈237k）；构造超长消息断言不会把人设挤出请求 |
| B8-4 | 无界集合治理：`tasks` 上限 + 完成归档、启动调用 `_pruneDedupe`、assistant 正文与 `thought` 字符上限、`maxEpisodes` 上限收到 5000 | CORE-20、CORE-08 | `TaskManager.js:156-234`、`TriggerRegistry.js:365-375`、`AiGirlfriend.js:592-594`、`config.js:88` | 长跑 30 天模拟后各 JSON 尺寸在预算内（写一条容量回归测试） |
| B8-5 | 落盘次数合并：引擎内状态变更微任务去抖；`_finalize` 路径上的同步写盘改为一次批量 | CORE-23 | `EmotionEngine.js:86,121,136`、`AffinityEngine.js:126,171`、`PersonalityDrift.js:764` | 一轮对话 `writeFileSync` 次数 ≤4（现 9-13），且最后一个 delta→done 帧间隔明显缩短 |
| B8-6 | 历史裁剪与 system 消息位置修正：trim 改按「成对但容忍孤立 assistant」；动态 system 块合并到首条之后、历史之前；主动消息 4 条 system 合成 1 条 | CORE-21 | `AiGirlfriend.js:597-599,513,852-871` | 有主动消息插入后裁剪不再错删 user 消息；严格校验的 provider 不再 400 |
| B8-7 | 修 `maxPromptHistory` 与 `MAX_HISTORY` 的矛盾（要么把 200 提到 500 并如实展示，要么把 UI 上限降到 199） | CORE-21 | `AiGirlfriend.js:38`、`SettingsAdvancedTab.tsx` | 设 500 时实际生效 500，或 UI 最大只能选到真实上限 |
| B8-8 | 小口径修正：`lastRandomSlotKey` 补零与时段语义、`recentSentTexts` 载入保留最新 2 条、`decaying` 与 `settleDecay` 判定分离、里程碑发布移到抽取之后 | CORE-20/21 | `ProactiveEngine.js:209,550`、`AffinityEngine.js:210`、`AiGirlfriend.js:386-392` | 每条一个断言；新建纪念日当轮即可触发 |

## B9 · 开关与配置持久化

| # | 任务 | 对应缺陷 | 涉及文件 | 验收标准 |
|---|---|---|---|---|
| B9-1 | 四个入口加真 `enabled` 判定：`_emitEvent`、`TriggerRegistry._onEvent`、`_publishNarrativeMilestones`、`UserEmotionEngine.analyze/ingestTurn` | CORE-10 | `AiGirlfriend.js:156-163,386,474,362`、`TriggerRegistry.js:265-287` | 三个开关逐个关掉后：对应 `data/*.json` **mtime 不变**、无事件入队、无 emit 日志 —— 真正做到「关闭态安全」 |
| B9-2 | 开关与运行时参数持久化：`updateConfig` 把 toggles/chat params/memory 选项写进 `state.json`（**不含任何 Key**），启动时恢复 | CORE-10 | `AiGirlfriend.js:203-213,1207-1220` | 关掉叙事 → 重启后仍是关；`state.json` 里 grep 不到 key |
| B9-3 | 前端暴露三个开关（走 `syncConfig`），并在 `/config/status` 只回运行时值（去掉 `triggerRegistry.enabled` 双真相） | CORE-10、HTTP-10 | `api.ts:100-128`、`SettingsAdvancedTab.tsx`、`AiGirlfriend.js:1277-1286` | UI 切换后 `/config/status.companion` 立即变化且重启保持 |
| B9-4 | 关闭时冻结并清空事件队列，状态里标注「已暂停」；重新开启不倒灌历史候选 | CORE-10 | `TriggerRegistry.js:41-50,383-406` | 关闭 2 h 再打开，队列长度 0 |

## B6 · 陪伴感路线图（依赖 B0~B2、B4、B9）

按 `docs/companion-upgrade/PRD.md` 的 9 维度与需求池，本审计逐条确认了**现有钩子**与**必须先改的形状**：

| 需求 | 现状钩子 | 必须先修的东西 | 最小落地形状 |
|---|---|---|---|
| **REQ-02 共情响应策略** | 策略表已存在但从未接入（PROMPT-01）；`getStyleGuide` 只看她自己的 PAD，没有任何入参接收用户情绪 | B4-1（接线）、CORE-14（用户情绪符号经常判反）、CORE-10（开关关不干净） | `getStyleGuide(herPAD, userEmotion)` + `buildSystemContext` 增一个「回应策略」段 + `_finalize` 里让她的 delta 受用户情绪调制（共振项） |
| **REQ-05 话题闭环/未来事件** | `promise` 叙事类型与 `promiseFollowupTrigger` 都在，但 `followupCount` 恒 0 → 追问**一生只发一次**（CORE-19）；`sourceEpisodeId` 从不写入 → 无法回溯「上次聊的事」；**没有任何话题级未来时间抽取**（只有 TaskManager 处理显式待办，且 prompt 明令禁止输出"明天"这类相对词） | B2-10（计数器接线）、B0-4（ghost 丢消息）、B1-1/B1-6（成本） | 叙事 schema 加 `dueAt/followupCount/sourceEpisodeId` 写路径 + 投递成功回调自增（照抄 `TaskManager.reminderState` 范式） |
| **REQ-06 关系跃迁仪式感** | `updateBaselineForAffinity` 已经算出 `tierChanged` 并返回，**返回值在 `AiGirlfriend.js:445` 被丢弃**；`nextStage/pointsToNextStage` 只发给前端 | B2-9（账本）、无 | `TRIGGER_EVENTS` 加 `STAGE_ADVANCED` → `_finalize` 里比较前后 stage 发布 → 复用 REQ-04 事件层；`relationshipStages` 每条加机器可读的「解锁项」字段（专属称呼/话题深度） |
| **REQ-07 自适应节奏** | `STAGE_ECONOMY`/`FREQUENCY` 全是静态表；`getAutoDailyLimit` 没有输入 | **响应率遥测完全不存在**：主动消息进 history 时没有任何标记（`recordProactiveMessage:941`），`consumeMessage` 也不记录客户端是否取走 → 无法计算「她主动发的那条你有没有回」 | `recordProactiveMessage` 打 `proactive:{reason,deliveredAt}`；投递/过期/被回复三类结局记账；再让频率档位随近 7 日响应率浮动 |
| **REQ-08 人格外显与边界** | `personalityPrompt` 只输出 7 个形容词档位，没有行为指令；`willfulness` 只改数字，无人消费 | B4-3/B4-5（prompt 形状）、**B2-5（S01 在 ghost 期间误判失联，会把维度算脏）** | `getPromptInjection` 输出「策略」而非「标签」；`buildSystemContext` 加一个随 `willfulness/trust` 变化的「可以反对/表达喜好」指令位；`LifeSimulator` 活动可作为观点素材 |
| **REQ-09 冷落反应分层** | 只有 `miss_you` + `inactiveDesc()` 三档文案；她的 PAD **不随离线时间变化**（`decay` 只往基线收），好感度有 `settleDecay` 而情绪没有对机制 | B0-4（ghost 丢消息）、B2-5、且 `notifyUserActive` 在**每次 HTTP chat 都调**（含失败轮）→ 闲置时钟被流量而非互动重置 | 给 `EmotionEngine` 加与 `AffinityEngine.settleDecay` 对称的惰性离线结算（按离开时长把 P/D 拉低）；`life_log.json` 只留 24 h，多日离开需要更长素材窗口 |
| REQ-10~13（P2） | 情绪时间线已有（`GET /state/user-emotion` 但前端无 UI）；叙事已有但无删除 UI；纪念日机制已有但 `occurredAt` 与 `recurring.anniversaryDate` 互不校验、`monthly` 会把 30 号钳成 28 号（CORE-21 附） | B7（前端补视图）、B2（日期修正） | 先修日期正确性，再谈可视化与虚拟约会 |

**结论**：陪伴感下一轮的地基不是「再加子系统」，而是 **B0（不丢数据）+ B2（模型给的数不骗人）+ B9（关得掉）+ B4（prompt 说得上话）**。REQ-02 是这批做完后性价比最高的一件，因为它 90% 已经写好，只是没接线。

## 剩余清单（2026-10-05 核对代码后的实况，共约 41 项）

| 批次 | 剩余 | 重点项 |
|---|---|---|
| B0 | 0.5 | B0-6 后半：`MemoryStore`/`NarrativeStore`/`UserEmotionEngine` 的去抖 flush 仍不回传写盘结果 |
| B1 | 3.5 | B1-2 调用计数可见、B1-4 嵌入熔断、B1-5 query 嵌入 memoize、B1-6 后台队列合并（不丢信息） |
| B2 | 0.5 | B2-10 尾巴：`EmotionEngine.history` 无消费者（留给 REQ-10）、narrative 的 `tags/jokeTrigger/sourceEpisodeId` 无写路径（REQ-05 前置） |
| B3 | 9 | `POST /config` 零校验、baseUrl 可指向任意主机、GET 会改状态、上游错误当回复、上传/413、自由文本无上限、一致性小修打包、日志隐私与队列无界 |
| B5 | 11 | CI 补后端 eslint/`next build`/boot smoke、`/health` + logger、`.env.example`、路由层测试、全量档案导出导入、依赖升级与 `.gitattributes`、`start_services.py` 去硬编码 |
| B7 | 17 | 主动消息 FIFO 与串气泡、后端离线态与重试、乐观更新回滚、401 可操作提示 + token 输入框、向导提前置完成、a11y 基线、触屏 hover-only、类型收口、移动端视口与 safe-area、IME 回车误发 |
| B8 | 6 | `memory.json` 15 MB 反复重写、总 prompt 预算裁剪（回忆/事实单条上限已随 B4 做掉）、tasks/dedupeSeen/正文长度无界、每轮 9-13 次同步写盘、system 消息位置 |
| B9 | 4 | 三个开关关不干净（emit/ingest/milestone 仍跑）、开关不持久化、前端无 UI、关闭后队列倒灌 |
| B6 | α/β | α（REQ-02 共情 + 跃迁仪式感 + 主动消息情绪回灌）依赖 B2/B4/B9；β（REQ-05/07/09）需 PRD §5 的 Q1~Q3 拍板 |

**已完成**：B0（除 B0-6 后半）、B2（除 2 个尾巴）、**B9 全部**、**B4 全部（除 B4-8 后半）**、B1-3、B3-1、B3-10、B5 的 6 项前置。
**已取消**：B1-1（事实提取节流 / 省钱模式）—— 成本不作为削减理由。

## 会话日志（便于下次接续）

| 日期 | 内容 | commit |
|---|---|---|
| 2026-10-03 | 全面审计（5 路专项 + 进程内探针实测）→ 本文件与 `01-analysis.md` 产出 | `4485512` |
| 2026-10-04 | **B0**（数据/并发/重置/鉴权/流式）+ **B2**（解析边界/情绪/检索 BM25/账本/叙事接线）+ B1-3 + B5 前置（`run-tests.mjs` 聚合器与沙盒数据目录） | `80e8729` |
| 2026-10-05 | **B9**（三个子系统真关得掉 + 开关持久化 + 设置页开关） | `98eb821` |
| 2026-10-05 | **B4**（prompt 层九项：策略接线、好感度单一真源、表达优先级、metadata 统一、中文化、引述围栏、体积压缩、主动消息链去重、身份外观对齐） | `966820e` |

**下次开工的断点**：B6-α（依赖已全部满足）——
① REQ-02 情绪共振：`_finalize` 里让她的 PAD 增量受 `userEmotionEngine` 结果调制（现在只是"读到了但不影响她自己"）；
② 跃迁仪式感：`updateBaselineForAffinity` 返回的 `tierChanged` 目前在 `AiGirlfriend.js:445` 被丢弃，接上 `TRIGGER_EVENTS` 新事件即可复用事件层；
③ 主动消息情绪回灌：`recordProactiveMessage` 之后调 `applyDelta`（`docs/proactive-consistency/DIAGNOSIS.md:161-163` 三条遗留里的两条）；
④ `_recentStoryIds` 与 `getRandomStory` 的防复读账已在 B4/B2 接好，可顺带验证。

**开工前必做的健康检查**：`cd backend-node && npm run check && npm test`（16 套）与
`cd frontend && npx tsc --noEmit && npx eslint src && npx vitest run`（85 例）。
测试全程写沙盒目录，不会碰 `backend-node/data/`。

## 执行顺序与里程碑（按「拟人化优先」重排）

```
B0 ✅ 已完成 → M1 数据不再会悄悄丢/复活，串行保证与重置语义可信
   ↓
B2（1.5 天）→ M2 模型给的数字不再能骗过引擎：好感度不会因引号冻结、
              情绪不会一句话被拉爆、冷暴力不再被误判成失联、用户情绪不再判反
   ↓
B8（2 天）  → M3 一条长消息不再冻结整个进程（卡顿=最直接的"她不在场"）
   ↓
B9（1 天）  → M4 三个子系统真的关得掉、关得住（为后续调参留出安全边界）
   ↓
B4（1.5 天）→ M5 prompt 说得上话：单一真源、中文、有优先级、身份不漂移
   ↓
B6-α（2 天）→ M6 ★拟人化第一波：REQ-02 共情策略接线 + CORE-19 残件全部接上
              （追问闭环 / 主动回顾共同经历 / 主动消息情绪回灌 / 跃迁仪式感）
   ↓
B1 / B5 / B3 / B7（并行推进）→ M7 健康度、护栏、契约、前端健壮性
   ↓
B6-β → REQ-05 话题闭环 / REQ-07 自适应节奏 / REQ-09 冷落分层（需 Q1~Q3 拍板）
```

> 与上一版的差别：B1-1 取消；B4 从「靠后」提到 B6 之前（prompt 是所有拟人化的表达能力上限）；
> B6 拆成 α/β 两段，α 只依赖 B2/B4/B9，可以立刻做。

**门禁要求（每批合并前必须全绿）**：`cd backend-node && npm run check && npm test`、`cd frontend && npx tsc --noEmit && npx eslint src && npx vitest run`，且 `data/` 目录在测试后 mtime 零变化（B0-3 新增的断言）。B5 完成后追加：后端 eslint、`next build`、boot smoke（`GET /health`）三项。

## 需要用户拍板的事项

| # | 问题 | 影响 | 默认动作（不回复即按此执行） |
|---|---|---|---|
| P1 | `POST /system_prompt` 人设编辑功能要不要留？（当前无 UI、会清历史、不落盘） | B0-1 是「修」还是「删」 | 删接口 + README 同步；将来做人设编辑器时再按正确语义重建 |
| P2 | 中断的半轮回复要不要入库？ | B0-2 策略 | 正文入库、跳过情绪与好感度结算 |
| P3 | 事实提取节流档位（每 N 轮 / 最小间隔 / 信号词） | B1-1 成本 vs 记忆完整度 | 每 3 轮且 ≥60 s，信号词命中当轮必调 |
| P4 | 「完全重置」是否清主动消息配额与生活日志 | B0-5/B0-7 范围 | 清计数、队列与日志，保留用户配置 |
| P5 | 好感度/情绪是否允许模型「一次说很多」？（当前单轮 LLM 可推动 P 达 0.27，且引号数字会让好感度永久冻结） | B2-4/B2-6 严格程度 | 一律裁剪到 prompt 声明的范围（±0.5 / −10~+3），并透出解析告警 |
| P6 | 用户情绪词表误判（「不开会…超开心」被判低落）修法：邻域窗口 vs 暂时只信 LLM | B2-7 | 改邻域窗口 + 语料回归集；词表权重降到 0.3 |
| P7 | 三个陪伴感开关：给 UI 还是只留 env？（README 目前写成用户可配） | B9-3 | 给设置页 UI，并让它们持久化 |
| P8 | 主动消息桌面通知是否只显示「小爱给你发来一条消息」（锁屏不露正文） | B7-17 | 默认只显示提示语，可在设置里放开正文 |
| P9 | 关键词检索修成真 BM25 后，`[相关回忆]` 会从「最近的」变成「相关的」，体感会明显变化 —— 要不要同时保留一点 recency 兜底 | B2-8/B8-1 | 相关性为主、recency 加分 ≤0.05，并留一个 env 开关便于回退 |
| P10 | PRD §5 的 Q1~Q5（真实的人 vs 理想化伴侣、负面情绪接受度、频率偏好、回忆尺度、终态） | 决定 B6 全部排期 | 不动 B6，只做 B0~B9 |
