# 离线记忆迁移：人工授权和停写前提

此工具只供已获授权的操作者在受控离线维护窗口中逐条迁移。**操作者必须独立停掉并保持停掉所有源、目标、其他后端及撤销标记写者，直至迁移进程和其子进程均结束，并对无法跨库证明的停写承担责任。** 如果无法确认这一前提，不得运行。扫描和锁不能证明跨主机、跨命名空间、文件标记或其他后端停写；这不是跨库原子操作，也不是自动安全保证。

先对私有目录执行只读诊断：

```sh
/usr/bin/python3 scripts/memory-offline-preflight.py /绝对/规范的私有目录
```

人工核对所有服务、计划任务、主机、挂载别名、共享存储和写者；报告始终 `authorizes_migration: false`，空报告只是瞬时可见结果。文件名可能敏感，应妥善保管。不得直接调用 worker 绕过人工入口。

准备目录直系私有证明 JSON，字段严格为 `scope`、`source`、`event`、`text`、`created_at`、`provenance`；内容须与源数据库唯一活动私有记录一致。证明不具备历史真实性的密码学证明力，操作者须独立核实原始来源和处理权限。

```sh
/usr/bin/python3 scripts/memory-offline-migrate.py /绝对/私有目录 /绝对/私有目录/proof.json 租户 数字用户 onebot-message:42 --retention-ms 86400000
```

必须在交互终端核查显示的内容、摘要及失效时间，手动输入动态 `CONFIRM` 令牌。不得用参数或布尔值替代人工授权。工具持有作用域进程锁、源 SQLite 写入保留锁，检查可见进程、锁、sidecar、撤销标记与文件摘要；worker 对源锁交接再检查，并在目标 SQLite 写事务中复核身份、撤销、tombstone 后插入。存在其他可见进程、检查不完整、锁竞争、状态不符或授权过期时拒绝。源锁交接存在间隙，摘要和可见检查不能发现所有转瞬即逝的撤销或外部写入；维护窗口不可省略。

审计库先持久记录 attempt；worker 消费后为 consumed，只有确认结果后才记为 inserted、duplicate 或 forgotten。崩溃或 worker 返回异常的结果为未知，禁止自动重试，须人工核对源、目标与审计记录。不得删除或回滚审计库以绕过该限制。仅在 reservation 前中断且确知无 attempt 时才可重新人工授权。

**信任边界：**运行用户的同 UID 进程可以改写代码、授权账本和目录、模拟终端输入或替换文件，因此不被视为对抗性隔离边界；测试中通过 PTY 自动输入确认仅用于合成夹具，不代表真人授权。目标打开前后比较 inode 可阻止已复现的检查后替换，但不是对恶意同 UID 进程原子绑定 SQLite 文件描述符的保证；同 UID 写者及目录替换仍必须在维护窗口内停止。源锁由父进程释放后子进程重新获取，不能证明交接间隙没有瞬时写入或遗忘，即便摘要复原也无法检测。

## 合成验证

在隔离工作区运行：

```sh
TMPDIR="$PWD/.test-tmp" PYTHONPATH="$PWD/test" /usr/bin/python3 -m unittest memory_offline_preflight_test memory_offline_migrate_test memory_offline_crash_test -v
```

测试使用合成记录、临时目录和独立进程；正向、遗忘竞争及崩溃注入均执行，不证明实际部署停写。
