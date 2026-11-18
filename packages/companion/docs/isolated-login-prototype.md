# 人工验证接管：仅合成页面原型

**此原型不能登录 B 站或抖音，也没有接入 `/login`，不能导入 Cookie。** 它只验证隔离图形桌面的画面和人工输入通路；旧 headless 浏览器的验证状态不能迁移。真正的接管需要从新图形浏览器重新扫码，并在同一浏览器会话内由本人完成验证。生产版还需先完成独立访问授权、同会话绑定、凭据隔离校验与原子导入；没有这些保障前不得用于真实账号。

## 合成测试

服务器需以 root 启动，并有 `unshare` 网络及挂载命名空间权限、mount、Xvnc、xauth、openbox、Python 3 和脚本内指定的 Chromium。桌面和浏览器启动前降权到每次随机选取的、非现有账户 UID；这不是 user namespace 或强隔离容器，root 和同 UID 进程仍可信。挂载仅在独立 mount namespace 内，临时 passwd 条目不会写入宿主 `/etc/passwd`。脚本拒绝附带 URL，浏览器运行在独立无外网网络命名空间；RFB 只开放 0700 临时目录中的 0600 Unix socket，不开放 TCP。默认 60 秒硬超时，不操作也会清理；`SYNTHETIC_HANDOFF_TTL` 可设为 1–300 秒（仅合成测试）。启动：

```sh
cd /root/ai-companion-xiaoyu/ai-companion-kit/packages/companion
python3 scripts/isolated-login-prototype.py
```

输出 `SOCKET=/.../rfb.sock`，保持该进程运行。在**本人可信电脑**上，先按组织流程核验服务器 SSH 主机密钥，使用本人受限的 SSH 账号和密钥；SSH 账号必须有遍历 socket 全路径并连接该 socket 的权限。默认路径位于 `/root` 且 socket 属于临时 UID，普通账号通常无权连接；本原型尚未提供安全的授权代理或受限转发账号配置，不应为使其工作而放宽 `/root`、工作目录或 socket 权限。仅在测试环境以可信管理员身份进行验证，生产使用前必须实现受限转发。然后在本人电脑执行（替换真实账号、主机和刚输出的 socket 路径）：

```sh
ssh -N -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=yes \
  -L 127.0.0.1:15900:/服务器上输出的/rfb.sock 用户@服务器
```

本人电脑用 VNC viewer 连接 `127.0.0.1:15900`，页面点击后变绿，表示该图形页面收到可信指针释放事件。VNC 协议本身未加密且没有密码；只能走上述经身份验证的 SSH 隧道，不能开放公网端口、共享隧道或把屏幕交给模型。服务器 root、同 UID 用户以及本人电脑其他有权限的进程可能访问画面；无法信任这些主体时不要使用。结束时关闭 viewer 和 SSH，然后在服务器按 Ctrl-C；临时 profile 和 socket 会删除。异常断电或 SIGKILL 无法保证清理，须在服务器检查并安全删除 `TMPDIR/login-prototype-*` 残留。

自动验证：`python3 test/isolated_login_prototype_test.py`。它直连私有 Unix socket 测试 RFB 画面和指针，不证明真实人类、远程 SSH 身份验证或第三方登录成功。

## 日后真实接入的安全边界（未实现）

- 本人仅在专用浏览器的官方网站界面扫码、输入验证码和操作滑块，不向聊天、模型、日志或他人提供验证码、密码、Cookie 或屏幕。不要让自动化代做挑战或绕过平台验证。
- 不复用旧 headless 会话，不将一个浏览器的挑战结果移到另一个会话冒充完成。扫码、挑战和导出必须绑定同一新会话，并有明确的超时和撤销。
- 新会话需按平台在隔离环境进行有效性校验，通过后才可沿既有安全导入流程私有权限原子写入；失败不覆盖现有凭据，日志和错误不得包含凭据。尚未实现或验证该路径。
- 访问控制应当验证单次授权、身份、会话范围、并发与销毁；`SecurityTypes None` 仅因 Unix 文件权限和受认证 SSH 隧道而适合此受控合成测试，不能直接当成生产安全方案。不要以此文档宣称 `/login` 已可接管。
