# 虚拟居室角色层与首期本地验证服务实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 构建虚拟居室首期角色层与本地安全验证服务，实现 6 核心动作的离线转码（去底板/抑制白边）、共享 Manifest 与声明交付、后端跨平台与可取消转场服务改造，以及前端 CustomEvent 解耦与角色图层渲染。

**架构：** 遵循“离线媒体处理 -> 共享契约驱动 -> 后端安全服务 -> 前端状态与图层解耦”架构。媒体层用 Python(Pillow)+ffmpeg 提取无底板透明 WebM 与海报；后端 Node.js 提供跨平台配置注入、Range 206 静态流与可取消状态机；前端基于 CustomEvent 渲染自适应角色与 bodyBox 交互。

**技术栈：** Node.js v24 (node --test), Python 3.11+ (Pillow), ffmpeg (libvpx-vp9), 原生 HTML5/ES6/CSS3 (CustomEvent, EventSource, SVG/Canvas)

---

### 模块分工与文件边界

- **媒体与契约 (template-analyst / Task-5 范围)**：
  - 测试：`packages/companion/test/room-character-assets.test.mjs`
  - 纯函数单元测试：`scripts/test_alpha_cleaner.py`
  - 离线处理脚本：`scripts/prepare-room-character.py` 与 `scripts/prepare_room_character.py`
  - 交付物：
    - `packages/companion/public/room_assets/character/manifest.json`
    - `packages/companion/public/room_assets/character/NOTICE.md`
    - `packages/companion/public/room_assets/character/clips/*.webm`
    - `packages/companion/public/room_assets/character/clips/*.webp`
- **后端服务改造 (backend-lead / Task-6 范围)**：
  - 源码：`packages/companion/src/virtual-room.js`
  - 测试：`packages/companion/test/virtual-room-server.test.mjs`
- **前端视图交互 (frontend-dev / Task-7 范围)**：
  - 页面与样式：`packages/companion/src/virtual-room.js` 内置页面或对应前端静态资源
  - 测试：浏览器控制台/DOM 验证及集成断言

---

### 任务 1：编写 Node.js 媒体契约断言测试并验证红灯 (TDD Red)

**文件：**
- 创建：`packages/companion/test/room-character-assets.test.mjs`

- [x] **步骤 1：编写失败的契约断言测试**

编写测试断言 `public/room_assets/character/manifest.json` 存在，校验其符合共享契约：
- `schema === 1`, `id === 'shenshen'`, `canvas: [640, 360]`, `bodyBox: [212, 60, 428, 330]`, `anchor: [320, 330]`；
- 包含 `idle`, `move`, `sleep`, `work`, `think`, `greet` 六个 clip；
- `greet.loop === false`，其他 5 个 clip 的 `loop === true`；
- 每个 clip 对应的 `src`（WebM）和 `poster`（WebP）文件存在且非空；
- `NOTICE.md` 存在且声明 CC BY-NC-SA 类条款及非 MIT 资产。

- [x] **步骤 2：运行测试验证预期红灯**

运行命令：`node --test packages/companion/test/room-character-assets.test.mjs`
预期：FAIL（提示 `manifest.json` 或对应文件不存在）。

---

### 任务 2：编写 Python 去底板与白底反解单元测试并验证红灯 (TDD Red)

**文件：**
- 创建：`scripts/test_alpha_cleaner.py`

- [x] **步骤 1：编写算法纯函数的单元测试**

覆盖 4 个核心断言：
1. `floor_faint_alpha`：$a \le 1$ 像素无论原 RGB 为何，一律置为 $(0, 0, 0, 0)$；
2. `unblend_rgba`：在 $a=100$ 混入白底情况下的颜色精准反解；
3. `unblend_rgba`：两端 $a < 21$ 与 $a \ge 250$ 不做反解，保持边界安全；
4. `erode_alpha`：3x3 最小值滤波正确收缩边缘 1px。

- [x] **步骤 2：运行单元测试验证预期红灯**

运行命令：`PYTHONPATH="scripts" python -m unittest discover -s "scripts" -p "test_*.py"`
预期：FAIL（提示导入失败或函数未定义）。

---

### 任务 3：实现 Python 离线素材处理脚本并验证纯函数绿灯 (TDD Green)

**文件：**
- 创建：`scripts/prepare_room_character.py`
- 创建：`scripts/prepare-room-character.py`

- [x] **步骤 1：实现 Pillow 纯函数反解与去底板逻辑**

编写 `floor_faint_alpha`、`unblend_rgba`、`erode_alpha` 及 `process_frame`。

- [x] **步骤 2：运行单元测试验证绿灯通过**

运行命令：`PYTHONPATH="scripts" python -m unittest discover -s "scripts" -p "test_*.py"`
预期：PASS（5 tests OK）。

- [x] **步骤 3：补齐 CLI 调度、ffmpeg 透明 VP9 转码、Poster 抽取与 Manifest/Notice 输出**

参数化 `--source` 与 `--output`，临时帧使用 `tempfile.TemporaryDirectory` 自动清除，确保无垃圾残留。

---

### 任务 4：执行离线导入 6 动作素材并验证媒体契约测试绿灯

**操作与产物：**
- 运行：`scripts/prepare-room-character.py`
- 产物生成在：`packages/companion/public/room_assets/character/`

- [x] **步骤 1：执行离线导入转换**

运行命令：
```bash
python scripts/prepare-room-character.py --source "F:/Documents/Project/dsh-pet-indesktop/assets/characters/shenshen/videos" --output "F:/Documents/Project/ai-companion-kit/packages/companion/public/room_assets/character"
```

- [x] **步骤 2：运行 Node.js 媒体契约断言测试验证绿灯**

运行命令：
```bash
node --test packages/companion/test/room-character-assets.test.mjs
```
预期：PASS（所有断言 100% 绿灯）。

- [x] **步骤 3：统计素材体积与临时文件清理确认**

核验 6 动作 WebM 总体积（实测 ~3.70 MB < 4MB 预算），检查工作区无临时帧残留。

---

### 任务 5（后端范围 / Task-6）：虚拟居室路由重构、跨平台路径注入与优雅关停

**文件：**
- 修改：`packages/companion/src/virtual-room.js`
- 测试：`packages/companion/test/virtual-room.test.mjs`

- [x] **步骤 1：剔除绝对路径，支持配置注入**
重构 `startVirtualRoomServer`，接受 `{ dataDir, assetsDir, host, port, devMode }` 注入。
- [x] **步骤 2：实现 Range 206 响应与路径穿越防御**
对 `.webm` 视频支持 `Range: bytes=start-end` 请求头；对所有文件路径做 `path.normalize` 与根目录边界校验。
- [x] **步骤 3：实现 2 秒代次防幽灵转场与可关闭服务**
状态机转场增加 `version` 代次控制与定时器销毁；导出 `.close()` 方法关闭 HTTP 服务并断开 SSE 连接。

---

### 任务 6（前端范围 / Task-7）：CustomEvent 解耦、防竞争条件与动态角色渲染

**文件：**
- 修改：`packages/companion/src/virtual-room.js` 页面渲染层

- [x] **步骤 1：建立 CustomEvent 总线与防竞争时序**
既有 EventSource 由页面内联先启动，角色渲染器（renderer）先注册 `window.addEventListener('room:state', ...)`，再主动 `fetch('/api/status')` 获取初始快照并丢弃过期快照，实现严格防竞争。
- [x] **步骤 2：动态装载 Manifest 与脚底锚定**
异步加载 `/room_assets/character/manifest.json`，根据 `canvas` 与契约约定的 `anchor: [320, 330]` 基准定位角色图层。
- [x] **步骤 3：映射 5 状态机动画与 bodyBox 交互反馈**
绑定 `idle`, `move`, `sleep`, `work` 状态；点击 `bodyBox` 区域触发 `greet`（元气挥手，单次不循环），播完平滑切回原状态；隐藏或低动效时降级至静态 `poster`。

---

### 任务 7：首期集成审查与验证交接

- [x] **步骤 1：运行全套首期自动化测试**
- [x] **步骤 2：审查各模块行号与代码质量**
- [x] **步骤 3：向 Team Lead 做首期完成汇报**
