# 虚拟居室角色层（深深首期）独立审查与离线验证报告

- **审查角色**: 独立 Reviewer (room-reviewer)
- **审查分支**: `feat/room-character`
- **基线版本**: 原开发基于 `00c463e` 进行（当前分支基于 origin/main 进行收口审查）
- **验证时间**: 2026-11-04
- **审查结论**: **验收通过（Ready for Integration）**。首期 6 段动作切片、manifest 契约、去白媒体管线、前后端接缝、离线演示服务及配套自动化测试已全部闭环并通过验证。

---

## 一、运行说明与快速上手

### 1. 离线独立居室演示运行
本项目已新增纯离线轻量演示服务，不依赖 Playwright、QQ 机器人或任何外部平台：

```bash
# 方式 1：通过 root package script 运行
npm run room:demo

# 方式 2：直接指定端口启动（默认 127.0.0.1:18889，避免与 18888 冲突）
node packages/companion/examples/room-demo.js --port 18889
```

- **浏览器访问**: 打开 `http://127.0.0.1:18889/`
- **核心离线体验要点**:
  1. **角色展示**: 默认状态下小鱼呈现床边待机表现（素材未持手机，`idle.webm` / 待机呼吸休闲），立于床边；
  2. **交互反馈**: 鼠标悬浮小鱼身体区域出现光晕反馈，单次点击或聚焦按回车/空格，小鱼播放单次「元气挥手致意」动画 (`greet.webm`)，播放完毕自动平滑切回当前居室业务动作；
  3. **离线转场**: 点击下方操作栏「去书桌工作」按钮，小鱼触发 2 秒「费劲爬向书桌」移动过渡动画 (`move.webm`)，随后平滑就座并切换为「敲代码写笔记」工作状态 (`work.webm`)；
  4. **未启用平台安全反馈**: 点击「去电脑前刷抖音」按钮，后端在无平台注入时返回 HTTP 503 并提示「功能未启用：抖音服务未启用或未连接」，HUD 明确展示错误信息，绝不虚构成功；
  5. **无障碍与动效自主切换**: 默认尊重系统 `prefers-reduced-motion` 设置（若系统开启减弱动画则默认展示静态 WebP 海报）；同时在小鱼头顶提供「开启动画 / 静态角色」用户显式切换按钮，允许用户主动覆盖系统偏好进行动画播放与静态海报切换；切换至其他后台标签页时，视频自动 pause 节约渲染开销，页面切回时自动 resume。

---

## 二、范围限制与已知边界（Non-Goals & Scope Limits）

在首期审查中，明确区分设计范围限制与缺陷，以下内容为用户批准的首期既定边界：

1. **睡眠动作姿态说明**:
   - 桌宠源素材切片中 `random/原地小憩沉眠.webm` 原始动作即为坐在床沿低头闭目微动（坐姿小憩）；
   - 首期直接复用桌宠真实素材，未重新绘制卧姿睡姿。
2. **纯离线运行与平台隔离**:
   - 本期不启动真实 Playwright 浏览器或抖音爬虫，不联网，不访问私人配置与数据库；
   - 平台 status provider 采用依赖注入，彻底解耦 `bili-browser.js` 等平台硬依赖；
   - 未装配真实平台时，相关控制接口返回 503，并通过新增的「去书桌工作」按钮提供全流程离线体验。
3. **既有全仓基线分离（不升级为本期必修）**:
   - 执行 `node scripts/check.mjs` 时，仓库既有基线存在 2 处失败（当前项目环境模块解析缺 `playwright-core` 依赖导致 `bili-browser.js` 导入与冒烟失败）以及 10 处文档/测试内的历史脱敏警告；
   - 按照最小侵入与隔离原则，本任务未引入外部网络依赖或重构无关模块，此 2 处失败属既有环境基线，不属于角色层新增缺陷。
4. **调度与鉴权系统**:
   - 本期重点为角色动画层、坐标系、离线交互与静态资源服务，未实现完整日程生活调度系统或用户权限认证体系。

---

## 三、规格审查与实现符合度矩阵

| 审查维度 | 规格要求 | 实际实现与代码证据 | 审查结论 |
| :--- | :--- | :--- | :---: |
| **Manifest 规范** | schema=1, id=shenshen, canvas [640,360], bodyBox [212,60,428,330], anchor [320,330] | `manifest.json:2-17` 完全符合，字段严格强校验 | **PASS** |
| **6 Clips 契约** | idle, move, sleep, work, think, greet (greet 单次 loop:false, 其余 loop:true) | `manifest.json:18-49`，各 clip 均包含相对路径的 src 与 poster，循环属性符合 | **PASS** |
| **透明媒体管线** | 离线 a<=1 底板清理、白底反解、alpha 腐蚀（核半径 1px / 3x3） | `scripts/prepare_room_character.py:42-105` 完整实现纯函数，`test_alpha_cleaner.py` 覆盖 | **PASS** |
| **真实 Hash 溯源** | 来源与衍生视频/海报 sha256 记录，源变动时拒绝错误缓存 | `manifest.json:_provenance` 记录 6 组双向 Hash，源文件与 `dsh-pet-indesktop` 100% 吻合；`should_reuse_clip` 拒绝坏缓存 | **PASS** |
| **版权声明** | 依据桌宠 THIRD_PARTY_NOTICES，CC BY-NC-SA 类条款，个人非商业，非 MIT | `NOTICE.md:1-14` 明确声明上善无形画师署名、CC BY-NC-SA 类条款及非 MIT 资产 | **PASS** |
| **前端状态防竞态** | 消费 window room:state 事件，无额外 SSE；初始 /api/status 慢响应不覆盖新状态 | `model.js:235-253` 与 `renderer.js:304-312` 实现时间戳 + 版本单调递增双重防竞争 | **PASS** |
| **坐标与点击区域** | 脚底锚点定位，CSS transform 自身百分比计算；bodyBox 收拢热区不遮挡家具 | `model.js:123-185`，`renderer.js:180-183`，`character.css:9-25, 63-75`，热区精准缩小 | **PASS** |
| **反馈与生命周期** | 单次 greet，新业务状态立即覆盖反馈；hidden 暂停、reduced-motion 降级、pagehide 清理 | `renderer.js:197-250, 314-356, 412-435`，已实现双缓冲减少切换闪烁，清理监听与媒体 | **PASS** |
| **后端资源防逃逸** | 跨平台路径解析，限定 MIME，防御 `..` 路径穿越与隐藏文件，支持 HTTP Range 206/416 | `virtual-room.js:1468-1605`，严格基于 `path.relative`、扩展名白名单及 RFC 9110 Range | **PASS** |
| **后端生命周期** | 支持 port: 0、ready Promise、stop() 结束 SSE 与 Sockets、可取消 2s 爬行过渡 | `virtual-room.js:1068-1130, 1727-1768`，支持元数据更新不中断转场 | **PASS** |
| **离线与安全性** | 默认 127.0.0.1 loopback，CSRF Origin 校验，64KB body 限制，平台未装配报 503 | `virtual-room.js:1627-1690`，安全防护到位 | **PASS** |
| **打包规范** | companion package files 包含 character 与必要静态图，不打包实况二维码 | `packages/companion/package.json:20-29` files 字段精准，`npm pack --dry-run` 验证不含 qr 码 | **PASS** |

---

## 四、独立测试与验证证据（Verification Evidence）

全部测试均在 Windows 环境独立直接执行，记录退出码与真实测试统计：

### 1. 角色层与居室服务 Node 单元测试
```bash
node --test packages/companion/test/*.test.mjs
```
- **输出结果**:
  - `room-character-assets.test.mjs`: 3/3 PASS (Manifest 架构、物理文件存在性、NOTICE.md 条款)
  - `room-character.test.mjs`: 24/24 PASS (状态映射、Object.hasOwn 防御、坐标数学公式、版本竞争时序、DOM Seam、海报降级、后台静音、用户动效切换覆盖系统 reduced-motion 按钮)
  - `virtual-room.test.mjs`: 16/16 PASS (服务就绪与优雅停止、HTML 挂载、资源路径防穿越、Range 206/416、数据目录跨平台、抖音未装配 503、2s 转场取消与恢复、爬行中元数据保留、版本单调自增、畸形 Host/URI 400 防悬挂、realpath 防 symlink 逃逸、超出边界 end clamp 206、demo 脚本启动)
- **真实统计**: **44 tests passed, 0 failed, duration: ~680ms, exit code: 0**

### 2. Python 图像处理算法与缓存逻辑单元测试
```bash
python -m unittest scripts/test_alpha_cleaner.py
```
- **输出结果**:
  - `test_import_exists`: PASS
  - `test_floor_faint_alpha_clears_low_alpha`: PASS (a<=1 彻底清零)
  - `test_unblend_rgba_math`: PASS (白底公式数学反解与原色还原)
  - `test_unblend_rgba_extremes_unchanged`: PASS (极端 alpha 边界保护)
  - `test_erode_alpha_reduces_isolated_pixel_and_respects_px`: PASS (最小值滤波微缩)
  - `test_should_reuse_when_source_hash_matches`: PASS (源哈希一致时安全复用)
  - `test_should_reject_reuse_when_source_hash_changed`: PASS (源修改时拒绝复用触发重转)
  - `test_should_reject_reuse_when_derivatives_missing`: PASS (衍生文件缺失拒绝复用)
  - `test_should_reject_reuse_when_cached_meta_missing`: PASS (缺少元数据拒绝伪造)
  - `test_should_reject_reuse_when_force_flag_passed`: PASS (force 标志强制重跑)
- **统计**: **Ran 10 tests in 0.006s, OK, exit code: 0**

### 3. 生活模块既有测试独立回归
```bash
node --test packages/own-life/test/*.mjs
```
- **输出结果**: 通过自定义测试脚本断言执行 20 条规则全部 PASS（`OK pass=20 fail=0`，Node 测试套件包装输出为 1 个测试）
- **统计**: **1 test (20 passed assertions in custom runner), 0 failed, exit code: 0**

### 4. 全仓代码质量检查（Baseline Check）
```bash
node scripts/check.mjs
```
- **输出结果**:
  - 语法检查：64 项全部 ✅（包含全部新增的前后端及测试代码文件，并行会话新增的 desktop-host 等文件亦全部语法通过）
  - 模块导入：1 ❌（既有基线：当前环境模块解析缺 `playwright-core` 依赖）
  - 功能冒烟：1 ❌（既有基线：当前环境模块解析缺 `playwright-core` 依赖）
  - 脱敏检查：10 ⚠️（既有基线：小黑盒等历史文档含既有敏感正则模式告警，本任务未引入任何新增告警）
- **统计**: **通过 64 · 失败 2 · 警告 10，exit code: 1**（与当前全仓状态完全吻合，语法通过总数增加系外部并行会话新增文件所致，基线失败数仍保持 2，未引入新缺陷）

### 5. 媒体文件物理抽样与 Hash 校验
- **抽样检测**:
  - `clips/idle.webm` ~ `greet.webm`: 格式 VP9, 尺寸 640x360, 解码像素格式 RGBA, Alpha 通道极值 `(0, 255)`。
  - `clips/idle.webp` ~ `greet.webp`: 格式 WebP, 尺寸 640x360, mode=RGBA, Alpha 极值 `(0, 255)`。
- **Hash 一致性**:
  - 6 个衍生 WebM 与 6 个衍生 WebP 的本地实际 SHA-256 与 `manifest.json` 中记录的 `derived_webm_sha256` / `derived_poster_sha256` 100% 逐一匹配。
  - 6 个源 WebM 文件的实际哈希与桌宠本地源 `dsh-pet-indesktop/assets/characters/shenshen/videos/` 完全匹配。

### 6. npm 打包脱敏与文件白名单核验
```bash
npm pack --dry-run --ignore-scripts --offline ./packages/companion
```
- **核验结论**:
  - 打包文件共 58 个，压缩包体积 5.7 MB；
  - 包含：`public/room_assets/character/*`、`examples/room-demo.js`、`sample-room.png`、`screen_standby.jpg` 及 `src/*`；
  - **严密排除**：未将 `douyin_qr_live.png`（实况登录二维码）或测试脚本打入包中，符合脱敏与精简化要求。

---

## 六、Chromium 本地实测与截图证据（Lead 实机验证）

按团队分工与权限规范，真实浏览器画面渲染与多端交互操作由 Team Lead 亲自启动真实 Chromium 验证（环境：Chromium 1280x800，非多端泛化，未测 Safari/手机）：
- **验证环境**: 本机真实浏览器访问 `http://127.0.0.1:18889/`
- **Lead 实机观察结论与最小证据**:
  1. **首屏动效开关与海报展现**: 本机 Chromium 默认 `prefers-reduced-motion: true`，刷新后角色区域顶端正确出现「开启动画」按钮，默认安全展现静态海报；点击按钮后文本变为「静态角色」，表明成功开启视频模式；
  2. **网络与协议符合度 (Network)**: 确认 `idle.webm`、`greet.webm`、`move.webm`、`work.webm`、`sleep.webm` 均稳定以 HTTP 206 `video/webm` 返回；SSE 保持 200 持续推送；JS/CSS/JSON 资源 200 且版本 query 生效；控制台（Console）保持干净无报错；
  3. **交互与动作状态流转**:
     - 鼠标点击小鱼实体：纯前端本地交互派发 `greet` 动画反馈，触发 `clips/greet.webm` 媒体请求（不调用 `/api/action`，仅用户点击下方操作栏按钮如去书桌/睡觉等才调用 `/api/action`）；
     - 点击「去书桌工作」：角色平滑移动至工位并渲染 `work` 敲代码写笔记状态；
     - 点击「闭眼入睡」：在床沿区域成功观察到闭眼坐姿小憩状态；
     - 两次 `move`/`sleep` 前置请求出现的 `ERR_ABORTED` 紧接同 URL 206，系媒体重新 load 时的标准浏览器中止旧请求，并非网络故障或播放失败；
  4. **家具层级与抽屉遮挡防御**: 点击书架成功弹出生活日记抽屉（仅展现 demo 临时日记，不读真实隐私数据），小鱼图层保持正常显示，家具与热区未被角色框遮挡；
  5. **实机截图归档**: 真实运行截图已保存至 [screenshots/room-character-preview.jpg](screenshots/room-character-preview.jpg)（展示睡眠状态与日记抽屉并存场景）。

---

## 七、审查整改复盘（Review Findings & Resolution）

在审查阶段，Reviewer 提出并协同团队完成了以下关键技术缺陷的修复闭环：

1. **媒体脚本缓存伪造与导入失效**:
   - *问题*: `prepare_room_character.py` 缓存复用未对比源哈希且缺失时伪造 `frames=241`；`--meta-only` 解析后未消费；根目录下执行 `test_alpha_cleaner.py` 因缺少 `sys.path` 报错。
   - *整改*: 增加 `should_reuse_clip` 模块校验源 SHA256，补齐 `--meta-only` 拦截，保留真实 provenance 记录，补充 5 个缓存测试用例并修复导入路径。
2. **前端 CSS Transform 变换基准与原型链污染**:
   - *问题*: `calculateAnchorTransform` 原先使用舞台百分比代入 `translate3d`，导致自身相对尺寸位移严重失真；`ROOM_STATES[stateName]` 未防御 `constructor` 原型链属性；缺失视频 `canplay` 竞态保护与 `hidden` 播放拦截。
   - *整改*: 前端改写为自身画幅相对百分比 `(worldLeft / renderWidth) * 100%`，引入 `Object.hasOwn`，增加 `loadGeneration` 与页面后台检测，补充 23 项高覆盖测试。
3. **后端转场状态死锁与单调版本缺失**:
   - *问题*: `virtual-room.js` 在爬行转场期间，若调用 `setState(null, { message })` 更新文本，原逻辑误将过渡计时器清除导致小鱼卡在爬行状态无法就座；状态快照缺少版本号难以保证前端幂等更新。
   - *整改*: 严格区分纯元数据更新与状态变更，爬行期间保持转场 timer 并在到达后正确融合元数据；状态引入全局单调自增 `version` 字段，并在前端状态机中确立版本号优先仲裁规则。

---

## 八、交付总结

本首期开发严格恪守任务与安全边界：
- 零外部网络依赖，全流程离线可重现；
- 媒体管线具备数学推导（去白底反解、底板清除、Alpha 腐蚀）与全量 SHA256 溯源，版权合规；
- 代码架构清晰，实现了双缓冲减少切换闪烁、单一 SSE 消费、状态竞态保护、HTTP Range 206 切片及跨平台安全服务；
- 当前发布与交付状态参照 Git 提交规范与远程推送流程。
