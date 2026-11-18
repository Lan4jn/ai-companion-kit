# memory-brain 来源与许可审计（候选仍关闭）

## 证据

- 本机 `/root/memory-brain` 没有 Git 元数据、顶层 LICENSE 或作者声明。`pyproject.toml` 声明 `memory-core` 版本 `0.2.1`。
- 公开仓库 [peterpoal134/memory-brain 历史提交 2f3b7d8b16c5024cbc2706ae674762738e9940d4](https://github.com/peterpoal134/memory-brain/tree/2f3b7d8b16c5024cbc2706ae674762738e9940d4/memory-core) 的 `memory-core/` 下，5 个顶层文件和 `memory_core/` 目录的 25 个源码/HTML/JSON 文件，共 30 个文件，Git blob SHA-1 与本机对应文件逐一一致，包括 `store.py`、`engine.py`、`server.py` 和 `pyproject.toml`。所选本机源码无上游缺项；上游另有 12 个文档、样例和测试文件不在本次比对集合中。这是很强的版本内容匹配证据，但不能证明文件下载链、权利人身份或该副本的获得方式。
- 该提交 [根 LICENSE](https://github.com/peterpoal134/memory-brain/blob/2f3b7d8b16c5024cbc2706ae674762738e9940d4/LICENSE) 标称源代码公开、非商业许可，要求修改版保留署名和许可，商业和企业生产使用需事先取得书面授权；同一提交的[根 README](https://github.com/peterpoal134/memory-brain/blob/2f3b7d8b16c5024cbc2706ae674762738e9940d4/README.md) 顶部重申非商业，但 License 小节又写 AGPL-3.0-or-later，提及 AstrBot 插件。两个声明的范围和适用关系不清，不应自行裁定。
- 仓库后续版本 GitHub 标识 AGPL-3.0，但不能反推历史 0.2.1 副本的授权，或确认全部贡献者同意重新授权。

## 决策与后续

继续关闭生产功能，不复制或分发该核心，不迁移生产记忆；向仓库作者取得书面澄清：上述精确提交中 `memory-core/` 的权利人、适用许可证、个人或商业部署及修改/再分发权限、第三方代码许可。核对许可后还须审查 numpy、Python 及其他依赖，且另行完成恢复/反回滚等安全评估。现有保存数据没有检查。

一个可能替代是 [astrbot_plugin_memory_beyond](https://github.com/AlanBacker/astrbot_plugin_memory_beyond/tree/d62e239dc813000aa852956da09d2ee4910a952e)，该提交 GitHub 元数据标明 MIT；这是独立项目，不是相同接口或经过审核的替代品。现有 worker 强依赖 `memory_core.store.Store`、`MemoryEngine` 和固定 SQLite 表、遗忘墓碑及事务；Memory Beyond 采用文件式档案，不能直接替换 engineRoot，尚未验证同等权限、去重、保留期及防复活语义。安全适配须新建后端、保留作用域和来源授权及同一事务的遗忘屏障，利用合成数据逐项测试并审计依赖；不能将其作为已经可用的替代或打开生产配置。
