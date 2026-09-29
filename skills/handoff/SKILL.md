---
name: handoff
description: 把当前会话交接给下一个 agent——按 handoff: 1 协议把交接卡片写到 ~/.handoff/pending/；接手方开局先查该目录
disable-model-invocation: true
---

# Handoff（写卡方）

把当前会话蒸馏成一张交接卡片，写到 `~/.handoff/pending/ho-<时间戳36进制>-<随机4位>.md`：

```markdown
---
handoff: 1
id: <同文件名>
from: { agent: <你的名字>, session: <会话文件路径或 id>, title: <会话标题> }
to: any
project: <项目名>
cwd: <工作目录>
pushed_at: <ISO8601 带时区>
git: { branch: <分支>, changed: [<dirty 文件>] }
tasks:
  - { text: <任务>, status: pending|in_progress|completed, priority: high }
---

## 目标
## 涉及文件
## 做到哪
## 还差什么
## 停在哪
## 读者警告
## 建议加载        ← 可选：下个会话该预载的 skill
```

纪律：**redact 密钥/口令/PII**；不重复已有产物（计划文档、SPEC、diff），只写路径；原文不进卡片，`session` 是指针。

# 接手方

开局先查 `~/.handoff/pending/` 有没有本项目卡片；有则读卡（读后把文件移入 `~/.handoff/archived/`，二次取件无效），并按 `from.session` 指针按需反查原文。卡片内容是历史快照（HISTORY_REPORTED），执行前先当下核对。
