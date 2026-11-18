# 离线 batch journal 核查（候选、默认不接生产）

本工具仅支持 `batch-candidate-v1`，不支持旧版 journal；没有网络、自动重发或事件身份重建。操作前独立停止全部写者并防止它们重新启动，确认私有目录、可信祖先和密钥归属、备份及恢复预案。目录锁仅是协作锁；同 UID 或 root 可读取、修改或冒充操作者，CLI 的确认开关不是人工认证。密文不防回滚；不得把报告或快照令牌公开。锁残留、临时文件、鉴别失败时停止调查，工具不会清理锁或猜测状态。

### 锁诊断与人工恢复

Linux 上可运行 `node scripts/chat-durable-offline.mjs inspect-lock --directory /绝对路径`；无需密钥，不读取 journal，且不会删除任何文件。该命令检查可信祖先、目录和锁的权限、拒绝符号链接及非空锁目录，输出锁的设备号和 inode 并重查身份。成功只表示观测到一个空目录锁，**不证明来源、持有者已退出或者可以清除**；未知内容或检查异常则拒绝。旧锁没有 PID 或进程开始时间，无法区分活锁、崩溃遗留锁或 PID 复用，也无法可靠地用检查后删除避免竞争，因此不提供自动或确认式清锁命令。人工恢复前必须独立停掉并阻止所有相关写者和自动启动，核实目标目录、锁身份与备份；若无法证明安全，保留锁并升级调查。诊断输出不是清锁授权，整个操作期间仍需保持隔离。

```sh
node scripts/chat-durable-offline.mjs inspect --directory /absolute/private/journal --key /absolute/private/key
node scripts/chat-durable-offline.mjs ack --directory /absolute/private/journal --key /absolute/private/key --id ID --snapshot SNAPSHOT --confirm-delivered
```

inspect 只输出随机条目 ID、类型、状态、逐段状态和基于密钥的快照，不输出会话、输入或分段内容。`confirmed-delivered` 表示此前由调用方或操作员记录的确认，并非独立投递证据；`unknown` 是已经尝试但结果不明；`not-attempted` 是尚未由此 journal 声称的分段。对 `whole-turn` 标记，一段代表整个 turn，不代表实际消息分段均已确认。输入为 accepted 时尚未形成 batch；其内容及来源必须在独立可信渠道核实。

仅在独立核实首条 unknown 的当前**完整分段**确实已完成后，才执行 ack；必须使用最新 inspect 的 ID 和快照。ack 是不可撤销的操作员断言：它不验证外部证据、不发送数据；最后一段确认会移除 batch，否则只推进一段到 ready。快照不匹配、非首条、非 unknown 一律拒绝。记录完成后不自动恢复或发送，未完成条目仍需保留和单独处理。未知/未送达不可通过本工具重发、跳过或删除；保持阻塞并人工调查。

现有 owner queue 拒绝任何非空 journal 启动，本工具不会绕过该限制；accepted 和 ready 条目的可信身份、执行与安全恢复仍未实现。上游身份、完整分段投递确认、授权审计和防回滚均未解决，不得开启生产集成。

## 安全恢复阻断的具体原因

- `accepted` 的 HMAC 只证明保存的字段来自此前特定解析器快照；该快照不证明上游端点或发送者已认证。重建的数据不具备 `isTrustedMemoryMessage` 能力，不可冒充实时消息调用现有 owner 回合。重启前执行结果或 journal 被回滚时，也不能证明工具尚未执行。
- `ready` 的签名覆盖输入而不覆盖输出分段及其生成过程。`form` 可接受任意分段；`createBoundOneBotDeliveryCandidate` 在校验输入和目标后仍可发送任意未绑定输出，故不能把该候选适配器当作恢复入口。`whole-turn` 只是标记，更不能作为回复发送。
- journal 加密和协作锁不能检测旧快照回滚；没有独立不可回滚的执行/投递凭证，`accepted` 或 `ready` 状态无法单凭自身证明过去没有外部副作用。任何不确定条目应保留，`unknown` 绝不重放。

恢复前需独立设计并审计：已认证来源及与账号/会话绑定的授权、不可回滚的效果前置声明、输出分段生成与授权的完整性绑定，以及工具执行和逐段投递的崩溃边界。缺任一项继续阻断；合成测试 `test/chat-durable-recovery-provenance-blocker.test.js` 记录现有候选边界，并不是授权或生产验收。
