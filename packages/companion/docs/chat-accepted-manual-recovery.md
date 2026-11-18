# 旧 accepted 消息的逐条人工恢复

此路径仅适用于主持久聊天的 owner 私聊。必须先独立停掉全部 journal 写入者，使用私有终端和受保护的密钥及目录；不得删除不明锁。每次只审核该会话队首一条，命令在 packages/companion 下执行。`inspect-input` 会显示私密消息，避免记录或共享其输出。

1. `node scripts/chat-durable-offline.mjs inspect --directory /绝对目录 --key /绝对密钥`，取得队首 ID。
2. `node scripts/chat-durable-offline.mjs inspect-input --directory /绝对目录 --key /绝对密钥 --id 条目ID --owner 主人QQ`。该命令验证保存字段的签名、会话和 owner，输出消息及快照；这**不证明**上游服务身份、历史配置或 journal 未回滚。
3. 独立核对接收时 OneBot 服务与发送者身份可信，并通过独立不可回滚的记录确认该消息确实从未发起生成（包括工具及其他外部副作用）；任一无法确认则停止，不授权。确认后运行 `node scripts/chat-durable-offline.mjs approve-input --directory /绝对目录 --key /绝对密钥 --id 条目ID --owner 主人QQ --snapshot 上一步快照 --confirm-not-generated --confirm-trusted-ingress`。
4. 在满足既有主入口的认证发送、记忆遗忘屏障和人工启动条件后，下一次正常启动只对该条发起一次生成：先持久写入 generation-unknown；生成异常、进程中断或结果不明时保持阻断，绝不重试。成功得到 ready 后也暂停，不自动发送。
5. 再次停止写入者，使用 `inspect` 找到新 batch ID，`node scripts/chat-durable-offline.mjs inspect-segments --directory /绝对目录 --key /绝对密钥 --id 新batchID --owner 主人QQ` 查看生成文本及快照。确认可发送且独立核实未发生过发送后，执行 `node scripts/chat-durable-offline.mjs approve-ready --directory /绝对目录 --key /绝对密钥 --id 新batchID --owner 主人QQ --snapshot 上一步快照 --confirm-send`，下次正常启动才允许发送。发送结果 unknown 不自动重试；不可把不确定误判为未发送。

工具仅离线记录授权，不发送、不伪造事件。完整 journal 回滚不可检测；密钥持有者和同 UID 代码必须可信。以上步骤不是实际启动或操作生产的授权。
