# AI Girlfriend

情感陪伴型 AI 智能体「小爱」，支持多轮对话、语音交互、向量记忆、情绪建模与主动关怀。

## 启动

```bash
# 方式一（推荐，一条命令拉起两端，脱离会话存活）
python scripts/start_services.py            # 已在跑就跳过；结束时打印每端状态
python scripts/start_services.py --status   # 只查状态不启动

# 方式二：手动开两个终端
cd backend-node && npm install && npm run dev     # 后端 :8000
cd frontend && npm install && npm run dev         # 前端 :3000
```

打开 http://localhost:3000，首次运行会引导配置 API Key。

**判断后端到底活没活**：`curl http://127.0.0.1:8000/health`（免鉴权）。
端口通了不代表服务可用，所以 `/health` 会真去检查数据目录可写性，并回答这几个问题：

| 字段 | 含义 |
|------|------|
| `ok` / `dataDirWritable` | 数据目录能不能写（不能写等于所有对话与记忆都会丢） |
| `version` / `node` / `uptimeSeconds` | 现在跑的是哪个版本、起来多久了 |
| `llmConfigured` | 后端**内存里**有没有 API Key。`false` 不是故障，见下面那段说明 |
| `model` / `baseUrlHost` | 当前模型与上游主机名（只给主机名，不给完整地址） |
| `chatQueueDepth` / `proactiveQueueSize` | 对话队列与主动消息队列的长度（超过上限的新请求会被 429） |

> API Key 只保存在浏览器 localStorage，后端进程内存持有、**从不落盘**：
> 单独重启后端后，需要先用浏览器打开一次页面（前端启动时会自动把配置回灌给后端），
> 否则直接调 `/chat` 会返回「请先配置 API Key」。想让后端脱离浏览器可用时，
> 设 `AI_GIRLFRIEND_API_KEY`（见下表）。

## 环境变量

后端全部运行时数值集中在 `src/config.js`（模块里不允许出现裸数字，一律走 `envNumber` 并带范围裁剪），
**完整清单见 `backend-node/.env.example`**（80 多个旋钮，按 10 组带说明注释；复制成 `.env` 就能改，
一个都不填也能跑）。这里只列常用的：

| 变量 | 默认 | 作用 |
|------|------|------|
| `PORT` / `HOST` | `8000` / `127.0.0.1` | 监听地址。**`HOST` 设成非回环地址而没配 token 会直接拒绝启动** |
| `AI_GIRLFRIEND_TOKEN` | 未设置 | 设置后所有业务接口要求 `Authorization: Bearer <token>`；未设置时只允许本机回环访问 |
| `AI_GIRLFRIEND_API_KEY` | 未设置 | 服务端侧的对话 Key（不落盘，仅本次进程有效） |
| `AI_GIRLFRIEND_DATA_DIR` | `backend-node/data` | 数据目录。测试与多实例用它隔离，避免互相覆盖 |
| `FRONTEND_ORIGIN` | 未设置 | 追加一个允许的前端源（改端口时才需要） |
| `CHAT_MAX_PROMPT_HISTORY` / `CHAT_TEMPERATURE` / `CHAT_UNLIMITED_CONTEXT` | `30` / `0.75` / `false` | 上下文条数、采样温度、无限上下文 |
| `MEMORY_RETRIEVAL_MODE` / `MEMORY_FACTS_ENABLED` | `auto` / `true` | 记忆检索模式与事实提取开关 |
| `USER_EMOTION_ENABLED` / `NARRATIVE_ENABLED` / `TRIGGER_REGISTRY_ENABLED` | 全部 `true` | 陪伴感三个子系统总开关（关 = 退回改造前行为） |
| `EMOTION_RESONANCE_ENABLED` | `true` | 情绪共振：他的情绪改变她自己的 PAD（关掉后她的增量与改造前逐轴一致） |
| `PROACTIVE_EMOTION_ENABLED` | `true` | 主动消息的情绪回灌：被接住 / 落了空都会改变她的心情 |
| `AI_GIRLFRIEND_DEBUG` | 未设置 | 设为 `true` 才把内心独白与模型 CoT 的**原文**打进日志（默认只记长度） |
| `CHAT_QUEUE_MAX` | `4` | 对话队列深度上限，超出直接 429（`error_code: service_busy`） |

### 凭据去向相关（重要）

`base_url` / `embedding_base_url` 决定**你的 API Key 会被发到哪里**，因此后端做了分级校验：

| 地址类型 | 行为 |
|---|---|
| 公网 http(s) 地址 | 正常接受 |
| `127.0.0.1`、`localhost`、`10/8`、`172.16/12`、`192.168/16`、内网裸主机名 | **接受，但响应里带 warning**（本地 Ollama / LM Studio 这类用法是合法的，只是 Key 会跟着发过去） |
| `169.254.0.0/16`（AWS/Azure/GCP 元数据）、`100.100.100.200`（阿里云元数据）、`metadata.*`、`0.0.0.0`、IPv6 链路本地 `fe80::/10` | **一律拒绝**（400），这类地址只会把 Key 送进元数据服务 |
| 非 http(s) 协议、URL 里内嵌账号密码、超过 2048 字符 | 拒绝 |

需要放行特例时用 `AI_GIRLFRIEND_BASE_URL_ALLOWLIST=host1,host2`（精确主机名）或
`AI_GIRLFRIEND_ALLOW_PRIVATE_BASE_URLS=true`（整体放行，包括元数据段，仅在你清楚自己在做什么时用）。

`POST /config` 的字段校验很严格（类型、长度、枚举、布尔不接受 `'false'` 字符串），
错误会逐条列在响应的 `errors` 里；空串对**主 `api_key` 表示「不动」**（前端每次挂载都会发 `''`，
把它当清空会抹掉 `AI_GIRLFRIEND_API_KEY` 的兜底值），要显式清空请传 `null`；
嵌入与 TTS 的 Key 则相反，空串就是清除。

## 安全边界

- 默认只监听 `127.0.0.1`，局域网与外部一律 401。
- 配了 `AI_GIRLFRIEND_TOKEN` 后，`/static`（TTS 音频，等同对话内容）也要凭证：
  `<audio>` 标签带不了请求头，因此支持 `?token=<token>` 查询串。
- 关闭浏览器不等于数据出境：所有对话、记忆、好感度都只写在 `backend-node/data/`。
- 内心独白（`<monologue>`）与模型 CoT 默认**不进日志**，只记长度；`AI_GIRLFRIEND_DEBUG=true` 才打原文。
- 上游模型服务的错误不再当回复文本吐出来：气泡里是可读的中文分类提示，
  细节只进日志，程序侧稳定码在响应的 `error_code` 字段
  （`upstream_auth` / `upstream_rate_limited` / `upstream_network` / `not_configured` / `service_busy` …）。
- 取主动消息是 `POST /chat/proactive/consume` 而不是 GET：GET 语义下任何预取或重播都会
  吃掉一条消息，旧地址现在返回 405。


## 技术栈

- **前端**: Next.js 16 (App Router) + React 19 + TypeScript + TailwindCSS + Framer Motion + zustand
- **后端**: Node.js **>= 20.9**（ESM）+ Express — 版本要求写在两个 `package.json` 的 `engines` 里，CI 也跑 20
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

### 备份与恢复（设置页 → 系统 → 数据与备份）

上表这 11 个文件就是「小爱是谁」的全部。**没备份 = 丢了就是没了**，所以：

- **导出档案**：一次请求拿到一份含全部 11 个文件的 JSON（导出前会先把去抖里
  未落盘的数据 flush，否则最近几轮会在档案里凭空缺失）。档案里**不含 API Key**，
  后端在导出前自检，检出疑似密钥就直接不出这份档案。换机器时导入这一份即可。
- **自动快照**：`POST /reset`（完全重置）、档案导入、快照恢复之前，都会先把当前
  `data/` 原样复制一份到 `backend-node/backups/<时间戳>-<原因>/`，默认保留最近 10 份
  （`BACKUP_KEEP`）。手滑重置之后在设置页点「恢复」就能救回来。
- **导入不需要重启**：写盘后逐个引擎热加载；万一某个引擎热加载失败，
  响应里会明确写 `restartRecommended: true`，界面会提示你重启一次，不会假装成功。
- 备份目录默认跟着数据目录走（`AI_GIRLFRIEND_DATA_DIR` 的旁边），所以跑测试不会
  在仓库里堆真实快照；`backend-node/backups/` 已在 `.gitignore` 里。

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/chat` | 发送消息（非流式） |
| POST | `/chat/stream` | 发送消息，SSE 流式返回正文 |
| POST | `/chat/proactive/consume` | 取走一条主动消息（无则 204）。**必须是 POST**：这个动作会出队 |
| GET | `/chat/proactive/peek` | 只读预览队首，不消耗 |
| GET | `/chat/proactive` | 已废弃，回 405（旧的消费型 GET 会被预取和重播误吃消息） |
| POST | `/chat/proactive/trigger` | 手动触发主动消息（reason 需在类型目录内） |
| GET | `/chat/proactive/status` | 主动消息引擎运行时状态 |
| POST | `/config` | 模型 / API 配置（无 GET；回显走 `/config/status`）。字段严格按类型校验：错误列在 `errors`，未知字段列在 `warnings` |
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
| GET | `/backup/status` | 数据目录 / 备份目录 / 快照列表 |
| GET | `/backup/export` | 导出整份档案（`.json` 附件下载；导出前自动 flush） |
| POST | `/backup/import` | 导入档案（导入前自动快照；报告逐项列出写入与热加载结果） |
| POST | `/backup/snapshot` | 只在服务器本地存一份当前状态快照 |
| POST | `/backup/restore` | 从某份快照恢复（恢复前再存一份 pre-restore 快照） |
| GET | `/affinity/ledger` | 好感度变更账本 |
| GET/POST | `/system_prompt` | 人设 prompt |
| GET/POST | `/personality` | 性格状态 / 更新（预设 / 七维 / 开关） |
| GET | `/personality/ledger` | 性格变化账本 |
| POST | `/personality/reset` | 恢复默认预设并清空账本 |
| GET | `/life/current` `/life/history` | 当前活动 / 活动历史（两条都是纯读，不再顺手生成并写盘） |
| POST | `/audio/speak` `/audio/transcribe` | TTS / 语音转文字 |

## 陪伴感增强（REQ-01 ~ REQ-04 / REQ-06）

在既有「记忆 + 情绪 + 好感度 + 主动消息」之上叠加子系统，让她更「懂你」、更「有共同经历」，
并且**自己的情绪真的被牵动**。均默认开启，且都遵循「关闭态安全」——任一开关关掉即完全退回改造前行为。

- **用户情绪识别通道（REQ-01）**：单独追踪「用户」的情绪（与描述小爱自身状态的
  `EmotionEngine` 解耦）。词表优先，复用主对话 `<metadata>.user_emotion` 做 LLM 校准；
  产出情绪时间线并落 `user_emotion_state.json`。
- **情绪共振（REQ-02）**：他此刻的情绪会**改变她自己的 PAD**，作为第三个成因**叠加**在
  「词表判定 + 模型 emotion_delta」的混合结果之上（不是再平均一次），幅度按关系阶段调制
  （陌生 0 / 初识 0.3 / 朋友 0.6 / 挚友 0.85 / 恋人 1），叠加后统一裁剪到单轮每轴总上限。
  共振与她自己的情绪时间线共用同一份融合读数，两条链路是一本账。
  纯函数与阶段表在 `core/emotionResonance.js`，开关 `EMOTION_RESONANCE_ENABLED`。
- **共同经历叙事层（REQ-03）**：从情节记忆派生「我们的故事」（第一次、约定、纪念日等），
  独立落 `narrative.json`，不改动 `MemoryStore` schema；每轮以 topK + 字数上限克制注入。
  主动回顾的防复读账从**已落盘的 `lastRecalledAt` + 冷却窗**派生，重启也拦得住复读。
- **事件层（REQ-04 / REQ-06）**：`EventBus` + `TriggerRegistry` 把情绪转折、纪念日、约定到期、
  **关系阶段跃迁**翻译成事件候选入队，再由 `ProactiveEngine` 复用既有全闸门（情绪 / ghost / 配额 /
  自发间隔 / 去重）触达，**不旁路任何经济模型**。四个触发源：
  `emotion_turn` / `anniversary` / `promise_followup` / `stage_advanced`。
  运行时状态见 `GET /chat/proactive/status` 的 `triggerRegistry` 字段。
- **关系跃迁仪式感（REQ-06）**：好感度跨过阶段线的那一轮就发布 `stage_advanced` 事件，
  她会主动说一句「我们好像不一样了」，说的内容取自 `relationshipStages.js` 里那个阶段
  **新解锁的行为**（与每轮的【关系阶段】说明书同一份措辞）。目前只对向上跃迁发消息，
  向下（正在疏远）只发事件不发消息 —— 那要先等 PRD §5 的 Q2 拍板。
- **主动消息的情绪回灌**：她递出去的话被接住会开心、落了空（超时未送达）会失落，
  增量表在 `core/proactiveTypes.js` 各类型的 `emotionFeedback`。失落会自然收紧情绪闸门，
  「被冷落」不再需要另写规则。开关 `PROACTIVE_EMOTION_ENABLED`。

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

本地门禁与 CI 完全等价，四条命令跑完就能判断这次改动是否可提交：

```bash
# 后端
cd backend-node
npm run check      # 语法解析（src + scripts）+ 真导入冒烟（scripts/smoke-import.mjs）
npm run lint       # 零依赖静态检查 R1~R5（全局遮蔽 / 重复 export default / 空 catch / 调试残留 / 未用 import）
npm test           # 20 套测试：跑完全部再汇总，全程写沙盒数据目录

# 前端
cd frontend
npm run typecheck  # tsc --noEmit
npm run lint       # eslint src
npm run test       # vitest run
npm run build      # 生产构建（不要与 dev server 同时跑，会抢 .next）
```

几点约定，改动时请一起守住：

- **测试一律写沙盒**：`scripts/run-tests.mjs` 会给每个子进程注入 `AI_GIRLFRIEND_DATA_DIR`，
  所以跑完 `backend-node/data/` 的 mtime 应该零变化。自己新加 HTTP 测试套件时，
  结尾必须 `proactiveEngine.stop()` 再 `process.exit(code)` —— 容器起的定时器会让进程挂着不退出。
- **测试必须能失败**：新套件请走 `scripts/lib/testKit.mjs`，并把 `expect` 写成实际断言条数；
  「某一节被注释掉」或「中途 return」都会因为条数不符而变红（这是审计 INFRA-01/02 的教训）。
- 后端不上 eslint 是因为装它要几十 MB 而本机出网只有几十 KB/s；`scripts/lint-style.mjs`
  用五条有针对性的规则替代，每条都对应一次真实事故（详见该文件头）。

## API 密钥

| 服务商 | Base URL | 模型 |
|--------|----------|------|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |

> 语音（TTS/ASR）固定走 OpenAI 官方接口，需在设置中单独配置有额度的 Key。

## 许可证

MIT
