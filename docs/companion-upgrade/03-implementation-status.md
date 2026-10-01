# 陪伴感增强 · 实现状态（T01–T05）

> 本文记录 REQ-01 / REQ-03 / REQ-04 三个子系统的落地范围、文件清单与集成收口结论。
> 架构与契约真源见 [`02-architecture.md`](./02-architecture.md)；PRD 见 [`PRD.md`](./PRD.md)。
> 验证记录见 `W1-verification.md` / `W2-verification.md`。

## 一、交付总览

| 任务 | 内容 | 状态 |
|------|------|------|
| T01 | 用户情绪识别通道（REQ-01） | 已落地并通过 QA |
| T02 | 共同经历叙事层（REQ-03） | 已落地并通过 QA |
| T03 | 事件层基础设施 EventBus / TriggerRegistry（REQ-04） | 已落地并通过 QA |
| T04 | 三个事件触发源接入（REQ-04） | 已落地并通过 QA |
| T05 | 集成收口（配置 / 路由 / 重置 / 停机 / 文档） | 本文 |

## 二、文件清单

### REQ-01 用户情绪识别通道
- `backend-node/src/core/UserEmotionEngine.js` —— 情绪时间线引擎（去抖落盘 `user_emotion_state.json`）
- `backend-node/src/core/userEmotionLexicon.js` —— 中文情绪词表
- `backend-node/src/core/prompts/userEmotionPrompt.js` —— prompt 注入片段构建
- 落盘：`backend-node/data/user_emotion_state.json`

### REQ-03 共同经历叙事层
- `backend-node/src/core/narrative/NarrativeStore.js` —— 叙事库（去抖落盘 `narrative.json`）
- `backend-node/src/core/narrative/NarrativeExtractor.js` —— LLM 抽取 + 三层节流 + 归一化
- `backend-node/src/core/narrative/NarrativeRetriever.js` —— 检索 + 纪念日查询
- `backend-node/src/core/narrative/narrativeTypes.js` —— 事件类型 / prompt 常量
- `backend-node/src/core/prompts/narrativePrompt.js` —— 注入段构建
- 落盘：`backend-node/data/narrative.json`

### REQ-04 事件层
- `backend-node/src/core/EventBus.js` —— 进程内同步发布订阅
- `backend-node/src/core/TriggerRegistry.js` —— 触发源注册表 + 事件候选队列（落盘 `trigger_state.json`）
- `backend-node/src/core/triggerEvents.js` —— **事件层唯一事实源**（事件名 / payload 契约 / 触发源元数据 / `TRIGGER_REGISTRY_CONFIG` / `TRIGGER_THRESHOLDS`）
- `backend-node/src/core/triggers/emotionTurnTrigger.js`
- `backend-node/src/core/triggers/anniversaryTrigger.js`
- `backend-node/src/core/triggers/promiseFollowupTrigger.js`
- 落盘：`backend-node/data/trigger_state.json`

## 三、接入点（T05 收口）

### 配置统一
- `config.js` 新增 `triggerRegistry` 配置块：**re-export** `core/triggerEvents.js` 的
  `TRIGGER_REGISTRY_CONFIG`，实现「所有运行时数值统一从 config 读」，同时不破坏
  `triggerEvents.js` 的既有导出（测试依赖它）。`enabled` 默认值与 T03 一致（env 未设 = true）。
- 三个新开关支持运行时热更新（`POST /config`）：`user_emotion_enabled` / `narrative_enabled` /
  `trigger_enabled`，由 `AiGirlfriend.updateConfig` 统一处理；`trigger_enabled` 走
  `TriggerRegistry.setEventLayerEnabled`（模块级运行时态的唯一写点）。
- `GET /config/status` 新增 `companion` 字段回显上述开关与 `triggerRegistry` 配置块。

### 路由补齐
- `routes/state.js`：`GET /state/user-emotion`、`GET/DELETE /state/narratives`（根路径、无 `/api` 前缀，camelCase 契约）。
- `routes/chat.js`：`GET /chat/proactive/status` 追加顶层 `triggerRegistry`（`registry.getStatus()`
  完整快照：queue / cooldowns / nextEligible / triggers）；既有 `{ queue, engine }` 契约保持不变。

### 重置与停机
- `AiGirlfriend.resetAll()`：覆盖 history / affinity / personality / emotion / **userEmotion** /
  **narrative** / tasks / memory；**新增 triggerRegistry**（仅当容器注入时纳入，避免把「未装配」当成功重置）。
  返回值 `{ reset, failed }` 容错结构不变。
- `services/container.js` 停机清理 flush 覆盖：memory / **narrative** / **userEmotion**（新增）/
  **triggerRegistry**；`UserEmotionEngine` 新增公开 `flush()` 供停机兜底。

## 四、一致性检查结论

- **无循环依赖**：事件装配顺序 `EventBus → TriggerRegistry → 触发源注册 → ProactiveEngine(registry)`；
  `AiGirlfriend` 仅单向持有 `eventBus` / `triggerRegistry` 引用（可选注入，缺省 null 时静默 no-op）。
- **关闭态安全**：三个子系统开关缺省时行为等于改造前；事件层 `enabled=false` 时
  `consumeEventQueue()` O(1) 返回 false，链路整体静默。
- **前后端契约无漂移**：新增字段均为**追加**（既有 `{ queue, engine }` 与 `/config/status` 字段全保留）；
  新端点沿用既有 camelCase 根路径约定。

## 五、验收

- `cd backend-node && npm run check` —— 63/63 通过
- `cd backend-node && npm test` —— 全量套件通过（含 `test-memory` / `test-reset-all` / 事件层套件）
- `cd frontend && npx tsc --noEmit` —— 通过
