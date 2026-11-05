# memory-brain 改造工程（执行文档）

> 给**接手的 agent** 用的施工图。不是参考、不是建议。
> 读完应该知道：改什么、不改什么、先做什么、做到什么程度算完。
>
> 配套：`docs/memory-brain-integration-spec.md`（需求分析、上游审计、P0–P3 原始规格）。
> 本文是**施工版**，两份冲突时以本文为准。

---

## 0. 给接手的 agent

### 你是谁

执行者。取舍已经做完了，**不需要重新评估要不要做**。如果你判断某个方案有更好的实现，在该任务下写一段「替代方案 + 理由」，不要直接换。

### 必须问老爸的三种情况

1. 要动 `role.md` 的人格描述
2. 要改发送频率、主动找人的策略
3. 要删数据、清空记忆库

其他技术选择（库、分层、字段命名）你自己定。

### 从哪开始

```bash
cd /root/ai-companion-xiaoyu/ai-companion-kit
git checkout feat/memory-brain-spec
ls /tmp/mb || git clone --depth 1 https://github.com/peterpoal134/memory-brain.git /tmp/mb
```

### 一个前提

小鱼不是 AstrBot。上游 `plugins/` 下四个 AstrBot 插件**装了没用**，只当设计参考读。能跑的是 `memory-core/`（独立 HTTP 服务）和 `life/life_loop.py`（独立进程）。

---

## 1. 这件事要干什么

把「会忘记、有情绪、有自己的日子」的架构，搬进小鱼这个「能聊天、能刷视频、但记不住也不会长大」的系统里。

改造完她应该有六层：

```
① 输入    聊天 / 语音 / 图片 / 刷抖音 / 看文章        已有
② 记忆    写入 · 存储 · 检索 · 遗忘                   要建  ← 主战场
③ 情绪    PAD / 标签 / 衰减 / 不主导判断              有雏形，缺衰减
④ 生活    自己决定今天干什么 · 兴趣权重 · 笔记         有定时任务，缺决策
⑤ 表达    语感 · 去客服腔 · 控句长                    只有格式清洗，缺语感
⑥ 反馈    被纠正→降权 · 每日归纳 · 评估集             完全没有
```

### 能力对照

| 能力 | 现在 | 目标 | 优先级 |
|---|---|---|---|
| 记忆写入（自动） | 无 | 每轮异步抽取五类记忆 | P0 |
| 记忆遗忘（衰减/归档） | 无 | 定时维护，低价值自动归档 | P0 |
| 记忆召回 | 无（试过又撤） | 五路混合检索，权重照抄 | P0 |
| 记忆体检 | 无 | 重复/冲突/孤立可查 | P1 |
| 语义去客服腔 | 无 | 替换表 + 句长控制 | P1 |
| 语感统计 | 无 | 统计真人句长分布约束输出 | P2 |
| 生活决策 | 定时任务（到点就刷） | 每轮自选动作 + 兴趣权重 | P1 |
| 情绪衰减 | 无（点亮就停住） | 半衰期回落，单次有上限 | P2 |
| 身份分层 | 单文件 self-image.json | 三层，身份不可改 | P2 |
| 反馈降权 | 无 | 被纠正的记忆降权 | P2 |
| 评估集 | 无 | 40 条查询，改检索就跑 | P2 |
| 记忆可视化 | 无 | 3D 大脑接 `/graph` | P3 |
| 生视频 / 换装 | 无 | 5 秒视频、try_on | P4 可选 |

---

## 2. 现状

### 2.1 小鱼

```
仓库    /root/ai-companion-xiaoyu/ai-companion-kit
代码    packages/companion/（Node.js ESM，39 模块，15031 行）
配置    packages/companion/config.json（gitignore）
数据    packages/companion/data/
服务    systemctl status ai-companion-xiaoyu
QQ      1808531252（NapCat，OneBot v11，ws://127.0.0.1:3003）
面板    http://127.0.0.1:18888/
```

相关模块：

| 模块 | 现在做什么 |
|---|---|
| `src/brain.js` | 组 prompt、调模型、Function Calling、写回 |
| `src/memory.js` | 短期记忆（turns.jsonl，1455 条真实对话） |
| `src/mood.js`（303 行） | 心情：每日基准 + 会话即时，**离散标签** |
| `src/relationship.js` | 人物关系（101 人） |
| `src/growth.js`（219 行） | 从批评/表扬提炼自我认知 + avoidRules |
| `src/diary.js` / `diary-author.js` | 日记（182 篇） |
| `src/humanize.js`（285 行） | 输出清洗：**只有格式层** |
| `src/douyin-living.js` | 刷抖音，`setTimeout` 20~30 分钟一轮 |
| `src/bili-living.js` / `web-living.js` | 刷 B 站 / 看网页 |
| `src/proactive.js` | 主动搭话（45~160 分钟一次，每天最多 4 次） |
| `src/image-gen.js` | 生图 + 图库 |

### 2.2 上游

| 模块 | 行数 | 是什么 | 能不能用 |
|---|---|---|---|
| `memory-core/` | 4,239 | 独立记忆 HTTP 服务，35 个接口 | **能，主战场** |
| `plugins/astrbot_plugin_memory_brain` | 7,779 | 记忆插件 | 不能装，读设计 |
| `plugins/astrbot_plugin_persona_state` | 2,069 | 情绪 PAD + 好感 | 不能装，借衰减 |
| `plugins/astrbot_plugin_human_style_guard` | 306 | 发送前清洗 | 不能装，借替换表 |
| `plugins/astrbot_plugin_self_style` | 243 | 自我档案 | 大概率重复，扫一眼 |
| `life/life_loop.py` | 1,235 | 生活层，决策制 | 借决策循环 |
| `dsh/persistent-self` | 951 | 跨会话身份，7 层 | 借分层 |
| `dsh/dafeiyu-3d-brain` | 85,554 | 3D 记忆可视化 | 参考，P3 |
| `docs/room*.md` | — | 房间（占位图） | **不抄**，已实测 |
| `docs/generation.md` | — | 生图生视频 | P4 可选 |

**协议**：AGPL-3.0-or-later / 作者自述「源代码公开、禁止商业使用」。自用可以，别商用。vendored 目录要带它自己的 LICENSE。

### 2.3 已经试过、又回退的

上一次整合（`e314460`，撤于 `d956bc3`）只做了 `/recall`：记忆块拼进 system prompt。

**为什么撤**：跑半天发现库里永远是那 55 条测试数据——**她只「想得起来」，不会「记得住」**。

教训：**写回是地基，召回是地面。先打地基。**

vendored 的 memory-core 在 `git show ab8107c` 里，可以直接捡。

---

## 3. 为什么这是个大工程

1. **六层里三层要从零建**（记忆写入 / 遗忘 / 反馈），不是补丁能解决
2. **每条记忆写入花一次 LLM 调用**，要设计限流、去重、成本控制，否则一天几百条把库刷成垃圾
3. **遗忘比记住更难**：衰减曲线、归档阈值、相似合并、冲突检测，四个都要调参
4. **表达层是横切关注点**：所有出口（私聊 / 群聊 / 主动搭话 / 语音）都经过，一处改错全线生效

**估算**（一个人，熟悉这套代码）：

```
Phase 0  地基（记忆读写 + 遗忘）         8~12 人日
Phase 1  表达与生活（语义清洗 + 决策）    5~7 人日
Phase 2  情绪与反馈（衰减 + 降权 + 评估）  5~7 人日
Phase 3  可视化与身份                    3~5 人日
Phase 4  视频与换装（可选）              5~8 人日
```

**别一次全上。** 每个 Phase 结束必须能跑、能退回、能验收。

---

## 4. 阶段计划

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4
  地基        表达生活      情绪反馈      可视化       可选
   │            │            │            │
   └ 每阶段独立可上线、可回退、有验收
```

T1.1（语义替换）不依赖 Phase 0，可以并行。T2.2（反馈降权）必须有 Phase 0 的记忆 ID 才能做。

---

## 5. 任务详表

编号 `T<阶段>.<序号>`。每个任务独立提交、独立验收。

---

### T0.1 vendored memory-core

**目标**：上游 `memory-core/` 进仓库，版本受控。

```bash
git show ab8107c --stat                    # 上次做过，文件列表在这
rsync -a --exclude 'data/' --exclude '__pycache__/' /tmp/mb/memory-core/ packages/memory-core/
cp /tmp/mb/LICENSE packages/memory-core/LICENSE
```

写 `packages/memory-core/VENDOR.md`：来源、改动（只删 data 和缓存）、升级方式、协议。

**systemd**：`/etc/systemd/system/memory-core.service`，`WorkingDirectory` 指仓库内路径，`MEMORY_DB` 指 `packages/memory-core/data/brain.db`（`data/` 已 gitignore）。

**验收**：`systemctl is-active` → active；`curl /health` → ok；`git status` 无 `*.db`。

**坑**：
- 依赖只有 `numpy`：`/usr/bin/python3 -m pip install numpy`
- 数据在 WAL，服务在跑时只拷 `brain.db` 会得到 4KB 空壳——**先停服再拷，或连 `-wal`、`-shm` 一起拷**

---

### T0.2 记忆写回（核心）

**目标**：每轮对话结束，异步把有信息量的内容抽成记忆落库。

```
POST /digest/extract  {"conversation": "...", "user": "qq:578021239"}
→ {summary, kind, importance, valence, entities[], relations[]}
kind ∈ episode | fact | preference | relation | skill

POST /remember  {"text": summary, "kind": kind, "importance": ..., "visibility": "..."}
```

**改动点**：
1. 新模块 `src/memory-write.js`：封装 extract + remember，全 try/catch，失败只打日志
2. `brain.js` 回复流程**之后**调用，不 `await`（fire-and-forget）
3. `config.memoryWrite`：`{enabled, minUserChars: 8, dailyLimit: 200, visibilityRule}`

**限流规则**（不做会刷爆）：
- 用户消息 < 8 字或纯语气词（"在吗""哈哈""嗯"）→ 跳过
- 每天最多 `dailyLimit` 条，超了只在私聊写
- 相似内容交给 memory-core 的相似合并，前端也可预判

**visibility**：私聊 → `private`；群聊 → `group`；涉及老爸个人信息 → 一律 `private`。

**验收**：
- 聊 10 轮有内容的话，`/stats` 的 `active` 增加 ≥ 5
- 回复延迟增加 < 200ms
- `kill` memory-core 后她照常回复，日志只有 warning
- 连发 20 条"在吗"，一条都没写进库

**坑**：别在 `await` 链里调；`digest/extract` 要一次 LLM 调用，配 `MEMORY_LLM_BASE/KEY/MODEL`，用最便宜的模型。

---

### T0.3 记忆召回

**目标**：召回结果拼进 system prompt。

**接口**：`POST /recall {"query","k","visibility"}` → `{hits[], block}`

**改动点**：
- 新模块 `src/memory-read.js`（或并入 `memory-write.js`）
- `brain.js` 构建 situation 时插入，位置在「日记」之后、「最近对话」之前
- 注入块带 marker（`【你记得的旧事】`），重复注入先删旧块
- 失败返回空串，绝不抛

**验收**：问「上次说的那个摩托」能召回；召回文本 < 600 字；关开关后 prompt 里没这个块。

---

### T0.4 遗忘与维护

**目标**：库不能只涨不消。

```
POST /decay             衰减
POST /archive           归档
POST /maintenance/run   一次跑完：衰减 + 归档 + 相似合并 + 冲突检测
GET  /health            体检报告
```

**做法**：systemd timer 或 hermes cronjob，每天凌晨跑一次 `/maintenance/run`。

**验收**：灌 100 条垃圾记忆，跑一次维护后 active 下降；`/health` 能看到重复/无实体/冲突数量；importance ≥ 0.8 的不被误删。

**为什么必须和 T0.2 同批上**：上游原则第一条「先有遗忘，再谈记住」。只写不删，一个月后全是"她今天吃了饭"。

---

### T1.1 语义去客服腔

**参考**：`/tmp/mb/plugins/astrbot_plugin_human_style_guard/main.py` 第 62~70 行。

```
"在?呢?想我了?还是有事(呀|吗|么)?？"  → "，咋了。"
"有什么事(呀|吗|么)?？"               → "咋了？"
"说吧，什么事"                          → "咋了？"
"有啥事(呀|吗|么)?？"                 → "咋了？"
```

外加 `[微笑]` 类表情码检测（`FACE_CODE_RE`）。

**改动点**：`src/humanize.js` 清洗链，**插在拆句之前**（拆完句号都没了，正则匹配不上）。

**验收**：10 条客服腔 ≥ 8 条改成口语；正常句子不误伤；现有 humanize 回归不掉。

---

### T1.2 生活决策循环

**现状**：`src/douyin-living.js:765` 的 `scheduleNext` 固定 20~30 分钟一轮，到点就刷。

**参考**：`/tmp/mb/life/life_loop.py`，不要整体搬，只重写决策那段。

**改动点**：
1. 新模块 `src/life-decider.js`：输入 `{now, lastAction, interests, fatigue}` → `{action, reason}`
2. 动作集先做三个：`watch` / `idle` / `learn`（`learn` 复用 `web-living.js`）
3. `douyin-living.js` 的 tick 先问 decider，不是 `watch` 就不刷
4. `data/interests.json`：兴趣权重，聊到/看到某话题 `+0.05`

**验收**：连续 10 轮不是清一色 `watch`；权重 0.9 的兴趣更常被选；关开关后行为跟现在一致。

---

### T2.1 情绪衰减

**现状**：`mood.js` 有标签没衰减。

**参考数值**（`persona_state/emotion.py`）：

```
单条消息最多变 0.12
标签半衰期 45 分钟
心情半衰期 6 小时
强度 < 0.25 不外露
```

**改动点**：`mood.js` 加 `value` + `at`，读取时按 `exp(-Δt/半衰期)` 衰减。**不必引入完整 PAD 三维**（改动面太大），数值化标签就够。

**验收**：被骂一句上升、2 小时后接近基线；连发 5 句不一次到底；老 `mood.json` 平滑迁移。

---

### T2.2 反馈降权

**做法**：
1. 识别"纠正"：老爸说"不是""错了""我没说过"
2. 找到最近注入的记忆 ID（recall 时带回并记录）
3. 调 `/decay` 或直接降 importance，并写一条 `lesson`：「用户纠正过我：<内容>」
4. **同时保留** `growth.js` 现有行为（改人格规则），两条线并存

**验收**：纠正一次对应记忆 importance 下降；`growth.jsonl` 多一条；正常不同意（"我觉得不对"）不触发。

**关键区分**：`growth.js` 改的是**人格规则**（以后别做 X），这里改的是**记忆可信度**（这条记错了）。不冲突。

---

### T2.3 评估集

**做法**：
1. 从 `turns.jsonl`（1455 条）挑 40 条「问过去的事」的查询
2. 标注正确答案（哪条记忆该被召回）
3. 脚本跑 recall@1 / @3 / @5
4. 目标：@1 ≥ 70%、@3 ≥ 90%、@5 ≥ 95%（上游指标）

**验收**：`node scripts/eval-recall.mjs` 输出三个数字；改检索权重前后能对比。

---

### T3.1 3D 记忆大脑

**已实测**：页面能跑，双色半球 + 光柱 + 轨道环，左下角「节点 28 · 边 60 · 记忆 40」，可拖拽旋转。

**做法**：
1. 拉 `GET /graph`（`memory_core/server.py:627`）
2. 转成 `DATA-FORMAT.md` 格式
3. 换掉 `demo-standalone.html` 里硬编码的 28 个节点
4. 挂到 18888 房间页面旁边

**验收**：打开能看到真实记忆数量和内容，不是演示数据。

---

### T3.2 身份分层

**参考**：`/tmp/mb/dsh/persistent-self/schema.sql` 注释：

> 身份不可改，只能追加。因为**身份是判断的前提，不是判断的结论**。"我没有亲属"如果也能被推翻，那假记忆进来时就没有第一道关。

**做法**：拆 `identity` / `standards` / `facts` 三层（先三层）；`identity` 只 append，不提供 update/delete；每层带 `why` 字段用于冲突检测。

**验收**：改 identity 的调用被拒绝；冷启动能读出三层拼进 prompt；老 `self-image.json` 无损迁移。

---

### T4.1 生视频 / 换装（可选）

上游 v1.2.1 有 `draw_self_video`（5 秒视频）、`try_on`（换装）、衣帽间。小鱼只有生图。

**先评估再动手**：生视频成本（火山 Seedance 按秒计费）和收益要老爸拍板。

---

## 6. 架构决策记录（ADR）

防止后来的人（或 agent）推翻已定的方向。

### ADR-1 走 HTTP 旁路，不走 `/v1/chat/completions`

上游支持把 memory-core 当模型端点（`baseUrl=/v1`、`model=memory-core`、请求带 `user`）。**不采用**：那条路绕过小鱼的 `brain.js`，工具调用、多模态、人格注入全丢。只调 `/recall`、`/remember`、`/digest/extract`，主模型不动。

### ADR-2 vendored 而不是 submodule

submodule 会让部署多一步 `--recursive`，上游随时可能变。拷贝 + `VENDOR.md` 记录来源，升级时 rsync 覆盖更直接。

### ADR-3 检索权重照抄上游

```
0.18 语义 + 0.46 关键词 + 0.11 图谱 + 0.14 重要性 + 0.11 新鲜度
```

**关键词权重最高**。实测过：不配 embedding 时纯关键词仍能召回。别改成「语义为主」，中文场景会掉。

### ADR-4 先有遗忘，再谈记住

上游原则第一条。T0.2 和 T0.4 **必须同批上线**。

### ADR-5 人格只读

所有增强是往 system prompt 追加注入块，带 marker，重复注入先删旧块。**不改 `role.md`**。

### ADR-6 每个功能一个开关，默认关

关掉后行为必须跟现在一模一样。这是能安全上线的唯一办法。

### ADR-7 上游房间不抄

已实测：上游房间是 AstrBot 面板的一个 tab，脱离 page bridge 直接报「页面桥没有加载」，素材是纯色块占位图。小鱼 18888 的房间（2.5D 等距、鲸鱼主题、可开关灯/切时段/切天气）完成度远高于它。

唯一可借的是**功能清单**：上游面板顶栏 `3D / 重载 / 变化 / 评估 / 家 / 反思 / 沉淀 / 睡觉 / 维护 / 体检 / 冲突 / 忘记` —— 一份「记忆系统该有哪些动作」的清单，可以照着补她的动作集。

### ADR-8 表达层的范围

「表达层」不是「humanize 加几条正则」。它包含三块：

1. **语感统计**：真人中位句长 / 无标点率 / 口头禅频率（从 `group-chatter.jsonl` 1529 条真实群聊算）
2. **发送前清洗**：压客服腔、控句长、分段、表情节奏
3. **人格注入块**：只读人格 + 追加块

T1.1 只做了第 2 块里最小的一部分。完整表达层放 Phase 2。

---

## 7. 风险与回退

| 风险 | 表现 | 回退 |
|---|---|---|
| 写回刷爆库 | 一天几百条寒暄 | `config.memoryWrite.enabled = false` |
| 召回注入太长 | prompt 超限，回复变慢 | 调小 `topK` / `maxBlockChars` |
| 抽取花太多钱 | LLM 账单涨 | 降 `dailyLimit`，换最便宜模型 |
| 情绪衰减过头 | 她变得没情绪 | 调大半衰期，或只留标签 |
| 生活决策乱选 | 一天到晚发呆 | `config.lifeDecider.enabled = false` |
| memory-core 挂 | 记忆不更新 | `Restart=always` + 前端全 try/catch |

每次改动前先 `git stash` 或建分支，改完能一键回。

---

## 8. 硬约束（犯了会搞坏线上）

1. **不能两个进程同时登录同一个 QQ**。改代码前 `systemctl stop ai-companion-xiaoyu`，测完再起。
2. **`config.json`、`role.md` 在 gitignore 里**，改配置不算提交。
3. **代理相关不改代码**（老爸明确要求）。`clashctl` 只作本地 7890，需要代理的地方改配置。
4. **人格文件只读**。所有增强是注入块，不改 `role.md`。
5. **每个新功能一个开关，默认关**。
6. **不碰 `192.168.31.160`**。
7. **密钥不进日志、不进提交、不进文档**。`/root/AccessKey.txt` 是火山 AK/SK，输出一律 `[REDACTED]`。
8. **数据格式冻结**：`diary.jsonl`、`human-insights.json`、`web-knowledge.jsonl`、`douyin-daily.json` 字段名不改，老数据要能读。
9. **写完必须验证**：`systemctl is-active` + 真实聊一句 + 看日志，不能只看代码对不对。

---

## 9. 交付标准

每个任务完成，`git log` 里应有一条中文 commit 说明**为什么改**；在本文档对应任务下补一行：

```
- [x] 已完成 <commit-sha> <日期>
```

**Phase 0 结束时的验收清单**：

- [ ] memory-core 常驻，`/health` 正常
- [ ] 聊 10 轮后 `/stats` 的 active 增长
- [ ] 杀掉 memory-core，她照常回复
- [ ] 凌晨维护跑过一次，日志可查
- [ ] 关掉所有新开关，行为跟改造前一模一样
- [ ] 所有测试通过

**最后一条最重要**：能一键退回原状，才算做完了。
