# AI Girlfriend

情感陪伴型 AI 智能体「小爱」，支持多轮对话、语音交互、向量记忆、情绪建模与主动关怀。

## 启动

```bash
# 终端 1 - 后端 (端口 8000)
cd backend-node
npm install
npm run dev

# 终端 2 - 前端 (端口 3000)
cd frontend
npm install
npm run dev
```

打开 http://localhost:3000，首次运行会引导配置 API Key。

## 技术栈

- **前端**: Next.js 16 (App Router) + React 19 + TypeScript + TailwindCSS + Framer Motion + zustand
- **后端**: Node.js (ESM) + Express
- **AI**: 兼容 OpenAI API（OpenAI / DeepSeek / Claude 等）

## 目录结构

```
backend-node/
├── src/
│   ├── server.js            入口：监听端口 + 优雅停机
│   ├── app.js               Express 装配（中间件 / 路由 / 错误处理）
│   ├── config.js            环境配置集中管理（端口、CORS、上传目录）
│   ├── routes/              按领域拆分的路由
│   │   ├── chat.js          /chat、/chat/proactive/*
│   │   ├── configRoutes.js  /config、/config/proactive
│   │   ├── tasks.js         /tasks CRUD
│   │   ├── audio.js         /audio/speak、/audio/transcribe
│   │   ├── state.js         /history、/memories、/state、/system_prompt
│   │   ├── life.js          /life/*
│   │   └── personalityRoutes.js  /personality 状态与预设
│   ├── middleware/          统一错误处理、异步包装、参数校验
│   ├── services/
│   │   └── container.js     单例服务容器 + 停机清理
│   ├── utils/
│   │   └── jsonStore.js     JSON 持久化（原子写 + 旧数据迁移）
│   └── core/                领域逻辑
│       ├── AiGirlfriend.js      对话编排
│       ├── EmotionEngine.js     PAD 三维情绪模型
│       ├── PersonalityDrift.js  长期性格漂移
│       ├── Memory.js            向量记忆检索
│       ├── ProactiveEngine.js   主动消息调度
│       ├── LifeSimulator.js     日常活动模拟
│       ├── TaskManager.js       任务清单
│       ├── Voice.js             TTS / ASR
│       ├── affinityRules.js     好感度变化校验规则
│       └── prompts/             prompt 资源（人设 / 关系阶段 / 主动消息）
└── data/                    运行时数据（state、记忆、情绪、性格、任务、生活日志）

frontend/
└── src/
    ├── app/                 入口装配（layout / page / globals.css）
    ├── components/
    │   ├── ui/              通用原语（Button / Dialog / Card / Switch …；中性黑白与语义色均走 token）
    │   ├── chat/            聊天页（ChatPage / ChatInput 胶囊 dock / 消息气泡 / 工具栏）
    │   ├── character/       角色面板（立绘 / 好感度 / 情绪徽章 / PAD 状态）
    │   ├── settings/        设置弹窗（通用 / 语音 / 记忆 / 性格 / 主动 / 系统 六页签）
    │   ├── wizard/          首启引导（欢迎 / API 配置 / 完成，三步）
    │   ├── dialogs/         业务弹窗（任务 / 记忆 / 导出）
    │   ├── voice/           语音控件（朗读按钮 / 录音波形）
    │   ├── theme/           主题切换弹窗
    │   └── effects/         背景特效（樱花飘落）
    ├── stores/              zustand 状态（chat / settings(ttsEngine) / ui / theme；其余配置经 lib/storage 平铺存取）
    ├── hooks/               业务逻辑（聊天流 / 主动轮询 / 语音 / 录音 / 自动滚动）
    ├── lib/                 API 客户端、localStorage、cn、通知音、浏览器语音
    ├── styles/              设计 token 三层（tokens 尺度 / themes 主题×模式 / utilities 装饰）
    └── types/               全局共享类型
```

**主题系统**：`data-theme`（sakura / starry / ocean / forest 四色相）× `data-mode`（light / dark）
正交组合共 8 种，界面颜色一律经 CSS 变量走 token；两处有意例外：PAD 三维条的轴向
正负配色（数据可视化语义，不随主题色相变化）与主题选择器的预览渐变（需要展示
「目标主题」的颜色）。支持系统 `prefers-reduced-motion`（禁全部装饰动画、压缩过渡，
framer-motion 经 MotionConfig reducedMotion="user" 跟随）。

## 数据存放

所有运行时数据统一写入 `backend-node/data/`（不再依赖启动目录），各文件在首次
发生相应事件时才落盘：

| 文件 | 内容 |
|------|------|
| `state.json` | 昵称、对话历史、模型配置（baseUrl / modelName 等） |
| `affinity_state.json` | 好感度（AffinityEngine 自持） |
| `memory.json` | 向量记忆 |
| `emotion_state.json` | PAD 情绪状态 |
| `personality_state.json` | 性格特质与交互统计 |
| `proactive_state.json` | 主动消息配置、当日配额、冷却与待送队列 |
| `life_log.json` | 日常活动模拟记录 |
| `tasks.json` | 任务清单 |
| `user_emotion_state.json` | 用户情绪时间线与当前情绪态（REQ-01 用户情绪识别通道） |
| `narrative.json` | 共同经历叙事库「我们的故事」（REQ-03 叙事层） |
| `trigger_state.json` | 事件候选队列 + 触发源冷却 + 去重标记（REQ-04 事件层） |

首次启动会自动把旧版 `<repo>/memory_db/` 下的数据迁移过来（不覆盖已有新数据）。

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/chat` | 发送消息（非流式） |
| POST | `/chat/stream` | 发送消息，SSE 流式返回正文 |
| GET | `/chat/proactive` | 取一条主动消息（无则 204） |
| POST | `/chat/proactive/trigger` | 手动触发主动消息（reason 需在类型目录内） |
| GET | `/chat/proactive/status` | 主动消息引擎运行时状态 |
| POST | `/config` | 模型 / API 配置（无 GET；回显走 `/config/status`） |
| GET | `/config/status` | 配置状态 |
| GET/POST | `/config/proactive` | 主动消息配置 |
| GET/POST/PUT/DELETE | `/tasks` | 任务清单 |
| GET | `/tasks/summary` `/tasks/due` | 任务统计 / 即将到期 |
| GET/DELETE | `/history` | 对话历史 |
| POST | `/reset` | 完全重置（历史 + 记忆 + 好感度；「新对话」用 DELETE /history） |
| GET/DELETE | `/memories` | 向量记忆 |
| GET/POST | `/state` | 好感度 / 昵称 |
| GET | `/state/user-emotion` | 用户情绪时间线（REQ-01；引擎缺失时回落空结构） |
| GET | `/state/narratives` | 共同经历叙事列表（REQ-03；含 stats） |
| DELETE | `/state/narratives/:id` | 手动删除一条叙事 |
| GET | `/affinity/ledger` | 好感度变更账本 |
| GET/POST | `/system_prompt` | 人设 prompt |
| GET/POST | `/personality` | 性格状态 / 更新（预设 / 七维 / 开关） |
| GET | `/personality/ledger` | 性格变化账本 |
| POST | `/personality/reset` | 恢复默认预设并清空账本 |
| GET | `/life/current` `/life/history` | 当前活动 / 活动历史 |
| POST | `/audio/speak` `/audio/transcribe` | TTS / 语音转文字 |

## 陪伴感增强（REQ-01 / REQ-03 / REQ-04）

在既有「记忆 + 情绪 + 好感度 + 主动消息」之上叠加三个子系统，让主动关怀更「懂你」、
更「有共同经历」。三者均默认开启，且都遵循「关闭态安全」——任一开关关掉即完全退回改造前行为。

- **用户情绪识别通道（REQ-01）**：单独追踪「用户」的情绪（与描述小爱自身状态的
  `EmotionEngine` 解耦）。词表优先、复用主对话 `<metadata>.user_emotion` 做 LLM 校准，
  **不新增任何 LLM 调用**；产出情绪时间线并落 `user_emotion_state.json`，为情绪共振触发源供数。
- **共同经历叙事层（REQ-03）**：从情节记忆派生「我们的故事」（第一次、约定、纪念日等），
  独立落 `narrative.json`，不改动 `MemoryStore` schema；每轮以 topK + 字数上限克制注入，
  并在后台按「轮次 / 时间窗 / 好感度跃迁」三层节流调用 LLM 抽取。
- **事件层（REQ-04）**：`EventBus` + `TriggerRegistry` 把情绪转折、纪念日、约定到期
  翻译成事件候选入队，再由 `ProactiveEngine` 复用既有全闸门（情绪 / ghost / 配额 / 自发间隔 /
  去重）触达，**不旁路任何经济模型**。三个触发源：`emotion_turn` / `anniversary` / `promise_followup`。
  运行时状态见 `GET /chat/proactive/status` 的 `triggerRegistry` 字段。

开关（`POST /config`，snake_case，缺省不动原值）：`user_emotion_enabled` / `narrative_enabled` /
`trigger_enabled`；当前生效值见 `GET /config/status` 的 `companion` 字段。

## 内心独白 vs 模型思考

模型一次输出里可能有两类「思考」，归属完全不同，代码里分两条通道处理，绝不混淆：

| 片段 | 归属 | 去向 | 用户可见 |
|------|------|------|----------|
| `<monologue>…</monologue>` | 小爱的人设内心独白（我们 prompt 要求写的） | `inner_thought`，随消息持久化 | 默认隐藏，气泡旁小图标 hover 可见 |
| `<think>…</think>` | 模型自己的推理链 CoT（推理模型/蒸馏版会写进正文） | `model_reasoning` | 永不展示 |
| `reasoning_content` 字段 | 推理模型的原生 CoT（独立字段） | `model_reasoning` | 永不展示 |
| `<metadata>…</metadata>` | 情绪 / 好感度结构化数据 | 进情绪系统，不出现在正文中 | 否 |

`/chat` 与 `/chat/stream` 的 `done` 事件都会带上 `inner_thought`、`model_reasoning`
（后者按 `CHAT_THINKING_MAX_CHARS` 截断，默认 2000 字符，仅用于排障）。

兼容：若模型只输出 `<think>` 且没有原生 `reasoning_content`（非推理模型 + 旧格式），
该 `<think>` 仍被当作人设独白，行为与重构前一致。

本地验证（会临时把后端指向 mock，跑完记得恢复 `data/` 并重启）：

```bash
cd backend-node
node scripts/mock-llm-server.mjs 8899     # 终端 1
node scripts/verify-thinking-split.mjs    # 终端 2
```

## 开发

```bash
# 后端语法检查（不依赖子进程，纯解析）
cd backend-node && npm run check

# 流式过滤器单元测试
cd backend-node && npm test

# 前端类型检查与 Lint / 构建
cd frontend && npx tsc --noEmit
cd frontend && npx eslint src
cd frontend && npm run build      # 注意：与 dev server 不要同时跑（会冲突 .next）
```

## API 密钥

| 服务商 | Base URL | 模型 |
|--------|----------|------|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |

> 语音（TTS/ASR）固定走 OpenAI 官方接口，需在设置中单独配置有额度的 Key。

## 许可证

MIT
