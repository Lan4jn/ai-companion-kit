# memory-core（vendored）

这个目录是 [peterpoal134/memory-brain](https://github.com/peterpoal134/memory-brain) 里 `memory-core/` 的原样拷贝，**不是我们写的**。

## 为什么放在仓库里

小鱼的长期记忆靠它（`src/memory-brain.js` 调它的 `/recall`）。之前是从 `/root/memory-brain` 临时跑的，版本不受控、换机器就丢。放进来之后跟着仓库一起走。

## 协议

上游是 **AGPL-3.0-or-later**（README 原文），仓库根目录的 LICENSE 文件写的是"源代码公开许可（非商业）"。无论按哪个算，它都**不是 MIT**——本目录的 `LICENSE` 是上游原文件，不受根目录 MIT 影响。

改动这个目录的文件就等于改动 AGPL 代码。只调用它的 HTTP 接口不受影响。

## 和上游的差异

只做了两件事，没改一行 Python：

1. 去掉了 `data/`（数据库，本地生成，在 .gitignore 里）
2. 去掉了 `__pycache__/`、`.venv/`

代码本身跟上游完全一致。

## 怎么跑

```bash
# 依赖
/usr/bin/python3 -m pip install numpy

# 手动跑
cd packages/memory-core
MEMORY_DB=$PWD/data/brain.db \
MEMORY_TOKEN=<token> \
MEMORY_PORT=8780 \
/usr/bin/python3 -m memory_core.server
```

生产用 systemd（`/etc/systemd/system/memory-core.service`）：

```
WorkingDirectory=/root/ai-companion-xiaoyu/ai-companion-kit/packages/memory-core
Environment=MEMORY_DB=/root/ai-companion-xiaoyu/ai-companion-kit/packages/memory-core/data/brain.db
Environment=MEMORY_TOKEN=<token>
```

## 怎么升级

上游更新时整目录覆盖，别手工改这个目录里的文件，否则下次同步会被冲掉：

```bash
git clone --depth 1 https://github.com/peterpoal134/memory-brain.git /tmp/mb
rsync -a --exclude 'data/' --exclude '__pycache__/' /tmp/mb/memory-core/ packages/memory-core/
git diff --stat packages/memory-core    # 确认只有预期变化
```

## 我们用到哪些部分

| 用 | 不用 |
|---|---|
| `POST /recall`（拼进 system） | `plugins/` 四个 AstrBot 插件 |
| `POST /remember`（手动导入历史） | `life/` 生活层 |
| `GET /health`、`/stats` | `/v1/chat/completions`（OpenAI 兼容入口） |
| `memory_core/engine.py` 的检索逻辑 | `dsh/`、`tools/`、`eval/` |

它的检索是「关键词 FTS + 图谱 + 重要性 + 新鲜度」混合；**没配 `MEMORY_EMBED_URL` 时不走向量**，中文近义匹配因此较弱（搜"摩托"找不到"853R"）。要提升得接 Ollama bge-m3。
