# 贴吧同会话候选的安全状态

此路径仅供 `fixture.invalid` 离线模拟；不是生产安全边界。用户操作模拟接管后，同一 Chromium context 在模拟身份验证成功时不可逆切换为只读：模拟登录 POST 最多一次，验证后禁止所有 POST；只放行 fixture 的精确 GET，禁止 WebSocket，阻止 service worker，其他请求中止。断开后关闭 context 并撤销 reader。测试使用真实 Chromium 和真实 reader，且监听 loopback 验证没有命中。

Playwright 路由、无效代理及 DNS 配置不等于操作系统级网络隔离：浏览器侧还存在路由覆盖不到的渠道和进程边界风险。本机测试未证明 netns、防火墙、浏览器与 broker 的进程/能力隔离。不得据此接入真实账号或启用生产候选；`createTiebaCandidate()` 保持关闭。注入的 verifier/transport 为可信测试代码，不能代表生产验证。

真实正例需要用户本人授权并操作独立隔离的接管会话，取得可核验的百度官方登录身份协议及响应证据（不能以 cookie 或页面文案冒充身份），设计登录阶段与只读阶段分别最小化的网络策略，在独立网络命名空间和可信 broker 上验证所有流量、重定向每跳、DNS pinning、私网/本地地址、WebSocket/UDP、进程隔离、失效和取消；再经专门安全审查后才可考虑上线。测试不得收集或记录真实凭据。
