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

- **前端**: Next.js 16 (App Router) + TailwindCSS + Framer Motion + TypeScript
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
│   │   └── life.js          /life/*
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
    ├── app/page.tsx         页面编排（状态与逻辑已抽离到 hooks）
    ├── app/components/      UI 组件（ui/ 通用件、chat/ 聊天件）
    ├── hooks/               业务逻辑（聊天 / 轮询 / 语音 / 录音 / 特效）
    ├── lib/                 API 客户端、localStorage、语音
    └── types/               全局共享类型
```

## 数据存放

所有运行时数据统一写入 `backend-node/data/`（不再依赖启动目录）：

| 文件 | 内容 |
|------|------|
| `state.json` | 好感度、昵称、对话历史 |
| `memory.json` | 向量记忆 |
| `emotion_state.json` | PAD 情绪状态 |
| `personality_state.json` | 性格特质与交互统计 |
| `life_log.json` | 日常活动模拟记录 |
| `tasks.json` | 任务清单 |

首次启动会自动把旧版 `<repo>/memory_db/` 下的数据迁移过来（不覆盖已有新数据）。

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/chat` | 发送消息（非流式） |
| POST | `/chat/stream` | 发送消息，SSE 流式返回正文 |
| GET | `/chat/proactive` | 取一条主动消息（无则 204） |
| POST | `/chat/proactive/trigger` | 手动触发主动消息 |
| GET/POST | `/config` | 模型 / API 配置 |
| GET | `/config/status` | 配置状态 |
| GET/POST | `/config/proactive` | 主动消息配置 |
| GET/POST/PUT/DELETE | `/tasks` | 任务清单 |
| GET | `/tasks/summary` `/tasks/due` | 任务统计 / 即将到期 |
| GET/DELETE | `/history` | 对话历史 |
| GET/DELETE | `/memories` | 向量记忆 |
| GET/POST | `/state` | 好感度 / 昵称 |
| GET/POST | `/system_prompt` | 人设 prompt |
| GET | `/life/current` `/life/history` | 当前活动 / 活动历史 |
| POST | `/audio/speak` `/audio/transcribe` | TTS / 语音转文字 |

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

# 前端类型检查与构建
cd frontend && npx tsc --noEmit
cd frontend && npm run build
```

## API 密钥

| 服务商 | Base URL | 模型 |
|--------|----------|------|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |

> 语音（TTS/ASR）固定走 OpenAI 官方接口，需在设置中单独配置有额度的 Key。

## 许可证

MIT
