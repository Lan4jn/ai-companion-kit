# memory-brain 整合方案（给开发者）

> 这份文档是需求说明 + 技术方案。上游项目已经读过、验证过、也接过一版又回退过，下面写的坑都是踩过的。
> 执行前请把「第 5 节 约束」看完，那里有几条是会搞坏线上服务的。

---

## 0. 一句话

把 [peterpoal134/memory-brain](https://github.com/peterpoal134/memory-brain) 里三样东西搬进小鱼：**记忆写回**（P0）、**语义清洗 + 生活决策**（P1）、**情绪衰减 + 身份分层**（P2）；另外评估 **3D 大脑可视化**和**房间风格**要不要抄。

---

## 1. 小鱼是什么

```
仓库    /root/ai-companion-xiaoyu/ai-companion-kit
代码    packages/companion/（Node.js ESM，39 个模块，15031 行）
配置    packages/companion/config.json（gitignore，不进仓库）
数据    packages/companion/data/
服务    systemctl status ai-companion-xiaoyu
QQ      1808531252（NapCat 接入，OneBot v11，ws://127.0.0.1:3003）
```

她**不是 AstrBot**。上游四个 `plugins/` 装了也没用，别再试。

她现在有的能力（跟本文相关的）：

| 模块 | 作用 |
|---|---|
| `src/brain.js` | 组 prompt、调模型、Function Calling、写回记忆 |
| `src/memory.js` | 短期记忆（turns.jsonl） |
| `src/mood.js` | 心情（每日基准 + 会话即时，**离散标签**） |
| `src/relationship.js` | 人物关系 |
| `src/growth.js` | 从批评/表扬里提炼自我认知和 avoidRules |
| `src/diary.js` | 日记 |
| `src/humanize.js` | 输出清洗（**只有格式层**：换行、CQ 码、零宽空格、拆句） |
| `src/douyin-living.js` / `bili-living.js` | 生活线（**定时任务制**） |
| `src/proactive.js` | 主动找人说话 |
| `src/image-gen.js` | 生图 + 图库 |

---

## 2. 上游项目结构（已审）

| 模块 | 行数 | 是什么 | 能不能用 |
|---|---|---|---|
| `memory-core/` | 4,239 | 独立记忆 HTTP 服务，23 个 py 文件，35 个接口 | **能，P0 主要靠它** |
| `plugins/astrbot_plugin_memory_brain` | 7,779 | 记忆插件（AstrBot） | 不能装，但**时间感知/提醒/备份**的设计要看 |
| `plugins/astrbot_plugin_persona_state` | 2,069 | 情绪 PAD + 好感 + 识海 | 不能装，借**衰减机制** |
| `plugins/astrbot_plugin_human_style_guard` | 306 | 发送前清洗 | 不能装，借**替换表** |
| `plugins/astrbot_plugin_self_style` | 243 | 自我档案 + 语气样例 | 大概率跟 `growth.js` 重复，扫一眼 |
| `life/life_loop.py` | 1,235 | 生活层，独立进程，**决策制** | 借**决策循环 + 兴趣权重** |
| `dsh/persistent-self` | 951 | 跨会话身份，7 层分层，SQLite | 借**分层 + 身份不可改** |
| `dsh/dafeiyu-3d-brain` | 85,554 | 3D 记忆大脑可视化（浏览器 JS） | 参考，P3 |
| `docs/room*.md` | — | 房间与玩具 | 对比风格，P3 |
| `docs/generation.md` | — | 生图生视频（自己接 ComfyUI） | 生图她有了，视频暂不做 |
| `eval/`、`tools/` | 127 | 检索评估集 | 可借，优先级低 |

上游代码已经拉到 `/tmp/mb`（浅克隆）。如果没了：

```bash
git clone --depth 1 https://github.com/peterpoal134/memory-brain.git /tmp/mb
```

**协议**：AGPL-3.0-or-later / 作者自述"源代码公开、禁止商业使用"。自用可以，别商用。

---

## 3. 需求清单

### P0 · 记忆写回（不做这个，其他都白搭）

**现状问题**：之前接过一版，只调了 `/recall` 把记忆拼进 prompt。跑了半天发现库里永远是那 55 条测试数据——**她只「想得起来」，不会「记得住」**。所以回退了。

**要做的事**：

1. 把 `memory-core` 作为 vendored 子包放进 `packages/memory-core/`（上次做过，commit `ab8107c` 可以捡回来，`git show ab8107c --stat` 看范围）
2. systemd 常驻，`127.0.0.1:8780`，token 走 config
3. 在 `brain.js` 的回复流程**之后**，异步调 `POST /digest/extract`：

```
POST /digest/extract   {"conversation": "...", "user": "qq:578021239"}
→ {summary, kind, importance, valence, entities[], relations[]}
```

`kind` 五选一：`episode | fact | preference | relation | skill`

4. 抽出来的结果直接 `POST /remember` 落库

**关键设计**：
- **异步、不阻塞回复**。用户等回复的时间不能增加。
- **限流**：只处理「有实质内容」的轮次。寒暄（"在吗""哈哈"）不写。建议规则：用户消息 ≥ 8 字 且 不含纯语气词。
- **开关**：`config.memoryBrain.enabled`，默认 `false`，出问题能一键关掉不影响聊天。
- **失败静默**：写成 try/catch 包住，记忆服务挂了最多是"这轮没记住"，不能让她的回复失败。

**验收**：
- 聊 5 轮有内容的天，`GET /stats` 的 `active` 从 55 涨到 ≥ 60
- 回复延迟增加 < 200ms（因为异步）
- 手动 `kill` memory-core，她照常回复不报错

**参考代码**：`/tmp/mb/memory-core/memory_core/extractor.py`（抽取提示词在 `USER_PROMPT`，已经写得很细，直接抄）

---

### P1 · 语义替换表（成本最低，收益最直接）

**现状问题**：`src/humanize.js`（285 行）全是**格式层**——换行兼容、CQ 码清洗、零宽空格、去 Markdown 加粗、逗号拆句、发送延迟。**没有任何语义层的"反客服腔"处理**，所以她说"有什么事吗"这种话只能靠 prompt 约束，约束不住。

**要做的事**：从 `/tmp/mb/plugins/astrbot_plugin_human_style_guard/main.py` 抄替换表（第 62~70 行附近）：

```python
(re.compile(r"在?呢?[，, ]*(?:是)?想我了?还是有事(?:呀|吗|么)?[？?]?"), "，咋了。"),
(re.compile(r"有什么事(?:呀|吗|么)?[？?]?"), "咋了？"),
(re.compile(r"说吧[，, ]*什么事[。？?]?"), "咋了？"),
(re.compile(r"有啥事(?:呀|吗|么)?[？?]?"), "咋了？"),
```

再加 `[微笑]` 这类表情码的检测（上游 `FACE_CODE_RE`）。

**注意**：
- 插在 `Humanizer` 的清洗链里，**在拆句之前**（拆句后句号都没了，正则匹配不上）
- 别替换得太狠——她本来就叫"咋了"会显得机械。上表只在**整句就是客服腔**时才换。

**验收**：
- 构造 10 条客服腔输入，替换后至少 8 条变成人话
- 正常句子（"今天去哪了"）不被误伤
- `npm test` 里 humanize 的回归测试不掉

---

### P1 · 生活决策循环（她现在没有"今天不想刷抖音"的自由）

**现状问题**：

```js
// src/douyin-living.js:765
const scheduleNext = (ms) => { timer = setTimeout(tick, ms); };
// 20~30 分钟一轮，到点就刷，不管她那一刻想不想刷
```

**上游做法**（`/tmp/mb/life/life_loop.py`，1235 行）：每轮问自己「现在想干什么」，从 12 种动作里选一个，带理由：

```
learn  学习（查维基、读资料）
watch  刷视频
idle   发呆
nap    午睡（只在 12:30–14:00 或很累时可选）
diary  写日记
...
还有一条反死磕规则：「最近连续 2~3 次都在纠结同一件事，今天先放下它」
```

**要做的事**：不要整体搬（1235 行 Python + ADB 依赖）。只把**决策那一段**用 Node 重写：

1. 新模块 `src/life-decider.js`：输入当前时间、最近活动、兴趣权重、精力值，输出 `{action, reason}`
2. `douyin-living.js` 的 `tick` 改成先问 decider，`action !== 'watch'` 就不刷
3. **兴趣权重**：`data/interests.json`，看她/聊到某个话题就 `+0.05`，决策时权重高的更容易被选（对应上游 `bump_interest`）
4. 至少保留三个动作：`watch` / `idle` / `learn`（`learn` 可以复用现有的 `web-living.js`）

**验收**：
- 连续 10 轮 tick，动作不是清一色的 `watch`
- 兴趣权重能影响选择（手动把「摩托车」权重拉到 0.9，看它会不会更常选相关内容）
- 关掉开关（`config.lifeDecider.enabled = false`）后，行为跟现在完全一致

---

### P2 · 情绪衰减（她现在只会"被点亮"，不会"消退"）

**现状**：`src/mood.js`（303 行）有每日基准心情 + 会话即时情绪，但情绪是**离散标签**，一旦被一句话触发就停在那个状态，没有自然回落。

**上游设计**（`/tmp/mb/plugins/astrbot_plugin_persona_state/emotion.py`）：

```
DEFAULT      {p: 0.05, a: 0.35, d: 0.5}      PAD 三维基线
MAX_STEP     0.12      单条消息最多改变这么多（防一句话情绪大跳）
LABEL_HALF_LIFE_MIN  45   标签半衰期 45 分钟
MOOD_HALF_LIFE_H     6    心情半衰期 6 小时
MASK_THRESHOLD       0.25 强度不够时不外露
```

**要做的事**：在 `mood.js` 里加**衰减**，不必引入完整的 PAD 三维（她现在用标签，改动面太大）：

1. 情绪值改成带时间的数值（`{key, value, at}`）
2. 读取时按 `exp(-Δt / 半衰期)` 衰减
3. 单次更新最多 ±0.12
4. 低于阈值就当基线（不外露）

**验收**：
- 被骂一句后情绪值升，2 小时后读出来接近基线
- 连发 5 句难听的话，情绪不会一次到底（有 MAX_STEP 限制）
- 现有 `mood.json` 格式能平滑迁移（老数据没有 `value` 字段时按 0.5 处理）

---

### P2 · 身份分层（她现在只有一个 self-image.json）

**现状**：`data/self-image.json` 单个 JSON。上游 `dsh/persistent-self` 分了七层：

```
身份层   我是什么        —— 永不衰减，不可改只能追加
标准层   我选什么        —— 可迭代，旧版留着
技术层   干过什么活      —— 会过时
事实层   用户是谁        —— 稳定
关系层   人和人的关系    —— 稳定
原话层   带情绪的原话    —— 永久
想法层   上一刻在想什么  —— 天天变
```

**最值得抄的是那条硬约束**（`schema.sql` 注释）：

> 身份不可改，只能追加。因为**身份是判断的前提，不是判断的结论**。"我没有亲属"如果也能被推翻，那假记忆进来时就没有第一道关。

**要做的事**：
1. 把 `self-image.json` 拆成 `identity` / `standards` / `facts` 三层（先三层，别一次七层）
2. `identity` 追加式写入，不提供修改接口
3. 每层带 `why` 字段，说明"为什么这条属于身份"，用于冲突检测

**验收**：
- 试图改 identity 的调用被拒绝
- 开机（冷启动）时三层都能读出来拼进 prompt
- 老 `self-image.json` 能无损迁移

---

### P3 · 3D 大脑（参考，不一定要做）

`/tmp/mb/dsh/dafeiyu-3d-brain/`，85K 行，其中绝大部分是 three.js + 真实 MRI 皮层网格（144490 + 145071 顶点）。纯浏览器 JS，无构建步骤。

```bash
cd /tmp/mb/dsh/dafeiyu-3d-brain && python3 -m http.server 8899
# 打开 http://127.0.0.1:8899/demo-standalone.html
```

**判断**：好看，但不解决任何记忆问题。如果要做，只做一件事——把她现有的 `data/images.db`、`turns.jsonl`、`memory-core` 的记忆数据做成可视化接口（看 `INTEGRATION.md`、`DATA-FORMAT.md`），挂在 18888 的房间页面旁边。

**先做评估再动手**：跑起来看一眼，截图给老爸，他决定要不要。

---

### P3 · 房间风格对比（要不要抄）

两个都要跑起来看：

```
上游   /tmp/mb/docs/room.md + room-assets.md（AstrBot 版，只带占位图）
小鱼   http://127.0.0.1:18888/（src/virtual-room.js，2.5D 等距居室）
```

**要回答的问题**：
1. 上游的房间是 2D/3D？交互方式是什么？
2. 它的"玩具"系统是什么（`docs/room.md` 提到 room + toys）
3. 跟小鱼的 2.5D 等距居室比，风格差在哪
4. 值不值得换/混

**产出**：一段对比结论 + 截图，不要直接改代码。

---

## 4. 优先级与排期建议

```
第一批（能独立上线）
  P0 记忆写回          —— 3~4 天
  P1 语义替换          —— 半天

第二批（依赖第一批稳定）
  P1 生活决策循环      —— 2~3 天
  P2 情绪衰减          —— 1~2 天

第三批（评估性质，先出结论不动代码）
  P2 身份分层          —— 先出方案
  P3 3D 大脑 / 房间    —— 跑起来对比，截图汇报
```

---

## 5. 约束（这几条会让线上挂掉，务必看完）

1. **不能有两个进程同时登录同一个 QQ**。改代码前先 `systemctl stop ai-companion-xiaoyu`，改完再起。测试用单独的小号或 mock。
2. **`config.json`、`role.md` 在 `.gitignore` 里**，不进仓库。改配置不算提交。
3. **代理相关不要改代码**（老爸明确说过）。`clashctl` 现在只作本地端口 7890，需要代理的地方改配置。
4. **人格文件只读**。所有增强都是往 system prompt 追加"注入块"，每个块带 marker，重复注入先删旧块，**不要动 `role.md` 的人格描述**。
5. **每个新功能一个开关，默认关**。关掉后她的行为必须跟现在一模一样。
6. **不准碰 `192.168.31.160`**。
7. **密钥不进日志、不进提交、不进文档**。`/root/AccessKey.txt` 是火山 AK/SK，用 `[REDACTED]` 代替。
8. **数据格式冻结**：`diary.jsonl`、`human-insights.json`、`web-knowledge.jsonl`、`douyin-daily.json` 的字段名不要改，老数据要能读。

---

## 6. 交付方式

```
分支     从 feat/memory-brain-spec 拉 feat/memory-<模块名>
提交     一个功能一个 commit，中文说明「为什么改」而不是「改了什么」
测试     改动前先跑一遍现有测试，别把绿的跑红
文档     每个 P 做完在本文档对应小节下面补一行「已完成 <commit>」
```

**回退参考**：上一版整合（只接了 recall）在 `e314460`，撤它的是 `d956bc3`。想捡回 vendored 的 memory-core，`git show ab8107c` 能看到完整文件列表。
