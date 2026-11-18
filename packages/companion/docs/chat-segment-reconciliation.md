# 持久聊天逐段离线对账

仅在持久聊天进程已停止、独占日志且终端安全的情况下操作。工具不会连接网络或发送消息。持有日志和密钥的本机用户是可信操作者；密钥应保持私密。`inspect-segments` 会在终端显示私聊回复正文，不要将输出写入共享日志。

1. `node scripts/chat-durable-offline.mjs inspect --directory /绝对路径 --key /密钥绝对路径` 找到条目 id。
2. `node scripts/chat-durable-offline.mjs inspect-segments --directory /绝对路径 --key /密钥绝对路径 --id 条目ID --owner 主人QQ` 校验签名及会话范围，查看正文、索引和状态。`confirmed-delivered` 表示传输确认或人工确认，不是由日志独立证明对方已阅读；`unknown` 须用独立证据核实，不能推断。
3. 仅在独立核实当前 unknown 段确已发送后，执行 `node scripts/chat-durable-offline.mjs reconcile --directory /绝对路径 --key /密钥绝对路径 --id 条目ID --owner 主人QQ --snapshot 上一步快照 --decision delivered --authorize-resume`。unknown 段不允许以 not-delivered 重试；不能确认已发送则保持阻断。授权会允许后续启动时发送尚未尝试的后续段。快照过期需重新检查，别绕过锁或修补签名。

最后一段确认已发时保留待写历史凭据，不重发该段。启用主入口时仍须满足独立的历史遗忘屏障及已认证发送条件；缺少条件时拒绝启动，不能为强行恢复而禁用屏障。启动时只恢复有有效授权的 ready 分段或已确认的 history-pending；它们之后排队的启动前 accepted 输入仍会阻断，不自动生成或发送。密文日志无法检测整体回滚，操作前仍须独立核实外部效果并保护密钥。
