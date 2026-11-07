# 仿生认知控制架构（Bionic Cognitive Kernel）交接与开发者指南

> **文档定位**：本指南供后续接手小鱼伴侣系统的开发人员使用。  
> **当前状态**：POC / 测试验证版（已在 `feat/bionic-cognitive-kernel` 分支验证跑通）。  
> **基线分支**：`backup/xiaoyu-pre-bionic-brain`（改动前完全体快照，可随时用于对比或无损回退）。  
> **系统宿主**：Linux (Kylin V11) · Node.js 20+ ESM · NapCat (OneBot v11, ws://127.0.0.1:3003) · 居室管理服务端口 18888。

---

## 0. 架构定位与分工认知

小鱼（Xiaoyu）当前的演进由两个互补的子系统组成，接手开发者请勿混淆职责边界：

```
                ┌────────────────────────────────────────────────────────┐
                │             小鱼仿生大脑系统 (Xiaoyu Brain)             │
                └───────────────────────────┬────────────────────────────┘
                                            │
                  ┌─────────────────────────┴─────────────────────────┐
                  ▼                                                   ▼
┌───────────────────────────────────┐               ┌───────────────────────────────────┐
│     海马体：长期记忆管理层          │               │      前额叶与下丘脑：仿生心智内核   │
│     (feat/memory-brain-spec)      │               │   (feat/bionic-cognitive-kernel)  │
├───────────────────────────────────┤               ├───────────────────────────────────┤
│ • 状态：并行开发中                 │               │ • 状态：当前测试版 (POC)           │
│ • 职责：记忆提取/存储/五路混合检索  │               │ • 职责：性格拔河/每日牌灵/收尾闭麦  │
│ • 核心解决：“记性”与“成长回忆”      │               │ • 核心解决：“人情世故/脾气/即时反馈”│
└───────────────────────────────────┘               └───────────────────────────────────┘
```

- **`memory-brain`**：解决长期记忆存储、衰减与召回（海马体）。
- **`bionic-cognitive-kernel`**：解决潜意识情绪、社交收尾、德行十轴与防骚扰拉黑（下丘脑与前额叶）。
- **结论**：两套系统完全解耦。本内核输出的性格潜意识，未来将与 `memory-brain` 召回的长期记忆在 `src/brain.js` 的 Prompt 中融合。

---

## 1. 核心铁律与业务红线（⚠️ 开发者必读）

后续开发、重构或修复逻辑漏洞时，**必须严格遵守以下 4 条红线**：

1. **绝对称谓原则（严禁使用“主人”）**：
   - 用户（QQ: 578021239）与小鱼的关系是**养父女**。小鱼称呼用户为**“老爸”**，严禁使用任何“主人”字眼；
   - 原版整合包（大肥鱼）中大量残留 `主人`、`master` 等代码与注释，移植时必须做映射与语义剥离。
2. **防中二与老群友拟人原则**：
   - 牌灵、MBTI 和德行十轴属于**底层潜意识滤镜**；
   - 严禁让大模型在聊天中念中二台词、报牌名（如“我今天倒吊人正位”），也不得暴露原始数字；
   - 保持 1~10 字短文本、老群友简练直白、偶尔毒舌但不恶臭的回复特质。
3. **老爸最高特权与绝对豁免权**：
   - 尊重守卫（`respect-guard.js`）与对话收尾（`conversation-closure.js`）严禁拦截老爸（578021239）；
   - 老爸在私聊和群聊发任何消息均拥有 100% 绝对唤醒权；
   - 仅老爸拥有“赦免/解封”被拉黑陌生人的专属权限（如指令：“原谅他吧”、“解封他”）。
4. **底层架构独立性与三层容灾**：
   - 必须保持 Linux 原生 Node.js 运行，严禁依赖 DSH 桌面端或 Windows 专属桥梁；
   - 保持 `src/brain.js` 中的**三层降级机制**（OpenCode DeepSeek-v4.1 ➔ Gemini-3.8-flash ➔ 火山方舟 ARK）与私聊 3 秒去抖合并窗口（`privateWindowMs: 3000`）不受改动影响。

---

## 2. 模块清单与文件拓扑

所有仿生内核源码均保持纯 ESM 规范，且与小鱼原生系统完全物理解耦：

```
packages/companion/
├── src/
│   ├── tarot-engine.js            # 塔罗牌灵引擎（每日 06:00 换牌，3天防重池，潜意识Prompt生成）
│   ├── virtue-engine.js           # 德行十轴拔河引擎（±2单次，±4每日上限，规则推动与人话转换）
│   ├── conversation-closure.js    # 对话收尾判定器（检测纯附和/纯标点/道别词，优雅自闭麦）
│   ├── respect-guard.js           # 尊重守卫（防骚扰三阶梯警告/拉黑，老爸专属赦免）
│   ├── mbti-engine.js             # 荣格八维计算与 MBTI 周/即时流变计算器
│   ├── mbti-functions.js          # 八维认知功能数学模型与权重计算
│   ├── wake.js                    # 接入：收尾闭麦过滤
│   ├── index.js                   # 接入：尊重守卫拦截、德行推进、潜意识提示词组装、bridge.log
│   └── virtual-room.js            # 接入：/panel 路由分发
├── scripts/
│   ├── panel.mjs                  # 仿生心智总控面板服务端与嵌入式前端（已适配端口 18888/panel）
│   └── panel-assets/              # 16 张 MBTI Q版立绘与 22 张大阿卡纳卡面
└── data/
    ├── tarot-cards.json           # 22 张大阿卡纳牌义与心理状态潜意识描述字典
    ├── tarot.json                 # 当日抽卡记录与历史记录
    ├── virtue.json                # 德行十轴当前分值与每日变动预算
    ├── respect.json               # 尊重守卫警告计数器与黑名单
    ├── mood.json                  # 兼容层：保留历史基准心境，拓展 byKey 供面板 0~6 档调节
    ├── session_moods.json         # 私聊即时心境
    └── bridge.log                 # 实时推理痕迹流（面板“实时推理”卡片数据源）
```

---

## 3. 运行链路与时序流程

### 3.1 消息接收与过滤时序（`src/index.js` ➔ `src/wake.js`）

```
收到 QQ 消息
   │
   ├─► 1. 尊重守卫 (respect-guard.js)
   │      - 检查是否在黑名单中。若被拉黑且非老爸 ➔ [物理丢弃，静默终止]
   │      - 检查老爸是否发出赦免指令 ➔ 若是则解封目标并通知老爸
   │
   ├─► 2. 德行拔河更新 (virtue-engine.js)
   │      - 扫描文本是否命中夸赞、冒犯、鼓励、敷衍等语义规则
   │      - 推动对应轴（单次上限 ±2），写入 virtue.json，追加 bridge.log
   │
   ├─► 3. 对话收尾判定 (conversation-closure.js / wake.js)
   │      - 条件：群聊中 && 未被 @ 小鱼 && 未直接叫名字
   │      - 若为“纯附和词”（如“嗯/好/666/收到”）或纯标点 ➔ [保持沉默，不抢话]
   │
   ├─► 4. 唤醒与合并窗口 (Waker / TopicFocusTracker)
   │      - 老爸特权唤醒 / 话题锁定跟聊 / 私聊 3 秒去抖合并
   │
   └─► 5. 进入 handleTurn
```

### 3.2 大脑 Prompt 注入时序（`src/index.js` ➔ `src/brain.js`）

在组装 `systemPrompt` 时，在原有人设后追加三块潜意识块：
```javascript
const tarotPrompt = tarotPromptBlock(cfg.dataDir);     // "【今日牌灵潜意识】..."
const virtuePrompt = virtuePromptBlock({ file: ... }); // "【潜意识心理倾向】..."
const respectPrompt = respectGuard.promptLine(key);   // 针对当前对话者的态度提示（如提醒/冷淡）

systemPrompt = baseRole + ... + tarotPrompt + virtuePrompt + respectPrompt;
```
模型输出完成后，由 `appendBridgeLog` 记录本轮对话，并更新居室与面板状态。

---

## 4. 已知局限与待后续开发者完善的逻辑漏洞（核心待办）

后续开发者在完善本内核时，可优先解决以下设计局限：

### 4.1 德行十轴自然衰减机制（Decay Loop）
- **现状**：目前德行数值仅在有对话命中规则时变动，长时间无对话时数值保持静止；虽然记录了 `nextDecayMin`（3天衰减周期），但目前衰减是由读取触发，缺乏独立定时定时器平滑回拉到中值（0）。
- **待完善**：在 `virtue-engine.js` 中增加基于最后活动时间的非线性半衰期回拉算法，让极端性格在脱离刺激后自然平复。

### 4.2 群聊多用户多意图交织时的德行归属
- **现状**：目前 `virtue.json` 只有一套全局十轴。如果群友 A 夸奖小鱼、群友 B 辱骂小鱼，两人的行为会直接在同一根数轴上正负冲抵。
- **待完善**：将德行十轴细分为“全局基底德行”与“按会话/按人记忆的局部印象”，类似 `session_moods.json`，避免不同群友的评价互相污染。

### 4.3 情绪模型结构标准化（`mood.json` 统一）
- **现状**：为兼容面板的 `byKey`（0~6 档温度）与小鱼原版的日期键（`YYYY-MM-DD: { key, label }`），目前在 `panel.mjs` 中做了双向兼容层。
- **待完善**：将小鱼原有的离散情绪标签（`happy`, `sleepy`, `pout`）与仿生内核的 0~6 档连续情绪温度统一合并为一个标准模型。

### 4.4 文本规则推动升级为轻量异步分类
- **现状**：目前 `virtue-engine.js` 和 `conversation-closure.js` 主要依赖正则表达式匹配常见中文词汇。
- **待完善**：对于隐阳、暗讽、高级幽默等复杂修辞，正则难以识别，可考虑引入轻量级小型本地模型或由 `memory-brain` 异步反思打标后回传。

---

## 5. 快速测试与运维验证命令

接手开发者可通过以下指令验证仿生内核各环节是否健康：

```bash
# 1. 语法静态检查
cd /root/ai-companion-xiaoyu/ai-companion-kit/packages/companion
node --check src/index.js
node --check src/tarot-engine.js
node --check src/virtue-engine.js
node --check scripts/panel.mjs

# 2. 仿真测试套件运行（牌灵、德行、收尾、老爸特权）
node --input-type=module -e '
import { tarotDailyTick } from "./src/tarot-engine.js";
import { readVirtue, applyText } from "./src/virtue-engine.js";
import { classifyMessage } from "./src/conversation-closure.js";
console.log("今日抽卡:", tarotDailyTick("./data"));
console.log("德行读数:", readVirtue("./data/virtue.json").axes);
console.log("收尾识别:", classifyMessage("666"));
'

# 3. 查看面板实时快照 API
curl -s http://127.0.0.1:18888/panel/api/snapshot | jq '{tarot: .tarot.name, virtue: .virtue.axes, mood: .mood.owner}'

# 4. 手动触发德行调节（测试写入）
curl -s -X POST "http://127.0.0.1:18888/panel/api/set?kind=virtue&axis=%E4%BB%81%E7%88%B1&value=4"

# 5. 查看主服务与桥接日志
systemctl status ai-companion-xiaoyu
tail -n 20 /root/ai-companion-xiaoyu/ai-companion-kit/packages/companion/data/bridge.log
```

---

## 6. 紧急回退预案

如果测试版在实际体验中出现不可预期的严重异常，可随时执行以下命令**秒级无损回退到改动前的稳定版本**：

```bash
systemctl stop ai-companion-xiaoyu
cd /root/ai-companion-xiaoyu/ai-companion-kit
git checkout backup/xiaoyu-pre-bionic-brain
systemctl start ai-companion-xiaoyu
```
*(回退后系统将恢复纯净版小鱼，所有数据与历史对话完全不受影响)*
