# 增量 PRD：小爱任务清单系统重构

> 增量文档 —— 只描述**变更部分**。未提及的模块（好感度、情绪、记忆、生活模拟、TTS）保持现状不动。

## 1. 项目信息

| 项 | 值 |
| --- | --- |
| Language | 中文 |
| Programming Language | 既有栈：frontend = Next.js 16 + React 19 + Tailwind；backend = Node + Express 4（ESM） |
| Project Name | `ai_girlfriend_task_system_refactor` |
| 变更范围 | backend：TaskManager / ProactiveEngine / proactiveTypes / AiGirlfriend / prompts.systemPrompt / routes.chat / routes.tasks；frontend：types / api / 新增 taskStore / useChatStream / TaskDialog |

**原始需求复述**：对「小爱的任务清单」提示系统进行重构与优化 —— ① 让 AI 能正确识别用户意图并自动布置清单；② 在适当的对话时机提醒用户任务。

**现状痛点（本次要消灭的）**
1. 对话链路零任务意图识别：说「明天下午 3 点提醒我开会」，任务不会被创建，只能手动加。
2. 提醒只会命中「dueTime 前 15 分钟」，且没有「已提醒」标记 —— 冷却（30min）一过同一任务反复提醒。
3. `reminderTime` 字段存在但从未被使用。
4. 逾期任务永远不提醒（`getDueSoonTasks` 要求 `due > now`）。
5. 任务提醒受每日主动消息配额限制，配额用完用户自己设的提醒也发不出去。
6. `addTask` 里 `...taskData` 展开在默认值之后，外部入参会覆盖 `id / completed / createdAt`。
7. 前端「今日进度」统计的是全部任务而非今日任务；逾期任务无视觉标记。

## 2. 产品定义

### 2.1 Product Goals（3 个正交目标）

- **G1 说得出口就记得住**：用户用自然语言说出代办/提醒意图时，小爱在同一轮对话内完成建单，并在 UI 上让用户明确感知到「她记下了」。
- **G2 提醒只说一次、该说的一定会说**：每条任务的「到期前 / 自定义时刻 / 逾期」三类提醒各自最多触发一次，逾期任务不再被漏掉，且提醒不被每日主动消息配额吃掉。
- **G3 对话里自然地提**：小爱在合适的话题里顺口提一句快到期/已逾期的任务，而不是生硬播报、也不是每轮都提。

### 2.2 User Stories

1. As a 用户，我想对小爱说「明天下午 3 点提醒我开会」，这样我不用打开任务弹窗手动填表单，她就帮我记下了。
2. As a 用户，我想在小爱帮我建单后立刻看到一条提示（toast + 任务弹窗里的 ✨ 标记），这样我知道她真的听懂了、也知道记的内容对不对。
3. As a 用户，我想在任务到期前被提醒一次、逾期了也被提醒一次，而不是被同一条任务反复轰炸或彻底漏掉。
4. As a 用户，我想在我设的自定义提醒时刻（reminderTime）被提醒一次，这样「提前 10 分钟叫我」这种说法能真的生效。
5. As a 用户，我想看到「今日进度」真的只统计今天的事、逾期任务有醒目标记，这样我一眼知道现在该做什么。

## 3. 技术方案与需求池

### 3.1 契约设计（先定契约，后端前端都按它改）

#### 3.1.1 LLM metadata 扩展（P0）

在**现有 `<metadata>` JSON 内部**追加一个**可选**字段 `task_action`（不新开 XML 标签）：

```json
<metadata>{"emotion":"开心","affinity_change":0,"emotion_delta":{"P":0.1,"A":0,"D":0},
"task_action":{"action":"add","title":"开会","dueTime":"2026-10-01T15:00:00+08:00"}}</metadata>
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `action` | `"add" \| "complete" \| "delete" \| "none"` | **缺省/不写 = none = 不执行任何写操作** |
| `title` | string | `add` 必填；`complete`/`delete` 用于匹配 |
| `dueTime` | ISO 8601 字符串 \| null | 由 LLM 直接给出绝对时间 |
| `taskId` | string \| undefined | 可选，命中 `[System Context]` 里注入的任务 id 时给出，用于精确匹配 |

**选型理由（决策，已拍板）**
- 放 metadata 内部而非新标签：streamFilter 已能完整捕获 `<metadata>`，新标签要改 TAGS 状态机 + 三条解析路径；放进 JSON 是纯追加字段，老模型不输出时行为**完全不变**（向后兼容硬约束）。
- 单条对象而非数组：小模型输出数组易漏易错；`add` 场景一輪一条覆盖 95% 需求。后端解析层统一 `toArray()` 归一化，P1 放开数组时零改动。

#### 3.1.2 后端 → 前端 `/chat` 与 `/chat/stream done` 新增字段（P0）

```ts
taskResult: {
  action: "add" | "complete" | "delete" | "none";
  ok: boolean;
  task?: Task;                       // 变更后的任务实体
  reason?: "missing_title" | "bad_due_time" | "duplicate"
         | "not_found" | "ambiguous" | "unknown_action";
} | null
```

`routes/chat.js` 新增 `taskPayload(result)` helper，与现有 `affinityPayload(result)` 平级，/chat 与 /chat/stream 的 done **共用** —— 沿用项目既有手法，避免两处独立手写导致「流式有、非流式没有」。

#### 3.1.3 Task 实体字段追加（P0，纯追加不删改）

```ts
source: "manual" | "ai";                       // 默认 "manual"
reminderState: {                               // 默认 {}
  dueRemindedAt?: string;                      // 到期前提醒已发时间
  customRemindedAt?: string;                   // reminderTime 提醒已发时间
  overdueRemindedAt?: string;                  // 逾期提醒已发时间
  dialogMentionedAt?: string;                  // 对话内提及时间（P1 防抖用）
}
```

`data/tasks.json` 老数据无这两个字段 → `TaskManager._load()` 一次归一化补齐（幂等迁移）。

### 3.2 需求池

#### P0（Must have —— 缺一项本次重构不成立）

| # | 需求 | 落点 | 验收标准 |
| --- | --- | --- | --- |
| **P0-1** | **AI 意图识别**：在 `buildSystemContext()` 的 `[Response Instructions]` 第 3 条（Metadata）后追加 `task_action` 规则段，含**正向触发清单**与**反向禁止清单** | `prompts/systemPrompt.js` | 说「明天下午3点提醒我开会」→ 建单成功；说「我今天开了个会」「任务好多啊」「你上次提醒我的事」→ `action:none`，不建单 |
| **P0-2** | **任务上下文注入**：`_prepare()` 的 `taskText` 从「N 条待办 + 前 3 条标题」升级为「最多 5 条，格式 `[id] 标题（10月1日 15:00 / 今日 / 无时间）`，并单独标出「已逾期」「1 小时内到期」」 | `AiGirlfriend._prepare()` | 模型能在 `complete`/`delete` 时给出正确 `taskId`；人设 prompt 与既有文案逐字未变 |
| **P0-3** | **解析与执行**：`_parseReplyText()` 解析出 `taskAction`；`_finalize()` 内同步执行并产出 `taskResult`；**不新增任何 LLM 调用** | `AiGirlfriend.js` | 一次对话只有一次阻塞网络往返；/chat 与 /chat/stream 行为完全一致 |
| **P0-4** | **时间归一化**：后端宽松解析 `dueTime`（ISO / `YYYY-MM-DD HH:mm` / `YYYY/MM/DD HH:mm` / 带或不带时区），失败则**丢弃时间保留任务**并回 `reason:"bad_due_time"` | `core/taskTime.js`（新增小工具） | 「明天下午3点」「10月1日 15:00」「2026-10-01T15:00」三类输入都能落地 |
| **P0-5** | **TaskManager 修复与扩展**：① `...taskData` 展开移到默认值**之前**并改为字段白名单（`title/description/dueTime/reminderTime/completed/source`），`id/createdAt` 永不被外部覆盖；② 新增 `getReminderCandidates(now)`、`markReminded(id, kind, at)`、`getTodayTasks()`；③ `_load()` 归一化迁移 | `core/TaskManager.js` | 恶意 body 传 `id`/`completed:true` 无效；老 tasks.json 载入不报错且字段补齐 |
| **P0-6** | **提醒闭环**：ProactiveEngine 步骤 ② 改为消费 `getReminderCandidates()`，取优先级 `overdue > custom > due` 的第一条，入队**成功后** `markReminded()` | `core/ProactiveEngine.js` | 同一任务的同一类提醒在全生命周期内只触发一次；进程重启后（落盘）不重复 |
| **P0-7** | **逾期不再遗漏**：候选含 `overdue`（`dueTime <= now - 1min` 且未完成），为避免凌晨骚扰，**仅在 07:00–23:00 之间入队** | `TaskManager.getReminderCandidates()` | 昨天 14:00 逾期的任务，今天 09:00 会被提醒一次且只有一次 |
| **P0-8** | **配额与冷却**：`proactiveTypes.js` 中 `task_reminder` 的 `baseCooldown` 30min → **5min**（去重职责交给 `reminderState`，不再靠类型冷却硬扛），并新增 `quotaExempt: true` | `proactiveTypes.js` + `ProactiveEngine.canTrigger/_runCheck` | 当日主动消息配额打满后，任务提醒仍能发出；两条不同任务可在 5min 内各提醒一次 |
| **P0-9** | **前端契约**：`types/index.ts` 追加 `TaskActionResult`、`Task.source`、，`ChatResponse.taskResult`；`api.ts` 的 done 解析追加 `taskResult` 映射（**注意别再漏字段**） | `types/index.ts`、`lib/api.ts` | 流式与非流式都能拿到 taskResult |
| **P0-10** | **新增 taskStore**：`stores/taskStore.ts`（zustand，**无 persist**），持有 `tasks`、提供 `fetchTasks / addTask / toggleTask / removeTask / applyTaskResult(result)` | `stores/taskStore.ts`（新增） | 弹窗未打开时 AI 建单也能更新真源；刷新后与后端一致 |
| **P0-11** | **感知与反馈**：`useChatStream.settle()` 内若 `taskResult.ok` → `applyTaskResult()` + `toast("小爱帮你记下了：开会 ✨")`，失败则 `toast("小爱没太听清，你再说一次？","info")`；`TaskDialog` 改为消费 taskStore | `hooks/useChatStream.ts`、`dialogs/TaskDialog.tsx` | 建单后 toast 出现；打开弹窗立刻能看到新任务 |
| **P0-12** | **今日进度语义修正**：进度条只统计今日任务（`dueTime` 在今天，或今天创建且无 `dueTime`），标题改为「今日进度」并在无今日任务时整块隐藏、改显示一行「另有 N 条待办」 | `TaskDialog.tsx` | 昨天完成的任务不再计入今日分子；今天 0 条时不显示 0/0 空条 |
| **P0-13** | **逾期视觉标记**：未完成且 `dueTime < now` → 时间行变 `status-danger` 色 + 「已逾期」角标；排序：逾期 → 有到期时间 → 无到期时间 → 已完成 | `TaskDialog.tsx` | 逾期任务永远在列表最上方且一眼可辨 |

#### P1（Should have）

| # | 需求 | 落点 | 说明 |
| --- | --- | --- | --- |
| **P1-1** | `reminderTime` 真正生效：候选窗口 `(now-15min, now+15min]`，命中后 `customRemindedAt` 落盘 | TaskManager + ProactiveEngine | 「提前 10 分钟叫我」这类说法可落地 |
| **P1-2** | 对话内顺带提醒：`_prepare()` 注入一段软指令（快到期/已逾期可在话题自然时提一句，不生硬播报），并用 `dialogMentionedAt` 做 24h 防抖 | systemPrompt.js + TaskManager | 防每轮复读 |
| **P1-3** | AI 来源标记：卡片显示 ✨ + tooltip「小爱帮你记的」 | TaskDialog.tsx | 手动/AI 来源可区分 |
| **P1-4** | `task_action` 支持数组（一次说多件事），后端 `toArray()` 归一化后逐条执行 | AiGirlfriend.js | 解析层已预留 |
| **P1-5** | AI 可执行 `complete`（「那个会开完了」）；`delete` 需用户明确说「删掉/取消/不用做了」才执行，匹配要求 `taskId` 精确或唯一模糊命中，0 命中/多命中一律不执行并回 `reason` | AiGirlfriend.js | 安全优先，宁可不做不可误删 |
| **P1-6** | `GET /tasks/summary` 追加 `today: {total, completed}`（纯字段追加，旧字段不动） | routes/tasks.js | 供 P2 的桌面小组件 |
| **P1-7** | 后端 `[TaskManager]` 关键动作打日志（建单/提醒/去重命中），便于回归排查 | TaskManager.js | — |

#### P2（Nice to have）

| # | 需求 | 说明 |
| --- | --- | --- |
| **P2-1** | 提醒气泡附「做完了」快捷按钮 → 直接 `PUT /tasks/:id {completed:true}` | 提醒闭环最后一公里 |
| **P2-2** | AI 删除后 toast 提供 5s「撤销」 | 误删兜底 |
| **P2-3** | 同名未完成任务重复检测：AI 建单时命中则回 `reason:"duplicate"`，前端提示「已经记过啦」 | 防重复清单 |
| **P2-4** | 输入框 placeholder 提示「也可以直接跟小爱说：明天下午3点提醒我开会」 | 教育用户用自然语言 |

### 3.3 UI Design Draft（改动点描述，非整屏重设计）

- **任务弹窗（TaskDialog）** 保持现有三段式：进度条 → 任务列表 → 手动添加表单。
  - 进度条：文案「今日进度 x/y」；今日无任务时替换成一行灰色小字「今日没有安排，另有 N 条待办」。
  - 任务卡片：左侧勾选圈 / 中间标题 + 时间行（逾期红色 + 「已逾期」角标，AI 来源加 ✨）/ 右侧删除。
  - 列表排序：逾期 → 有到期时间（升序）→ 无到期时间 → 已完成（沉底、半透）。
  - 空态文案保持「暂时没有任务哦，亲爱的快去添加吧~ ✨」不变。
- **全局**：不新增常驻入口。AI 建单的反馈只在聊天区以 toast 呈现（沿用现有 `uiStore.toast`），不改气泡渲染逻辑。
- **数据流**：`useChatStream.settle()` → `taskStore.applyTaskResult()` → TaskDialog 订阅 taskStore 自动重渲染（弹窗关闭时不渲染，打开即最新）。

### 3.4 明确不做（避免范围蔓延）

- 不改 `PERSONA_SYSTEM_PROMPT` 既有任何一行文案（硬约束）。
- 不引入任务相关的前端 persist 中间件（硬约束）。
- 不为意图识别增加第二次 LLM 调用（硬约束）。
- 不新增 `/tasks/today` 路由（今日筛选在前端做，前后端同机同时区）。
- 不动好感度 / 情绪 / 记忆链路。

## 4. 决策建议（模糊点已拍板，未回复即按此执行）

| # | 模糊点 | 我的决策 | 理由 |
| --- | --- | --- | --- |
| D1 | `task_action` 放 metadata 内 vs 新标签 | **放 metadata 内** | streamFilter 已捕获 metadata；JSON 内追加字段天然向后兼容，老模型行为零变化 |
| D2 | 一次对话能否建多条任务 | **P0 单条**，解析层 `toArray()` 归一化，P1 放开数组 | 小模型输出数组易漏；解析层预留后放开成本为零 |
| D3 | 相对时间谁解析 | **LLM 直接给绝对时间 + 后端宽容归一化**，不做本地 NLP 解析库 | 不引入依赖、不加网络往返；`[System Context]` 已注入 Current Time |
| D4 | 时间解析失败怎么办 | **丢弃 dueTime、保留任务**，回 `reason:"bad_due_time"` | 建单本身有价值，不该因为时间没听懂就把整件事丢了 |
| D5 | 提醒去重放哪 | **放 Task 上（`reminderState`），不放 ProactiveEngine 类型冷却上**；同时把 `task_reminder` 冷却降到 5min | 30min 冷却是「防同任务反复提醒」的劣质替代；真正的去重必须在任务维度，否则两条不同任务会互相挤占 |
| D6 | 提醒要不要占每日配额 | **不占**（`quotaExempt: true`） | 用户自己设的提醒，不该被「今天主动消息发够了」吃掉 |
| D7 | 凌晨要不要提醒逾期 | **逾期提醒限 07:00–23:00**；到期前/自定义提醒保持 `quietExempt` 全天可发 | 到期提醒是即时性的必须发；逾期提醒是补漏，凌晨 3 点说「你昨天的事没做」是骚扰 |
| D8 | AI 能否删除任务 | **P1 才开放，且要求明确删除措辞 + 精确/唯一匹配**，0 命中或多命中不执行 | 误删不可恢复（当前无回收站），安全优先 |
| D9 | 任务列表要不要全局 store | **要，新增 `stores/taskStore.ts`（无 persist）** | AI 建单时弹窗通常没打开，组件本地 state 无法被外部更新 |
| D10 | 今日口径 | **dueTime 在今天，或今天创建且无 dueTime**；前端按本地时区算 | 不新增后端路由；与 dayKey 同机同口径 |
| D11 | `addTask` 入参 | **白名单化**（`title/description/dueTime/reminderTime/completed/source`），`id/createdAt` 不可外部覆盖 | 现有 `...taskData` 在默认值之后展开，可被 body 注入 `id`/`completed` |
| D12 | `/chat` 与 `/chat/stream` 一致性 | **新增 `taskPayload(result)` helper，两处共用** | 与现有 `affinityPayload` 同一手法，杜绝「流式有、非流式没有」 |

## 5. Open Questions（每条已附默认动作，未回复即按默认执行）

1. **Q：`source` 与 `reminderState` 要不要通过 `GET /tasks` 全量下发？**
   默认：**下发**（纯字段追加，前端需要 `source` 渲染 ✨、`reminderState` 便于排障；体积增加可忽略）。若要精简则改为只在 `/tasks` 下发 `source`，`reminderState` 不下发 —— 需你一句话。
2. **Q：AI 建单的 toast 是 success 还是 info 级别？**
   默认：**success**（"小爱帮你记下了：开会 ✨"），失败用 info（"小爱没太听清，你再说一次？"）—— 建单失败不是系统错误，不该用 error 吓用户。
3. **Q：逾期提醒文案由谁写？**
   默认：**新增 `buildProactivePrompt('task_reminder')` 的 `kind` 分支**（`due` / `custom` / `overdue` 三套语气），不复用现有单一「快到截止日期了」文案 —— 逾期和到期前的语气必须不同。现有文案对 `overdue` 完全不适用。
