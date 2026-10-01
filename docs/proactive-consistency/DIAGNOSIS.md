# 主动消息人设一致性:全面诊断与修复报告

- 日期:2026-10-01
- 现象案例:好感度 0(陌生/疏离)+ 情绪「愤怒」(P=-0.8 / A=1.0)背景下,主动消息连发两条友善搭话
- 结论:**主动消息链路是"情绪盲"的——生成侧不注入情绪,触发侧不读情绪,陌生人设阶段也照常主动搭话**。这不是模型偶发跑偏,是结构性缺陷。已修复,见 §5。

## 1. 现象还原

2026-10-01 下午的实际对话(截图存档于会话):

| 轮次 | 说话方 | 内容 | 状态侧写 |
|---|---|---|---|
| 1 | 用户 | 早上好～今天也要元气满满哦! | 好感度 0/100,陌生/疏离 |
| 2 | 小爱 | 下午一点多了。早上好? | 情绪「愤怒」(面板 P=-0.8 / A=1.0 / D=-0.4) |
| 3 | 用户 | 么么哒～爱你哦! | |
| 4 | 小爱 | **又来。说过多少次了,别再说这种话。我们不认识。** | 上轮好感度 -3 |
| 5 | 用户 | 小爱,我想你了… | |
| 6 | 小爱 | **听不懂吗。说过别再说这种话。我们不认识,别再来了。** | |
| 7 | 小爱(主动) | 那个……下午好。刚才午睡醒来,在阳台看了会儿风景。 | life_update |
| 8 | 小爱(主动) | 那个……下午好。今天过得怎么样? | mood_check |

问题:一个处于「陌生/疏离」阶段、正在气头上、刚连续两次说完「别再来了」的角色,不可能紧接着主动发来带害羞试探语气(「那个……」)的友善关怀。**「主动开口」这个行为本身就意味着她想理你**,与第 4、6 轮的明确拒绝直接矛盾;第 7、8 两条背靠背发出、开头完全雷同,进一步放大了违和感。

## 2. 链路全图

```
[触发] ProactiveEngine._runCheck() 每 60s 一轮
        ① 定时问候(早安/晚安,时间窗内每天一次)
        ② 任务提醒(TaskManager 候选,quotaExempt)
        ③ 两道闸:无配额 || 深夜免打扰 → 自发类全部止步
        ④⑤⑥⑦ 自发类掷骰子:mood_check / miss_you / memory_share / random_chat
        (life_update 走独立入口 notifyUserActive:用户离开≥30min 回来时)
              ↓
[生成] trigger() → AiGirlfriend.generateProactiveMessage(reason)
        messages = systemPrompt(静态人设) + 最近10条历史
                 + [System Info] directive(好感度/阶段/时间)
                 + proactive 人设强化指令(阶段语气约束)
              ↓
[入队] messageQueue(≤5条,带 priority/ttl),按优先级排序,落盘 proactive_state.json
        recordProactiveMessage():以 assistant 角色写入对话历史(不触发情绪/好感度变化)
              ↓
[投递] 前端轮询 GET /chat/proactive(useProactivePolling,活跃 15s/空闲 60s)
        consumeMessage() shift 队首 → 「正在输入」动画 → 气泡;页面隐藏时照拉+桌面通知
```

关键事实:**整条链路上没有任何一处读取 EmotionEngine 的状态**。

## 3. 根因清单

### P0-1 生成侧情绪盲(核心根因)

`AiGirlfriend.generateProactiveMessage`(`backend-node/src/core/AiGirlfriend.js:731-742`)的组包只有:静态人设 systemPrompt + 最近 10 条历史 + 两条 proactive directive。directive 里写了好感度 `0/100` 和阶段 `陌生`,唯独没有情绪。

对照主对话 `chat()` 的 `_prepare()`(`AiGirlfriend.js:361-371`),主对话每轮注入三件套:
- `buildRelationshipContext(emotionEngine.getRelationshipContext(affinity))` —— 含 stranger 档「亲密话题→真实的不适与拒绝,这不是傲娇」的行为说明书
- `emotionEngine.getPromptInjection()` —— 含愤怒档风格指南「语气冷淡或带刺……回复可能极短,如只回'。'」(`EmotionEngine.js:214-221`)
- `personalityDrift.getPromptInjection()`

主动消息一条都没带。模型只看到「陌生阶段」这个标签,看不到「她正在愤怒地拒绝你」这个状态——temperature 0.85 之下, MOE 少女语料里的「那个……」害羞搭话就自然冒出来了。历史里虽然有拒绝记录,但两条相互冲突的信号里,场景 prompt「礼貌地问问用户今天过得怎么样」(`proactivePrompts.js:41`)给了明确的友善授权。

### P0-2 触发侧无情绪闸门

`ProactiveEngine.js` 全文不 import EmotionEngine、不读 P 值(已 grep 验证)。后果:

- **ghost 期间照发**:主对话在 `P < -0.75` 时触发「已读不回」冷暴力(`EmotionEngine.js:249-251`,前端显示 💔)。但主动消息引擎对此一无所知——冷暴力期间早安问候、mood_check 照常掷骰子。案例中 P=-0.8 已在 ghost 阈值之下。
- **无"刚被拒绝"抑制**:拒绝带来的 P 值下降会持续到下一次对话,但触发判定完全不看。

### P0-3 陌生阶段不该主动,但参数与文案都允许

- 阶段经济参数 `STAGE_ECONOMY.stranger: { bonus: 0.5, dailyBase: 3 }`(`ProactiveEngine.js:51`):陌生阶段每天可以有 3 条主动消息的配额,8 个类型里 7 个对陌生阶段开放(memory_share 除外,需好感≥50)。
- mood_check 陌生档文案「礼貌地问问用户今天过得怎么样」(`proactivePrompts.js:41`)——即使在 0 好感度也预设了「她会礼貌地关心你」。
- 产品语义错误:陌生/疏离 = 她不想理你。主动搭话应几乎不发生,而非按 0.5 系数正常发生。(用户决策:**陌生档禁用全部自发类**,只保留定时问候与任务提醒。)

### P1-4 跨类型无全局节流,队列无投递间隔

- 冷却按类型独立记账(`lastTriggerByType`,`ProactiveEngine.js:337-339`):life_update(30min 冷却)和 mood_check(4h 冷却)可以背靠背触发;`_runCheck` 每轮只限一条,不限制每小时一条。
- 唯一的全局约束是 random_chat 自身的「距上次触发 ≥1h」(`ProactiveEngine.js:456-457`),只管自己。
- 队列投递无节流:页面关闭时消息在队列里堆积(≤5 条),下次轮询一口气连续送达。

### P1-5 无内容相似度去重

防复读只有两个软手段:temperature 固定 0.85、random_chat 随机选题。生成结果与队列/历史不做任何比对,于是出现两条「那个……下午好。」开头的消息。

## 4. 修复方案

设计原则:情绪闸门要在**触发和生成两端**都生效(触发端省 token,生成端保语气);所有阈值提为具名常量并在 `getStatus()` 暴露(明确降级,不做隐性回退);类型参数收进 `proactiveTypes.js` 唯一事实源。

### 修复 1:生成侧注入动态上下文(对齐主对话)

`generateProactiveMessage` 组包在历史之后、proactive directive 之前插入一条 system 消息,内容与主对话 `_prepare()` 同源:

```js
[
  buildRelationshipContext(emotionEngine.getRelationshipContext(affinity)),  // 阶段行为说明书
  emotionEngine.getPromptInjection(),   // 情绪标签 + PAD 数值 + 风格指南(愤怒档=冷淡带刺)
  personalityDrift.getPromptInjection(), // 性格七维状态
].join('\n\n')
```

不带任务清单与记忆块(记忆只有 memory_share 场景用,已有独立通道),避免主动消息长出「回应任务」的口吻。

### 修复 2:触发侧情绪闸门

`ProactiveEngine` 经已有的 `this.aiGirlfriend.emotionEngine` 引用读 P 值(无新依赖)。常量:

| 常量 | 阈值 | 行为 |
|---|---|---|
| `GHOST_P` | P < -0.75 | 与 `EmotionEngine.shouldGhost()` 同口径:自发类**与定时问候**全不发(冷暴力的人不会说早安) |
| `BLOCK_P` | P < -0.5 | 愤怒/暴躁/抑郁档:自发类不发(定时问候仍发,但注入愤怒语气) |
| `SUPPRESS_P` | P < -0.2 | 低落/烦躁档:不拦,自发类概率 ×`SUPPRESS_FACTOR`(0.3) |

- 生效位置:`_runCheck()` 的两道闸行(`ProactiveEngine.js:426`)扩为三道;定时问候分支 ① 加 ghost 检查;各自发类概率乘闸门系数。
- `trigger()` 同样校验 block 档——手动触发(设置页「来一句话」)也不该在愤怒时生成友善闲聊。
- `task_reminder` 不受任何情绪闸门影响(用户自己设的功能性提醒)。
- `getStatus()` 新增 `emotionGate` 字段(模式/P 值),前端可展示「因情绪低落暂缓」。

### 修复 3:类型表 `minAffinity` —— 陌生档禁用自发类

`proactiveTypes.js` 类型表新增 `minAffinity` 字段(该表是全项目唯一事实源,先例是 memory_share 的「好感度≥50」硬编码,统一搬进表):

| 类型 | minAffinity | 说明 |
|---|---|---|
| mood_check / miss_you / random_chat / life_update | 16 | 初识档解锁,陌生档(0-15)禁用 |
| memory_share | 50 | 原 `_runCheck` 硬编码搬入 |
| morning/night_greeting、task_reminder | 无 | 礼貌问候与功能性提醒不限 |

判定点:`canTrigger()` 统一校验(自动触发);`trigger()` 开头同样校验(手动触发)。陌生档 prompt 文案保留但不再可达。

### 修复 4:全局自发间隔 + 相似度去重

- **全局自发间隔**:新增 `SPONTANEOUS_GAP = 90min` 与 `lastSpontaneousAt` 时间戳(落盘)。5 个自发类(带 `spontaneous: true` 标记)共享:90 分钟内至多一条自发消息,彻底消除背靠背。task_reminder、定时问候不受限(定时问候时间窗与自发类窗口本就不重叠)。
- **相似度去重**:`trigger()` 入队前,与队列内现有消息 + 最近 2 条已发消息(`recentSentTexts`,落盘)比对——归一化空白后前 `DUPLICATE_PREFIX_LEN`(**8**,现实案例两条复读的共同前缀「那个……下午好。」恰好 8 字符,单测实测 10 拦不住)字符雷同即视为复读,丢弃且不入账(记账之前丢弃,配额天然不占;但写同类型冷却时间戳,防止每个轮询周期重掷骰子重调 LLM 的重试风暴)。

### 修复 5:自动化测试

新增 `backend-node/scripts/test-proactive-gating.mjs`(mock aiGirlfriend,不调 LLM),覆盖:陌生档拦截、minAffinity 边界、ghost/block 档拦截、suppress 档系数、task_reminder 豁免、全局自发间隔、相似度去重、memory_share≥50;挂进 `npm test` 串联。测试按 `test-personality.mjs` 先例对 `data/proactive_state.json` 做备份/还原。

## 5. 验证方案与结果

**方案**(遵循开发约定:8000 常驻实例不动,PORT=8100 临时实例):

1. `npm test` 全绿(含新增 test-proactive-gating)。
2. PORT=8100 起临时实例,情绪设为愤怒(P=-0.8):`POST /chat/proactive/trigger`(random_chat/mood_check)应被拒;60s 轮询不应产出自发消息。
3. 情绪设为中性、好感度调至 35(朋友档):手动触发应成功,且后端日志确认生成组包含情绪/关系注入。
4. 触发两条自发消息验证 90min 全局间隔与相似度去重。

**结果**(2026-10-01 实测):

1. **`npm run check` 语法门禁 48/48 通过;`npm test` 五脚本串联全绿**(含新增 `test-proactive-gating.mjs` 36 项断言,真实 `proactive_state.json` 备份/还原分毫未动)。
2. **PORT=8100 临时实例 + 真实现场状态**(愤怒 P=-0.84、好感度 0——比截图时更极端):
   - `GET /chat/proactive/status` → `emotionGate: {mode:"block", factor:0, P:-0.84}`、`ghosting: true`、`stage: "stranger"`、`spontaneousGapRemainingMs: 5129747`。
   - `POST /chat/proactive/trigger`:random_chat / mood_check / morning_greeting 全部 **HTTP 503**,日志逐条 `Blocked ...: ghosting (P=-0.84)`。
   - `POST /state {affinity:35}` 后 random_chat 仍 503——情绪闸与好感度闸相互独立,阶段解锁不绕过情绪拦截(设计如此);验证后好感度已还原 0。
   - task_reminder 豁免路径由单测 G 节覆盖(ghost 中照发)。
3. **正路径(情绪中性)E2E 未跑**:临时实例无 API Key(只存常驻进程内存),生成必失败;pass/suppress 档的触发与入队由单测 B/F 节覆盖,注入文案与主对话 `_prepare()` 同源(同函数同参数),风险低。
4. 测试本身抓到一个真 bug:去重前缀长度最初定 10,单测证明拦不住现实那对复读消息(共同前缀恰 8 字符),已改为 8——这正是要写这条测试的原因。

## 6. 遗留观察(本次不修)

- **情绪衰减只发生在对话时**:`decay()` 仅在每轮回复后(0.03)与 ghost 早退(0.05)被调用,挂机不衰减、重启不衰减(`emotion_state.json` 原样恢复)。这意味着愤怒可以无限期存续——情绪闸门会因此长期压制主动消息。这其实是「冷暴力持续期间她确实不该主动」的正确行为,但若用户希望关系随时间自然缓和,可考虑给 EmotionEngine 挂定时衰减。
- **主动消息不反馈情绪**:`recordProactiveMessage` 明确不触发情绪/好感度变化(职责在 `chat()`)。保持简单,不闭环。
- 前端投递无间隔(队列按优先级一口气送达):90min 生成端间隔已从源头消除堆积,前端节流暂无必要。
- 主动消息的 emotion 字段(<metadata> 解析)只透传给前端做气泡表情,后端不消费——如需「主动消息也影响情绪」,在 `trigger()` 成功后调 `applyDelta` 即可,本次不做。

## 附录 A:主动消息类型表(修复后)

| id | 优先级 | 冷却 | 时间窗 | minAffinity | spontaneous | 配额 | 深夜 |
|---|---|---|---|---|---|---|---|
| morning_greeting | 80 | 24h 固定 | 07:30–09:30 每日一次 | – | 否 | 占 | 豁免 |
| night_greeting | 80 | 24h 固定 | 21:30–23:30 每日一次 | – | 否 | 占 | 豁免 |
| task_reminder | 100 | 5min | 全天 | – | 否 | **豁免** | 豁免 |
| miss_you | 50 | 3h | 全天 | 16 | 是 | 占 | 受限 |
| mood_check | 60 | 4h | 14:00–21:00 | 16 | 是 | 占 | 受限 |
| memory_share | 40 | 6h | 全天 | 50 | 是 | 占 | 受限 |
| random_chat | 30 | 2h | 全天 | 16 | 是 | 占 | 受限 |
| life_update | 20 | 30min | 离开≥30min 回来时 | 16 | 是 | 占 | 受限 |

## 附录 B:PAD → 行为映射速查

| P 区间 | 情绪标签(EmotionEngine.js:148-171) | 主对话行为 | 主动消息(修复后) |
|---|---|---|---|
| P < -0.75 | 愤怒/暴躁 | ghost:「已读不回」💔 | 自发类+定时问候全不发,task_reminder 照发 |
| -0.75 ≤ P < -0.5 | 愤怒/暴躁/抑郁 | styleGuide:冷淡带刺 | 自发类不发;定时问候发但带愤怒语气 |
| -0.5 ≤ P < -0.2 | 低落/焦虑/烦躁 | styleGuide:简短省略号/冷淡 | 自发类概率 ×0.3 |
| P ≥ -0.2 | 正常区间 | 正常 | 正常掷骰子 |

阶段经济(STRANGER 档修复后):自发类全部 minAffinity=16 拦截,`STAGE_ECONOMY.stranger.dailyBase=3` 实际不可达,保留参数供未来策略调整。
