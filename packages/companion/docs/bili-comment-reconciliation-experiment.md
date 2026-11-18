# B站评论人工对账：隔离实验

此实现未部署或使用真实账号测试。楼中楼直接 POST `/x/v2/reply/add` 时，仅在 HTTPS 响应成功且 `code=0`、`data.rpid_str`（或安全整数 `rpid`）与 `data.reply` 的 rpid、oid、mid、type、root、parent、原文全部一致时，才把关联预留记录哈希的回执持久化。字段结构参考 [Bilibili API 社区文档](https://github.com/BACNext/bilibili-API-collect-backup/blob/master/docs/comment/action.md)，并非平台签名；实际响应字段可能变化，缺失时继续 unknown。网页发评和历史 unknown 无此回执，继续封存。

人工明确选择账号、aid、root、候选 rpid 和隔离账本目录，调用 `reconcileComment({account,aid,root,rpid,ledgerDir})`；它匿名只读评论区并检查完整分页、唯一候选、UID、视频、root/parent、rpid、内容摘要、时间及 state=0。只有回执与原预留精确绑定且公开检查通过才追加 confirmed 文件；原 unknown 预留永不覆盖或移除，依旧阻止重复。多次对账可安全重复；读取不完整、回执缺失、审核中或 API 错误都保持 unknown，不自动重试发送。公开内容/时间相似不是因果证据；编辑器清空和 code=0 单独也不是。

账本目录必须为所有发送/对账进程共享且可靠的本地持久文件系统，支持硬链接原子创建与文件及目录 fsync。写回执及确认均先 fsync 临时文件，再无覆盖链接并 fsync 目录；崩溃遗留临时文件不构成证据。回执丢失后不可凭人工复制、模拟成功或改写账本补造。记录没有签名或平台远程证明；可信边界要求本地代码、传输和账本免受同 UID 进程、管理员及手动篡改；否则必须整体停止使用并人工调查。不得清理、回滚、迁移未保全的账本，亦不得将 testEndpoint 测试数据用于真实对账。人工判定未发出后的解除限制仍须停写、审计和人工授权，不由此接口实施。

匿名分页的完整性及真实响应形态未在真实账号验证；这不是上线许可。已有本地 fake 测试不证明平台行为；未取得合格回执时必须保持阻断。
