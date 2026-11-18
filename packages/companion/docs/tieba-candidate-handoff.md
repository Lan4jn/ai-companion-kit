# 贴吧登录候选交接

`createTiebaCandidateFactory` 默认关闭，显式启用并注入 `openOwnerSession`、`verifyIdentity` 和 `listSource` 后返回无参工厂，可传入 `setupProductionTieba({candidateFactory})`。工厂要求验证器返回稳定的非空 `subject`（1–128 位 ASCII 字母、数字、下划线或连字符），后续缺失或变化即撤销；subject 必须来自经独立验证的身份协议，不能使用用户名、cookie、网页任意文本或用户布尔值充当身份凭证，该格式只是候选内部契约而非已验证的百度身份格式。直接调用底层 `createTiebaLoginIntegration` 保留无 subject 的测试兼容性，不得用于真实身份认证。会话需提供隔离的 Playwright context 与 close；身份验证器必须独立、可信，不能以 cookie 存在作为身份凭证。reader 和房间登录 provider 使用同一个候选实例；关闭或失败撤销会话，状态为 unknown。候选读取只读、限制目标与内容，解析使用隔离浏览器。房间登录页“结束本地会话”通过受保护的 POST 调用 `provider.cancel()`，撤销已建立或正在建立的会话，等待资源清理后可重新开始；这不是平台服务器端退出登录，也不是实际接管服务。

真实贴吧官方 HTTPS 身份正例、身份协议和真实账号登录均未验证；本仓库没有可信的生产身份验证器或可交付的真实登录接管实现，不可据此启用真实登录。配置未变更。注入 transportOptions 会绕过默认网络依赖，仅限受控测试或经独立安全审查的可信部署。读取前后均重新验证身份，读取期间失效的结果被丢弃并撤销会话；这不能证明未验证的身份协议或浏览器隔离安全。

[百度账号问题反馈中心](https://passport.baidu.com/v2?ucenterfeedback) 描述网页登录方式和登录后查看账号名，亦指出百度账号能登录而单产品可能无法登录。这只是面向用户的说明，不规定可机器核验的可信字段，也不能证明贴吧会话已认证；因此不能据此把页面任意文本提升为 online。真实浏览器工厂、完整登录出口隔离及正式正例仍缺失，必须保持关闭。

`tieba-mock-handoff.js` 的 `fixtureDependencies()` 仅供本地模拟测试：合成身份、虚构域及受控 HTML，不是官方实现。`node --test test/tieba-handoff-candidate-reader-e2e.test.js` 通过本地网页 viewer 点击合成登录，使用同一 Chromium context 身份与受控正文，再通过真实候选 source、HTML 解析器及 reader 读取，关闭 viewer 后撤销。该测试不接触真实账号或真实贴吧网络。

候选传输目前只接受 `tieba.baidu.com` 的 secure host-only Cookie，会丢弃 `.baidu.com` 或 `.tieba.baidu.com` 域 Cookie；如果真实登录依赖这些 Cookie，共享读取将无法保持登录态。离线试验确认直接放宽会违反现有 host-only 安全边界，因此未放宽：必须先经用户授权验证真实需要、厘清凭据最小范围及新的隔离模型，再调整策略并更新对应安全测试。该限制不能作为真实登录失败或成功的证据。
