# 小鱼数据资产迁移清单

> 自动生成。字段名为实测结构，值一律不打印（cookie 类只列键名）。
> 生成时间：2026-11-04 ｜ 数据目录：`packages/companion/data/`

## 迁移优先级

### P0 必须原样迁移（丢了人格就断）
| 文件 | 体量 | 内容 |
|---|---|---|
| `people.json` | 184 人 / 163KB | 所有认识的人：昵称、称呼、事实、标签 |
| `relationships.json` | 101 人 / 17KB | 亲密度、互动计数、关系阶段 |
| `diary.jsonl` | 182 条 | 生活日记（抖音/B站/网页/学习） |
| `turns.jsonl` | 1400 条 | 完整对话历史 |
| `human-insights.json` | 12KB | 潜水学到的语言习惯（habits/slangs/goldenSamples） |
| `bili-knowledge.jsonl` | 194 条 | B站看过的视频知识 |
| `web-knowledge.jsonl` | 2 条 | 自己上网查明白的事 |
| `mood.json` | 10 天 | 每日心情曲线 |
| `self-portrait.json` / `.txt` | — | 自我形象 |
| `stickers/` | 944 文件 | 表情包库（含索引） |
| `group-chatter.jsonl` | 1529 条 | 群友对话样本（学习语感的原料） |

### P1 凭据，单独处理
| 文件 | 说明 |
|---|---|
| `douyin-cookies.json` | 62 条 cookie，含 sessionid。**不进 git**（已确认 data/ 在 .gitignore），迁移走加密通道或重新扫码 |
| `config.json` | API key、QQ 配置。同样不进 git |

### P2 可重建，迁不迁都行
`douyin-feed.json`、`douyin-daily.json`、`web-surfing-history.json`、`current-activity.json`、`session_moods.json` —— 都是运行态缓存/当日计数，Python 端跑起来会自己生成。

## 字段契约


## `bili-knowledge.jsonl`
- 大小：123 KB ｜ 条数：194
- 字段：`at`, `bvid`, `title`, `up`, `duration`, `summary`, `points`, `tags`
- 类型：at=str, bvid=str, title=str, up=str, duration=int, summary=str, points=list[5], tags=list[4]

## `current-activity.json`
- 大小：0 KB ｜ 类型：object
- 顶层字段（6）：`type`, `title`, `up`, `watched`, `duration`, `at`

## `diary.jsonl`
- 大小：61 KB ｜ 条数：182
- 字段：`category`, `activity`, `title`, `author`, `thought`, `liked`, `commented`, `followed`, `at`
- 类型：category=str, activity=str, title=str, author=str, thought=str, liked=bool, commented=bool, followed=bool, at=str

## `diary.jsonl.bak_015653`
- 大小：35712 B（非结构化）

## `douyin-cookies.json`
- 大小：18 KB ｜ 类型：list[62]
- 数组长度：62
- 元素字段：`name`, `value`, `domain`, `path`, `expires`, `httpOnly`, `secure`, `sameSite`
- 类型：name=str, value=str, domain=str, path=str, expires=float, httpOnly=bool, secure=bool, sameSite=str

## `douyin-daily.json`
- 大小：0 KB ｜ 类型：object
- 顶层字段（4）：`date`, `comments`, `likes`, `videos`

## `douyin-feed.json`
- 大小：13 KB ｜ 类型：list[28]
- 数组长度：28
- 元素字段：`title`, `author`, `duration`, `views`, `timeAgo`, `url`, `authorHref`, `raw`
- 类型：title=str, author=str, duration=str, views=str, timeAgo=str, url=str, authorHref=str, raw=str

## `group-chatter.jsonl`
- 大小：210 KB ｜ 条数：1529
- 字段：`t`, `group`, `userId`, `name`, `text`
- 类型：t=int, group=str, userId=str, name=str, text=str

## `human-insights.json`
- 大小：12 KB ｜ 类型：object
- 顶层字段（5）：`lastLearnedAt`, `habits`, `slangs`, `goldenSamples`, `recentThoughts`

## `mood.json`
- 大小：1 KB ｜ 类型：object
- 顶层字段（10）：`2026-10-26`, `2026-10-27`, `2026-10-28`, `2026-10-29`, `2026-10-30`, `2026-10-31`, `2026-11-01`, `2026-11-02`, `2026-11-03`, `2026-11-04`
- 嵌套对象：2026-10-26, 2026-10-27, 2026-10-28, 2026-10-29, 2026-10-30, 2026-10-31, 2026-11-01, 2026-11-02, 2026-11-03, 2026-11-04

## `people.json`
- 大小：163 KB ｜ 类型：object
- 顶层字段（184）：`123456`, `41375334`, `54226530`, `104593054`, `111222333`, `125881997`, `180656436`, `207655128`, `273886031`, `277163139`, `307282285`, `360736041`, `390966129`, `397596404`, `406706387`, `467272278`, `470911779`, `475705752`, `491606533`, `498518011`, `499261975`, `505382591`, `510672580`, `549824719`, `578021239`, `582137217`, `601519493`, `603482296`, `615988883`, `619201914`, `729374657`, `741393536`, `745365861`, `750811096`, `809039874`, `849201423`, `850416043`, `861613558`, `872215296`, `875200764`
- 嵌套对象：123456, 41375334, 54226530, 104593054, 111222333, 125881997, 180656436, 207655128, 273886031, 277163139

## `people.json.bak_bili_20261025_012251`
- 大小：24365 B（非结构化）

## `people.json.bak_purge_1793118371`
- 大小：25024 B（非结构化）

## `relationships.json`
- 大小：17 KB ｜ 类型：object
- 顶层字段（101）：`41375334`, `111222333`, `125881997`, `180656436`, `277163139`, `307282285`, `360736041`, `406706387`, `470911779`, `491606533`, `499261975`, `505382591`, `510672580`, `578021239`, `603482296`, `615988883`, `745365861`, `849201423`, `850416043`, `861613558`, `872215296`, `875200764`, `914785328`, `949846526`, `956636409`, `975863987`, `1006381634`, `1007205774`, `1036123339`, `1047259353`, `1061308930`, `1076916540`, `1178386722`, `1196706614`, `1229292008`, `1257598465`, `1292872143`, `1365296619`, `1366687998`, `1375805769`
- 嵌套对象：41375334, 111222333, 125881997, 180656436, 277163139, 307282285, 360736041, 406706387, 470911779, 491606533

## `self-portrait.json`
- 大小：0 KB ｜ 类型：object
- 顶层字段（3）：`version`, `desc`, `at`

## `self-portrait.txt`
- 大小：282 B（非结构化）

## `session_moods.json`
- 大小：0 KB ｜ 类型：object
- 顶层字段（2）：`group:839388538`, `private:bili:53374723`
- 嵌套对象：group:839388538, private:bili:53374723

## `stickers/`（目录）
- 文件数：944

## `turns.jsonl`
- 大小：432 KB ｜ 条数：1400
- 字段：`t`, `where`, `who`, `text`, `reply`
- 类型：t=int, where=str, who=str, text=str, reply=str

## `voice/`（目录）
- 文件数：0

## `web-knowledge.jsonl`
- 大小：1 KB ｜ 条数：2
- 字段：`topic`, `learned`, `why`, `at`
- 类型：topic=str, learned=list[3], why=str, at=int

## `web-surfing-history.json`
- 大小：43 KB ｜ 类型：list[100]
- 数组长度：100
- 元素字段：`topic`, `reason`, `time`, `details`, `mood`
- 类型：topic=str, reason=str, time=int, details=str, mood=str
