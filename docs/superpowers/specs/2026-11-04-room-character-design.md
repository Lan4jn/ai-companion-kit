# 虚拟居室角色层与首期交互子系统设计规格 (Room Character Layer & Subsystem Spec)

> **文档性质**：用户同意开发的首期实施规格 (Phase 1 Implementation Specification)
> **日期**：2026-11-04
> **所属仓库**：`F:\Documents\Project\ai-companion-kit`
> **当前分支**：`feat/room-character`
> **多角色分工**：
> - **媒体与文档（template-analyst）**：负责 6 动作离线转码、底板清理、poster 抽取、共享 manifest 契约及 NOTICE 声明，以及 Node.js 媒体契约断言测试；
> - **后端服务（backend-lead / lead）**：负责 `virtual-room.js` 路由重构、跨平台路径注入、安全 loopback 绑定、可取消状态机转场、可关闭 HTTP 服务与离线 demo 模式；
> - **前端视图（frontend-dev）**：负责 CustomEvent 数据流、防竞争条件、动态 Manifest 加载、锚点脚底落地对齐、5 状态机动画映射、bodyBox 点击交互与 poster 降级。

---

## 1. 目标与首期边界 (Scope & Boundaries)

### 1.1 核心目标
在 `ai-companion-kit` 中建立首期高可用、自包含且跨平台的虚拟居室角色层与本地开发验证服务。将静态房间模板与真实小鱼角色（OC 溟月 / 深深）动态素材打通，提供流畅可感知的 5 状态居室交互体验。

### 1.2 严格范围边界 (Strict Boundaries)
- **包含内容 (In Scope)**：
  - 角色 6 个核心动作的透明 WebM 与静态 WebP 海报交付；
  - 共享契约 `/room_assets/character/manifest.json` 与 CC BY-NC-SA 类条款授权声明；
  - 居室服务的跨平台注入改造与安全 loopback 绑定（默认 `127.0.0.1:18888`）；
  - 媒体静态资源的 Range 206 渐进式流式传输与路径越界防范；
  - 状态机的 2 秒代次防幽灵可取消转场；
  - 优雅停机能力与离线开发调试演示模式；
  - 前端 CustomEvent 事件解耦与状态机驱动的动画切换、poster 容灾。
- **不包含内容 (Out of Scope)**：
  - 绝不引入或实现全量生活协调调度系统（已有独立服务，不产生耦合）；
  - 绝不实现复杂的全量用户认证或外部鉴权系统（首期聚焦本地开发与单机体验）；
  - 绝不修改外部桌宠源码仓（`dsh-pet-indesktop` 保持只读引用）；
  - 绝不执行 git commit 或 git push。

---

## 2. 共享数据契约 (Shared Manifest Contract)

前端、后端与媒体层严格遵循以下完全一致的共享契约定义：
- **访问接口**：`GET /room_assets/character/manifest.json`
- **物理路径**：`packages/companion/public/room_assets/character/manifest.json`
- **相对路径规则**：`clips` 中的 `src` 与 `poster` 均为相对于 `manifest.json` 所在 URL 的相对路径。

### 2.1 Manifest JSON 规范示例

```json
{
  "schema": 1,
  "id": "shenshen",
  "canvas": [640, 360],
  "bodyBox": [212, 60, 428, 330],
  "anchor": [320, 330],
  "clips": {
    "idle": {
      "src": "clips/idle.webm",
      "poster": "clips/idle.webp",
      "loop": true
    },
    "move": {
      "src": "clips/move.webm",
      "poster": "clips/move.webp",
      "loop": true
    },
    "sleep": {
      "src": "clips/sleep.webm",
      "poster": "clips/sleep.webp",
      "loop": true
    },
    "work": {
      "src": "clips/work.webm",
      "poster": "clips/work.webp",
      "loop": true
    },
    "think": {
      "src": "clips/think.webm",
      "poster": "clips/think.webp",
      "loop": true
    },
    "greet": {
      "src": "clips/greet.webm",
      "poster": "clips/greet.webp",
      "loop": false
    }
  },
  "attribution": {
    "character": "溟月 (深深)",
    "artist": "上善无形",
    "origin": "PC2005-cloud/dsh-pet",
    "notice": "同人素材遵循 CC BY-NC-SA 类条款，仅限个人非商业使用，保留署名与来源，禁止商用"
  }
}
```

---

## 3. 动作素材审片特征与映射

素材源自 `dsh-pet-indesktop/assets/characters/shenshen/videos/`。经首帧与中段审片，各动作特征如下：

| 动作标识 (Clip) | 来源文件路径 | 循环标记 (loop) | 审片特征与居室交互定位 |
| :--- | :--- | :--- | :--- |
| `idle` | `idle/待机呼吸休闲.webm` | `true` | 首帧为通用站姿，轻缓呼吸浮动，适合房间常态待机与床沿闲坐。 |
| `move` | `move/漂浮踏步.webm` | `true` | 原地踏步位移感，适合状态切换时的走动与转场过渡。 |
| `sleep` | `random/原地小憩沉眠.webm` | `true` | **审片确认**：中段呈现坐着打瞌睡并垂头浅睡状态，非平躺卧床，不承诺完全贴合床铺几何。 |
| `work` | `random/写代码.webm` | `true` | **审片确认**：角色模型自带小型笔记本电脑敲击动画，放置在书桌区域时需避开背景固定绘制的电脑位置。 |
| `think` | `random/工作状态-思考冒泡.webm` | `true` | 侧头思考、头顶出现冒泡粒子，适合消息处理与思考状态。 |
| `greet` | `click/点击回应-元气挥手.webm` | `false` | 单次点击反馈动作，元气挥手致意，播放单次结束后平滑切回原动作。 |

---

## 4. 后端开发验证服务设计 (Task-6 Backend Scope)

### 4.1 跨平台路径与依赖解耦
- **彻底剔除写死路径**：移除 `virtual-room.js` 中所有 `/root/ai-companion-xiaoyu/...` 绝对路径；
- **配置注入支持**：`startVirtualRoomServer({ dataDir, assetsDir, host, port, devMode })` 支持通过入参动态注入数据与资源根目录，默认回退至项目相对路径；
- **安全 Loopback 绑定**：默认仅监听 `127.0.0.1` 本地回环地址，避免暴露公网未受权访问。

### 4.2 静态资源分发与安全防护
- **MIME 类型支持**：完整支持 `.html`, `.css`, `.js`, `.json`, `.png`, `.jpg`, `.webp`, `.webm` 的正规 Content-Type 头；
- **Range 206 分段响应**：针对视频 `.webm` 实现标准的 HTTP `Range` 头解析与 `206 Partial Content` 响应，保障浏览器端视频缓冲与快进能力；
- **路径穿越拦截**：对请求路径做规范化（`path.normalize`）与边界前缀校验，坚决杜绝 `..` 越界读取系统敏感文件。

### 4.3 状态机 2 秒可取消过渡与防幽灵机制
- **5 状态机**：`bed_phone`, `bed_sleep`, `bed_sit`, `crawling`, `desk_laptop`；
- **转场规则**：床上任意状态切换至 `desk_laptop` 时，自动进入 `crawling` 状态，延时 2 秒后切换到目标状态；
- **代次取消**：每次状态变更递增 `version` 代次，打断或重设状态时立即取消在飞的延时定时器，杜绝旧状态定时器回写造成的“幽灵状态覆盖”。

### 4.4 可优雅关闭与离线演示模式 (Offline Demo)
- **服务实例封装**：`startVirtualRoomServer` 返回包含 `.close()` / `.stop()` 方法的统一控制器，支持关闭底层 `http.Server` 实例并清理活动的 SSE 客户端集合；
- **离线调试模式**：在无需连接外部大模型和手机设备的情况下，提供轻量独立运行的验证服务。

---

## 5. 前端视图与渲染层设计 (Task-7 Frontend Scope)

### 5.1 数据流架构与防竞争 (Anti-Race)
- **解耦事件总线**：在页面全局监听 `window.addEventListener('room:state', (e) => ...)`，实现 HUD 卡片、场景画布与角色表现的松耦合；
- **防竞争启动时序**：
  1. 页面既有 `EventSource` 由内联脚本首先启动，持续监听服务端 SSE 广播；
  2. 角色渲染器（renderer）首先注册 `window.addEventListener('room:state', ...)` 事件总线；
  3. 渲染器随后主动调用 `fetch('/api/status')` 获取当前状态快照进行首帧填补，若快照版本早于已收到的 SSE 状态则安全丢弃过期快照，确保无时序竞争；
  4. 既有 SSE 管道与新增事件总线协同工作，无需破坏性颠倒启动连接。

### 5.2 角色渲染器与锚点系统
- **动态装配**：异步读取 `/room_assets/character/manifest.json`，根据配置的 `canvas: [640, 360]` 动态创建自适应视频图层；
- **锚点落地对齐**：严格依据共享契约中定义的 `anchor: [320, 330]` 作为角色脚底基准点，在 3:2 房间背景中定位小鱼落脚点；
- **状态与动作映射**：
  - `bed_phone` / `bed_sit` -> `idle`
  - `crawling` -> `move`
  - `bed_sleep` -> `sleep`
  - `desk_laptop` -> `work` (若处于思考或互动则切至 `think` / `greet`)
- **交互命中与回退**：
  - 点击区域采用 `bodyBox: [212, 60, 428, 330]` 进行几何判定；
  - 点击小鱼后触发 `greet`（元气挥手，`loop: false`），并在 `ended` 后自动切回当前常态动画；
- **容灾与低功耗降级**：
  - 页面隐藏（`document.visibilityState === 'hidden'`）或用户开启 `prefers-reduced-motion` 时，暂停视频并切换为静态 `poster.webp`；
  - 视频加载错误时，静默优雅降级显示对应动作的 WebP 海报。

---

## 6. 媒体处理管线设计 (Task-5 Media Scope)

### 6.1 运行依赖与约束
- **环境要求**：宿主 Python 3.11+ (带 Pillow 库) + 系统 PATH ffmpeg 工具；
- **无 Qt 依赖**：不依赖 PySide/Qt 运行库，纯利用 Python 图像处理能力与 ffmpeg 编解码；
- **无残留保证**：所有拆帧与临时 WebP/PNG 均在操作系统临时目录操作，转换完成后立即彻底清理，绝不在代码仓库中留存中间帧。

### 6.2 抑制白边与底板清理纯函数
实测证明源素材存在 82.01%（188,965/230,400 像素）的 `a == 1` 底板残留与白底抠图白晕：
1. **底板清理**：凡 $a \le 1$ 的像素，强制置为 $(0, 0, 0, 0)$；
2. **白底反解**：针对 $21 \le a < 250$ 的半透明边缘像素：
   $$\text{rec} = \text{clamp}\left(\frac{\text{stored} - 255 \times (1 - a)}{a}, 0, 255\right)$$
3. **边缘微缩 1px**：Alpha 通道应用 3x3 最小值滤波，抑制外圈发散杂白毛刺；
4. **透明 VP9 压制与中段 Poster**：重新压制为带有 Alpha 通道的轻量级 VP9 WebM，并抽取第 $N/2$ 帧导出为无损透明 WebP 海报。

---

## 7. 授权与声明规范 (Attribution & Notice)

在 `packages/companion/public/room_assets/character/NOTICE.md` 中严格原样声明：
1. 素材派生自社区开源项目 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)；
2. 角色 OC「溟月」出自画师 **上善无形**，素材由社区成员整理制作；
3. **许可性质**：同人素材遵循 **CC BY-NC-SA 类条款**，**仅限个人非商业使用**，使用须保留署名与来源，禁止商用；
4. **明确排除**：本角色动画素材**绝非 MIT 许可资产**。
