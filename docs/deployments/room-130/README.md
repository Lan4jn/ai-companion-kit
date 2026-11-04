# 130 虚拟居室角色层独立预览部署指南

> **说明**：本目录为 130 独立沙箱预览部署的配置与模板文件。目前 192.168.31.130 宿主上尚未实际执行此部署（已按用户要求暂停远端变更），本文档仅供后续按需部署参考。文档中不包含任何个人凭据、归档绝对路径或机器私钥。

本文档介绍如何在宿主 `192.168.31.130` (`picoclaw-130`) 上以独立沙箱运行虚拟居室角色层预览服务。

---

## 1. 架构与隔离设计

1. **端口隔离**：
   - 生产服务：占用 `18888` 端口（位于 `/root/ai-companion-xiaoyu`，保持原有状态，绝不动它）；
   - 预览服务：占用 `18889` 端口，独立监听 `0.0.0.0:18889`。
2. **目录与版本隔离**：
   - 部署根路径：`/opt/room-character-preview/`
   - 版本发布目录：`/opt/room-character-preview/releases/<timestamp>/`
   - 活跃软链接：`/opt/room-character-preview/current` 指向最新发布版本。
3. **数据与权限隔离 (systemd)**：
   - `DynamicUser=yes`：以动态分配的无特权临时系统用户运行；
   - `StateDirectory=room-character-preview`：数据落地于专用隔离目录 `/var/lib/room-character-preview`；
   - `ProtectHome=yes` 与 `ProtectSystem=strict`：严格只读系统目录，杜绝跨目录读取 `/root/` 下的真实日记与账号凭据。

---

## 2. 部署与启动命令（由 Lead 在远端执行）

### 2.1 同步产物并建立版本链接

```bash
# 1. 创建发布目录（示例时间戳）
STAMP=$(date +%Y%m%d%H%M%S)
mkdir -p /opt/room-character-preview/releases/$STAMP

# 2. 将 packages/companion 产物及 launch.mjs 复制至发布目录
# （包含 src, public, package.json, launch.mjs）
cp -r packages/companion/src packages/companion/public packages/companion/package.json /opt/room-character-preview/releases/$STAMP/
cp docs/deployments/room-130/launch.mjs /opt/room-character-preview/releases/$STAMP/

# 3. 更新 current 软链接
ln -sfn /opt/room-character-preview/releases/$STAMP /opt/room-character-preview/current
```

### 2.2 安装 systemd 服务单元

```bash
# 复制 systemd unit 文件并重载
cp docs/deployments/room-130/room-character-preview.service /etc/systemd/system/
systemctl daemon-reload

# 启动并设置开机自启
systemctl enable --now room-character-preview.service
```

---

## 3. 服务验证与日常运维

### 3.1 状态与日志查看

```bash
# 查看运行状态
systemctl status room-character-preview.service

# 查看实时日志
journalctl -u room-character-preview.service -f
```

### 3.2 局域网访问地址

浏览器直接打开：
- 居室主页：`http://192.168.31.130:18889/`
- 屏幕监视器：`http://192.168.31.130:18889/monitor`
- 状态接口：`http://192.168.31.130:18889/api/status`

### 3.3 停止服务

```bash
systemctl stop room-character-preview.service
```
