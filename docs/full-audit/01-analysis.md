# 小爱 · 全面代码审计分析

- **文档类型**：缺陷与风险分析（不改代码，只给结论与证据）
- **日期**：2026-10-02
- **审计范围**：`backend-node/src`（21 837 行核心代码）、`frontend/src`、`docs/`、测试与 CI、依赖与仓库卫生、prompt 层
- **配套文档**：修改计划见 [`02-plan.md`](./02-plan.md)

## 0. 口径

| 严重度 | 定义 |
|---|---|
| **P0** | 会造成用户数据丢失/损坏、安全暴露、或核心链路在正常使用中直接失败 |
| **P1** | 行为与设计意图不符、明显成本/性能浪费、契约不一致、用户可感知的体验缺陷 |
| **P2** | 工程质量债：可维护性、测试缺口、命名与文档漂移、边角体验 |

编号规则：`分区-序号`，分区为 `HTTP`（路由与中间件）/ `CORE`（编排与引擎）/ `PROMPT` / `FE`（前端）/ `INFRA`（测试·CI·依赖·仓库）/ `ROAD`（陪伴感路线图阻塞项）。

## 1. 结论摘要

**审计方法**：5 路专项静态审计（HTTP 层 / 领域逻辑 / 前端 / 工程基建 / prompt 层）+ 进程内假 LLM 探针实测 + 真实起服务打接口 + 全量跑门禁。所有条目都带 `file:line`；标了「实测」的是本轮跑出数字或复现过的。

**规模**：条目 **79** 条 —— P0 **20**、P1 **33**、P2 **26**（其余为「已核查不是问题」清单，见各分区末尾）。

| 分区 | 条数 | 最严重的一条 |
|---|---|---|
| HTTP | 20 | 落盘失败一律当成功（200 但磁盘没变，Windows `EPERM` 常态触发） |
| CORE | 23 | 一次异常后对话串行保护永久失效；一条长消息可冻结整个进程 |
| PROMPT | 8 | 共情策略表是死代码（REQ-02 的地基没接线） |
| FE | 16 | 流式中途失败会重跑整轮：好感度加两次、性格漂两次、钱付两遍 |
| INFRA | 12 | 两条测试永远不会失败，CI 绿灯是假的 |

**Top 10（按「修复性价比 × 用户可感知」排序）**

1. `FE-04` 流式失败重跑整轮 —— 一次网络抖动就让关系分数翻倍涨、账单翻倍。
2. `CORE-11` 模型把数字加引号 → 好感度**永久冻结**且零告警。
3. `CORE-07` 关键词检索同步 O(n²·T) 且在请求路径上 —— 默认配置下一条长消息卡死整个服务。
4. `CORE-06` 队列在异常后失去互斥 —— 之后所有状态读写都在并发下裸奔。
5. `CORE-12` ghosting 被性格系统读成「用户失联」→ 每天扣安全感/亲密度，自我强化。
6. `CORE-01` 冷暴力期间的用户消息**根本不入库**（实测）：她真的会「忘记」你说过什么。
7. `PROMPT-01` + `CORE-14` 用户情绪通道：策略表没接线，词表还把「不开会…超开心」判成低落。
8. `CORE-10` 三个子系统开关关不干净、不持久、前端还发不出去（README 承诺落空）。
9. `FE-01` 冷暴力时界面给她挂「开心」标签和笑脸（实测映射缺失）。
10. `HTTP-06/07/08` 落盘失败静默、重置被在途轮次撤销、部分重置前端读不懂 —— 三条叠起来就是「数据不可信」。

**一句话判断**：这个代码库的**分层纪律和单一真源意识是好的**（阶段阈值、词表、类型表、config 集中都执行到位），但它把复杂度全花在了「新增子系统」上，而**请求路径上的性能、并发与解析边界基本没有设防**；测试面恰好覆盖不到这些，所以缺陷全是静默的。因此本计划的顺序是：先修数据与并发正确性（B0）、再修模型可信度（B2）、再修性能（B8）与开关（B9），**然后补护栏（B5）**，最后才动契约、前端与 prompt。

## 2. HTTP 层（路由 / 中间件 / 配置）

### HTTP-01 · P0 · 改人设会静默清空对话历史且不落盘
- 位置：`backend-node/src/core/AiGirlfriend.js:1064-1067`（`updateSystemPrompt`）→ `backend-node/src/routes/state.js:51-56`（`POST /system_prompt`）
- 现象：该方法把 `this.history` 重建为**只剩一条 system**，既不调 `_saveState()`，也不通知前端。内存里 200 条对话当场消失；磁盘上的 `state.json` 要到下一次写入才被空历史覆盖。
- 影响：一次 `POST /system_prompt` 就等价于「清掉整段对话」，但接口语义里完全没有这个承诺。当前前端**没有任何调用点**（`grep system_prompt frontend/src` 为空），属于「无主的危险接口」。
- 修法：① 保留历史，把新的 system prompt 就地替换 `history[0]`；② 落盘 + 返回变更摘要；③ 若确认不需要人设编辑功能，则连同路由与 README 接口表一并删除（推荐先做 ③ 的决策，② 是保留时的最低要求）。
- 补充（HTTP 层专项核实）：① 人设**本身从不持久化** —— `state.json` 的 config 段只存 baseUrl/model/嵌入（`:203-213`），所以「改人设 + 不落盘」的组合意味着：**改完之后、下一次写盘之前重启，旧历史会带着默认人设复活**；② `fail(res, !system_prompt, …)` 放过 `0`/`{}`/`[]`/`"   "`，非字符串会直接进 `history[0].content`，之后每次 LLM 调用都 400；③ 无长度上限，1MB 人设会挂在每一条请求上。

### HTTP-02 · P1 · 客户端断开不会中止生成，token 与状态照旧消耗
- 位置：`backend-node/src/routes/chat.js:116-117`（只置 `closed=true` 停止转发）
- 现象：SSE 连接关闭后，`aiGirlfriend.chatStream()` 仍继续消费上游流、跑完 `_finalize()`（情绪/好感度/性格结算、写历史、事实提取、叙事调度）。
- 影响：用户刷新页面/关标签后，后端继续为该轮付费并写入状态；配合「前端只有 60s 超时、没有停止按钮」（`frontend/src/hooks/useChatStream.ts:61-62`），长回复场景下的浪费和「用户以为没发生」的状态错位都无法避免。
- 修法：`res.on('close')` 时向编排层传中止信号（`AbortController` 透传给 OpenAI SDK 的 `signal`），并明确「中断的半轮」是否入库（建议：保留已生成正文、跳过情绪/好感度结算，或整体回滚，二选一并在文档里写死）。

### HTTP-03 · P1 · 测试与真实数据目录不可隔离
- 位置：`backend-node/src/utils/jsonStore.js`（`dataPath()` 锚定 `BACKEND_ROOT`，无 env 覆盖）；证据：仓库现存残留文件 `backend-node/data/affinity_test_tmp.json`（由 `scripts/test-reset-all.mjs:44` 创建，`:54` 尽力删除但已失败一次）
- 现象：数据根目录无法通过环境变量指到临时目录，测试只能对真实 `data/` 做「备份/还原」式自愈约定。
- 影响：一次断言崩溃或进程被杀就会污染真实用户数据（已经发生过，残留仍在）；新人加测试的默认动作就是「写用户数据」。
- **本次审计现场复现**：在仓库根执行 `cd backend-node && npm test`（04:38Z）后，`data/user_emotion_state.json` 的 `state.updatedAt` 与 `timeline[0].ts` 从 `1790870038659` 被改写为 `1790915898350`（测试脚本重新摄入了一条「今天好难过」），`proactive_state.json` / `trigger_state.json` mtime 同步被刷新。也就是说：**跑一次测试 = 改一次用户档案**，且没有任何提示。
- 修法：`dataPath()` 支持 `AI_GIRLFRIEND_DATA_DIR`（缺省保持现路径，零行为变更），测试统一指向 `data-test/` 或系统临时目录，并在 `package.json` 里加 `pretest` 校验。

### HTTP-04 · P2 · 未匹配路由返回 HTML 而非 JSON，前端报错不可读
- 位置：`backend-node/src/app.js:44-56`（只有 `errorHandler`，没有 404 兜底）
- 实测：`curl http://127.0.0.1:8000/nonexistent` → `404` + `<!DOCTYPE html>...Cannot GET...`
- 影响：`api.ts` 的 `request<T>` 会对 HTML 做 `JSON.parse`，用户看到的是一条语法类报错而不是「接口不存在」；任何路径拼错的排障都会被误导。
- 修法：路由挂载后补 `app.use((req,res)=>res.status(404).json({detail:`Not found: ${req.method} ${req.path}`}))`。

### HTTP-05 · P2 · 后端重启后必须先用浏览器打开一次，否则 curl/脚本链路全废
- 实测：重启后端后 `GET /config/status` → `{"isConfigured":false,"currentModel":"grok-4.7","baseUrl":"https://cf.sheapi.cc/v1"}`，而 `data/state.json` 里模型配置是有的。
- 原因：API Key 只存浏览器 localStorage，靠 `frontend/src/hooks/useBootstrap.ts:41-51` 挂载时 `POST /config` 回灌；后端自身不持久化 Key（`AiGirlfriend._saveState` 的 config 段里没有 apiKey）。
- 影响：README 的启动章节没写这条，任何「先起后端再调试脚本」的流程都会撞上「请先配置 API Key」；本地自动化验证也因此无法脱离浏览器跑。
- 修法：文档明确写死该约束；并支持 `OPENAI_API_KEY`（或 `AI_GIRLFRIEND_API_KEY`）env 兜底 + 启动日志提示当前来源（不落盘 Key，避免把密钥写进 `data/`）。

### HTTP-06 · P0 · 落盘失败一律当成功：200 但磁盘没变
- 位置：`utils/jsonStore.js:89-101`（`writeJson` 失败返回 `false`），**没有任何 HTTP 调用点检查返回值**：`AiGirlfriend.js:973`（`DELETE /history`）、`:1232`（`POST /state`）、`:1037`（`POST /reset`，`failed` 只收集 throw，而 `_saveState` 从不 throw）、`:1218`（`POST /config`），以及 `Memory.clearMemory→flush`、`ProactiveEngine._saveState`、`TaskManager.saveTasks`
- 影响：Windows 上 `fs.renameSync(tmp, 已存在文件)` 因杀软/索引句柄抛 `EPERM` 是常态 → 用户收到 200，磁盘仍是旧文件，下次开机整段关系回滚。且写盘前没有 `fsync`，断电/崩溃时可能留下半截文件。
- 修法：`writeJson` 的布尔值向上传播并计入 `resetAll`/各接口的 `failed`；tmp 写入后 `fsyncSync` 再 rename；rename 失败时退化为「覆盖写 + 保留 tmp」。

### HTTP-07 · P0 · 「完全重置」不与在途对话串行，重置会被悄悄撤销
- 位置：`AiGirlfriend.resetAll()`（`:1002-1044`）不排空 `_chatQueue` / `_narrativeQueue` / `_extractQueue`
- 现象：若重置时有一条回复正在生成，随后 `_finalize` 仍会 `history.push(...)`（`:589-594`）并 `_saveState()`（`:397`）→ 刚清空的对话与记忆**在重置之后被写回去**，用户看到「重置成功但记录还在」。
- 与 B0-5 的关系：除队列外，`proactiveEngine`（队列/当日配额/`sentDays`/各类冷却/`recentSentTexts`）与 `LifeSimulator`（`life_log.json`）也都不在清理范围内 —— 重置后仍会投递**按旧关系生成**的滞留主动消息（最多 5 条），且当日配额已烧完导致主动关怀到零点前彻底沉默。
- 修法：`resetAll` 改 async，先 `await this._chatQueue`，用世代号让 `_finalize`/`_persistAfterReply` 在写前校验；补 `proactiveEngine.resetState()` 与 `lifeSimulator.resetLog()`。

### HTTP-08 · P0 · 部分重置（207）前端读不懂，用户被告知「失败」而数据其实已删
- 位置：`routes/state.js:41` 返回 207 + `{status:'partial', failed:[...]}`；`frontend/src/lib/api.ts:149-152` 对任何 `!res.ok` 直接 throw，**从不解析响应体**
- 影响：`resetAll` 的容错设计（如实透出失败面）在 UI 上完全失效：用户看到「重置失败」→ 要么再点一次（又清一遍），要么以为没清。
- 修法：改为 200 + `{status:'partial'}`，或让 `request()` 支持「按路由解析非 2xx JSON」；UI 明确列出「已清空：X；失败：Y（原因）」。

### HTTP-09 · P1 · CORS 漏掉 PATCH，改事实的接口在浏览器里必挂
- 位置：`app.js:24` methods 只有 `GET/POST/PUT/DELETE/OPTIONS`，但 `routes/state.js:91` 有 `PATCH /memories/facts/:id`，且 `frontend/src/lib/api.ts:193` 就在用 `method:"PATCH"`（**已核实**）
- 影响：浏览器预检失败，设置页「编辑事实记忆」保存必然报错（跨域），而 CI 不跑浏览器所以无人发现。
- 修法：methods 补 `'PATCH'`；补一条「路由方法集合 ⊆ CORS 允许集合」的启动期断言或单测。

### HTTP-10 · P1 · 三个陪伴感开关前端根本发不出去（README 承诺落空）
- **已核实**：`grep -rn "user_emotion_enabled|narrative_enabled|trigger_enabled" frontend/src` → **零命中**；`api.ts:100-128` 的 `toBackendConfigPayload` 不带这三个字段
- 影响：`README.md:153-154` 把这三个开关写成用户可配的 `POST /config` 契约，实际只有手敲 curl 能改；设置页里看到的「陪伴感」相关状态是只读回显。
- 修法：要么在设置页补三个开关（走 `syncConfig`），要么把 README 改成「仅环境变量/接口可调」。

### HTTP-11 · P1 · `POST /config` 零校验：能把 Key 清空失败、能把开关「设 false 变 true」
- 位置：`routes/configRoutes.js:15-53` → `AiGirlfriend.updateConfig:1093-1104` 只做真值判断；布尔字段 `:1141-1183` 一律 `!!`
- 现象：① 非字符串（`{}`/`123`/数组）会被直接写成 `this.apiKey/baseUrl`，`initOpenAI` 把异常吞成 `console.error`（`:229-231`）→ 接口仍回 `{"status":"updated"}`，之后 `/chat` 走 `_preChatGuard` 返回「请先配置 API Key」**但 HTTP 200**；② 客户端传 `"false"`（字符串）或 `0` 会被 `!!` 变成 `true`，静默打开子系统；③ `if (cfg.apiKey && …)` 让空串永远无法清空主 Key，而嵌入/TTS 字段支持清空 —— 契约不对称。
- 修法：路由层做类型校验（字符串非空或 `''`=清空；布尔必须 `typeof==='boolean'`），URL 校验 `^https?://` + 长度上限；`initOpenAI` 失败要向上冒泡成 400。

### HTTP-12 · P1 · `base_url` 可指向任意主机（含内网/元数据地址），并携带用户 Key
- 位置：`configRoutes.js:20-21` → `AiGirlfriend.js:225`、`memory/EmbeddingClient.js:59`，无 scheme/主机白名单、不管重定向；`baseUrl` 会落 `data/state.json`（当前值 `https://cf.sheapi.cc/v1`）
- 影响：任何能到达该端口的一方（未配 token 时按 `auth.js:130-136` 是本机任意进程）都能让服务器带着 `Authorization: Bearer <用户 Key>` 去 POST 任意地址，包括 `169.254.169.254` 或内网其它服务。
- 修法：`http(s)` 校验 + 非回环主机需显式确认；`HOST !== 127.0.0.1` 时禁止私网地址；把「当前 baseUrl」在 `/config/status` 与设置页高亮回显。

### HTTP-13 · P1 · GET 接口会改状态：一个 `<img>` 就能掏空主动消息队列
- 位置：`routes/chat.js:150-154` → `ProactiveEngine.consumeMessage()`（`:693-699` shift + 写 `proactive_state.json`）；同类：`GET /life/current` → `LifeSimulator.js:245-248` 可能新建活动并写 `life_log.json`
- 影响：GET 不触发 CORS 预检，任意网页放一个 `<img src="http://127.0.0.1:8000/chat/proactive">` 就能持续消耗用户的主动消息配额与队列（CSRF 类）。
- 修法：消费改 POST（或要求自定义头），`getCurrentActivity` 变纯读；写盘只在状态真变化时发生。

### HTTP-14 · P1 · 上游错误文本直接当回复内容下发
- 位置：`AiGirlfriend.js:636`、`:713` 把 `e.message` 拼成 `reply` 并以 200 返回；`middleware/errorHandler.js:9-11` 还会把 4xx 的 `err.message` 原样回给客户端
- 影响：OpenAI SDK 的错误串含模型名、请求 ID、上游主机、余额提示 —— 既泄漏信息又把技术报错塞进气泡（用户看到的是「发生了点小意外: Request timed out.」这种半英文）。
- 修法：上游错误映射为稳定错误码 + 中文文案，细节只进服务端日志。

### HTTP-15 · P1 · 无 `unhandledRejection` 兜底，一条逃逸异常就能杀掉进程
- **已核实**：`grep -rn "unhandledRejection|uncaughtException" backend-node/src` → 零命中；`server.js:28-40` 只处理 SIGINT/SIGTERM
- 叠加风险面：`chat.js` 的 `.then` 可能重入 `.catch` 再次 `res.write`（无 `res.writableEnded` 守卫）；`proactiveEngine.notifyUserActive()`（`chat.js:119`）在 `flushHeaders()` 之后且不在 try/catch 里，抛错会变成 `ERR_HTTP_HEADERS_SENT` + 流永久挂起。
- 修法：`server.js` 补全局兜底（记录后优雅退出或继续，需明确策略）；SSE 两处回调加 `writableEnded` 守卫；notify 包 try/catch；加 15s 心跳 `: ping`。

### HTTP-16 · P1 · 上传与音频路径的三处松口
- 位置：`routes/audio.js:19-28` —— `path.extname(file.originalname)` 直接拼进文件名（无白名单、无长度上限，300 字符扩展名 → `ENAMETOOLONG`）、无 `fileFilter`（任意 MIME 都会转发给 Whisper）、`limits.fileSize` 超限只带 `err.code` → `errorHandler` 变成 **500 而不是 413**；`POST /audio/speak` 的 `text` 只判空（`audio.js:31-33`），传数字/对象时 `Voice.js:87` 的 `text.slice` 抛 TypeError → 500
- 另：崩溃后 `temp_uploads/` 无开机清扫；`jsonStore.js:91` 每个文件用固定 `.tmp` 名，两个进程同时写会互相 rename 覆盖。
- 修法：扩展名白名单 + `fileFilter`、413 显式处理、`typeof text === 'string'` 校验、启动时清扫 temp、tmp 名加随机后缀。

### HTTP-17 · P1 · `/static` 是唯一免鉴权的数据面，而 `HOST` 可以单独放开
- 位置：`middleware/auth.js:35,113`（`/static` 豁免）+ `app.js:39` + `server.js:18`（`HOST=0.0.0.0` 与 token 是两件独立的事，`warnIfTokenMissing()` 只警告）
- 影响：TTS mp3 就是「对话内容的语音版」，配了 token 也照样对局域网敞开。
- 修法：`/static` 需要 token（查询串短时效签名 URL）；或 `HOST !== 127.0.0.1` 且无 token 时**拒绝启动**。

### HTTP-18 · P1 · 自由文本无长度上限，会永久抬高每轮 prompt
- 位置：`routes/tasks.js:29-32`（title/description 只判空，最长可到 1MB 请求体）→ `core/prompts/taskPrompt.js:82` 每轮原样注入；`routes/state.js:65-74` 事实 `content` 无上限 → `core/Memory.js:179` 每条事实原样注入
- 修法：入库前截断（title 200 / description 2000 / fact 500），注入时再兜一层。

### HTTP-19 · P2 · 一批「小但成体系」的契约与一致性问题
- 跨日陈旧：`ProactiveEngine._resetDailyCountIfNeeded()` 只在 `_runCheck` 里调（`:480`），但 `trigger()` 会 `dailyMessageCount++`（`:638`）、`getStatus()` 会读（`:755`）→ 零点后手动触发按**昨天**的配额判定；`AffinityEngine.getMeta()`（`:211`）不 roll 而 `recordUserTurn`（`:147`）roll → `GET /state` 与 `/chat` 对「今天」的理解不一致。修法：读时 roll。
- `AffinityEngine.setAffinity`（`:64-68`）不写账本 → 手动调好的好感度在「变更账本」里查不到原因，面板解释不了自己的数字。
- `context_count`（`chat.js:71,135` 含 system）与 `historyCount`（`AiGirlfriend.js:1073` 不含）口径不同。
- 情绪哨兵值外泄：`_preChatGuard` 返回 `emotion:"default"`（`:727,736`）、ghost 返回 `"冷漠"`、路由兜底 `"平静"` —— 三套，前端能直接渲染出 `default` 这个词。
- 默认值魔数 `35` 出现在 `chat.js:73,131`、`ProactiveEngine.js:336,760`、`AffinityEngine.js:23` 五处，应 import `DEFAULT_AFFINITY`。
- 昵称默认自相矛盾：`AiGirlfriend.js:63` 是 `"你"`，`:204`/`:1072` 是 `"亲爱的"`（空昵称存成后者、重启后变后者）。
- `config.js` 违反自己写的 `envNumber` 规则：`port`（`:38`）、`CHAT_TIMEOUT_MS`（`:69`）、`CHAT_THINKING_MAX_CHARS`（`:72`）用 `Number(x) || fallback`，把 0 当未设置（`:17-18` 注释明确说 0 合法）。
- `getCompanionStatus()`（`:1277-1286`）同时下发运行时开关 `triggerEnabled` 与静态默认 `triggerRegistry.enabled` —— 一个响应里两个真相。
- `/chat` 与 `/chat/stream` 的 done 仍是两处字面量（`:68-81` vs `:127-139`，后者少 `token_usage`）；`chat.js:164` 又手抄了第三份「降级 registry 快照」。
- `middleware/validate.js:2` 注释宣称有 `validateBody`（不存在），只有 `fail(res, cond, detail)` 这种双重否定 API，5/7 路由用、2 个路由完全不用。
- `routes/life.js:9-15` 函数名叫 `lifeSimulatorOr404` 实际返回 503。
- 死接口（前端零调用点）：`GET+POST /system_prompt`、`GET /config/status`、`GET /life/history`、`GET /tasks/summary`、`GET /tasks/due`、`GET /state/narratives`、`GET /state/user-emotion`、`DELETE /state/narratives/:id`。
- `utils/jsonStore.js:17-23` 的旧数据迁移清单已过期（缺 `tasks/affinity_state/proactive_state/user_emotion_state/narrative/trigger`）；隔离出来的 `*.corrupt-*`、`*.bad.bak` 永久堆积无清扫。
- **隐私**：`AiGirlfriend.js:806,813,834` 每轮把完整内心独白、模型 CoT、原始 metadata 打进 stdout —— 对这个应用而言，日志就是日记本。另 `app.js` 未 `disable('x-powered-by')`，`_chatQueue` 无长度上限（等于一条无界的付费调用队列）。

### HTTP-20 · 已核查为「不是问题」的项（避免后续重复排查）
`req.body` 在非 JSON 内容类型下仍是对象（解构不会 throw）；任务/事实/叙事 id 只喂 `findIndex`，不拼文件路径或 shell；`express.static` 根在 `static/`，无穿越；API Key 从不落盘、也从不在 `/config/status` 回显；`/memories` 与 `/state/narratives` 会剥掉 embedding 大字段；token 比较用长度归一的 `timingSafeEqual`，回环判定 fail-closed；所有 route→engine 的方法调用都真实存在。

## 3. CORE · 编排与引擎

### CORE-01 · P0 · ghosting 早退会丢弃用户消息，破坏「已读不回」的自洽
- 位置：`backend-node/src/core/AiGirlfriend.js:430-442`（`_prepare` 返回 `{done}`）→ 写入历史发生在 `_finalize`（`:589-594`）
- 现象：进入冷暴力（P < −0.75）时直接返回 `reply: null`，该轮 `userInput` **从未进入 history**，也不落 `memory.json`，`_turnCount` 不增（`:549`）。
- 影响：① 用户连续三条消息被「已读不回」，模型上下文里这三条完全不存在，下一轮情绪回正后她会像没事人一样回答「你刚才说什么？」——最刺眼的穿帮；② 主动消息侧 `miss_you`/情绪闸门基于「最后一次互动时间」判定，而 `notifyUserActive`（`:427`）在早退**之前**已执行，等于冷暴力期间用户的每封消息都替她把「闲置计时」清零，反向削弱了 `miss_you` 触发；③ 叙事层轮次节流被跳过（设计如此，但与 `recordProactiveMessage` 一样形成历史断层）。
- 修法：早退前仍 `history.push({role:'user'})` + 落盘（可选：不调 LLM、不进 episodes，但必须留下「我看见了但没回」的痕迹）；并考虑把 ghost 期间的用户消息记成「被忽略」信号供情绪回升/冷落分层（REQ-09）使用。
- **实测（2026-10-02，进程内假 LLM 探针，数据已还原）**：把 P 压到 −0.9 后发「你还在吗」→ 返回 `{reply:null, special_action:'ghosting'}`；`history` 长度 3→3（消息未入库）、`_turnCount` 1→1、`episodes` 1→1、模型调用 0 次；**但 `lastUserActiveTime` 被刷新为当前时刻**。情绪回正后再发一条，送给模型的 5 条 messages 里只有上一轮「今天好难过」，被已读不回的那条完全不存在。

### CORE-02 · P1 · 每轮模型调用预算未文档化，事实提取每轮必发
- 位置：调用点枚举 `AiGirlfriend.js:627/677/878`、`memory/FactExtractor.js:121`、`memory/EmbeddingClient.js:76`、`narrative/NarrativeExtractor.js:166`、`Voice.js:84`
- 现象：`config.memory.facts.enabled` 默认 true（`config.js:114`），`Memory.recordTurn` 每轮排一次事实提取；情节入库还要一次 embedding；叙事在三层节流命中时再加一次。
- 影响：README 把「不新增 LLM 调用」写成 REQ-01 的卖点（`README.md:143-145`），但整条链路的真实倍数是 1 → 最坏 5，且大部分发生在响应之后、用户看不见。用户换了计费敏感的 Key 时，只会感到「很贵、很慢」却查不到原因。
- 修法：① 把「每轮调用数」做成 `/config/status` 的可见字段（本轮实际发生次数）+ README 成本表；② 事实提取加节流（按轮次/字符数/信号，参照叙事层已有的三层节流范式）；③ 提供一键「省钱模式」把事实提取与叙事抽取的 N 提到保守值。
- **实测**：单轮正常对话（无叙事信号）触发 **2 次 chat.completions（`AiGirlfriend.js` 主对话 + `Memory.js` 事实提取）+ 1 次 embedding**；即使用户只发一句「今天好难过」也一样。也就是说当前实现把「每轮多付一次对话费用」当成了默认行为，而 README 通篇没有成本口径。

### CORE-03 · P1 · 事件层 `promise_followup` 的次数上限失效
- 位置：`backend-node/src/core/triggers/promiseFollowupTrigger.js:29-57` 读 `followupCount`，但 `grep -rn followupCount backend-node/src` 显示**只读不增**
- 现象：`maxFollowups=3` 的判定永远基于初始值 0。
- 影响：约定追问只靠触发源冷却（60min）+ 类型冷却 + 90min 全局自发间隔兜底，长期可能反复追问同一件事——正是 PRD 担心的「毛骨悚然/复读」面。
- 修法：`ProactiveEngine.trigger()` 成功投递后回调 registry，让 `promise_followup` 命中的叙事 `followupCount++` 并 `scheduleSave()`（叙事库已有 `updateNarrative` 通道）；同时补一条单测锁死「第 4 次不再追问」。

### CORE-04 · P1 · 纪念日窗口两处定义不一致
- 位置：`config.js:193` `narrative.anniversaryWithinDays = 7` vs `core/triggerEvents.js` 阈值 `withinDays = 3`
- 现象：查询按 7 天窗口产出候选，触发判定按 3 天窗口放行。
- 影响：4–7 天的纪念日被查出来但不触发，属「静默失效」；用户改了 7 这个 env 还会误以为生效。
- 修法：单一真源——触发阈值只读 `config.narrative.anniversaryWithinDays`，删掉 `triggerEvents.js` 内的重复数字（保留 `TRIGGER_THRESHOLDS` 里其它项）。

### CORE-05 · P1 · 情绪数值缺少每轮幅度裁剪，与其他通道口径不一致
- 位置：`AiGirlfriend.js:569-575`（`applyDelta(autoDelta)` 后无条件再 `applyDelta(emotionDelta)`）；对比好感度 8 道校验（`affinityRules.js:70-153`）、性格 `MAX_PER_TURN 1.5`（`personalityRules.js:18-34`）
- 现象：`EmotionEngine.applyDelta` 只 clamp 结果到 `[-1,1]`，不裁剪 LLM 给的单轮 delta；模型可一次 `{"P":0.9}` 把情绪从低落直接拉到兴奋，或反向。
- 影响：情绪是主动消息闸门、风格指南、记忆染色（`emotionWeightNegative`）的共同输入，被模型单次输出拉满会让「PAD 三维模型」退化为模型的表情包。README 也明确写了 prompt 约束是 −0.5~+0.5（`systemPrompt.js:88`），但代码不校验。
- 修法：与好感度同款：在 `applyDelta` 增加 `maxAbsPerAxis` 参数（默认 ±0.5，走 config），LLM delta 与词表 delta 分别裁剪后再混合；ledger/trace 记录实际生效值。
- **实测**：词表 delta 有裁剪（日志 `analyzeInput → delta P:-0.15`，轴上限 ±0.5/±0.4/±0.3），LLM delta 无裁剪——模型给 `emotion_delta.P = +0.9` 时，经 `inertia=0.7`（实际乘 0.3）后单轮真实推动 **+0.27**（P 0.26→0.53）。连续三轮这样的输出足以把 P 从「block 档」拉回正常区间，从而**替模型自己解开主动消息的情绪闸门**——而这正是好感度通道专门写 `affinityRules` 要防的事。

### CORE-06 · P0 · 一次异常之后，对话的串行保护**永久失效**
- 位置：`AiGirlfriend.js:405-410`（`chat`）与 `:651-662`（`chatStream`）——catch 回调里 `this._chatQueue = Promise.resolve()`
- 机理：A 拒绝 → A 的 catch 把 `_chatQueue` 改写成已 resolve 的 Promise，但此时 B 已经挂在 A 后面 → 后来的 C 挂在**新的空队列**上，与 B **并发执行**。此后互斥永久丢失，直到重启。
- 可达性：`_prepare` 不在任何 try 里（`:623`、`:669`），`personalityDrift.settleDaily` / `shouldGhost()` / `updateBaselineForAffinity` / `buildSystemContext` 任一抛错即触发。而 `EmotionEngine._loadState:398` 把 `data.state` 原样赋值 —— 一个被手改或半损坏的 `emotion_state.json`（`"P": "0.3"`）就能让 `getPromptInjection` 的 `emotion.P.toFixed(2)`（`:259`）每轮抛错，等于**一个状态文件把整台引擎的并发保证永久打掉**。
- 后果：并发下 `history`、`_affinity` 读改写、`personalityDrift.current`、`TaskManager.tasks`、两个 store 的数组全都没有隔离（D-2.2）。
- 修法：catch 里**不要**改写队列（`.catch()` 返回兜底值即可自然续链）；`_prepare` 纳入 try；`_loadState` 对 P/A/D 做 `Number.isFinite` 校验并回落默认值。

### CORE-07 · P0 · 关键词检索是同步 O(n²·T) 且在请求路径上 await —— 一条长消息可冻结整个进程
- 位置：`core/memory/KeywordScorer.js:33-55`（每轮对**每个 episode 重新分词**，且 df 在「每文档 × 每词」的内层循环里用 `docs.filter(...includes(term))` 全库重算），调用链 `AiGirlfriend._prepare:451` → `Memory.buildMemoryContext` → `MemoryRetriever._keywordSearch`
- **实测**（500 条 episode、真实聊天文本、单线程）：19 词查询 **138 ms**；1000 条 552 ms；91 词（约 150 字）消息 **2 888 ms**；2000 条 + 91 词 **59 641 ms**。`config.chat.maxMessageLength=8000` 意味着一条合法长消息的外推耗时是**分钟级**，期间 Node 事件循环完全卡死 —— `/chat/proactive` 轮询、`ProactiveEngine.check()`、其它在途流全部停摆。**这是无需并发的自我 DoS，而且是开箱默认路径**（未配嵌入 Key 时 `resolveMode()` 返回 keyword）。
- 修法：分词结果与 df 建索引缓存（episode 变更时增量更新）、idf 提到文档循环外、注入前对 query 词数截断；长期方案是把检索移出请求路径（后台预热 + 本轮取缓存）。

### CORE-08 · P0 · `memory.json` 会被撑到 ~15 MB 并每 2 秒全量重写
- 位置：`MemoryStore.js:132-154`（去抖 2 s 全量 `writeJson`）+ `utils/jsonStore.js:98`（`JSON.stringify(data, null, 2)` 缩进写盘，1024 维向量的每个浮点各占一行）
- **实测**：100 条 episode = 2.9 MB；**500 条（默认上限）= 14.6 MB**，仅 stringify 58 ms。配了嵌入 Key 后，每次活跃期每 ≥2 s 就同步重写 15 MB；启动 `readJson` 也要解析 15 MB（1-2 s、几十 MB 瞬时堆）。
- 附带：`config.js:88` 的 `envNumber(..., 500, 10, **100000**)` 允许把 `maxEpisodes` 设到 10 万 → 约 3 GB 的 `memory.json`。
- 修法：向量与文本分离存储（或 base64/TypedArray 编码）；写盘去掉 `null, 2`；`maxEpisodes` 上限收到现实值（如 5000）。

### CORE-09 · P0 · 没有任何 token/字符预算护栏
- 位置：`Memory.js:160` 把 `[相关回忆]` 的 `h.text`（= `"User: 最长 8000 字\nXiao Ai: 模型整段回复"`）**原样注入**，无每条上限；`Memory.js:179` 事实原样注入；`AiGirlfriend.js:322-339` 历史裁剪只按条数
- **实测最坏情况**：固定开销 ≈ 6.3k 字符；3 条回忆 ≈ 30k 字符 + 12 条事实 + `unlimitedContext` 下 200 条历史 ≈ 200k 字符 → **单请求约 12-16 万 token**。对比叙事层已经实现了 300 字符硬上限（`narrativePrompt.js:38`），更早上线的记忆层反而一点护栏都没有。
- 后果：服务商直接 400，或从**头部**静默截断 —— 也就是把 `[System Context]`/人设丢掉，模型在半路「失忆成人」。
- 修法：给每条注入文本设字符上限（回忆 300 字、事实 120 字），并在 `_buildPromptMessages` 前做一次总字符预算裁剪（按优先级丢块）；`unlimitedContext` 明确「只放历史、其它块按预算收缩」。

### CORE-10 · P0 · 三个「关闭态安全」开关全都关不干净，而且用户根本关不了
- 前置事实（**已核实**）：`frontend/src/lib/api.ts:100-127` 从不发送 `user_emotion_enabled/narrative_enabled/trigger_enabled`（全仓只有后端读它们）→ 三个开关无 UI 路径（同 HTTP-10）。
- **关不持久**：`updateConfig` 只在连接类字段变化时 `_saveState()`（`AiGirlfriend.js:1207-1220`），而 `_saveState` 的 payload（`:203-213`）根本不含开关 → **每次重启都回到 config 默认（三个全 ON）**，前端又只重发 chat/memory 字段，于是回滚是永久且不可见的。
- `userEmotion.enabled=false` 时仍然：`AiGirlfriend.js:474` 调 `analyze()`（一轮两次，约 160 次 `includes` 扫描）、`:362` 调 `ingestTurn()`（改状态 + 追加 timeline + **全量重写 `user_emotion_state.json`**）、`:373` 发 `USER_EMOTION_TURN` 事件 → 照样产出 `emotion_resonance` 主动消息。只压掉了 prompt 注入。与 `config.js:131` 写的「不分析、不注入、不落盘」三条全矛盾。
- `narrative.enabled=false` 时：抽取与注入确实被挡（`:487`、`:1309`），但 **`_publishNarrativeMilestones()`（`:386`→`:1451-1481`）没有 `_narrativeEnabled()` 判定**，仍会为每条纪念日/约定发 `NARRATIVE_MILESTONE` → 触发 `anniversary_recall`/`promise_followup`，**引用一个已关闭功能的叙事库**；`NarrativeStore` 也照常加载与对外服务（`routes/state.js:172-191`）。
- `trigger.enabled=false` 最严重：`setEventLayerEnabled` 写的模块级布尔值**只有一个读取点**（`ProactiveEngine.js:671`）。`_emitEvent`、`EventBus.emit`、`TriggerRegistry._onEvent` 全都不判 → 关闭状态下仍然每轮发布、派发、评估、**入队**、扣冷却/去重、并 `scheduleSave()` 写 `trigger_state.json`；队列在整段关闭期间持续累积（`maxQueueSize:20`、TTL 20-120min），**重新打开时会把几小时前算好的消息一次性倒出来**。`ProactiveEngine.js:472-477` 的「逐字节不变」注释只对 `_runCheck` 成立。
- 修法：① 四个入口加真判定（`_emitEvent`、`_onEvent`、`_publishNarrativeMilestones`、`ingestTurn/analyze`）；② 开关随 `updateConfig` 落盘（存进 `state.json` 的 `toggles` 段，注意别把 Key 写进去）；③ 前端补三个开关；④ 关闭时清空/冻结事件队列并在状态里标注「已暂停」。

### CORE-11 · P0 · 模型把数字写成字符串，好感度就**永久不动**且无任何告警
- 位置：`AiGirlfriend.js:827` `affinityChange = metadata.affinity_change || 0` → `affinityRules.js:76` `let cur = Number.isFinite(rawChange) ? rawChange : 0`
- 现象：`{"affinity_change": "+3"}`（这个 prompt 下极常见的引号写法）是字符串 → `Number.isFinite` false → `cur=0`；`true`、`NaN`、带 U+2212 负号的 `"−20"` 全部落到同一个静默 0。`:824` 的正则只修 `: +3` 这种未加引号的形式。
- 影响：只要模型保持这个习惯，**关系就再也不会长进**，日志、账本、UI 都不显示异常。
- 修法：在解析边界统一 `Number(...)` 强转 + 引号剥离，转换失败要 `console.warn` 并在 `/chat` 响应里透出 `affinity_parse_error`。

### CORE-12 · P0 · ghosting 期间用户被性格系统判成「长期失联」，天天扣分
- 位置：`AiGirlfriend._finalize:583` 是 `personalityDrift.recordUserTurn` 的唯一调用点，而 `_recordStats` 正是在这里写 `stats.lastActiveDate`（`PersonalityDrift.js:589`）并把 `consecutiveInactiveDays` 归零（`:590`）
- 机理：走 ghost 早退 → `_finalize` 不执行 → `lastActiveDate` 冻结，但 `settleDaily`（`AiGirlfriend.js:421`）照跑 → `PersonalityDrift.js:197-198` 每天把 `consecutiveInactiveDays` +1，≥3 天触发 **S01 `long_absence`：independence +2.0、security −2.5、affection −1.5/天**（直到 `MAX_PER_DAY 3.0`）。
- 影响：**天天给她发消息的用户，被按「消失一周」来改变性格**，而且这个变化会自我强化（越没安全感越容易触发冷暴力）。`avgDaily7`/`activeDays` 也同时失真。
- 修法：把 `_recordStats`/`lastActiveDate` 的更新移到 `_prepare`（凡收到用户消息就算活跃），ghost 只影响回复与否、不影响活跃度统计。

### CORE-13 · P1 · 词表与 LLM 的情绪增量被**双计**，且 LLM 侧不裁剪
- 位置：`AiGirlfriend.js:569-573`（`applyDelta(autoDelta)` 之后无条件再 `applyDelta(emotionDelta)`，注释明说「叠加混合」）
- 实测：「我今天好难过」词表给 P −0.20、LLM 通常再给 ≈−0.3，各乘 0.3 惯性 → 同一事件落地幅度约为设计意图的 **2 倍**。叠加 CORE-05/下面 D-3.1 的无裁剪，`{"P":-5}` 这种格式失误可**单轮把 P 砸到 −1.0**，直接 trip `shouldGhost()`（`EmotionEngine.js:250`）进入冷暴力循环。
- 修法：改为加权混合（`w1*auto + w2*llm`，和 ≤1）；LLM delta 逐轴裁剪到 `[-0.5,0.5]`；`decay()` 也补 clamp（`EmotionEngine.js:133-135` 目前不 clamp）。

### CORE-14 · P1 · 用户情绪词表的否定判定是**整句级**，正常中文被误判
- 位置：`core/userEmotionLexicon.js:108` + `:245`：只要整条消息含 `不/没/别/无/未` 且主标签为正向，就把 valence 取反
- 反例：「今天不开会，和朋友聚了聚，超开心」→ 含「不」→ 开心被翻成负 → 注入 prompt 的是「用户情绪：低落」。而 `无`（无语）、`没`（没什么）这类字在中文里高频出现，误判率不低。
- 修法：改成**邻域窗口**判定（情绪词前后 N 字内出现否定才算否定），并对 `无语/没什么/不错` 等做词形排除；补一组真实语料回归用例。

### CORE-15 · P1 · 关键词检索既不是 BM25，相关性也被 recency 淹没
- 位置：`textSim.js:21-37` 的 `tokenize` 返回 `[...new Set(...)]`（去重）→ `KeywordScorer.js:44` 的 `tf` **恒为 1**，`dl` 是去重 bigram 数而非文档长度 → `k1/b/avgdl` 饱和项形同虚设（文件头 `:3-6` 描述的公式代码执行不了）；`:55` 又除以 `maxIdf * terms.length`
- **实测**：500 条库、19/39 词查询时 `topBaseScore ≈ 0.00016`，而 `recencyWeight` 上限 0.15（`config.js:100`）→ 相关性与 recency 的数量级差 3 个，**`[相关回忆]` 实际返回的是「最近的」而不是「相关的」**。
- 附带：`NarrativeRetriever.js:130` 用 `>=`、`MemoryRetriever.js:93` 用 `>`，同阈值不同包含性；`affinityRules.js:92` 用原始 `userInput` 而 `EmotionEngine.analyzeInput:281` 先 lowercase → 英文词表（`sorry`）一条路径能命中另一条不能；`SOFT_REJECTION` 的「哼」、`HARD_REJECTION` 的「后退」是子串匹配，小爱**引述**用户（"你刚刚说你不想后退"）会被判成她在拒绝（`:100-116`）。
- 修法：tf 用未去重词频、df 预计算缓存、归一化去掉 `terms.length` 并让 recency 只做小幅加分（或改成分层排序）；两处阈值统一；拒绝判定改词组级 + 只看非引述片段。

### CORE-16 · P1 · 好感度不变量与账本的三处破口
- 非有限 `rawChange` 时：`affinityRules.js:76` 静默换 0，但 `AffinityEngine.js:166` 把**原始值**写进账本 → `rawChange:"+3", finalChange:0, trace:[]`，`rawChange + Σ(to−from) === change` 不成立（`/affinity/ledger` 的所有消费者都错）。
- `AffinityEngine.js:153` `after = clampAffinity(before + change)` 会**取整**，而 `change` 可能是小数（`affinityRules.js:88-90` 的单轮裁剪放行浮点）→ `before + finalChange ≠ after`；0/100 边界处 `finalChange` 还会虚报（实际 +0 报 +3）。
- `:158-159` 日配额按**取整前**的 `change` 扣：好感度 99 时 `change=+3` 只涨 1 分，却扣掉 `daily.gained += 3`（上限 8）并写 `gainEvents`（喂 24h 疲劳）→ 满级用户一条贴心话烧掉 1/3 日预算，UI 显示 `dailyCapReached:true` 而分数没动。
- `:120-124` 时间衰减条目伪造 `rawChange:0` + `trace:[{from:0,to:finalChange}]`，与真实轮次条目混在同一账本里；`settleDecay:111` 在 `applied>0` 判定**之前**就消费掉 `lastUserActiveTime`，于是好感度触底后每个衰减窗口被静默吃掉（可能是有意，但完全没写）。
- 修法：账本统一存「实际生效值」并保证可加性；日配额按实际入账分数扣；衰减条目单独分表或加 `kind` 字段。

### CORE-17 · P1 · 重置的世代号覆盖不全，删掉的东西会复活
- 已有保护：事实提取队列（`Memory.js:92/96/99`）、叙事抽取（`AiGirlfriend.js:1313/1318/1332`）
- **缺保护**：① **episode 嵌入与写入**（`Memory.js:64-86` 完全没有世代概念）—— `clearMemory()` 落在 `await embed()` 期间，续体照样 `addEpisode + scheduleSave`，**被删的对话在重置之后复活**；② `_applyFactOps`（`:106-146`）/`_applyNarrativeOps`（`AiGirlfriend.js:1345-1388`）只在**调用前**判一次，函数内部每条 add/update 都 await 嵌入，中途落地的清空会被继续循环的写入盖掉；③ **用户情绪**没有世代：`UserEmotionEngine.reset()`（`:309-325`）清完 timeline，队列里的 `ingestTurn`（`:158`）又把「重置前内容」推回去并重新排盘。
- 修法：把「读取-计算-写入」三段都过一遍世代号校验（嵌入返回后再校验一次），或让 `clearMemory/reset` 也走 `_chatQueue` + 一个统一的 `stateGeneration`。

### CORE-18 · P1 · 后台无背压、嵌入调用重复且顺序颠倒
- `Memory._extractQueue`（`:93`）与 `AiGirlfriend._narrativeQueue`（`:1315`）是无界 `.then()` 链，**不合并、不丢弃**：连发 10 条 → 10 次串行事实提取（每次带全量事实表，3-10 s），积压无限增长且越来越描述过期轮次。
- 同一轮里 `userInput` 被嵌入**两次**（记忆检索 `Memory.js:158` 与叙事检索 `NarrativeRetriever.js:106`，字符串完全相同、都 await、`timeout 2500ms/maxRetries 0`）→ 慢或坏时**每轮白加最多 5 秒预填充延迟**。
- `Memory.js:133-134` 先 `await embed(content)` **再** `isDuplicateFact` → 每条重复事实都白付一次嵌入；叙事侧顺序是对的（`AiGirlfriend.js:1375` 判重 → `:1380` 嵌入），两条同构路径没对齐。
- `EmbeddingClient.available` 只是 `!!this.client`（`:52-54`），**没有失败计数/熔断/冷却** → `config.js:74` 注释承诺的「慢就快速降级」不成立：嵌入 Key 配错时每一轮都吃满 2500 ms，永远如此。
- 修法：本轮 query 嵌入 memoize 一次；判重前置到嵌入之前；加失败计数器（连续 N 次失败即冷却 M 分钟并切 keyword）；后台队列加去抖合并（同一 store 只保留最新一次待跑）。

### CORE-19 · P1 · 三处「写了但没人读」的惰性逻辑，直接废掉两个需求
- **`followupCount` 只读不写（比 CORE-03 更糟）**：`promiseFollowupTrigger.js:41-42` 用 `maxFollowups:3` 判上限、`:55` 用它拼 `dedupeKey = promise:{id}:{followupCount}`，但 `normalizeNarrative`/`updateNarrative`/`normalizeAdd` 都不含该字段 → 恒为 0 → **上限是死代码，且 dedupeKey 恒定**，配合永不清理的 `dedupeSeen`（CORE-20）→ 约定追问**一生只发一次**（REQ-05 的闭环根本立不起来）。
- **`NarrativeStore.markRecalled`（`:188-194`）与 `NarrativeRetriever.getRandomStory`（`:210-224`）零调用点** → `recallCount/lastRecalledAt` 永远是默认值，防重复回顾逻辑不执行；`memory_share` 仍在用 `Memory.getRandomMemory` 分享**原始对话轮**（`AiGirlfriend.js:914-924`），PRD §2.3 承诺的「升级为分享故事」写了但没接线。
- **`_recentStoryIds` 只 clear/delete、从不 add**（`:112/1053/1429`）→ 永远是空 Set，所谓随机回顾去重不存在；`narrativeStore.stats.lastExtractTurn` 写两次从不读（`shouldExtract` 只看 `lastExtractAt`），而 `NarrativeStore.js:196` 的注释声称三层节流会用它。
- 修法：**一律接线**（用户 2026-10-03 明确「最大程度拟人化」优先，见 `02-plan.md` 优先级原则）：`followupCount` 投递后自增、`memory_share` 改走 `getRandomStory`+`markRecalled`、`_recentStoryIds` 真正记录。这些恰好是 REQ-05 与 PRD §2.3「她主动想起我们之间的事」缺的那根线。

### CORE-20 · P1 · 无界增长的四个数组
- `TaskManager.tasks` **无上限也不归档**：`addTask:210-234` 只追加，完成的任务永不归档，而 prompt 还在主动鼓励模型建任务（`systemPrompt.js:90` + `taskPrompt.js:136-151`）。每轮代价：`getPendingTasks` 全量 filter + `decorateAndSort` 两次全量拷贝排序（`:462/464`）+ `getReminderCandidates` 全扫（`:297-331`）+ `saveTasks()` **同步全数组重写**（`:156-158`），而 `_markDialogMention`（`AiGirlfriend.js:525-538`）每个候选任务各写一次 → 一轮最多 3 次全量重写。
- `TriggerRegistry.dedupeSeen` **永不清理**：`_pruneDedupe`（`:365-375`）定义了但全仓无调用；键按小时/天分桶 → 约 2500 键/月、`trigger_state.json` 一年约 1.5 MB，且跨重启累积（只有 `reset()` 能救）。
- `history` 的**单条长度**无上限：`MAX_HISTORY=200` 只管条数，`replyText` 原样入库（`:592-594`），而 `max_tokens` 默认 0（不传）→ 模型可产出 2 万字回复被持久化并每轮回灌；`thought` 同样永久留在 `state.json`（送 LLM 时才剥掉）。
- `EmotionEngine.history`（`:50/110-119`）每轮 push 2-3 次、封顶 50、落盘、开机恢复 —— **没有任何读取点**。
- 附带：`_persistAfterReply` 的调用顺序与自身注释相反（`:383-384` 说「放在抽取之后」，实际 `_publishNarrativeMilestones()` 在 `:386`、抽取在 `:392`）→ 新抽取出的纪念日无法在创建它的那轮触发，而 `anniversaryTrigger.js:48` 按天去重，**丢失窗口 24 小时**。
- 修法：任务表加上限 + 完成即归档到 `tasks_archive.json`；启动时调用 `_pruneDedupe`；assistant 正文与 thought 各设字符上限；情绪 history 要么给 UI 用要么删；里程碑发布挪到抽取之后。

### CORE-21 · P2 · 一批「设置项骗人 / 口径不一致」的小问题
- `maxPromptHistory` 的 UI 上限 500 是假的：`MAX_HISTORY=200` + `:597-599` 的裁剪意味着 ≥199 的值**静默无效**，用户从 30 调到 500 实际得到 199。
- 历史裁剪假设严格交替（`splice(1,2)`），但 `recordProactiveMessage:941` 会 push **孤立的 assistant** → 之后每次裁剪都可能删掉一条 user 而保留另一轮的回答。
- 第二条 system 消息被 push 在**全部历史之后**（`:513`），主动消息链路更是连发 4 条 system（`:852-871`）：严格校验的服务商（要求首条 system、不允许中途 system）会直接 400。
- `buildProactivePrompt:73` 与 `buildProactiveDirective:217` 各自又 `new Date()`，一次生成里可能带两个时间戳。
- `lastRandomSlotKey`（`ProactiveEngine.js:550`）拼的是 `${dayKey}T${hour}:${0|30}`（无补零），且 `slotKey !== lastRandomSlotKey` 的写入发生在概率判定**之前** → 掷骰子失败的那次也把本时段烧掉了。
- `recentSentTexts` 载入时 `slice(0, LIMIT)`（`:209`）保留的是**最旧** 2 条而非最新 → 重启后去重比对的是过期前缀。
- `PROACTIVE_TYPES.eventDriven`（`proactiveTypes.js:194/210/226`）无任何闸门读取，`toPublicTypeInfo` 还把它丢掉；`PROACTIVE_GROUP_ORDER` 无消费者。
- `TRIGGER_EVENT_SCHEMAS` 文档里的 `NARRATIVE_MILESTONE.daysAgo` 从不发布（实际发 `daysUntil`），`anniversaryTrigger.js:31-33` 只能两种拼写都读。
- `getMeta()` 的 `decaying`（`AffinityEngine.js:210`）与 `settleDecay` 同窗口，好感度触底后会连续多天显示「衰减中」而实际 `applied:0`。

### CORE-22 · 已核查为「不是问题」的项
每轮 `decay()` 只调一次（`:575`，双衰减的怀疑不成立）；性格与好感度的衰减是两套独立时钟，**没有**双计；`sentDays`、`lastRandomSlotKey`、`PersonalityDrift.adapt`/streak 计数器、`Memory._recentSharedIds` 都是**活代码**（有读有写）；三个 ledger 都有封顶（200/200/50）；`narrative.json`（60×1024）与 `user_emotion_state.json`（50）体量可控。

### CORE-23 · 每轮同步写盘次数被严重低估
一轮成功对话实际触发 **9-13 次 `writeFileSync` + `JSON.stringify(…, null, 2)`**：`emotion_state.json` ×**4**（`EmotionEngine.js:86/121/136` 各自落盘 + `_finalize` 路径）、`affinity_state.json` ×1-2、`personality_state.json` ×1、`state.json` ×1（含全部 200 条）、`tasks.json` ×1-3，外加去抖的 memory/narrative/user_emotion/trigger。其中 6 次发生在**最后一个 delta 与 `done` 帧之间**，直接计入用户感知的响应延迟。修法：引擎内合并为「一次状态变更一次落盘」（微任务内去抖），或统一走一个 per-store 的写队列。

## 4. PROMPT 层

### PROMPT-01 · P0 · 「共情响应策略表」是死代码，REQ-02 的地基没接上
- 位置：`core/prompts/userEmotionPrompt.js:16-35`（`USER_EMOTION_RESPONSE_STRATEGY`：低落→先共情后建议 等策略表）与 `:45` 的 `buildUserEmotionContext`
- **实测**：`grep -rn buildUserEmotionContext src/ scripts/` → 只有 `scripts/test-user-emotion.mjs:19,323` 引用，**运行链路一次都没调用**。运行时注入的是另一段 `UserEmotionEngine.getPromptInjection()`（`AiGirlfriend.js:475` → `UserEmotionEngine.js:263-268`），内容只有一句「体贴地照顾他的状态」。
- 影响：REQ-01 辛苦建起来的用户情绪通道，到 prompt 这一步就断了——用户难过时她不会「先共情后建议」，与改造前的差别只有一条日志。而单测覆盖了那张表，容易让人误判「REQ-02 已经做了」。
- 修法：二选一并删掉另一份（两份都叫 `[User Emotion]`，将来必然漂移）：把 `getPromptInjection()` 改为消费策略表，或让 `AiGirlfriend` 改调 `buildUserEmotionContext`。

### PROMPT-02 · P1 · 好感度规则在一条消息里写了 4 遍，且数字互相矛盾
- 位置：`systemPrompt.js:16`、`:18-24`（铁律阶梯）、`:87`（Response Instructions 内重复）、`relationshipContext.js:24/40/57/73/88`（各阶段再复述一遍）
- 冲突实例：初识越界 persona 说 `-2~-3`、阶段文案说 `-1~-2`、引擎 `affinityRules.js:42` 落在 `-2/-3`；朋友阶段 prompt 说越界 `-1`，而 `affinityRules.js:43,123` 的 `Math.min(cur, floor)` 会把它**悄悄加重到 -2**；挚友阶段 `relationshipContext.js:73` 说「亲密话语 +1」，而 `systemPrompt.js:19-21` 说 +1 是「一天顶多一次的罕见时刻」——同一条消息里两条硬规则期望值相反。
- 影响：模型输出不稳定时无法归因（它照哪条执行都可能）；用户看到的好感度变化原因与提示语不一致，直接伤「规则可信度」。
- 修法：唯一真源——数字只保留一处，且**由 `AFFINITY_RULES` 反查生成**（阶段阈值已有先例），阶段文案只描述「什么算越界」，不写数字。

### PROMPT-03 · P1 · 语气有三个 prescribe 层，没有优先级；静态人设与性格预设互相打脸
- 位置：`relationshipContext.js:13/29/45/62/78`（阶段语气）、`EmotionEngine.js:184-247`（PAD 风格指南，不看阶段）、`personalityPrompt.js:9-59`（七维档位，不看预设）
- 实例：`stranger` 阶段 + `clingy` 预设时，模型同时收到「非常黏人，渴望时刻陪在用户身边」（`personalityPrompt.js:11`）与「不会：撒娇、主动关心私生活」（`relationshipContext.js:16`）；`PERSONA_SYSTEM_PROMPT:10` 的「温柔…小傲娇」与 `高冷` 预设（`personalityPresets.js:49-62`）冲突，而静态人设无法被动态层覆盖。
- 修法：显式声明优先级一行（阶段边界 > 当前情绪 > 性格底色 > 基础人设），并把固定性格形容词从基础人设里删掉，让预设成为唯一来源。

### PROMPT-04 · P1 · `<metadata>` 契约有三份互不一致的示例，且两个字段是「白花钱」
- 位置：`systemPrompt.js:15`（2 字段）、`:86`（4 字段，无 `task_action`）、`taskPrompt.js:141`（3 字段 + `task_action`，无 `emotion_delta`/`user_emotion`）
- `emotion` 字段：**实测**主对话链路解析后直接丢弃——`_parseReplyText` 返回它（`AiGirlfriend.js:838`），但 `_finalize` 的解构列表（`:545`）里没有它，响应最终用 `getEmotionLabel()`（`:608`）。只有主动消息消费（`:897`）。等于每轮让模型多写一个字段、多花输出 token，没人读。
- `user_emotion.confidence`：prompt 说「判断不出就省略」（`:89`），但 `UserEmotionEngine.js:130-134` 要求 valence/arousal/intensity/**confidence** 四个都有限，否则**整段 LLM 读取作废**退回纯词表。最该省的字段恰好是模型最爱省的。
- `task_action.taskId`：`taskPrompt.js:90` 每轮注入 `[短id]` 并解释「用于精确引用某条任务」，但 schema 里**没有任何字段能携带 id**（`taskActions.js:48,74-79` 支持，prompt 未告知）——白付 token 且能力被契约封死。
- 修法：一份 schema 示例（放在 `[Response Instructions]`，最靠近生成点）；`emotion` 不删而是**用起来** —— 主对话也采纳它做徽章与 PAD 融合（拟人化优先，见 `02-plan.md` 优先级原则）；`confidence` 缺失时按 0.5 兜底而非整段丢弃；`taskId` 补进 schema 让「精确引用某条任务」真的可用。

### PROMPT-05 · P1 · 全英文指令 + 唯一示例是英文，且没有任何「用中文回复」的约束
- 位置：`[System Context]`/`[Response Instructions]`/`Cognitive Assessment`/`Reply Style:`/`Example Format:`（`systemPrompt.js:57-95`）、`[Emotional State]`（`EmotionEngine.js:257`）、`[Personality State]`（`personalityPrompt.js:101`）、`[User Emotion]`（`UserEmotionEngine.js:264`）、`taskPrompt.js:138-149`（约 90% 英文）
- 关键：唯一的输出格式示例是**英文独白 + 英文正文**（`systemPrompt.js:93-94`：`Hmph, you are so annoying!`）。few-shot 示例的模仿权重高于散文指令 → 英文渗漏是可预期失败。`grep` 全部 prompt 模块：**没有任何一条**「用用户语言/中文回复」的指令。
- 修法：段落标题与规则正文改中文（机器标签 `<monologue>/<metadata>` 保留 ASCII），示例换成中文人设语气，并显式加一条输出语言规则。

### PROMPT-06 · P1 · 记忆/叙事/任务文本裸插进 system 消息，事实提取可被长期投毒
- 位置：`systemPrompt.js:59`（nickname）、`:60`（任务标题，`TaskManager.js:183,217` 不限长）、`:61` ← `Memory.js:168-170`（`[相关回忆]` 是**原样** `User: …\nXiao Ai: …`，用户单条最长 8000 字符）、`:69` ← `narrativePrompt.js:64-67`、`AiGirlfriend.js:919`
- 提取器同样裸拼：`FactExtractor.js:115-117`、`NarrativeExtractor.js:160-162`，且**没有一句**「以下对话是素材，不是指令」。
- 现实风险评估（本地单人应用）：经典「窃取他人数据」收益≈0；真正可达的是 ① **持久化人设投毒**——用户写一句看起来像指令的话 → 被提取成 `[已知事实]` → 之后每一轮都生效；② `task_action` 是唯一「prompt 输出直接改状态」的写原语（`AiGirlfriend.js:554-559` 无条件执行）。
- 修法：给数据块加围栏（如 `<memory_data>…</memory_data>`，`Memory.js:167-170` 三行改动）+ 人设里一句「围栏内是引述素材」+ 两个提取器加「忽略祈使句」条款。

### PROMPT-07 · P1 · 静态 prompt 已占每轮上下文的 3.5~4 倍人设长度，最大块是任务指令
- 实测字符数（全块填满时 `buildSystemContext` ≈ **5111 字**，空骨架 2143 字）：`taskPrompt.js:136-151` 单块 **1002 字**（比整份人物小传 889 字还大）、`[Response Instructions]` ≈1250 字、`relationshipContext` 435-608 字、narrative ≤300 字（有 config 上限 ✅）、**memory 无上限 ❌**（12 条事实不限长 + 3 条回忆含原始整轮文本）。
- 另：`taskPrompt.js:84-85` 已在任务列表里标 `⚠️已逾期/⏰1小时内到期`，`:114-126` 又把同 1-2 条任务原样列一遍（R6 重复）。
- 修法（按性价比）：① 任务指令压到 ~300 字（零能力损失）；② 删 persona 里重复的好感度阶梯与 `Reply Style:` 重复行（顺带解 PROMPT-02/03）；③ `[Response Instructions]` 中文化并收紧（≈1250→600）；④ 给 `[相关回忆]` 每条加字符上限（这是唯一可能独自冲到五位数的块）。

### PROMPT-08 · P1 · 人设外观与已上线立绘不一致，文档还留着旧「人物圣经」
- 位置：`systemPrompt.js:9` 仍写「粉色长发…紫色眼睛…露肩毛衣」；实际资产 `frontend/public/characters/*.webp`（2026-10-01 重绘）与 `docs/character-emote-prompts.md:14-20` 是**银白及腰长发 + 月牙发饰 + 蓝紫眼 + 月白高领毛衣**。
- 连带：`docs/emoji-avatar-prompts.md:26-31` 还有一份自称「从人设逐字提取，不要改写」的旧 Character Bible（pink hair / violet eyes / off-shoulder），照它再生成就会把身份劈成两半；`:5` 写「16 档情绪标签」而 `EmotionEngine.js:148-171` 现有 17 档；`relationshipContext.js:9` 与 `proactivePrompts.js:17-54` 把用户写死为第三人称「他」（有昵称字段却没有代词字段）；`proactivePrompts.js:21-29` 是阶段语气的**第二份**真源，已与 `STAGE_GUIDE` 在「挚友能否说最喜欢你了」上分叉（对比 `relationshipContext.js:61`）。
- 修法：抽一张「身份卡」（名字/自称/外观/不可谈判边界）作为唯一外观真源，人设与文档都从它取；旧 Character Bible 归档并在文件头标注失效；主动消息阶段文案改为从 `STAGE_GUIDE` 生成。

## 5. 前端

### FE-01 · P0 · 冷暴力（ghosting）时界面显示她在「开心」
- 位置：`AiGirlfriend.js:437` 发出 `emotion:"冷漠"` → `routes/chat.js:72` 原样下发 → `frontend/src/components/character/emotionMap.ts:65` 的 `normalizeEmotion` 查不到该键，回落 `"default"`，而 `:34` `default: "开心"`、`:9` `default.webp` 是微笑立绘
- **实测确认**：`emotionMap.ts` 全文无「冷漠」映射（`:46` 只映射了 满足/平静→default）。
- 影响：最该演出「她在生气不理你」的时刻，角色面板给她挂上「开心」标签和笑脸，情绪徽章与气泡内容直接对撞。这是陪伴感 D5/D7 的反面教材级穿帮。
- 修法：`emotionMap.ts` 补 `"冷漠"`（以及缺失的其余 PAD 标签）→ 映射到 `sad`/`angry` 或新增 ghost 资源；更根本的做法是**后端下发 `getEmotionLabel()` 而不是硬编码字符串**，并加一条前后端标签集合一致性测试（引擎 17 档 vs 前端映射表）。

### FE-02 · P0 · 两条主动消息间隔太近会永久丢一条
- 位置：`frontend/src/stores/chatStore.ts:227-240` —— 新消息到达时 `clearTimeout(proactiveTimer)` 取消的是**上一条还没落屏的投递**；后端 `consumeMessage()`（`routes/chat.js:150-156`）已经把它弹出入队，无法找回
- 影响：「早安 + 任务提醒」这种成组投递正是常见场景，用户少收到一条，且没有任何痕迹。
- 修法：改成 FIFO 队列 + 单条串行定时器，禁止取消待投递消息。

### FE-03 · P0 · 流式过程中来一条主动消息，两条气泡一起坏掉
- 位置：`chatStore.ts:120-128`（`appendDelta` 追加到「最后一条 assistant」）、`:101-109`（`finishWith` 覆盖最后一条）、`:227-240`（主动消息也 push assistant）、`ChatPage.tsx:134`（空正文不渲染）
- 时序：占位空 assistant → 主动消息入列 → delta 全写进**主动消息**气泡 → `finishWith` 用流式回复覆盖它 → 原占位永远空字符串且不渲染。结果：一条串词的气泡 + 一条隐形气泡 + 全程无报错。`isLoading` 只挡「发送」不挡「到达」。
- 修法：用 `streamingMessageId` 定位写入目标；或流式期间挂起主动消息投递。

### FE-04 · P0 · 流式中途失败会**重跑整轮对话**：好感度加两次、性格漂两次、钱付两遍
- 位置：`frontend/src/hooks/useChatStream.ts:82-95`（任何非超时错误都回退 `api.sendChat`）+ `AiGirlfriend._finalize:580-593`（服务端在第一轮就已经写历史、结算好感度与性格）
- 触发面很宽：SSE 单帧 `JSON.parse` 无保护（`api.ts:330`，代理注入 `data: [DONE]` 或截断帧即可）、`payload.type==='error'`、非 JSON 的 5xx 响应、甚至 `settle()` 自己抛错（被 `:92` 的空 `catch {}` 吞掉后同样走回退）。
- 影响：对话历史出现重复 user 消息、好感度双份增量、性格双份漂移、事实提取重复调用、**用户为同一句话付两次钱**。这是全部审计里性价比最高的一处修复。
- 修法：只有在「一个 delta 都没收到」时才允许回退 `/chat`（加 `gotDelta/gotDone` 标记）；否则报错并停止；每帧 `JSON.parse` 加 try/catch。

### FE-05 · P0 · 后端比前端晚起 = 看起来历史被删了，且永不自动恢复
- 位置：`chatStore.ts:175-181`（`fetchHistory` 只 toast 一次）、`:204-225`（`syncState` **完全静默** `catch {}`）、`useBootstrap.ts:39-40`（两者只在挂载时各跑一次，之后没有任何重试）
- 影响：空消息列表 + 欢迎语 + localStorage 镜像好感度，界面上没有任何「后端未就绪」的状态；用户合理推断是「记录没了」。配合 `docs/…` 里没有一句提到这个约束（见 HTTP-05）。
- 修法：`uiStore` 加 `backendOnline` 状态 + 常驻横幅；首次成功后重跑 `syncState()+fetchHistory()`；失败期间每 30s / `visibilitychange` 重试。

### FE-06 · P0 · 「完全重置」的部分成功路径在前端是死代码
- 位置：`api.ts:149`（207 也按错误 throw）→ `SettingsDialog.tsx:228-231` 提示「重置失败…后重试」并**跳过 reload**；`:219-224` 专门处理 `status==='partial'` 的分支永远进不去
- 影响：服务端其实已经清空，UI 仍显示旧对话与旧好感度，且 `:218` 的 `remove("affinity")` 没执行 → localStorage 镜像与服务器矛盾。与 HTTP-08 是同一根因的两端。
- 修法：见 B0-8。

### FE-07 · P1 · 状态同步群：一份数据三处真相，乐观更新没有回滚
- `syncState` 挂载后**再也不调**（`chatStore.ts:204`），而服务器端好感度会随时间衰减 → 长时间会话里面板显示的是几分钟前的数字；`ProactiveStatusStrip.tsx:59` 轮到的状态里**就带 affinity**，却不回填（同一数字三份：`chatStore.affinity` / `engine.affinity` / `MemoryDialog` 本地 state）
- `MemoryDialog.tsx:201` 手动调好感度：先本地 `setAffinity`（还写 localStorage，`chatStore.ts:146-149`）再请求，失败只 toast（`:205-210`）→ 错值跨刷新存活；`POST /state` 返回的新 stage 元数据被丢弃
- `usePersonality.ts:88-97` 乐观写 baseline 不回滚；`:165-169` 卸载时清掉 300ms 防抖 → **拖完滑块立刻关设置页，这次编辑静默丢失**
- `usePersonality.ts:75-77`：账本拉取失败也报「性格保存失败」（保存其实成功了）
- `chatStore.ts:191-198`「新对话」无在途保护：流式途中清空 messages，回来的正文被 `appendDelta` 丢弃（服务器有、刷新后又出现）
- `SettingsDialog.tsx:78-107` 主动消息配置双源（localStorage 先播种、服务器再覆盖、退出时全量写回），且 `:105-106` 硬编码了一份 8 个类型的默认列表（注释自己承认是在抄 `proactiveTypes.js`）；`getProactiveConfig` 失败只 `console.error`
- `Modal.tsx:18-35`：点遮罩/Esc 直接关闭，而 `SettingsDialog` 所有编辑都在本地 `useState` → 一次误触丢掉刚敲的 API Key，无 dirty 检查
- `useBootstrap.ts:38-39` 镜像恢复与真值拉取赛跑：`syncState` 失败时界面用的就是 localStorage 里那个**未校验**的值（`storage.ts:173-178` 接受 9999/负数，`AffinityHearts.tsx:11` 与 `/100` 文案于是开始说谎）

### FE-08 · P1 · 错误与离线态：全站 catch 静默，401 被翻译成误导文案
- `syncState` / 两个轮询器 / `useActivityPolling` 全部静默吞错 → 应用没有「后端不可用」这个概念（只有主动消息页一个小圆点）
- **没有任何 UI 能填 token**：`api.ts:28` 定义了 `AUTH_TOKEN_STORAGE_KEY` 并读取，但全仓库只有 `api.ts` 两处引用、从不写入；后端 401 的 `detail`（`auth.js:141-147`）在前端变成「配置同步失败，请确认后端已启动」（`useBootstrap.ts:50`）或被彻底吞掉 → 配错 token 与后端宕机无法区分，唯一出路是开 devtools
- `useChatStream.ts:97-99` 把所有错误统一改写成「⚠️ 连接中断…」：`API Key not configured`（`chat.js:62,97`）本该引导去设置页，却被说成网络问题
- `:62/97` 60s 超时后 UI 报错，但服务端那一轮**已经完成并改了状态**，前端不重同步，`setStoredAffinity` 还写入了旧值
- 全仓无「停止生成」按钮，错误路径也不 `reader.cancel()`（`api.ts:308-365`）→ 悬挂的响应体
- `Toast.tsx:18-21` 的定时器依赖含 `onClose`（`ToastViewport.tsx:27` 每次 store 变化都新建内联箭头）→ 错误循环下 toast 永不过期、按 `top: 1rem+idx*4.5rem` 一路堆下来盖住聊天区；`uiStore.pushToast`（`:45-46`）无去重无上限
- `api.ts:240-251`：后端 503（开关关了/队列满）被 `ProactiveStatusStrip.tsx:88` 报成「触发失败，请检查后端连接」

### FE-09 · P1 · 数据安全与文案不实
- `ApiConfigStep.tsx:74-76` 明写「API 密钥仅保存在本地浏览器中，不会上传到任何服务器」—— **不属实**：每次启动都会 POST 给 `BACKEND_URL`（`useBootstrap.ts:46-51`）并转发给服务商；若 `NEXT_PUBLIC_BACKEND_URL` 指向远端就是明文出网，且这条配置路径没有任何告警
- `FirstRunWizard.tsx:38-44`：`hasCompletedSetup=true` 写在 `await api.syncConfig` **之前** → 同步失败后刷新页面不再进向导，应用卡在「连接中断」且后端未配置
- `MemoryDialog.tsx:342,375` 单条记忆删除、`PersonalityPresetGrid.tsx:53` 切换预设（会清掉全部漂移）都是**单击即改**，而「新对话/清除记忆/完全重置」有二次确认 —— 破坏性分级不一致
- `DialogLayer.tsx:19/28` 导出的是 `chatStore.messages`（即上次 `fetchHistory` 的内存快照，失败时为空），却在 `ExportDialog.tsx:116` 被标为「适合备份」；导出内容含 `thought`（内心独白，`:39`），ghost 的 system 通知被标成「💖 小爱」（`:55`），`URL.revokeObjectURL` 在 `click()` 后同步调用（`:31`）

### FE-10 · P1 · 无障碍与触控基本缺位
- 对话框无 `role="dialog"`/`aria-modal`、无焦点移动/归还/陷阱、无滚动锁（`Modal.tsx`，全 `src` 零 `.focus()` 调用）；`ConfirmDialog` 不监听 Esc，且它打开时底下 `Modal` 的 Esc 处理仍会关掉设置页
- `Field.tsx:15-21` 的 `<label>` 没有 `htmlFor` 也不包裹控件 → 所有 Key/URL/模型/温度输入框都没有可访问名称（含 API Key 密码框）
- 移动端抽屉无标签无遮罩无焦点管理（`ChatPage.tsx:96-118`）；`CharacterAvatar.tsx:57-62` 是带 `onClick` 的 div（键盘不可达）；`AffinityHearts.tsx:15-27` 纯 ❤️/🤍 无文本替代
- **hover 才出现的操作在触屏上永久不可见**：`MemoryDialog.tsx:333,378` 的编辑/删除按钮 `opacity-0 group-hover:opacity-100` → 手机上记忆只能加不能删改
- `PersonalitySlider.tsx:66-75` 原生 range `opacity-0` 导致焦点环也看不见；`MemoryDialog.tsx:432-439` 的 range 既无 `aria-label` 也不被 label 包裹
- 流式内容无 `role="log"`/`aria-live`（全 `src` 零 `aria-live`）→ 新回复对读屏等于没发生；`SegmentedControl.tsx:36-53`、`ThemeDialog.tsx:44-72` 的选中态只靠颜色/✓ 表达
- **reduced-motion 下立绘会永久卡在旧表情**：`utilities.css:130-143` 对 `.animate-avatar-fade-out` 设 `animation:none !important`，`CharacterAvatar.tsx:74` 的 `onAnimationEnd` 于是永不触发 → 覆盖层以满不透明度盖住新表情（`MotionProvider` 的 `reducedMotion="user"` 管不到 CSS 动画）
- 对比度：47 处 `text-[10px]`，`--text-muted` 在 `--surface-1` 上约 **3.4:1**（小字号不达标）；`.gradient-text`（`utilities.css:117-127`）把 L72 的渐变用在 24px 标题上，约 2.7:1

### FE-11 · P1 · 类型安全：后端 JSON 全程无校验，可选字段当必选
- `api.ts:154` `(await res) as unknown as T`（`raw` 分支其实无人调用）、`:52` headers 断言、`:330-360` `JSON.parse` 后逐字段手工映射驱动 `ChatResponse`、`ChatMessage.tsx:87` `thought as string`、`emotionMap.ts:65` `as EmotionKey`
- `SettingsDialog.tsx:56/81/97` 把 localStorage 值直接 `as TtsEngine` / `as "low"|"medium"|"high"` / `as string[]` **不校验** → 脏值一路流进后端 payload，并让 `FREQUENCY_INFO[frequencyLevel]` 变 undefined，`SettingsProactiveTab.tsx:138-140` 读 `.name` 直接崩
- `PadStateBars.tsx:19` 无保护解构 `emotionalState.current`：老后端/异常响应给 `{}` 时在 `CharacterPanel` 里抛错，**整条侧栏空白**；`:71` `.toFixed()` 假设是数字
- `types/index.ts:61-67` 把 `recentChange/decaying/dailyCapReached` 标成**必选**，而 `:86-92` 与 `chatStore.ts:89-92` 当可选处理；`ProactiveEngineStatus`（`:154-175`）声明 14 个必写字段，`ProactiveStatusStrip.tsx:27-41` 又逐个兜默认值 —— 类型与代码对同一份 payload 的认知相反

### FE-12 · P2 · 渲染性能与体积
- `DialogLayer.tsx:19` 订阅 `messages` → **每个 SSE delta 都重渲染 DialogLayer 并重建 5 个 Modal**；`useAutoScroll.ts:30-38` 每 delta 一次 `matchMedia` + 强制布局读取；`AudioVisualizer.tsx:62-73` 每帧为每根条新建 `createLinearGradient`（≈1.9k 对象/秒）
- `useSakuraEffect.ts:14-31` 在 reduced-motion 下仍持续 append 节点（动画被 CSS 关掉 → 花瓣变成堆在 body 上的静态块）；`ChatPage.tsx:130-141` 的 `AnimatePresence` 子项没有 `exit`，纯开销
- 大文件：`MemoryDialog.tsx` 478、`api.ts` 419、`SettingsDialog.tsx` 401（6 个页签 + 全部配置态 + 2 条重置流程挤在一个组件）、`types/index.ts` 374；`useVoiceRecorder.ts:68-70` 每秒 tick 让整页在录音时重渲染
- `NumberField.tsx:40-42` 只在挂载时取 `value` → 程序化改「高级选项」后输入框不同步；`themeStore.ts:39-53`/`settingsStore.ts:15-17` 在模块作用域读 localStorage，`layout.tsx:28` 用 `suppressHydrationWarning` 把整棵 `<html>` 的水合告警静音

### FE-13 · P2 · 移动端与 CSS 细节错误
- `ChatPage.tsx:89` 用 `h-screen`(100vh) → iOS/Android 上输入坞被地址栏吃掉、键盘弹出时跳动；应改 `h-dvh`
- 全仓无 `export const viewport = { viewportFit: 'cover' }` → `ChatPage.tsx:146` 的 `env(safe-area-inset-bottom)` 恒为 0，**safe-area 适配实际是空操作**
- `EmojiPicker.tsx:50` 固定 `w-[344px] left-0` 锚在第 2 个 chip 上 → 375px 屏被 `body{overflow-x:hidden}` 裁掉约 28px
- `TypingIndicator.tsx:18-19/37-38` 用 `delay-75/delay-150`：Tailwind v3 里这是 **transition**-delay，动画延迟从未生效（三个点齐步跳），应为 `[animation-delay:75ms]`
- 触控目标 <44px：`ChatToolbar.tsx:44`(36px)、`Switch.tsx:22`(24px)、`Checkbox.tsx:29`、`QuickReplies.tsx:37`(~30px)、`TaskItem.tsx:119`(~24px)
- `AudioVisualizer.tsx:92-97` canvas 未按 `devicePixelRatio` 缩放（糊），`:72` `ctx.roundRect` 在老 Firefox 抛错无兜底；`CharacterAvatar.tsx:40-45` `<img>` 无 `width/height/loading`（CLS + 首次切换闪）
- `themes.css:48-49/76-99` 亮/暗与四主题**同特异度、靠源码顺序取胜** → 调整 `layout.tsx:5-8` 的 import 顺序会静默弄坏深色模式
- `.message-bubble` 的 CSS 动画与 `ChatMessage.tsx:63-66` 的 framer-motion 在进入动画上叠了两套

### FE-14 · P2 · 死代码与「第二份真相」
- 前端零调用：`api.ts:162 getAffinityLedger`（后端账本 UI 根本不存在）、`api.ts:137-154 raw` 选项、`speech.ts:41-43 stopLocalSpeech`（云端朗读开始时不会取消本地语音）
- 后端有接口、前端无入口：`GET/DELETE /state/narratives`（**「删除叙事」没有 UI**）、`GET /state/user-emotion`、`GET/POST /system_prompt`
- `SettingsAdvancedTab.tsx:28` 硬编码「后端 API 版本: v1.2.0」—— 无真源、必然腐烂
- `types/index.ts` 把 stage 元数据在 `AppState` 与 `ChatResponse` 各写一遍，`api.ts:334-360` 再手抄第 3 遍（`:340-343` 的注释记录过这里曾经断过）

### FE-15 · P2 · 语音与输入正确性
- `useVoiceRecorder.ts:38-77`：连点录音会起两路 `getUserMedia`（第一路从不 `stop()`，系统麦克风指示灯常亮）；所有失败（含「无麦克风」/不支持 `MediaRecorder`）都报成「麦克风权限被拒绝」；`api.transcribe` 对任何失败都返回 `null`（`api.ts:415-417`）→ 录音**静默消失**；无最长时长上限
- `ChatInput.tsx:56-64`：回复期间禁用输入框导致失焦，每次答完要重新点一下；`:60` 的 `onKeyDown` 没有 `!e.nativeEvent.isComposing` 守卫 → **中文输入法「上屏回车」会把半截拼音直接发出去**
- `MemoryDialog.tsx:145` 用 `e.message.includes("409")` 判重，而 `api.ts:151` throw 的是后端 `detail` → 「已有类似记忆」分支基本不触发；`:186-196` 删完不刷新 `stats`，页脚计数还是旧的
- `ProactiveStatusStrip.tsx:112-115` 的在线圆点跟着**未保存**的本地 `enabled` 变 → 保存前就显示「已暂停」
- `useProactivePolling.ts:77-84` 把消息全文推进桌面通知（锁屏可见）且无静音开关

### FE-16 · 已核查为「不是问题」的项
episode `timestamp * 1000` 正确（后端存 epoch 秒，`MemoryStore.js:105`）；`useProactivePolling`/`useVoiceRecorder` 的回调都经 ref 转发（无陈旧闭包）；`speakBus` 只有一个注册方（`ChatPage.tsx:47`）；`toBackendConfigPayload` 对 `max_tokens:0`/`reasoning_effort:""` 的 `??` 处理正确；`ProgressBar`/`StageProgress` 有 clamp。

## 6. 工程基建（测试 / CI / 依赖 / 仓库 / 文档）

### INFRA-01 · P0 · 两条测试永远不会失败，CI 绿灯是假的
- `scripts/test-stream-filter.mjs` 末行用硬编码 `const TOTAL = 16` 只统计 `passed`。断言失败时确实会 `process.exitCode = 1`（本条比初判更轻），但**没有 failed 计数**，且用例被删/提前 return 导致 `passed !== 16` 时只打印「存在失败」却仍然 exit 0 → CI 绿。
- `scripts/test-memory.mjs:559` 把 `async` 函数传给**同步**的 `check()`（定义在 `:29-39`）：`try/catch` 看不到后续 rejection，`passed++` 立刻发生，里面两条断言（无 Key 时 `available===false`、`embed()` 返回 null）**从未被执行**。同文件 `:40-50` 已有 `checkAsync` 且被正确使用 9 次，只漏了这一处。
- 影响：这两个文件恰好覆盖「标签剥离单一真源」和「无嵌入时降级」两条最容易被改坏的路径。它们等于没有测试。
- 修法：统一改成 `if (failed>0) process.exit(1)` + 断言总数由脚本自己数出来（不写常量）；`test-memory.mjs:559` 改 `await checkAsync(...)`。

### INFRA-02 · P1 · 布尔式 check 只报「全部通过」，不报跑了多少
- 位置：`test-proactive-gating.mjs:16-23`、`test-trigger-registry.mjs:19-26`、`test-triggers.mjs:18-25`
- 现象：只有 `failed===0` 就打印「全部通过」，没有 `passed` 计数、没有期望总数。整节被跳过也报绿。
- 修法：三个套件补 `passed/expected` 双计数并断言相等（与 INFRA-01 一并做）。

### INFRA-03 · P1 · `test-reset-all.mjs` 既不在 CI 里，又会真删用户数据
- 位置：`backend-node/package.json:11`（test 链里没有它）；`:26-41,56-62` 直接改真实 `emotion_state.json` / `tasks.json` 并据此断言，**无备份无还原**；`:44` 创建 `data/affinity_test_tmp.json`，`:54` 用 `catch {/* ignore */}` 吞掉删除失败（本次审计前该残留文件就在 `data/` 里，已被我清掉）
- 叠加：`:50` 的断言 `aff.affinity === aff._affinity` 是**同义反复**（getter 比自己的后备字段），永远为真。
- 影响：最危险的 `resetAll()` 路径，其回归测试既不会被 CI 执行，本地跑一次又会破坏真实状态。
- 修法：B0-3（数据目录可重定位）落地后把它挂进 `npm test`，并把同义反复断言改成与常量默认值比较。

### INFRA-04 · P1 · 用「源码字符串」当断言，行为坏掉测试还绿
- 位置：`test-personality.mjs:468-495`，例如 `:477` 断言源码含 `const sentiment = emotionDelta?.P ?? autoDelta.P;`、`:491` 找 `resetAll() {`、`:483-486` 比较 `settleDaily` 与 `shouldGhost` 的字符下标顺序、`:470-473` 用正则禁止四个文件里出现 `jsonStore|from 'fs'|fetch\(|await `
- 影响：字符串在但调用被删 → 绿；无害重排/改名 → 红。这类断言把「实现细节」钉死，却不验证任何行为。
- 修法：改成行为断言（调用引擎后检查状态/账本），顺序类约束用注释 + 一条真实调用序测试替代。

### INFRA-05 · P1 · 覆盖盲区：18/63 个源文件零测试，7 个路由只碰过 1 个
- 零覆盖清单：`app.js`、`server.js`、`routes/{chat,configRoutes,state,tasks,audio,life}.js`、`core/Voice.js`、`core/LifeSimulator.js`、`core/{taskActions,taskTime}.js`、`core/prompts/{proactivePrompts,relationshipContext,taskPrompt}.js`、`middleware/{asyncHandler,errorHandler,validate}.js`
- 前端：71 例只覆盖 4 个纯函数文件；`lib/api.ts`（最大模块、承载鉴权头与 SSE 解析）、6 个 store、9 个 hook、约 70 个组件**全部零测试**。
- 影响：本次 HTTP/CORE 审计发现的多数缺陷（`/system_prompt` 清历史、断开不中止、404 返 HTML）正好落在盲区里 —— 有测试框架也拦不住，因为根本没写到。
- 修法：见 B5 的「路由层最小 HTTP 测试 + 5 个高价值前端单测」。

### INFRA-06 · P1 · CI 门禁的四个空洞
- 位置：`.github/workflows/ci.yml`
- ① 后端**没有 lint**（零 `devDependencies`，无 eslint 配置）；② `npm test` 用 `&&` 串联，**第一个套件失败后 2~10 全不跑**，一次只暴露一个问题；③ **不跑 `next build`**，生产构建（RSC/CSS/资源）完全未验证（README:193 还把它列为手工步骤）；④ 没有任何**启动冒烟**：CI 从不 `node src/server.js`，`container.js` 装配顺序、端口绑定、`data/` 初始化、CORS 都不被验证。
- 另外：CI 直接 `npx tsc/eslint/vitest`，绕开 `package.json` 脚本，而前端 `"lint": "eslint"` 根本没带目标 —— 本地 `npm run lint` 与 CI 结果可以长期不一致。
- 修法：套件改为「全部跑完再汇总失败数」；补 `next build`；补一步 boot smoke（起后端 + `GET /health` + `GET /config/status`）；后端引入 eslint；CI 改调 `npm run` 脚本。

### INFRA-07 · P1 · `check-syntax` 只解析不链接，且不含 scripts/
- 位置：`scripts/check-syntax.mjs:12`（只遍历 `src/`）、`:29-30`（`vm.SourceTextModule` 解析不 link）
- 影响：写错 import 路径、改名后漏改的导出，`npm run check` 全绿，只有跑到那条 import 的测试才炸；`scripts/` 下 21 个脚本连语法检查都没有。
- 修法：check 之后补一步 `node --input-type=module -e "await import('./src/services/container.js')"` 的真导入冒烟；遍历范围加 `scripts/`。

### INFRA-08 · P1 · `POST /config` 完全不校验，可把 Key 指向任意主机
- 位置：`routes/configRoutes.js:19-33`（未 import `validate.js`）、`routes/life.js` 同样无校验；`middleware/validate.js` 全文只有 14 行的 `fail(res, cond, detail)`，**没有任何类型/形状/范围校验能力**
- 影响：`base_url` 无 scheme/主机白名单 → 任何能到达该端口且持有 token 的一方都能把后续对话（含 `api_key` 头）改指向外部主机；填了非法值则整条对话链路静默失败，且没有回滚。
- 修法：引入 `zod`（或手写等价 schema）给 `POST /config` 做形状校验 + `baseUrl` 必须是 `http(s)` 且默认只允许本机/白名单域名，非白名单时响应里显式回显并打日志告警；同时给 `/config/status` 增加「当前 baseUrl」高亮字段。

### INFRA-09 · P2 · 文档与仓库的失真点
- `docs/companion-upgrade/03-implementation-status.md:77` 声称 `npm test` 含 `test-reset-all` —— **不实**（见 INFRA-03）。
- `docs/companion-upgrade/W1-verification.md:6` 称 `_qa_w1_probe.mjs`「随仓库保留」—— 两个 `_qa_*.mjs` 实际**未被 git 跟踪**，克隆后无法复现验收证据。
- `docs/companion-upgrade/W2-verification.md:21` 的「39 项断言」与实际可执行调用点数（37）不符。
- `README.md:187-188` 注释仍写「流式过滤器单元测试」，实际已跑 10 个套件；`:43` 说 middleware 提供「参数校验」，与 INFRA-08 不符；`:110-135` 接口表**缺 `POST /memories/facts` 与 `PATCH /memories/facts/:id`**（`routes/state.js:65,91`，表内路径均真实存在，无虚列）。
- `frontend/README.md` 仍是 create-next-app 模板原文；`docs/` 无索引 README；文档命名大小写漂移（`DESIGN.md`/`design.md`、`PRD.md`/`prd.md`）。
- 修法：与 B5 的文档校正任务合并处理。

### INFRA-10 · P2 · 无 `.env.example`，37 个 env 旋钮全靠读源码
- 实测：仓库内 `find . -name '.env*'` 为空；`src/config.js` 读取 37 个 `process.env.*`；`middleware/auth.js:173` 还在提示「在 backend-node/.env 中写入 …」，但没有任何文件说明形状。
- 附带：`scripts/start_services.py:11-12,56-57` 硬编码 `D:\AI-Projects\ai-girlfriend`，且 `DETACHED_PROCESS` 等常量在 POSIX 不存在 → 换机/换系统即失效；`diag-*.mjs` 依赖 `playwright-core`，但该包**不在任何 package.json/lockfile 里**，克隆后必然抛「找不到 playwright-core」。
- 修法：补 `.env.example`（含注释分组）；启动脚本改为相对仓库根推导路径；`diag-*` 要么声明依赖要么移出仓库。

### INFRA-11 · P2 · 无日志体系、无健康端点、500 不可复现
- `src/` 内 138 处 `console.*`，零 logger 依赖；`middleware/errorHandler.js:9` 只打 `err.message`，**从不输出堆栈**；`AiGirlfriend.initOpenAI():229-232` 把构造失败吞成 `console.error` 并留下 `this.openai = null`，故障延后到第一次对话才暴露。
- 44 个路由里没有 health/version：探活只能打 `GET /config/status`（它同时也是配置面）。前端 `api.ts` 因此无法区分「后端死了」与「未配置」。
- 修法：`GET /health` 返回 `{ok, version, model, dataDirWritable, llmConfigured}`（免鉴权，只回非敏感字段）+ 引入极简 logger（带时间戳与 level，错误打堆栈）。

### INFRA-12 · P2 · 数据不可备份/迁移
- `data/` 整体被 `.gitignore:30` 忽略（无 fixture、无 schema 回归基线）；导出只有聊天气泡（`frontend/src/components/dialogs/ExportDialog.tsx:22-62`），`memory.json`/`narrative.json`/`personality_state.json`/`affinity_state.json`/`tasks.json` 均无导出入口 → 换机即丢整段关系，`POST /reset` 后不可恢复。
- 附带：无 `.gitattributes`（Windows 检出 + Linux CI 的 CRLF 漂移未管理）；`.gitignore` 漏了 `.workbuddy-ai/`（下次 `git add -A` 就会提交）；`backend-node/diag-*.png` 约 1.6 MB 本地噪声。
- 修法：把「导出/导入全量档案（含 data/ 全部 JSON + 校验和）」做成设置页一个按钮，作为 B0 之后的第一优先体验项。

## 7. 陪伴感路线图阻塞项（ROAD）

逐条评估与「必须先改的形状」已写进 [`02-plan.md`](./02-plan.md) 的 B6 表。这里只记录**证据级**的阻塞点：

| 需求 | 阻塞证据 |
|---|---|
| REQ-02 共情策略 | 策略表 `userEmotionPrompt.js:16-35` 无运行时调用点（PROMPT-01）；`EmotionEngine.getStyleGuide:184-247` 的入参只有她自己的 P/A/D，**没有任何位置接收用户情绪**；`_finalize:569-573` 她的 delta 也完全不受用户情绪调制 |
| REQ-05 话题闭环 | `followupCount` 恒 0 → 追问一生一次（CORE-19）；`sourceEpisodeId` 从不写入 → 无法回溯「上次聊的事」；全仓**没有话题级未来时间抽取**（`taskPrompt.js:145` 还禁止模型输出"明天"这类相对词） |
| REQ-06 跃迁仪式感 | `updateBaselineForAffinity` 已经算出并返回 `tierChanged`，**返回值在 `AiGirlfriend.js:445` 被丢弃**；`TRIGGER_EVENTS`（`triggerEvents.js:25-34`）里没有 stage 变化事件；各阶段文案是一坨散文，没有机器可读的「解锁项」 |
| REQ-07 自适应节奏 | **响应率遥测不存在**：`recordProactiveMessage:941` 把主动消息混进 history 时不带任何标记，`consumeMessage` 也不记录客户端是否取走 → 没有任何数据能算「她主动发的你有没有回」 |
| REQ-08 人格外显 | `personalityPrompt.js:66-102` 只输出形容词档位，无行为策略；`willfulness` 维度只改数字、无人消费；`affinityRules.js:100-116` 是**读她自己的输出**来事后惩罚，而不是事前给边界策略；且 CORE-12 会在 ghost 期间把维度算脏 |
| REQ-09 冷落分层 | 情绪**没有**离线结算（`decay` 只往基线收），而好感度有 `settleDecay`；`notifyUserActive` 在每次 HTTP chat 都调（`routes/chat.js:66`，含失败轮）→ 闲置时钟被流量而非互动重置；`life_log.json` 只留 24 h，多日离开无话可说 |
| REQ-13 纪念日 | `occurredAt` 与 `recurring.anniversaryDate` 互不校验（`NarrativeStore.js:86-93`），`monthly` 把 30 号钳成 28 号（`NarrativeRetriever.js:54-61`），prompt 从不要求 `occurredAt`（`narrativeTypes.js:197-198`）→ 年份永远等于「抽取那天」 |

另有 `docs/proactive-consistency/DIAGNOSIS.md:158-163` 记录、本次仍未修的三条：主动消息不反馈情绪/好感度、主动消息解析出的 `emotion` 后端不消费、前端投递无间隔。
