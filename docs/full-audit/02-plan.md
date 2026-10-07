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

## 剩余清单（2026-10-07 复核；**总数以下面这张表为唯一口径**，别在别处抄一份数字）

（历史口径，2026-10-07 已全部做完）开工时表内还剩 **25.5 项**，分布在 5 个批次：B7 14、B8 6、B1 3.5、B5 1.5、B2 0.5。
（这里曾经写死过「共约 9 项 / 12 项」之类的总数，与表内加起来对不上 —— 手写第二份真相迟早漂移，
改成只指口径不写总数。）

| 批次 | 剩余 | 重点项 |
|---|---|---|
| B0 | 0 | （B0-6 后半已随 B5-12 做掉：四个去抖 flush 现在都回传写盘结果，失败保持脏标记等下次重试） |
| B1 | 0 | B1-2 调用计数可见、B1-4 嵌入熔断、B1-5 query 嵌入 memoize、B1-6 后台队列合并（不丢信息）—— 四项全部落地 |
| B2 | 0 | B2-10 两个尾巴都已接线：`EmotionEngine.history` 有了消费者（REQ-10 情绪走势），narrative 的 `tags/jokeTrigger/sourceEpisodeId` 有了写路径 |
| B3 | 0 | （已收完：baseUrl 分级在**输入时**就显示，`POST /config` 的 warnings 与保存失败的后端 `detail` 都进了界面。`error_code` 的全站消费留给 B7） |
| B5 | 0 | （依赖升级已于 2026-10-07 做完：multer 2.4 / openai 5.23 / express 5.2，逐个升、每步全绿。B5-3「全迁 node:test」有意收窄为 `scripts/lib/testKit.mjs`） |
| B7 | 0 | 17 项全部落地（①~⑰ 见下面的会话日志与落地要点） |
| B8 | 0 | 关键词索引、`memory.json` 向量瘦身、注入总预算、无界集合、每轮写盘次数、system 消息位置与历史裁剪、`maxPromptHistory` 诚实化、B8-8 四条小口径 |
| B9 | 0 | （已随 B9 批次全部完成） |
| B6 | β | α 已完成。**β 按 P10 的默认动作停在门口**：REQ-05/07/09 的优先级由 PRD §5 的 Q1~Q5 决定，用户没拍板就不动 B6（本文「需要用户拍板的事项」里 P10 写明的默认动作就是「不动 B6，只做 B0~B9」） |

**已完成**：B0 **全部**、B2（除 2 个尾巴）、**B9 全部**、**B4 全部（除 B4-8 后半）**、**B6-α 全部**、**B3 全部**、**B5 除依赖升级全部（含 B5-12 档案导出/导入/快照）**、B1-3、**B7-①（全站稳定错误码：后端发码 + 前端按码分支）**、**B7-②（输入法回车误发 + 图标按钮 aria-label）**。
**已取消**：B1-1（事实提取节流 / 省钱模式）—— 成本不作为削减理由。
**有意收窄**：B5-3「把 10 个脚本整体迁到 `node:test`」。现有脚本各自带着「备份/还原真实 `data/*.json`、动态 import 顺序、沙盒目录」的装配逻辑，全量搬迁的风险大于收益；真正要解决的问题（INFRA-01/02：测试必须能失败）已经由 `scripts/lib/testKit.mjs` 的 `expect` 机制达成，并配了反向验证。

## 会话日志（便于下次接续）

| 日期 | 内容 | commit |
|---|---|---|
| 2026-10-03 | 全面审计（5 路专项 + 进程内探针实测）→ 本文件与 `01-analysis.md` 产出 | `4485512` |
| 2026-10-04 | **B0**（数据/并发/重置/鉴权/流式）+ **B2**（解析边界/情绪/检索 BM25/账本/叙事接线）+ B1-3 + B5 前置（`run-tests.mjs` 聚合器与沙盒数据目录） | `80e8729` |
| 2026-10-05 | **B9**（三个子系统真关得掉 + 开关持久化 + 设置页开关） | `98eb821` |
| 2026-10-05 | **B4**（prompt 层九项：策略接线、好感度单一真源、表达优先级、metadata 统一、中文化、引述围栏、体积压缩、主动消息链去重、身份外观对齐） | `966820e` |
| 2026-10-05 | **B6-α**（REQ-02 情绪共振、REQ-06 跃迁仪式感、主动消息情绪回灌、防复读账；顺带修好「新增默认开启类型永远进不了老用户 enabledTypes」这个从 REQ-04 就存在的拦死点） | `56002f2` |
| 2026-10-06 | **B3**（接口契约与安全）：`POST /config` 全字段校验、baseUrl 分级、消费型 GET 改 POST、上游错误稳定码、上传/TTS 收紧、自由文本上限、一致性小修打包、日志隐私与队列上限。新增 `test-audit-b3.mjs` 95 项 → 后端 18 套全绿、前端 89 例全绿 | `728cacb` |
| 2026-10-07 | **B5**（工程基建，除档案导出与依赖升级）：`GET /health` + 零依赖 logger（时间戳/级别/堆栈）、启动脚本改探 `/health`、`npm run check` 补真导入冒烟、零依赖静态检查 `npm run lint`、`testKit` 让「用例没跑」也判失败、`.env.example`（86 个旋钮分 10 组）+ 文档一致性测试、CI 补 lint/build/boot smoke、`.gitattributes`、engines 对齐 20.9。后端 **20 套**全绿、前端 typecheck/lint/test/build 全绿 | `1a68590` |
| 2026-10-07 | **B5-12**（全量档案导出/导入/自动快照）+ **B0-6 后半**（四个去抖 flush 回传写盘结果）：`/backup/{status,export,import,snapshot,restore}`、11 个数据文件的唯一清单与逐个热加载、`POST /reset` 前自动快照、设置页「数据与备份」面板。新增 `test-audit-b5b.mjs` 65 项 → 后端 **21 套**全绿、前端 **94 例**全绿 | `7e8d5b3` `46a03bb` `960d2d8` |
| 2026-10-07 | **B3-3 前端半格（B3 就此收完）**：设置页在**输入时**就显示 baseUrl 分级（ok 不占版面 / warn 琥珀 / block 红），文案与后端 `normalizeBaseUrl()` 逐字同源；新增 `lib/baseUrlGrade.ts` + `baseUrlGrade.test.ts`（36 例，**直接 import 后端模块**逐样本比对分级、放行/拒绝与告警文案，不再用正则抄）；「后端当前生效：…」一行暴露表单值≠生效值（含后端重启后 Key 未回灌）；`POST /config` 的 `warnings` 存进表单并在保存后展示、弹窗不关；保存失败提示由「请检查后端连接」改成后端 `detail` 原文，后端离线才提网络。前端 **10 套 / 130 例**全绿、后端 21 套全绿 | `cde4201` |
| 2026-10-07 | **两份 QA 散件收编**（`_qa_w1_probe.mjs` / `_qa_w2_verify.mjs` 删除） / `_qa_w2_verify.mjs` 删除）：它们的断言是独立编写的、有价值，外壳有害（直接 import 真 container、直接读写 `data/user_emotion_state.json`、不带沙盒、不声明断言条数）。grep 核对后只把**其它套件都没覆盖**的行为搬进新套件 `test-audit-qa.mjs`（35 项：`fuse()` 对畸形 LLM 输出的容错、timeline 封顶与「去抖≠永不落盘」、EventBus 异常隔离与入参校验、叙事写入去重、词表极端输入、事件驱动类型规格），container 级的通电实证搬进 `test-boot-smoke.mjs`（+5 项 → 23）。顺带给 `run-tests.mjs` 加「清单 vs 磁盘对账」守卫（新写 `test-*.mjs` 忘了登记 → 退出码 2，已反向验证）。后端 **22 套**全绿 | `341a1b7` |
| 2026-10-07 | **B7-①（全站稳定错误码）**：后端新增 `utils/errorCodes.js`（本机业务码表）并让 `fail/failWith` 按状态码兜底，鉴权/错误处理/8 个路由的每个非 2xx 都带 `error_code`；前端新增 `apiError.ts`（`ApiError.status/code/errors/action`）+ `errorCodes.ts`（码镜像 + 码→行动），`request`/`streamChat` 全部改抛 ApiError，`MemoryDialog` 的 `message.includes("409")`、`VoiceButton` 的英文文案匹配、`SettingsDialog` 的正则猜网络错误、`useChatStream` 万能的「连接中断」全部改成按码分支。语音模块的两条英文 detail 中文化（文案唯一来源在后端）。新增 `test-audit-b7.mjs`（112 项，逐路由）+ 前端 `errorCodes.test.ts`/`apiError.test.ts`（26 例，跨端逐值比对后端两张表）。实测：后端重启后发消息，气泡从「⚠️ 连接中断...」变成「请先配置 API Key 才能和小爱聊天哦~」。后端 **23 套**、前端 **12 文件 / 156 例**全绿 | `bb255d8` |
| 2026-10-07 | **B7-②（回车误发）**：把「回车是否该发送」抽成纯函数 `lib/sendShortcut.ts`，判 `isComposing` + 老 WebKit 的 `keyCode === 229` 兜底；输入法组词中按回车是确认候选词，旧写法会把半截话直接发进历史（不可撤回、还会参与好感度与记忆）。顺带给纯图标按钮补 `aria-label`、给输入框补名字。新增 `sendShortcut.test.ts`（6 例）；**实测**：`isComposing:true` 的回车文字留在输入框没发出去，真回车才发。前端 **13 文件 / 162 例**全绿 | `666dad1` |
| 2026-10-07 | **B7-③（后端离线态）**：新增 `lib/backendWatcher.ts` 纯状态机（在线 60 s 巡检 / 离线 30 s 重试 / 请求撞上网络失败立刻判离线并取消旧定时器 / 恢复只在 offline→online 跳变回调一次 / 探活带 generation 防旧回包写回新状态）；`uiStore.backendState` 三态（unknown 不弹横幅，免得每次刷新闪一下假故障）；`api.healthPing` 探活不反过来通知 watcher，`request/streamChat` 的网络层失败通过显式注册的 observer 上报；新增常驻横幅 `BackendOfflineBanner`（含「立即重试」，role=status + aria-live）与 `useBackendWatcher`（恢复时重做 syncConfig + syncState + fetchHistory 并提示，不再需要刷新页面）。新增 `backendWatcher.test.ts` 18 例（假定时器 + 可控 ping，零 sleep）；实测：把页面 fetch 打成失败后发消息，横幅立刻出现、气泡给「连不上后端」而不是「连接中断」，恢复后点「立即重试」横幅消失并弹出「后端已重新连上，对话历史已恢复」，同一个页面实例全程没刷新。前端 **14 文件 / 180 例**全绿 | `5dd7e34` |
| 2026-10-07 | **B7-④~⑰ 第一批（一次吃掉 9 格）**：主动消息改严格 FIFO 队列 `lib/proactiveQueue.ts`（旧写法 `clearTimeout` 顶掉上一条，200 ms 内连到 3 条只有最后一条上屏）；流式写入按 `streamingMessageId` 点名 + 流式期间挂起主动消息（FE-03 串气泡）；乐观更新统一回滚（好感度 / 性格 baseline / 保存配置**按失败的那一步**分别回滚本地镜像）+ 防抖改动卸载前 flush（`lib/optimisticTracker.ts`）；`lib/dialogGuard.ts` + `Modal` 焦点陷阱/滚动锁/焦点归还，X / Esc / 遮罩三条关闭路径共用「有未保存改动」闸门；设置→系统新增**访问令牌输入框**（`api.setAuthToken/hasAuthToken`），轮询撞 401 只提示一次；破坏性操作分级（删事实给 6 秒撤销条、删回忆与切预设改二次确认——后端没有重建回忆的入口，给做不到的撤销更糟）；向导在 `syncConfig` 真的成功后才写 `hasCompletedSetup`、`ApiConfigStep` 的「不会上传到任何服务器」改成准确表述、导出先向服务器要完整历史（`lib/chatExport.ts`）；PAD 读数走 `lib/padState.ts` 归一（缺字段/NaN 回落中性，展示组件不再有白屏能力）；录音单实例 + 失败分型 + `transcribe` 返回结果对象 + 计时移出页面级 state + 她说完自动聚焦；通知锁屏默认不露正文、主动消息朗读可单独关（`lib/notifyPrivacy.ts`/`proactiveDisplay.ts`）；**B2-10 那条「写了没接线」的 `EmotionEngine.history` 正式接上**：新增 `GET /state/emotion-history` + 面板「情绪走势」（`lib/emotionSeries.ts`，点数不足就不下结论）。**实测**：本机 24 条真实历史直接出图并显示「最近更有劲，也更爱动」，a11y 名字在 snapshot 里齐了（打开角色面板 / 想对小爱说的话 / 开始录音 / 发送 / 切换小爱的情绪）。新增 8 个用例文件，vitest **22 文件 / 233 例**、typecheck / eslint / `next build` 全绿 | `d665513` |
| 2026-10-07 | **B7 a11y / 对比度 / 性能 / 移动端 / CSS 层序**：Modal 焦点陷阱 + 滚动锁 + 焦点归还、Dialog 标题 `useId` + `aria-labelledby`；`Field` 把 `htmlFor`/`aria-labelledby`/`aria-describedby` 注入第一个控件（radiogroup/slider 不是 labelable，光有 htmlFor 关联不上）；分段选择器与主题弹窗改 WAI-ARIA radio 语义（roving tabindex + 方向键），规则抽成纯函数 `lib/radioGroup.ts` + `hooks/useRadioGroup.ts`；hover-only 操作补 `focus-visible` / `coarse`（`@media (hover:none)`）变体；工具栏与开关命中区撑到 44×44（`min-h-11 min-w-11`，视觉尺寸不变）。对比度实测：`--text-muted` 亮色 2.82→4.56、暗色 4.50→5.08，`.gradient-text` 亮色 1.58→3.26（大字 ≥3:1）。`themes.css` 全量收进 `@layer theme` + `:root[data-*]` 提权，`utilities.css` 走「裸规则 + 双写类名」（原因写在文件头：非 layer 规则永远赢过 layer 内规则）——物理调换 import 顺序后 11 个 token × 8 种组合解析结果零差异。移动端 `viewport-fit=cover` + `.app-shell-height/.pb-safe/.pt-safe`，EmojiPicker 改 portal + 按触发元与视口边界动态锚定。打字指示器三个点：`delay-75` 是 **transition**-delay 工具类，对 `animate-bounce` 完全无效 → 改 `[animation-delay:*]`。性能：DialogLayer 不再订阅 messages、useAutoScroll 缓存 matchMedia、AudioVisualizer 渐变提到帧外 + 按 dpr 缩放、reduced-motion 下彻底停樱花 | `390e9f3` |
| 2026-10-07 | **B1-2 前端半格 + 一处我自己引入的 a11y 错误**：`lib/llmCallsDisplay.ts` 把后端 `llmCalls` 快照渲染成「第 N 轮 · 本轮 x 次（主对话 1 · 事实提取 1 …）｜近 60 分钟共 y 次」，通道清单与中文标签**全部跟后端下发的一致**（前端不抄第二份），后端没这一段时整行不显示而不是排一列 0；设置→系统 顶部加「模型调用计数（排障用）」。⚠️ 上一格我给侧边栏无条件挂了 `role=dialog`/`aria-modal`，桌面端那是常驻静态栏，读屏会以为屏幕被模态挡住 —— 在浏览器查 aria 树时发现，改成只在窄屏抽屉展开时才挂 | `4d7cef4` |
| 2026-10-07 | **B8 全部 6 项 + B1 剩余 3.5 项 + B2-10 两个尾巴**：新增 `memory/KeywordIndex.js`（分词与 df 增量、idf 提出文档循环、query 词数有界；叙事侧那份「每篇重切 query、还把 hits 再算一遍」的私有实现改共用同一套）、`memory/vectorCodec.js`（磁盘形状换成 base64(Float32LE)，读侧只留 `toVector()` 一个口径并同时吃旧数组；实测 500×1024 维 10.08 MB → 2.78 MB）、`utils/jsonStore.js` 加 `{compact}` 而**默认仍带缩进**（其余 10 个文件字节形状不变）、`prompts/promptBudget.js`（逐块额度 + 整条 system 上限 + 按 TRIM_ORDER 丢块，人设与阶段说明书永不进丢弃表；`clampBlock` 行级裁剪并补回围栏闭合标签）、`utils/microtaskSave.js`（情绪/好感度/性格装上与 MemoryStore 逐字同款的 scheduleSave/flushSave/saveNow 契约：写失败保持脏、无脏数据 flush 返回 true 不写盘）、`core/historyWindow.js`（成对裁剪与字符预算同一份实现，容忍孤立 assistant；动态 system 块移到人设之后、窗口之前）、TaskManager 容量闸门（未完成任务超出上限**转入 `tasks_archive.json` 而不是删除**，已完成只留最近 N 条；新数据文件登记进 `core/backup.js` 清单）、`TriggerRegistry._pruneDedupe` 从「全仓只有定义、零调用」变成开机 + 每次 _prune 都清、`utils/llmCalls.js`（8 通道计数，本轮 + 滚动窗口，缓冲有界，只记通道与时间戳不记文本；经 `getLlmCalls()` 一个出口进 `/config/status` 与 `/health`）、嵌入熔断（`available` 从「配了没」改成「配了且健康」，改配置立即复位）、嵌入 LRU memoize（同轮 query 只走一次网络 —— 这是首字延迟修复不是省钱）、后台事实提取**合并不丢弃**、里程碑发布挪到叙事抽取之后（`_afterNarrativeQueue`：旧写法排在抽取之前而注释写的正好相反，本轮刚抽出的纪念日按天去重挡 24 小时）、narrative 的 `tags/jokeTrigger/sourceEpisodeId` 三个字段补齐写路径（抽取 schema + normalizeAdd 放行 + store 落盘 + 用本轮情节 id 补 sourceEpisodeId）。新增 `scripts/test-audit-b8.mjs`（79 项，与时间无关：数 `_saveState` 调用次数 + 显式 await 微任务，不比耗时不 sleep） | `652e7a2` |
| 2026-10-07 | **B5-13 依赖升级（最后半格）**：`multer` 1→2.4、`openai` 4→5.23、`express` 4→5.2，**逐个升、每步跑全套**（不混在一个提交里，任一步红就单独回退那一步）。multer 的 diskStorage/fileFilter/limits 不变；openai v5 没踩到流式 chunk 形状与错误类型（流式两条路径由 `test-stream-filter` + `test-audit-b0-http` 真起服务打 SSE 覆盖，错误分类走 `classifyUpstreamError` 读 status/code 不认类名）；express 5 没用到 req.query 赋值、`/static` 走 express.static 而非裸 `*` 通配，所以路由通配符与错误处理签名两条常见坑都没触发。缓存预热在临时目录里做（本机出网只有几十 KB/s，先把 tarball 全下进 npm 缓存再离线装），项目 `node_modules` 与 `package.json` 只在正式那一步动。装完真实进程由 nodemon 自动重启，`GET /health` 回 `ok:true` —— 是活进程验的，不只是测试里起的 | `ee1ade0` |
| 2026-10-07 | **B4-8 后半（身份卡）**：新增 `core/prompts/identityCard.js` 作为「她是谁」的唯一真源（名字 / 自称 / 对用户的称呼 / 外观 / 三条不可谈判边界，全部 `Object.freeze`），人设段改为 `renderIdentityBlock()` 渲染，主动消息链的人设强化指令不再自带第二份定义（只说「以人设为准」）。审计 PROMPT-08 说的「身份漂移」在代码层的根因就是外观与名字散抄：改一处就出现两个版本的小爱。新增 `scripts/test-audit-b4b.mjs`（11 项，测**渲染出来的 prompt 文本**而不是源码字符串：整条人设里外观只出现 1 次、主动消息链不复述外观）。顺带修一处触屏缺陷：「查看内心独白」原来是 `tabIndex` 的 `<span>`，手机上点一下不会获得焦点 → popover 只有 hover 一条路；改成 `<button>` | `dd037e7` `a9b71cd` |

**B7-④~⑰ 落地要点（2026-10-07）**：

| 点 | 做法与原因 |
|---|---|
| 丢消息的结构性原因是**一个共享 timer 变量** | 旧写法 `proactiveTimer` 全局唯一，新消息进来先 `clearTimeout` 上一条 → 「后到的把先到的取消掉」是写在结构里的。改成 `lib/proactiveQueue.ts` 严格 FIFO：**入队永不取消已排队条目**，挂起只是延后出队；正在「思考中」的那条在挂起时退回队首（不是丢弃）。溢出丢的必须是**还没出场的候选**，并回调上报 |
| 「改最后一条」在并发写入下必错 | 流式增量、收尾、ghosting 全部按 `streamingMessageId` **点名**（FE-03）。点名不到时：增量**丢弃**，收尾允许退回到「最后一条 assistant」—— 少一段渲染能看见，把话写进别人气泡看不见 |
| 回滚要按**失败的那一步**回滚 | 设置页保存 = `POST /config` + `POST /config/proactive` 两步。全量回滚本地镜像会把已经成功的 API Key 也抹掉，后果是「下次开机不再回灌 Key」——比原本的 bug 更难查。所以按 `configPushed` 分步回滚 |
| 关闭路径永远不止一条 | X 按钮、Esc、点遮罩。闸门做成独立模块（`lib/dialogGuard.ts`）由 Modal 与调用方**共用一个判定**，而不是逐条传 props —— 传 props 一定会漏掉其中一条（本次实测：只守 X 按钮时 Esc 照样丢改动） |
| 撤销只能给**真能撤销**的操作 | 删事实 → 6 秒撤销条（内容+重要度重新入库）；删回忆 → 二次确认（后端没有「写回一条回忆」的入口，给一个做不到的撤销比不给更糟：按了没反应会让用户怀疑整个界面） |
| 「写了没接线」的残件按老规矩接上 | `EmotionEngine.history` 每次结算都落盘却从没被消费过 → 新增 `GET /state/emotion-history` + 面板「情绪走势」（`lib/emotionSeries.ts` 归一 + 早/近窗趋势）。同时定下规矩：**点数不足就不下结论**，趋势句的阈值写在一处 |
| Tailwind 的 `delay-*` 是 **transition**-delay | `TypingIndicator` 三个点写的 `delay-75 / delay-150` 对 `animate-bounce` 这种 keyframes 动画完全无效，所以永远同步跳。要 `[animation-delay:150ms]` |
| `@layer` 有两条路，不能混用 | 主题**变量**可以整份收进 `@layer theme`（不与原子类争同一属性）；**装饰类**（`.gradient-text` / `.pb-safe`）收进 layer 就会被任意一个 Tailwind 原子类翻转，只能「裸规则 + 双写类名」提权。另外独立 CSS 文件里不能用 `@layer base/components/utilities` —— 那是 Tailwind 的指令名，v3 会直接报错。层序由「文档里第一次出现的 `@layer` 语句」决定，所以两份声明内容必须一致 |
| 触屏命中区用 `min-h/min-w` 撑，不用 padding | `min-h-11 min-w-11`（44×44，WCAG 2.5.5）能扩准度而**不改变视觉尺寸与间距**；加 padding 会把那一排按钮的间距一起顶开 |
| `viewport-fit="cover"` 是 safe-area 生效的前提 | 不 cover 时 `env(safe-area-inset-bottom)` 恒为 0，Home 指示条照样压住输入框 —— 只加 `pb-safe` 不写 cover 是「修了等于没修」的经典一对 |
| 每秒都变的展示值不能放页面级 state | 录音秒数从 `useVoiceRecorder`（挂在 ChatPage）挪到 `RecordButton` 内部自绘，页面只拿 `startedAt`。原来她每录一秒，整棵聊天树含全部历史气泡重渲染一次（FE-12） |
| 权限弹窗的 await 窗口是并发入口 | `getUserMedia` 还没回来时 `isRecording` 仍是 `false`，再点一次就开出**第二路麦克风**、两个 `MediaRecorder` 互相覆盖。闸门要在 await **之前**置位（`startingRef`），不能靠 state |
| B7-12 里 `types/index.ts` 的「可选性统一」**没有做类型大改**，如实记在这里 | 这一格的两条真实危害（老 payload 缺字段 → 白屏；脏 localStorage 值 → 一路带到后端）已经分别由 `lib/padState.ts` 归一与 `lib/storage.ts` 读取即归一消灭。剩下的「`AppState` 与 `ChatResponse` 字段可选性不一致」是两个接口**本来就不同的契约**（`/state` 一定给全、`/chat` 的 SSE 帧靠映射补默认值），把它们并成一个只会把必填项写成可选、然后在每个消费点多写一次判空。这一格按「危害已消除 + 口径写在文档」结案，不为了看起来整齐做类型搅动 |

**B8 / B1 落地要点（2026-10-07）**：

| 点 | 做法 |
|---|---|
| 理由只写「卡」不写「贵」 | B8/B1 每一条的注释都写成「一条消息冻结整个进程 / 首字变慢 / 磁盘形状失控」，**不出现省钱口径**。用户明确定过目标函数：最大程度拟人化，成本不作为削减功能的理由（B1-1 因此被取消而不是被实现） |
| 合并写盘不能改语义 | 微任务去抖（`utils/microtaskSave.js`）而不是定时器去抖：引擎的落盘目标是「本轮结束即一致」，跨请求合并会让 `resetAll` / 档案导出读到中间态。契约逐字照抄 `MemoryStore`：写失败**保持脏标记**、无脏数据时 `flush()` 返回 true 且不产生写盘（B0-6 的可观测性不能在新抽象里丢掉） |
| 向量压缩要双向兼容 | 读侧只留一个 `toVector()`，同时吃 `number[]` / `Float32Array` / base64 / 脏值→null。老用户磁盘上的 `memory.json` 不改写也能检索，写回时才顺带压缩。**新增读取点禁止再写 `Array.isArray(e.embedding)`** —— 那 8 处各自为政的判定向导火索就在这条上 |
| 默认写盘形状不许顺手改 | `writeJson` 新增 `{compact}`，但**默认仍是 `null,2` 缩进**：其余 10 个文件不动字节形状，改动面才可控（`test-audit-b8` 里直接断言默认写出来还带缩进） |
| 「上限」必须同时决定「超了怎么办」 | `TASKS_MAX_ACTIVE` 这种旋钮单独存在就是自欺。未完成任务超出上限时**转入归档文件**（她的承诺不能因为一个数字就消失），已完成才真的清掉。新增数据文件必须登记进 `core/backup.js` 清单 —— b5b 的目录对账测试会替我们守着 |
| 「写了没接线」的第四种形态 | `_pruneDedupe` 定义了、注释也写了、全仓零调用 —— 这类死代码不会报错，只会在长跑后把文件撑大。凡是「看起来有但没人调」的清理/计数器/字段，落地时都要在同一批里加**调用点 + 断言** |
| 与时间无关的断言怎么写 | 数 `_saveState` 被调次数并显式 `await Promise.resolve()` 等微任务排空；验「有界」直接量长度/字节；验索引不改变结果就比对两次同样的库输出。绝不 sleep、绝不比耗时（本项目的 CI 是 2 核 runner，睡出来的断言必然假失败） |
| 依赖升级的做法 | 逐个升、每步跑全套，各自一个提交（任一步红就回退那一步，不混）。慢网络下先在**临时目录**里把 tarball 全下进 npm 缓存，再在项目里离线安装 —— 中间态不污染项目的 `node_modules`。最后用真实进程 `GET /health` 复核，而不是只信测试里起的实例 |

**B7-① 落地要点（2026-10-07）**：

| 点 | 做法 |
|---|---|
| 码分两张表，别混 | `upstreamError.js` 管**上游模型服务**（鉴权/限流/超时/上下文超长），新增的 `errorCodes.js` 管**本机业务**（配置非法、资源不存在、凭证、语音未配、备份）。`internal_error` 两边都要用，做法是本机表**别名引用**上游值，不允许各写一遍字符串 |
| 漏传也一定有码 | `failWith(res, status, detail, code?)` 缺 code 时用 `codeFor(status)` 兜底。「重要的错误带码、其余只给文案」是半吊子契约：只要有一个分支没码，前端就得留着一条文案匹配，而那条分支会在某次改文案时静默失效 |
| 附加字段不丢 | `failWith` 多接一个 `extra`（405 的 `allow`、`invalid_config` 的 `errors[]`、导入的 `writeFailed` 报告），避免为了统一出口把老字段挤掉 |
| 前端不复制文案 | `ApiError.userMessage` 直接用后端 `detail`，前端只补「（设置 → 通用）」这种行动指引，且后端文案里已有「设置/配置/检查/稍后/重试」或以括号收尾时**不再追加**（否则一句话挂两个括号） |
| 「后端拒了」≠「后端没起来」 | `status === null` 才是网络故障。以前两处都在匹配错误文字（`/failed to fetch/`、`includes("api key")`），文案一改就把用户支去查网络，而问题是他刚填的地址 |
| 5xx 的码也是契约 | 500 统一 `internal_error`、503 按来源给 `service_not_ready` / `proactive_trigger_failed`；导入部分失败从「200 + 没人看得懂的 report」改成 500 + `backup_partial`（写了一半必须算失败） |
| 跨端怎么钉 | 前端测试直接 `await import()` 后端两张表做**集合相等**比对（新增码没登记、删了码前端还留着，都会红）；后端 `test-audit-b7.mjs` 逐路由打接口断言「非 2xx 必有码 + 码在表里」，含鉴权三个分支与 stub 出来的 `duplicate_fact`、503、500 |
| 顺带发现（下一格处理） | `ChatInput` 的 Enter 没判 `isComposing` —— 中文输入法选词途中按回车是「确认候选词」，旧写法却把它当发送，半截话直接进了历史（已修）。⚠️ 我当时另记了一条「发送按钮没有可访问名」是**我的自动化选择器没读 `title` 造成的误判**：按钮一直有 `title="发送"`，可访问名本来就存在；本轮仍补了 `aria-label`，但理由是「纯图标按钮不该只靠 title 一条腿」，不是「之前没名字」 |

**B3-3 前端落地要点（2026-10-07）**：

| 点 | 做法 |
|---|---|
| 分级不各写一套 | `frontend/src/lib/baseUrlGrade.ts` 是后端 `classifyBaseUrlHost()` 的**逐行镜像**，只负责「显示」；拒绝与否仍由后端裁决。`baseUrlGrade.test.ts` 直接 `await import()` 后端模块，拿 20 个主机名样本 + 10 个地址样本比对**分级、放行/拒绝结论、告警文案**三件事。跨端一致性测试从「正则解析后端源码」升级成「真的执行后端代码」：后端改写风格时正则守卫会静默失配，执行不会 |
| 为什么空串不参与比对 | 后端 `validateConfigBody` 对 `base_url: ''` 是短路处理（空串 = 清除/回退服务商预设），根本走不到 `normalizeBaseUrl`；测试里明确把这条差异写进注释，否则下一个人会以为是漏了用例 |
| 显示位置 | 输入框**下方一行**：warn 琥珀 + 后端原话，block 红 +「保存会被后端拒绝」，ok 什么都不占。边框跟着变色，扫一眼就知道地址有问题，不用读完句子 |
| 表单值≠生效值 | 新增「后端当前生效：…」一行（读 `GET /config/status`，只有非敏感字段）。后端重启后 Key 没回灌时（`isConfigured:false`）额外提示「点一次保存即可恢复对话」—— 这是本项目最容易自欺的一处：界面显示着上次保存的地址，聊天却一路报错 |
| warnings 不能被「已保存」盖掉 | `syncConfig` 返回类型补 `warnings/base_url`；保存成功但有提醒时**弹窗不关**、警告常驻表单（toast 3 秒就没了，而「未知字段被忽略」正是配置没生效的信号）。每次保存先清空上次的警告，避免挂账 |
| 失败原因说人话 | `saveFailureMessage()` 区分「后端 4xx 的 detail 原文」与「fetch 网络失败」：以前一律弹「请检查后端连接」，用户会去查网络，而真正的问题是他刚填的那个地址 |

**B5-12 落地要点（2026-10-07）**：

| 点 | 做法 |
|---|---|
| 唯一清单 | `core/backup.js` 的 `ARCHIVE_FILES`：11 个数据文件各自写明 `owner` / `reload()` / 中文 `label`。`test-audit-b5b` 会拿 `data/` 目录与这张表**对账**，新增数据文件不登记就红 —— 这正是 `jsonStore.LEGACY_FILES` 当年漏掉 5 个文件的同一类事故 |
| 导出 | 先 flush 全部去抖（memory/narrative/userEmotion/trigger + 五个同步引擎），再读盘；`app` 段只记上游**主机名**；导出前自检含密钥就**拒绝出档案**（`scanForSecrets`）；响应是 `Content-Disposition: attachment` |
| 导入 | `validateArchive` 纯函数先拒掉：不是本格式 / 版本不对 / 没有 files / 某项内容不是对象（否则等于「清空这份数据」）；校验和只作告警不作拒绝（对象重新序列化本就会差空白）。通过后 **先快照 → 写盘 → 逐个 reload**，报告如实列出 `written/writeFailed/reloaded/reloadFailed/restartRecommended` |
| 不重启就生效 | 每个 owner 加 `reload()`，第一件事都是**取消去抖中的待写定时器**并清/保脏标记 —— 不取消的话内存里的旧状态会在两秒后把刚导入的文件盖回去（表现成「导入没生效」）。测试里真的等了 `flushDebounceMs + 800ms` 再回读磁盘确认没被覆盖 |
| 重置可回滚 | `resetAll()` 开头 flush + `createSnapshot('pre-reset')`，快照目录随响应 `snapshot` 字段回给界面；快照失败**不阻断重置**但会如实打日志（用户已明确要求清空） |
| 备份目录推导 | `config.backup.dir` 默认 `null`，由 `backupRoot()` 落在**数据目录里面的 `backups/` 子目录**（跟着 `AI_GIRLFRIEND_DATA_DIR` 走，已随 `data/` 被 gitignore）。第一版用「数据目录的上一级/backups」推导，跑一次测试就在 `backend-node/backups/` 留下 4 份快照（内容是测试夹具，但位置出人意料且无人清理）—— 改成数据目录内部后，b5b 里加了「跑完不留仓库残留」的断言钉住 |
| B0-6 后半 | `MemoryStore/NarrativeStore/UserEmotionEngine/TriggerRegistry` 的 `flush()` 一律回传布尔，**失败时保持脏标记**（旧写法什么都不回，「磁盘满了」在整条去抖链路上完全不可观测） |

**测试自己踩到的两个坑（值得记）**：
1. 种子数据必须在 `import` 容器**之前**写好 —— 引擎在构造时就读盘，反过来会让内存全是默认值，
   测出来的「导入没生效」其实是测试自己的顺序错。
2. `createSnapshot` 内部的 `pruneSnapshots()` 会**把刚写的这份快照删掉**
   （按目录名取最新 N 份，遇到用未来时间戳批量建的测试样本，本次这份排最旧）。
   已加 `protect` 参数：本次新生成的那份永不参与清理。这是测试抓出来的真 bug，不是测试的错。

**B5 落地要点（2026-10-07）**：

| 项 | 做法 | 关键文件 |
|---|---|---|
| B5-10 | `GET /health`（免鉴权，`ok/version/node/uptimeSeconds/llmConfigured/model/baseUrlHost/dataDirWritable/companion/chatQueueDepth/proactiveQueueSize`；只回主机名不回完整地址，绝不含 Key）；`utils/logger.js` 在服务进程给 console 包一层时间戳+级别（业务代码两百多处 `console.log` 一个字没动），`errorHandler` 的 500 现在带堆栈但堆栈只进日志；`start_services.py` 由「探 TCP 端口」改成「探 `/health` 看 `ok`」并去掉硬编码路径 | `app.js`、`utils/logger.js`、`middleware/errorHandler.js`、`middleware/auth.js`、`scripts/start_services.py` |
| B5-9 | `npm run check` = 语法解析（src **+ scripts**）+ `smoke-import.mjs` 真导入一遍装配链并断言关键导出在位。反向验证过：故意写错一个 import 路径 → `npm run check` 变红 | `scripts/check-syntax.mjs`、`scripts/smoke-import.mjs` |
| B5-8 | 后端 `npm run lint`：**零依赖**静态检查 R1~R5（顶层遮蔽全局 / 重复 `export default` / 空 catch 无注释 / 调试残留 / 未使用 import）。不用 eslint 的理由写进文件头：装它要几十 MB 而本机出网几十 KB/s，且真正咬过我们的都是这五条可枚举的结构性错误。首次运行就抓出 7 处（含我自己今晚造的 `const URL = 'url'` 和 4 个未使用 import），全部修掉。CI 同时补 `next build`、boot smoke，并把前端改成调 `npm run typecheck/lint/test`（本地与 CI 等价） | `scripts/lint-style.mjs`、`.github/workflows/ci.yml`、两个 `package.json` |
| B5-1/2/5 | `scripts/lib/testKit.mjs`：`createHarness(name, {expect})` + `finish()` 返回退出码（**不在 finally 之前 exit**，否则备份还原被跳过会污染用户数据）。三个布尔式套件补上 40/45/42 条的 `expect`；反向验证：把 expect 改小 1 → 退出码 1。B5-5 的源码字符串断言早在 B2 就换成行为断言（只剩 TC-SRC-06「纯函数层零 I/O」这类架构守卫） | `scripts/lib/testKit.mjs`、`test-proactive-gating/trigger-registry/triggers.mjs` |
| B5-11 | `backend-node/.env.example`：86 个旋钮按 10 组带中文说明，含「一个都不填也能跑」、Key 两条来源与重启后果、HOST 对外必须配 token、日志隐私、baseUrl 安全边界。新增 `test-env-docs.mjs`（12 项）双向核对：代码读的变量必须有文档、文档里不能有代码不认的幽灵变量、README 不许再写「37 个旋钮」这种会过期的数字 | `.env.example`、`scripts/test-env-docs.mjs`、`README.md` |
| B5-13 | 加 `.gitattributes`（`* text=auto` + 二进制声明，**不强推 eol**，避免一次全库 renormalize 把真实改动埋进噪声）；两个 `package.json` 的 `engines` 从 `>=18` 提到 `>=20.9.0` 与 CI 对齐；README 补 Node 版本、`/health`、`start_services.py --status`、四条本地门禁 | `.gitattributes`、`package.json`、`README.md` |

**B5-13 依赖升级：留到快网络再做**（本机实测出网只有几十 KB/s，`npm audit` 也要连 registry）。有快网络时按顺序跑，每步都有本地门禁兜底：

```bash
cd backend-node
npm audit --audit-level=high
npm install multer@^2               # 1.x 是历史 CVE 线；diskStorage/fileFilter API 基本兼容，limits 字段不变
npm install openai@^5 && npm test   # 主要风险：流式 chunk 形状与错误类型；跑全套 npm test + 手动发一条消息
npm install express@^5 && npm test  # 变化最大：req.body 解析、路由通配符、res.status().json() 不变但错误处理签名要求四参数
git add -A && git commit            # 任一步 npm test 红就回退这一步，别混在一个提交里
```

**B5 唯一成体系没做的是 B5-12（全量档案导出/导入）**，下次接着做时注意两点已有的坑：
`POST /reset` 已有「部分失败回 200 + status:'partial'」的约定（HTTP-08），导入前自动快照要复用同一套
`writeJson` 原子写；`AI_GIRLFRIEND_DATA_DIR` 已经让导入路径可以先在沙盒里验证再落到真实目录。

**B3 落地要点（2026-10-06）**：

| 项 | 做法 | 关键文件 |
|---|---|---|
| B3-2 | `configValidation.js` 字段表驱动：类型严格（布尔不接受 `'false'` 字符串、数字不接受 NaN）、长度上限、枚举档位与 `config.REASONING_EFFORTS` 同源；未知字段（camelCase 误发）从静默忽略改成响应里点名 | `utils/configValidation.js`、`routes/configRoutes.js` |
| B3-3 | baseUrl **分级**而不是黑名单一刀切：云元数据/链路本地/0.0.0.0/CGNAT 一律拒（169.254.169.254、100.100.100.200、metadata.*），本机与局域网**合法但回 warning**（本地 Ollama 是这个应用的正常用法），两个显式开关 `AI_GIRLFRIEND_BASE_URL_ALLOWLIST` / `AI_GIRLFRIEND_ALLOW_PRIVATE_BASE_URLS`；`/config/status` 回显归一化后的 baseUrl 供前端高亮 | `utils/configValidation.js` |
| B3-4 | `GET /chat/proactive` 改成 405（旧客户端明确失败而不是静默变成只读）+ 新 `POST /chat/proactive/consume` + 只读 `GET /chat/proactive/peek`；`GET /life/current` 去掉懒生成，改成纯读（没活动如实回「在想事情」） | `routes/chat.js`、`routes/life.js`、`core/LifeSimulator.js`、`frontend/src/lib/api.ts` |
| B3-5 | `classifyUpstreamError` → 9 个稳定码 + 中文文案，细节只进日志；`/chat`、`/chat/stream`、队列兜底、未配 Key 四条路径统一走 `_fallbackResult`，响应带 `error_code` | `utils/upstreamError.js`、`core/AiGirlfriend.js`、`routes/chat.js` |
| B3-6 | 扩展名白名单 + `fileFilter`（落盘前就拒）、413/415/多部件正确状态码、`text` 必须是非空字符串且有长度上限、开机清扫 `upload-*` | `routes/audio.js`、`core/Voice.js`、`config.js` |
| B3-7 | `config.textLimits`（任务标题 200 / 描述 2000 / 事实 500 / 分类 40 / 昵称 50）：HTTP 入口超限回 400，引擎入口（AI 建单、LLM 提取）无条件截断，注入端再兜一层（护住修复前就存在的脏数据） | `config.js`、`TaskManager.js`、`memory/MemoryStore.js`、`Memory.js`、`prompts/taskPrompt.js` |
| B3-8 | 读 meta 时也 roll 日界（过零点不再显示昨天的「额度已满」）；`context_count` 与 `historyCount` 同口径；`/chat` 与流式 `done` 合成同一个 `chatResponsePayload`；兜底路径的 emotion 改用真实标签（`"default"` 会从哨兵值漏到前端）；`PORT`/两个 timeout/`thinkingMaxChars` 改走 `envNumber`；`lifeSimulatorOr404` → `lifeSimulatorOrNull`；`fail()` 支持 `error_code` | 多文件 |
| B3-9 | 独白/CoT/主动消息正文默认只打**长度**，原文需 `AI_GIRLFRIEND_DEBUG=true`（且仍截断）；对话队列深度上限 `config.logging.maxChatQueue`（默认 4），超出直接 429 + `service_busy` | `utils/log.js`、`core/AiGirlfriend.js`、`routes/chat.js` |

**B3 踩到并修掉的一个隐蔽 bug（值得记住）**：`configValidation.js` 里为了字段表写了 `const URL = 'url'`，
把全局 `URL` 构造器遮蔽掉，于是同文件的 `new URL(...)` 抛 "URL is not a constructor"，
表现却是**每一个合法 baseUrl 都被判成「地址不合规」**。改名为 `URL_KIND` 并在表旁边写了注释。

**B6-α 落地的四件事（2026-10-05）**：

| 项 | 做法 | 关键文件 | 开关（关闭态安全） |
|---|---|---|---|
| ① 情绪共振 | 本轮用户情绪融合值 → 她的 PAD 第三通道（**叠加**在两路混合结果之上，不是再平均一次），阶段系数调制（陌生 0 / 恋人 1），叠加后统一裁剪到单轮每轴总上限 | `core/emotionResonance.js`（纯函数）、`AiGirlfriend._finalize`、`config.emotion.resonance/totalAxisCap` | `EMOTION_RESONANCE_ENABLED=false` → `applyDelta` 收到的值与改造前逐轴一致（回归测试钉死） |
| ② 跃迁仪式感 | `_finalize` 结算点上比较前后阶段 → 发布 `stage_advanced` 事件 → `stageTransitionTrigger`（只放行向上）→ 新主动消息类型 `stage_transition`；「解锁项」措辞收敛到 `RELATIONSHIP_STAGES.unlocks`，每轮说明书与跃迁消息同源 | `triggerEvents.js`、`core/triggers/stageTransitionTrigger.js`、`proactiveTypes.js`、`relationshipStages.js`、`prompts/{relationshipContext,proactivePrompts}.js` | 事件层总开关 `TRIGGER_REGISTRY_ENABLED=false`（关掉后照旧结算、只是不发事件）；类型可在设置页单独关 |
| ③ 主动消息情绪回灌 | 两个结局点：`consumeMessage()`=被接住（按类型表 `emotionFeedback`）、`_pruneQueue()` 过期=落了空（只有 `spontaneous` 类失落）。失落会自然抬高情绪闸门，减少下一次主动 | `AiGirlfriend.recordProactiveOutcome`、`ProactiveEngine.{consumeMessage,_pruneQueue}`、`proactiveTypes.js` | `PROACTIVE_EMOTION_ENABLED=false` → 两条路径零副作用 |
| ④ 防复读账 | 删掉内存 `_recentStoryIds`（重启即失忆 + 与库里数字两个真相），改由已落盘的 `lastRecalledAt` + `recallCooldownMs` 派生；`getRandomStory` 真正接收排除集合（旧写法靠随机重掷 4 次碰运气，兜底分支连账都不记） | `narrative/NarrativeRetriever.js`、`AiGirlfriend.{_pickStoryForSharing,_recentlyRecalledStoryIds}` | `NARRATIVE_ENABLED=false` 照旧退回情节记忆路径 |

**顺带修的两个历史坑**（都在 REQ-04 就埋下，本次接线才暴露）：
1. `ProactiveEngine._applyConfig` 只会「过滤未知 id」，老用户磁盘上的 8 类永远只有 8 类 →
   事件驱动的新类型（emotion_resonance / anniversary_recall / promise_followup）从来没能发出过一条，
   被 `canTrigger()` 静默拦死。现在存盘记录 `knownTypeIds`（这份配置是对着哪一版目录表达的），
   加载时只补「目录里新增且默认开启」的类型，用户显式关掉的绝不补回来。
   本机实测：`data/proactive_state.json` 的 8 类 → 12 类。
2. 前端 `SettingsDialog` 离线兜底清单也抄了旧的 8 类 —— 改为 `storage.ts` 里单一导出的
   `DEFAULT_ENABLED_PROACTIVE_TYPES`，并由跨端测试（读后端源码）钉住两份不再漂移。
3. `buildProactivePrompt('memory_share')` 的场景文案原本以「语气要」结尾（半句话，被截断）。

**测试**：新增 `backend-node/scripts/test-audit-b6.mjs` 94 项断言（纯函数网格 + `_finalize` 集成 +
事件层端到端 + 两个结局点 + 防复读账 + 类型迁移），`npm test` 17 套全绿；
前端新增 `proactiveDefaults.test.ts`（4 项）→ vitest 89 例、`tsc --noEmit` 与 `eslint src` 全清。

**B6-β 的下次开工断点**（需要 PRD §5 的 Q1~Q3 拍板才能定优先级）：
① REQ-07 自适应节奏 —— 本次已经埋好结局点（`recordProactiveOutcome` 是天然的记账入口），
   下一步给 `recordProactiveMessage` 打 `proactive:{reason,deliveredAt}` 标记并按近 7 日响应率浮动频率；
② 向下跃迁要不要让她点破（`stageTransitionTrigger.evaluate` 现在对 `direction==='down'` 一律返回 null，
   事实已经发成事件，只差一个决定）；
③ REQ-05 话题闭环（`sourceEpisodeId` 写路径）/ REQ-09 冷落分层（`EmotionEngine` 的离线惰性结算）。

**B5-12 之后又抓到的一处自伤（2026-10-07）**：档案功能上线后第一次跑全量测试，
`backend-node/backups/` 里就多了 4 份 `pre-reset` 快照 —— 快照位置的推导规则
（「数据目录的上一级」）与测试的沙盒推导（系统临时目录）刚好错开，导致测试写到了仓库里。
改成「数据目录里面的 backups/ 子目录」并加断言；这类「新写的持久化路径没跟着 DATA_DIR 走」
的问题，凡是以后再加目录都要照这条检查一遍。

**只在 CI 上暴露的一类测试写法缺陷（2026-10-07，`7e8d5b3` 后端 Run tests 失败，本地全绿）**：
两条新写的断言把结果绑在了**调度时序**上 —— ①「并发打 7 轮慢请求，期望至少出现一个 429」：
本机 4 核能重叠，CI 的 2 核 runner 上请求可能一枚接一枚串行完成，入队时深度早已掉回 0；
②「scheduleSave 之后睡 1.2 秒，再读盘断言已落盘」：去抖定时器在负载下可以晚于任何合理等待。
两条都改成**与时间无关**的写法：①直接把 `_queueDepth` 推到上限来验闸门本身，并发那一轮只断言
「每轮要么 200 要么 429、绝不 500、结束后计数归零」；②测试自己调 `flush()` 拿返回布尔，再读盘。
教训：**凡是靠 sleep 撑起来的断言，都不能算回归测试** —— 它验证的是本机调度器，不是代码。
以后新写的异步断言一律走「显式 flush / 显式推状态」，不要靠等待。

**下次开工的断点**：B5、B3 均已收完（B5 只剩依赖升级，等有快网络）。接着做 **B7（16 项，前端）**，
第一格直接吃本批次的成果：
① 全站消费 `error_code`（`upstream_auth` → 「去设置页检查 Key」、`service_busy` → 「稍后再试」、
`not_configured` → 引导配 Key），别再匹配中文文案；设置页的 baseUrl 分级与 `POST /config` 的
warnings 已经落地（`lib/baseUrlGrade.ts` + `ApiConfigForm`），401 那格可以照同一套「稳定码 → 中文行动」来做。
之后 **B8（6 项，性能与容量）**；零碎尾巴：B2-10 两个尾巴、B4-8 后半；
B6-β（REQ-05/07/09）与 PRD §5 的 Q1~Q5 一起等拍板。
依赖升级（`multer`/`openai`/`express`）按上面的命令在有快网络时做。

**开工前必做的健康检查**：`cd backend-node && npm run check && npm run lint && npm test`（**23 套**）与
`cd frontend && npm run typecheck && npm run lint && npm run test`（**14 个文件 / 180 例**）；发版前再加 `npm run build`。
测试全程写沙盒目录，不会碰 `backend-node/data/`。
判断服务活没活：`curl http://127.0.0.1:8000/health` 看 `ok` 与 `llmConfigured`。

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
