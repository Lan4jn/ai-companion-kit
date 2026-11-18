# 贴吧只读阅读核心（未接入线上）

`src/tieba-reader.js` 导出 `createTiebaReader(options)`；默认 `enabled: false`，不启动定时器、不访问网络、不提供任何发布、点赞或回复功能。现有 `brain.complete({system,prompt,json,max_tokens,temperature})` 可注入；不能把模型返回的文本当作指令或工具调用。

调用方需提供可信只读适配器：`source.list({forum})` 返回帖子候选 `[{url}]`，`source.read({url,forum})` 获取该帖子真实标题和正文并返回 `{url,forum,title,body}`，`forum` 固定为 `肥鱼避难所吧`。列表摘要不能代替帖子正文。适配器须自行确认页面属于指定吧与指定帖子，拒绝登录、验证码、错误页、跨帖跳转、不完整正文，并限制网络访问和重定向；核心校验 URL 和字段，但**无法证明调用者提供的数据真实**。当前没有实现或验证真实贴吧适配器，不应启用。

显式启用后可调用 `await reader.run()`，状态分别为 disabled、unavailable、source_failed、invalid_source、model_failed、save_failed、no_posts、completed。`read` 是适配器返回且结构校验通过的帖数，不代表人类式理解。模型选择 continue/skip/stop 和是否记录；关键词仅取原文子串。落盘为指定目录 `tieba-interest.jsonl`，附原文、URL 和采集时间；这些文本和后续召回仍是不可信外部数据，不能作为系统指令或自动发布。

`await reader.recall(query, {isOwner:true, channel:'private'})` 只对可信传输层确认为主人的私聊开放。此参数是调用方安全边界，禁止信任模型或用户自行提供的标志；不要将结果注入群聊、公开平台或其他人的私聊。召回接线时还必须将原文标记为不可信数据，并执行对应渠道的隐私策略。

超时只停止等待，不取消适配器或模型的底层操作；适配器必须自行设置网络取消、资源上限和并发控制。文件追加没有跨进程去重、事务或崩溃恢复保证；在设计调度器、并发和去重策略并测试前不要接入线上。启用前还需测试真实站点来源、错误页与提示注入、真实身份隔离和接线；仅 mock 测试不证明真实浏览。
