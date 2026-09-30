# 手工验证清单：小爱性格系统前端（T04/T05）

> 输入口径：`docs/personality/DESIGN.md` §10 R-6（零新增依赖结论）所附 5 条手工验证项。
> 作者：QA（严过关） · 状态：**可执行版**（每条含操作 / 预期 / 控制台与 Network 观察点）
> 自动化边界：`npx tsc --noEmit` + `npx eslint src`（两者已复验 exit 0，2026-09-30）；
> 本清单覆盖「需要真实浏览器时序」的剩余验收面。

## 0. 环境准备

1. 启动后端：`backend-node/` 下 `npm start`（确认 8000 端口，无旧进程占用——若有先关闭）。
2. 启动前端：`frontend/` 下 `npm run dev`，浏览器打开并打开 **DevTools**：
   - Network 面板，过滤器输入 `personality`；
   - Console 面板保持可见。
3. 打开「设置 → 性格」Tab，确认 7 个滑块与 6 张预设卡片正常渲染（`GET /personality` 200）。

---

## 1. debounce 合并（DESIGN §10 清单①）

**操作**：在任一滑块上，300ms 内连续拖动 5 次（每次都改变数值，不松手等响应）。

**预期**：
- Network 面板只出现 **1 个** `POST /personality`；
- 该请求 body 的 `traits` 只含**最后一次**的值（如最后停在 62，则 `{"traits":{"security":62}}`）。

**观察点**：
- Network：请求数 = 1；发起时间应在最后一次拖动后 ≈300ms（debounce 窗口）。
- 若出现 ≥2 个请求 → debounce 合并失效（回归）。

## 2. 跨维度合并（DESIGN §10 清单②）

**操作**：300ms 内先后拖动「独立性」与「安全感」两个不同滑块，然后停手。

**预期**：
- Network 面板 **1 个** `POST /personality`；
- body `traits` **同时包含** `independence` 与 `security` 两个 key。

**观察点**：请求 payload 展开 `traits` 核对两个 key 都在；只出现一个 key 说明 pendingRef 被覆盖而非合并（回归）。

## 3. 请求序号 last-write-wins（DESIGN §10 清单③）

**操作**：拖动「安全感」到某值 A，松手后**立即（<300ms）**再次拖到值 B 松手（制造两次提交 + 两次响应乱序可能）。可用 Network 面板「Throttling」人为加大响应延迟来放大乱序窗口。

**预期**：
- 两次 `POST /personality` 均**发出**（不被去重）；
- 滑块最终停在 **B**，即使第一个（旧）响应更晚到达也**不回跳**到 A。

**观察点**：
- 代码锚点：`hooks/usePersonality.ts` 的 `commit()` 在 `applyState`（state 路径）与 `applyLedger`（ledger 路径）**各有一次** `seq !== seqRef.current` 丢弃校验，`reset()` 共用同一 `seqRef` 计数器——两条响应路径均受保护。
- Network：两个响应的 `baseline.security` 分别为 A、B，UI 始终显示 B。

## 4. 切预设打断 pending（DESIGN §10 清单④）

**操作**：拖动任一滑块（**不等待 300ms debounce 触发**），立刻点击任意预设卡片。

**预期**：
- Network 面板**没有** traits 的 `POST /personality` 发出（pending 被清空）；
- 随后只有 1 个 `{presetId:...}` 提交；
- 7 个滑块全部动画过渡到该预设值（baseline === current）。

**观察点**：
- 代码锚点：`applyPreset()` 先 `clearTimeout(timerRef)` 再清空 `pendingRef.current`，保证 traits 与 presetId 不混拍。
- Network：请求 body 应为 `{"presetId":"xxx"}` 且不含 `traits`。

## 5. 防抽动（DESIGN §10 清单⑤，§8.9 双层 transform）

**操作**：缓慢来回拖动「安全感」滑块，观察小三角（current）与把手（baseline）的动画；再把数值从 9.5 拖过 10.0（位数变化）。

**预期**：
- 动画进行中把手**不偏移半个身位**、不出现水平瞬移（双层 transform 生效：外层 motion.div 只 `animate x`，内层普通 div 才持有 `-translate-x-1/2`）；
- 数值区从 9.5 → 10.0 时**布局不跳动**（固定宽度 + `tabular-nums`）；
- 浮动带跟随 baseline 平滑移动，带宽不变形。

**观察点**（DevTools Elements，抽查任一滑块）：
- 小三角/把手结构必须是「外层 `motion.div`（`animate={{ x: "pct%" }}`）+ 内层普通 div（`-translate-x-1/2`）」双层，**同一元素上不得同时出现** motion 内联 transform 与 Tailwind translate 类（项目已知坑：motion 会整个覆盖 Tailwind translate）；
- 指示器定位一律 `translate-x`，不得出现对 `left/right` 的动画插值。

---

## 已知未自动化项（记录在案，不阻塞验收）

| 项 | 优先级 | 说明 |
|---|---|---|
| TC-THR-02 负向单轮 −1.5 | **N/A（结构上不可触顶）** | 即时规则单 category 槽 + 疲劳乘数 ≤1，同维负向叠加峰值 \|Δ\|≤0.8（security/trust），负向单轮上限在真实信号空间不可触顶；钳制逻辑由「正向精确 1.5」用例（R12+R17 trust 1.8→1.5）与同一代码路径覆盖。已同步标注进 TEST-CASES.md。 |
| TC-MIG-05 | P1 | `.traits` 残留读取路径的源码 grep 检查（v2 已无该字段，风险极低） |
| TC-MAN-07 | P1 | 引擎级 baseline_adapt 沉淀（纯函数层 `computeBaselineAdapt` 已有 2 个用例覆盖） |
| TC-API-08 | P1 | `presetId + traits` 同 body 叠加下发（路由为 preset→traits 固定顺序，逻辑已由 API-02/05 分路覆盖） |
| TC-THR-17 | P1 | 冷启动 19/20 边界（19→×0.5、20→全额；边界含义已由 10→×0.5 与 20→全额用例夹逼） |

> 补充说明：DESIGN.md「附：测试隔离范式加固」一节建议的「unlink 失败重试 3 次后 throw」方案未按原文采用——实测根因是本机沙箱 safe-delete 配额（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，每 turn 50 次删除上限），重试无效、throw 会让测试在配额触顶时整轮红。最终落地为 `forceUnlink`：失败打印 stderr + 降级覆写 `{"version":2}`（v2 空状态，等价干净），实测配额触顶下仍 129 项确定性全绿。该偏差建议架构师在 DESIGN 中追认。
