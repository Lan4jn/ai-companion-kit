# 持久聊天：显式信任本机 OneBot（隔离开发版）

默认关闭。原有证书固定 WSS/HTTPS 模式不变；仅在明确设置 `durableChat.enabled: true` 且 `durableChat.transport.trustLoopbackOneBot: true` 时，允许 `onebot.wsUrl` 使用 `ws://127.0.0.1:<port>/...`，并将 `durableChat.transport.senderUrl` 设为 `http://127.0.0.1:<port>/`。其他持久聊天所需的 owner、日志密钥、角色卡和记忆作用域配置仍不可省略。只允许字面量 IPv4 回环地址，不跟随重定向。不可把这一模式视为生产默认，不能用来连接 LAN。

**信任根：本机操作者指定的监听端口及提供 OneBot 的进程。** 明文 loopback 不证明进程身份、不防本机其他进程窃听/冒充，也不证明上游 QQ 身份；接入方完全依赖该 OneBot 如实提供账号与消息。WebSocket 入站、持久发送 HTTP 及辅助 API HTTP 可以是不同端口，端点都由操作者负责确认；辅助 `onebot.httpUrl` 如配置必须是字面量 `http://127.0.0.1:<port>/`，不跟随重定向、不使用代理。访问令牌在本机明文传输。内部 `authenticated` 名称是历史接口，不表示本模式具备密码学认证。若本机无法可信隔离，禁止启用。

当前模式使用现有消息来源能力、加密持久队列、owner 限制、输出过滤及不确定投递阻断；不是 Python `chat_local_supervisor.py`，后者仍未接入主路径。发送结果 unknown 代表对方可能已收到，不能自动重发；历史启动输入和恢复仍需现有人工审批。仅文本入站。此开发结果尚未部署或连接真实服务。

隔离测试：`node --test test/chat-main-loopback-integration.test.js test/chat-main-loopback-durable.test.js`；只启动测试自有回环假源与合成模型响应。
