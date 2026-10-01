# 「完全重置」功能全面分析（Coverage Audit）

> 分析对象：设置 → 系统 Tab → 「🔄 完全重置小爱 (不可逆)」
> 分析时间：2026-10-01
> 结论摘要：**功能实现正确、语义防护到位，但清理范围不"完全"——4 类数据被遗漏。**
>
> **⚠️ 更新（2026-10-01 同日修复）**：下述 P1/P2 问题**已全部修复**，清理范围从 4 类扩展到 6 类。
> 具体见文末「九、修复记录」。本报告第五节的问题清单保留为修复前的现场记录。

---

## 一、功能定位与调用链

| 层级 | 文件 | 关键代码 |
|------|------|---------|
| UI 入口（触发器） | `frontend/src/components/settings/tabs/SettingsAdvancedTab.tsx:19` | `<Button variant="danger" onClick={onReset}>🔄 完全重置小爱 (不可逆)</Button>` |
| 二次确认 | `frontend/src/components/settings/SettingsDialog.tsx:356-372` | `ConfirmDialog`，type=danger，列明清空"好感度/长期记忆/对话记录" |
| 确认执行体 | `frontend/src/components/settings/SettingsDialog.tsx:213-225` | `handleResetAll()` |
| API 客户端 | `frontend/src/lib/api.ts:136` | `resetAll: () => request("/reset", { method: "POST" })` |
| 后端路由 | `backend-node/src/routes/state.js:33-36` | `router.post('/reset', ...)` → `aiGirlfriend.resetAll()` |
| 核心实现 | `backend-node/src/core/AiGirlfriend.js:865-873` | `resetAll()` 依次重置 4 个引擎 |

### 完整调用链
```
SettingsAdvancedTab.onReset
  → setShowResetConfirm(true)              [弹确认框]
  → ConfirmDialog.onConfirm
  → handleResetAll()
      → api.resetAll()  POST /reset
          → aiGirlfriend.resetAll()
              ├─ this.history = [system]        (自带，不落盘)
              ├─ this.affinityEngine.reset()    → data/affinity_state.json
              ├─ this.personalityDrift.reset()  → data/personality_state.json
              ├─ this.memory.clearMemory()      → data/memory.json
              └─ this._saveState()              → data/state.json
      → remove("affinity")                  [清 localStorage 好感度缓存]
      → showToast("小爱已完全重置！")
      → setTimeout(window.location.reload, 1000)   [整页刷新复位前端内存态]
```

---

## 二、后端 `resetAll()` 逐引擎拆解

```js
// AiGirlfriend.js:865
resetAll() {
    this.history = [{ role: "system", content: this.systemPrompt }];
    this.affinityEngine.reset();        // 1
    this.personalityDrift.reset();      // 2
    if (this.memory) { this.memory.clearMemory(); }  // 3
    this._saveState();                  // 4 兜底落盘
}
```

| # | 引擎 | 重置行为 | 落盘文件 | 复杂度 |
|---|------|---------|---------|--------|
| 1 | **AffinityEngine.reset()** (`AffinityEngine.js:217-225`) | `_affinity = DEFAULT_AFFINITY`；清空 `gainEvents`、`ledger`；`lastUserActiveTime = Date.now()`；`daily = {gained:0}` | `data/affinity_state.json` | 完整 |
| 2 | **PersonalityDrift.reset()** (`PersonalityDrift.js:421-434`) | 回 `DEFAULT_PRESET_ID`（温柔）；`baseline/current` 克隆预设；清 `daily/ruleHits/adapt/ledger`；重置 `lastSettledDay` | `data/personality_state.json` | 完整 |
| 3 | **Memory.clearMemory()** (`Memory.js:296-303`) | `store.episodes = []`；`store.facts = []`；清 `_recentSharedIds`；`_extractGeneration++`（作废在途提取）；立即 flush | `data/memory.json` | 完整 |
| 4 | **_saveState()** (`AiGirlfriend.js:132`) | 写 `nickname + history(空) + config` | `data/state.json` | 注意：**nickname 被保留** |

---

## 三、清理范围矩阵（关键结论）

### ✅ 被清空的数据

| 数据 | 落盘位置 | 说明 |
|------|---------|------|
| 对话记录 history | `state.json` | 保留 system prompt 一条 |
| 好感度 affinity | `affinity_state.json` | 回默认档位 |
| 好感度变更账本 ledger | `affinity_state.json` | 清空（≤200 条） |
| 24h 增益事件 gainEvents | `affinity_state.json` | 清空 |
| 当日增益计数 daily | `affinity_state.json` | 归零 |
| 性格 current/baseline | `personality_state.json` | 回"温柔"预设 |
| 性格变化账本 ledger | `personality_state.json` | 清空 |
| 性格日累积/规则疲劳/适应量 | `personality_state.json` | 清空 |
| 情节记忆 episodes | `memory.json` | 全清 |
| 事实记忆 facts | `memory.json` | 全清 |
| localStorage `affinity` | 浏览器 | 前端显式 remove |

### ❌ 未清理（重置后仍残留）

| 数据 | 落盘位置 | 影响 | 严重度 |
|------|---------|------|--------|
| **情绪状态** | `emotion_state.json` | PAD 三维情绪、基线、关系上下文**未复位**。重置后小爱可能仍停留在"生气/低落"等历史情绪 | 高 |
| **任务列表** | `tasks.json` | 用户创建的提醒/任务**全部保留**。TaskManager 没有接进 resetAll | 中 |
| **主动消息状态** | `proactive_state.json` | 上次发送时间、计数等历史记录保留 | 低 |
| **生活日志** | `life_log.json` | LifeSimulator 的生活事件历史保留 | 低 |
| **用户昵称 nickname** | `state.json` | `_saveState()` 写 `this.nickname`（内存值，未重置），昵称保留 | 低（可能是有意） |
| **全部本地配置** | localStorage | `apiKey/baseUrl/modelName/主题/TTS/嵌入/主动开关/高级选项/引导标记` 等**全部保留** | 低（符合预期） |

> **注意**：重置**不删除** `memory.json.v1.bak`（v1 迁移备份），也不清 `temp_uploads/`。

---

## 四、设计上值得肯定的地方

1. **语义隔离严格**：`DELETE /history`（新对话）与 `POST /reset`（完全重置）被明确拆分。源码注释三处（`state.js:4-8`、`AiGirlfriend.js:844-852`、`chatStore.ts:199-203`）反复强调"新对话绝不能误清好感度"，历史 bug（共用 DELETE /history）已修复并留痕。
2. **二次确认到位**：`ConfirmDialog type="danger"`，文案明确列出三项清空内容 + "不可恢复"警示 + 引导用户"若只想清画面请用新对话"。
3. **前端状态兜底**：调用后 `remove("affinity")` + 整页 `window.location.reload()`，避免 Zustand 内存态残留（chatStore 也刻意删除了重复且不全的 `resetEverything`）。
4. **落盘原子性**：`jsonStore` 采用"临时文件 + rename"原子写 + 损坏隔离（quarantine），不会出现"损坏→读空→写回覆盖"的静默清空。
5. **在途任务作废**：`Memory.clearMemory()` 里 `_extractGeneration++` 让在途的事实提取失效，避免重置后又把旧对话提取回来。
6. **`if (this.memory)` 判空防护**：memory 未注入时不崩。

---

## 五、风险与问题清单

| 级别 | 问题 | 位置 | 建议 |
|------|------|------|------|
| **P1** | 情绪状态未重置 | `emotion_state.json` / `EmotionEngine` | `resetAll()` 增加 `this.emotionEngine.reset()`（若无此方法需新增） |
| **P1** | 任务列表未清理 | `tasks.json` / `TaskManager` | 明确产品意图：若"完全重置"应清空用户数据，需接 `TaskManager.clearAll()` |
| **P2** | `resetAll()` 无异常处理 | `state.js:33` | `aiGirlfriend.resetAll()` 若抛错（如落盘失败）会 500，前端只提示"重置失败"，但部分引擎可能已重置 → **状态不一致**。建议加 try/catch 或事务化 |
| **P2** | 前端 `handleResetAll` 失败时仍 reload | `SettingsDialog.tsx:221-224` | catch 分支只 toast，未 reload，UI 停留在旧状态；且 `setShowResetConfirm(false)` 在 catch 后执行 → 关框但未刷新，用户困惑 |
| **P2** | 重置与"性格 Tab 恢复默认"语义重叠 | `handlePersonalityReset` | 性格 Tab 的"恢复默认预设"也会 `personalityDrift.reset()`，与完全重置有部分重叠，文案需区分（当前已区隔：性格 tab 强调"不影响好感度/记忆"） |
| **P3** | `state.json` 的 config 段未清 | `state.json` | 重置不清 baseUrl/modelName（合理，属配置非关系数据） |
| **P3** | 无操作日志/审计 | — | 破坏性操作无留痕，无法追溯"谁在何时重置过" |
| **P3** | 无并发保护 | `state.js` | 重置进行中若恰好有 chat 请求写盘，可能交错（单进程 Node 风险较低，但 debounce flush 存在窗口） |

---

## 六、数据一致性视角

重置涉及 **4 个独立 JSON 文件**，由 4 个引擎各自 `_saveState()` 异步/同步落盘：

- `AffinityEngine.reset()` → 同步 `_saveState()`
- `PersonalityDrift.reset()` → 同步 `_saveState(now)`
- `Memory.clearMemory()` → `store.flush()`（**注意 MemoryStore 默认有去抖 debounce**，但 clearMemory 显式调用 flush 立即落盘）
- `AiGirlfriend._saveState()` → 最后兜底

**存在窗口**：若第 2 步成功、第 3 步抛异常，则 affinity/personality 已重置但 memory/history 未重置 → **部分重置的半状态**。没有事务回滚机制。

---

## 七、改进建议（按优先级）

1. **补齐清理范围**（若产品定义"完全重置=回到出厂"）
   ```js
   resetAll() {
       this.history = [{ role: "system", content: this.systemPrompt }];
       this.affinityEngine.reset();
       this.personalityDrift.reset();
       this.emotionEngine.reset();        // 新增
       this.taskManager.clearAll();       // 新增（需实现）
       if (this.memory) this.memory.clearMemory();
       this._saveState();
   }
   ```
   同时在 `ConfirmDialog` 文案中补充"情绪状态""任务列表"。

2. **事务化 / 失败回滚**：先快照各引擎状态，任一失败则回滚，或采用"全部成功才确认"的补偿逻辑。

3. **前端失败处理**：catch 分支也应提示并考虑不给成功 toast；成功后再 reload（当前已如此），失败保持弹窗可重试。

4. **可选：备份机制**：重置前把 `data/*.json` 打包到 `data/backup-reset-<ts>/`，给用户"反悔窗口"。

5. **补测试**：`scripts/` 下增加覆盖测试，断言重置后 6 个 JSON 文件的字段值。

---

## 八、相关文件索引

```
frontend/src/components/settings/tabs/SettingsAdvancedTab.tsx    UI 触发器
frontend/src/components/settings/SettingsDialog.tsx              handleResetAll + ConfirmDialog
frontend/src/lib/api.ts:136                                      api.resetAll
frontend/src/lib/storage.ts                                      KEYS / remove("affinity")
frontend/src/stores/chatStore.ts:199                             resetEverything 已删除的说明
backend-node/src/routes/state.js:33                              POST /reset
backend-node/src/core/AiGirlfriend.js:865                        resetAll()
backend-node/src/core/AffinityEngine.js:217                      AffinityEngine.reset()
backend-node/src/core/PersonalityDrift.js:421                    PersonalityDrift.reset()
backend-node/src/core/Memory.js:296                              Memory.clearMemory()
backend-node/src/core/memory/MemoryStore.js                      memory.json 持久化
```

---

## 九、修复记录（2026-10-01）

针对第五节问题清单的 P1/P2 项完成修复，已通过语法检查、类型检查与回归测试。

### 后端改动

| 文件 | 改动 |
|------|------|
| `core/EmotionEngine.js` | **新增 `reset()`**：PAD 回初值 `(0.3, 0.1, -0.1)`，清 `history`、`relationshipStage/relationshipLabel`、`baseline`，落盘 `emotion_state.json` |
| `core/TaskManager.js` | **新增 `clearAll()`**：清空 `tasks` 并落盘，返回清除条数 |
| `core/AiGirlfriend.js` | **重写 `resetAll()`**：6 步（history/affinity/personality/emotion/tasks/memory），**逐步独立 try/catch，单点失败不中断**，返回 `{ reset, failed }`；末尾 `_saveState()` 亦纳入容错 |
| `routes/state.js` | `POST /reset`：有失败项回 **HTTP 207 `partial`** + failed 明细，全部成功回 200 `reset` |

### 前端改动

| 文件 | 改动 |
|------|------|
| `lib/api.ts` | `resetAll` 返回类型扩展为 `{ status: "reset"｜"partial", reset, failed }` |
| `components/settings/SettingsDialog.tsx` | `handleResetAll`：partial 时提示"已重置但有 N 项未成功"；**成功与 partial 都整页 reload**；纯请求失败时保持确认框可重试；确认框文案补齐"性格/情绪/任务"三项 |
| `components/settings/tabs/SettingsAdvancedTab.tsx` | 危险操作说明补齐清空范围 |

### 修复前后对照

| 问题 | 修复前 | 修复后 |
|------|--------|--------|
| 情绪未复位 | `emotion_state.json` 残留（日志可见加载出"愤怒"） | `EmotionEngine.reset()` 回初值 |
| 任务未清理 | `tasks.json` 全保留 | `TaskManager.clearAll()` 清空 |
| 半重置风险 | 任一引擎抛错中断后续 | 逐步骤容错 + `failed` 回传 |
| 失败无感知 | 后端 500 / 前端只 toast | 207 partial + 前端如实提示 |
| 失败仍关框 | catch 后仍 `setShowResetConfirm(false)` | 请求失败保持弹窗可重试 |

### 验证

- `node --check` 通过：AiGirlfriend.js / EmotionEngine.js / TaskManager.js / state.js
- `npx tsc --noEmit` 通过（EXIT 0）
- 新增回归测试 `backend-node/scripts/test-reset-all.mjs`：**15/15 断言通过**，覆盖 EmotionEngine.reset、AffinityEngine.reset、TaskManager.clearAll 的内存态与落盘态

> 注：项目自带 `scripts/check-syntax.mjs` 在本机 Node 22 下报 `vm.SourceTextModule is not a constructor`，属脚本自身环境问题，与本次改动无关。
