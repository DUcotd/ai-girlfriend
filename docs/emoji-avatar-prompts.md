# 小爱表情包 · 人物图像重绘方案（AI 生成提示词）

> 目标：把现有 `frontend/src/lib/emojiData.ts` 里的文字 emoji，替换为一套**同一角色、统一画风**的小爱人物表情图。
> ⚠️ **本文的外观描述已过期（2026-10-01 立绘全量重绘为「银发月色系」）**：
> 下方 §1「Character Bible」里的 *粉色长发 / 紫色眼睛 / 露肩毛衣* 是重绘前的旧设定，
> 照它生成会把小爱的身份劈成两套。**当前唯一外观真源**：
> `docs/character-emote-prompts.md` §外观 + `backend-node/src/core/prompts/systemPrompt.js` 的人设第 1 条。
> 情绪标签现为 17 档（`EmotionEngine.EMOTION_LABELS`，本文写作时是 16 档）。
> 面板规格依据：`frontend/src/components/chat/EmojiPicker.tsx`（网格格子约 48px，`h-[180px]` 滚动区）。

---

## 0. TL;DR

| 项 | 结论 |
|---|---|
| 数量 | **48 张**（4 组 × 12），另加 1 张角色定妆图 = 生成 49 张 |
| 画风 | 日系赛璐璐上色 + 粗描边**贴纸风**（sticker / emote），半身胸像，正面视角 |
| 构图 | 头肩特写，角色居中，**纯色或透明底**，四边留 8% 安全边距 |
| 母版 | 1024×1024 PNG（透明底），导出 256 / 128 两档 WebP |
| 一致性 | 先出定妆图 → 用 `--cref`/`--sref`（MJ）或 IP-Adapter / LoRA（SD/Flux）锁定 → 再批量出 48 张 |
| 关键 | **提示词只改「表情/动作」那一段，前后两段逐字不变**——这是整套画风不散的唯一保证 |

---

## 1. 角色锚定（Character Bible）— 每张图都必须带

（**已失效，仅作历史留档** — 请勿据此生成；现行设定见文首提示与 `docs/character-emote-prompts.md`）

从**旧版**人设逐字提取，保留原文以便追溯：

| 属性 | 内容 | 英文锚定词 |
|---|---|---|
| 发色发型 | 粉色长发 | `long pink hair, soft sakura-pink, straight with gentle waves, side-swept bangs` |
| 眼睛 | 温柔的紫色眼睛 | `gentle violet-purple eyes, soft droopy upper eyelid, long eyelashes` |
| 服装 | 露肩毛衣 | `off-shoulder knit sweater, ivory cream color, ribbed collar` |
| 气质 | 温柔、有礼貌、偶尔害羞、小傲娇 | `warm and polite aura, slightly shy, hint of tsundere` |
| 年龄感 | 二次元少女（建议 18-20 岁观感） | `anime girl, late teens` |
| 风格 | 二次元 | `anime style, 2D` |

**定妆图提示词（先生成这一张，后续全部以它为参考）**

```
anime style sticker illustration, upper-body bust portrait of a beautiful anime girl,
long pink hair with gentle waves and side-swept bangs, gentle violet-purple eyes,
wearing an ivory off-shoulder knit sweater with ribbed collar,
warm polite smile, head slightly tilted, facing viewer,
clean cel shading, thick clean lineart, soft pastel pink and lavender palette,
soft rim light, expressive eyes with crisp highlights,
shown from chest up, centered composition, plain flat lavender background,
high detail face, vtuber emote style, high resolution, 1:1
```

**负向提示词（所有图共用，SD/Flux 类工具必填）**

```
realistic, photorealistic, 3d render, cgi, photograph, extra limbs, extra fingers,
bad hands, fused fingers, deformed face, asymmetric eyes, multiple heads, text, letters,
watermark, signature, logo, jpeg artifacts, cropped head, cut off head, busy background,
harsh shadows, dark lighting, nsfw, lowres, blurry
```

---

## 2. 三段式提示词模板

批量生成时**只替换 B 段**：

```
A[风格+角色前缀] + B[表情/动作] + C[构图+技术后缀]
```

- **A 段（固定）**
  `anime style sticker illustration, upper-body bust portrait of an anime girl with long pink hair, gentle violet-purple eyes, wearing an ivory off-shoulder knit sweater, clean cel shading, thick clean lineart, pastel pink and lavender palette, expressive eyes with crisp highlights,`
- **B 段（每张不同）**：见第 3 节各条
- **C 段（固定）**
  `centered bust composition, facing viewer, plain flat lavender background, soft rim light, vtuber emote style, high resolution`

> 想要透明底：把 C 段的 `plain flat lavender background` 换成 `isolated on pure white background, no background elements`，
> 生成后用 `rembg` / Photoshop 抠图，比直接要求模型出透明底可靠得多（所有模型出透明底都不稳）。

---

## 3. 表情清单（48 张）

> 命名规范：`xiaomi_{key}.webp`，key 用下表右列。
> 「情绪覆盖」标记 ★ 的是 **EmotionEngine 的 16 个情绪标签之一**，这类图将来还能接到气泡头像 / 情绪指示器上，优先级最高。

### A 组 · 基础情绪（12）— 必备，先做这组

| # | key | 中文 | 表情/动作要点 | B 段提示词片段 |
|---|---|---|---|---|
| 1 | `calm` ★平静 | 平静 | 柔和微笑，眼睛半睁放松 | `calm gentle smile, relaxed half-lidded eyes, serene expression` |
| 2 | `happy` ★开心 | 开心 | 弯眼大笑，张嘴露齿 | `happy open-mouth smile, crescent closed eyes, cheerful bright expression` |
| 3 | `smile` | 微笑 | 抿嘴轻笑 | `soft closed-mouth smile, gentle eyes, subtle warm expression` |
| 4 | `excited` ★兴奋 | 兴奋 | 星星眼，微张嘴，脸颊泛红 | `excited sparkling star eyes, slightly open mouth, light blush, energetic` |
| 5 | `shy` | 害羞 | 低头红脸，手背贴脸颊 | `shy bashful expression, deep blush, averting gaze downward, one hand near cheek` |
| 6 | `surprised` | 惊讶 | 睁大眼，小圆嘴 | `surprised wide round eyes, small open mouth, eyebrows raised` |
| 7 | `sad` ★低落 | 难过 | 垂眼，轻皱眉，泪光 | `sad downcast eyes, slight frown, teary glossy eyes` |
| 8 | `cry` | 哭泣 | 流泪，闭眼 | `crying, tears streaming down cheeks, tightly closed eyes, pained expression` |
| 9 | `angry` ★愤怒 | 生气 | 鼓腮，皱眉，瞪 | `angry puffed cheeks, furrowed brows, glaring, small annoyed frown` |
| 10 | `tsundere` ★傲娇 | 傲娇 | 扭头哼，抱臂，脸微红 | `tsundere pouting, head turned away, arms crossed, slight blush, "hmph" expression` |
| 11 | `sleepy` ★困倦 | 困倦 | 半闭眼打哈欠 | `sleepy half-closed eyes, yawning, one hand covering mouth, drowsy` |
| 12 | `thinking` | 思考 | 手指抵下巴，眼神上飘 | `thinking pose, index finger on chin, eyes looking up, small "hmm" mouth` |

### B 组 · 情绪扩展（12）— 把 16 个情绪标签补齐

| # | key | 中文 | 表情/动作要点 | B 段提示词片段 |
|---|---|---|---|---|
| 13 | `joy` ★狂喜 | 狂喜 | 大笑+双手举起+星星 | `overjoyed laughing, sparkling eyes, both hands raised, sparkles around` |
| 14 | `rage` ★暴躁 | 暴躁 | 眯眼怒视，咬牙 | `furious glaring eyes narrowed, gritted teeth, angry vein mark on temple` |
| 15 | `anxious` ★焦虑 | 焦虑 | 皱眉，冒冷汗，绞手 | `anxious worried brows, sweat drop on cheek, fidgeting clasped hands` |
| 16 | `depressed` ★抑郁 | 抑郁 | 空洞眼，低头，阴影 | `depressed hollow empty eyes, head hanging down, shadow over upper face` |
| 17 | `blah` ★烦躁 | 烦躁 | 烦躁啧嘴，撇头 | `irritated expression, clicking tongue, head tilted away, annoyed half-lidded eyes` |
| 18 | `hyper` ★亢奋 | 亢奋 | 超级兴奋，动态线 | `hyper energetic expression, wide dilated eyes, high energy, motion lines` |
| 19 | `content` ★满足 | 满足 | 眯眼满足微笑 | `content satisfied smile, happily closed eyes, blissful relaxed face` |
| 20 | `assertive` ★强势 | 强势 | 自信挑眉，叉腰 | `confident assertive smirk, eyebrows raised, hands on hips, chin up` |
| 21 | `clingy` ★撒娇 | 撒娇 | 上目线，双手合十 | `clingy pleading puppy eyes, upturned gaze, hands clasped in front of chest` |
| 22 | `dependent` ★依赖 | 依赖 | 侧头轻靠，软眼神 | `dependent soft gaze, leaning slightly, head tilted, trusting expression` |
| 23 | `flustered` ★慌乱 | 慌乱 | 手忙脚乱，脸红 | `flustered panicking expression, waving hands, heavy blush, sweat drops` |
| 24 | `blank` ★放空 | 放空/无语 | 面无表情，眼神空洞 | `deadpan blank face, emotionless flat eyes, small mouth, "...?" mood` |

### C 组 · 亲密互动（12）— 按关系阶段使用，好感度越高越可出现

| # | key | 中文 | 表情/动作要点 | B 段提示词片段 |
|---|---|---|---|---|
| 25 | `heart_eyes` | 爱心眼 | 瞳孔变爱心 | `heart-shaped pupils, lovestruck expression, adoring gaze` |
| 26 | `blow_kiss` | 飞吻 | 嘟嘴飞吻，眨眼 | `blowing a kiss, puckered lips, one eye winking, hand near mouth` |
| 27 | `hug` | 拥抱 | 双臂张开 | `open arms for a hug, warm welcoming smile, leaning forward slightly` |
| 28 | `headpat` | 摸摸头 | 双手抱头，害羞 | `shy embarrassed smile, both hands on head, blushing, "being patted"` |
| 29 | `handhold` | 牵手 | 向前伸手 | `reaching out one hand toward viewer, gentle shy smile, slight blush` |
| 30 | `cuddle` | 依偎 | 脸颊轻贴，闭眼 | `snuggling affectionately, cheek resting sideways, eyes closed, content smile` |
| 31 | `kiss` | 亲亲 | 闭眼凑近，脸红 | `eyes closed leaning in for a kiss, deep blush, soft anticipating expression` |
| 32 | `blush_peek` | 偷看 | 手遮脸偷瞄 | `peeking through fingers, hand partially covering blushing face, one eye visible` |
| 33 | `heart_hands` | 比心 | 双手比心手势 | `both hands making a heart shape, sweet smile, cheeks lightly pink` |
| 34 | `jealous` | 吃醋 | 鼓脸斜眼 | `jealous pout, puffed cheek, side-eye glance, arms crossed` |
| 35 | `tease` | 吐舌 | 眨眼吐舌 | `playful tongue out, winking, mischievous grin` |
| 36 | `whisper` | 悄悄话 | 手掩嘴，狡黠笑 | `hand cupped beside mouth, whispering, mischievous smiling eyes` |

### D 组 · 动作与日常（12）— 替代原「动作」「其他」两栏

| # | key | 中文 | 表情/动作要点 | B 段提示词片段 |
|---|---|---|---|---|
| 37 | `wave` | 挥手 | 抬手挥 | `waving one hand in greeting, friendly bright smile` |
| 38 | `clap` | 鼓掌 | 双手拍 | `clapping both hands, delighted laughing expression` |
| 39 | `peace` | 比 V | 手指比 V | `peace sign with one hand near cheek, winking smile` |
| 40 | `thumbs_up` | 点赞 | 竖大拇指 | `thumbs up, confident pleased smile, one eye closed` |
| 41 | `cheer` | 加油 | 握拳 | `clenched fist raised, determined motivated expression, energetic` |
| 42 | `salute` | 敬礼 | 抬手敬礼 | `playful salute with two fingers at brow, serious-cute face` |
| 43 | `bow` | 拜托 | 双手合十 | `both palms pressed together pleading, hopeful big eyes` |
| 44 | `shrug` | 摊手 | 摊手歪头 | `shrugging with both palms up, tilted head, awkward apologetic smile` |
| 45 | `eat` | 吃东西 | 腮帮鼓，拿勺子 | `cheeks stuffed with food, holding a spoon, happy chewing face` |
| 46 | `drink` | 喝奶茶 | 举杯吸管 | `holding a bubble tea cup, sipping through straw, content eyes` |
| 47 | `sleep` | 睡觉 | 闭眼，Zzz | `sleeping peacefully, eyes closed, small "Zzz" floating, slight drool` |
| 48 | `sparkle` | 期待 | 星星眼，双手合十 | `hopeful sparkling eyes, hands clasped, leaning forward in anticipation` |

---

## 4. 一致性生成工作流（关键，别跳过第 1 步）

1. **出定妆图**：用第 1 节提示词生成 4-8 张，人工挑 1 张「发型 / 瞳色 / 毛衣领口 / 脸型」最符合人设的，作为唯一角色基准。
2. **锁定基准**（按工具选一种）：
   - **Midjourney**：`--cref <定妆图URL> --cw 100`（角色）+ `--sref <定妆图URL> --sw 100`（画风）+ **固定 `--seed`**
   - **SD / Flux**：训练一个小 LoRA（20-30 张同角色图），或直接用 IP-Adapter FaceID + reference-only 控制
   - **即梦 / 可灵 / Nano Banana / GPT-Image**：把定妆图作为**参考图**上传，提示词写「保持参考图的角色外观与画风，改为以下表情：…」
3. **批量生成**：同一 session 内连续出图，**A 段和 C 段逐字复制不要手打**。
4. **挑图 + 修手**：手部道具是最容易崩的，优先挑手不明显的构图，崩了局部重绘。
5. **统一后处理**：抠底（`rembg`）→ 统一居中裁剪 → 统一色彩/亮度微调 → 导出三档。

**一次别生成超过 6 张再回头检视**——跑偏了要尽早发现。

---

## 5. 平台参数速查

| 平台 | 推荐写法 |
|---|---|
| Midjourney (niji 6) | `--ar 1:1 --niji 6 --style raw --cref <url> --cw 100 --sref <url> --sw 100 --seed 12345 --no text, watermark, realistic, 3d` |
| Stable Diffusion / Flux | 正向按 A+B+C，负向用第 1 节 negative；`CFG 5-7`，`Steps 28-35`，`1024×1024`；配角色 LoRA `weight 0.7-0.9` |
| 即梦 / 可灵 | 中文提示词即可：「日系动漫贴纸插画，粉长发的少女半身像，紫色眼睛，穿露肩毛衣，表情：弯眼大笑，纯色背景，正面居中，干净线条」 |
| Nano Banana / GPT-Image | 上传定妆图 + 「保持这个角色的外观和画风不变，只把表情改成：惊讶地睁大眼睛、小圆嘴」 |
| 本地批量 | `comfyui` + IP-Adapter + ControlNet(参考图)，挂队列跑 48 张，最省钱且最稳 |

---

## 6. 导出规格

| 用途 | 尺寸 | 格式 |
|---|---|---|
| 母版存档 | 1024×1024 透明底 | PNG |
| 面板显示（48px 格子 @2x/@3x） | 128×128 / 256×256 | WebP（质量 85） |
| 消息气泡头像（若启用） | 192×192 | WebP |

- 命名：`xiaomi_calm.webp`、`xiaomi_heart_eyes.webp` …
- 放 `frontend/public/emojis/`，用 `next/image` 或原生 `<img>` 引用 `/emojis/xiaomi_calm.webp`
- 单档 48 张 WebP 总量控制在 < 1.5MB（每张 ≤ 30KB）

---

## 7. 前端接入建议（等图出来再做，本次不动代码）

现有 `emojiData.ts` 是 `emojis: readonly string[]`，只存文字。要接人物图需改成对象数组，例如：

```ts
export interface EmojiItem {
    key: string;        // 稳定 id，用作 React key
    text: string;       // 插入到输入框的内容（仍可发 emoji 字符或颜文字）
    image?: string;     // 面板里显示的人物图路径；缺省时退回渲染 text
}
```

要点：
- **颜文字分类保持纯文本**（`layout: "wide"`），不参与人像化 —— 颜文字本身就是表情图像。
- `text` 与 `image` 解耦：面板显示人物图，但**插入到输入框的仍然是原来的 emoji 字符**（否则后端 LLM 会收到一堆图片路径，语义全丢）。
- 若希望 LLM 能理解「用户发了一张小爱开心图」，可在插入时同时携带语义标记（如 `😊`），或后续在 `streamFilter` / prompt 侧加映射，这是独立改动。
- 分类标签建议微调为：`情绪 / 互动 / 动作 / 颜文字`（原「爱心」「其他」两栏由人像图接管后语义更清楚）。

---

## 8. 出图质检清单

- [ ] 发型（粉长发 + 侧分刘海）、瞳色（紫）、毛衣（露肩、象牙白）在 48 张里是否一致
- [ ] 线条粗细、上色质感、光照方向是否统一（不统一 → `--sref` 权重不够）
- [ ] 表情是否**一眼可辨**（缩到 48px 还能分清开心和害羞吗？分不清就加大表情幅度）
- [ ] 是否全部正面、居中、四边有安全边距（否则面板里会顶边或歪）
- [ ] 手部五指令否正常；有道具的 4 张（eat/drink/peace/heart_hands）重点检查
- [ ] 有没有混进文字、水印、签名
- [ ] 缩到 48px 后主体是否仍清晰（缩小预览验证一次）
