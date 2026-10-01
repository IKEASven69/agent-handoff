# agent-handoff

agent 会话交接卡片（handoff card）的**开放文件格式** + 零依赖参考实现。
文件系统即总线：卡片落在 `~/.handoff/` 纯文件目录，任何工具直接读写，无 API、无守护进程。

## 目录约定

```
~/.handoff/
  pending/     # 待取件，一个卡片一个 .md 文件（可用 HANDOFF_HOME 覆盖根目录）
  archived/    # 已消费，滚动保留 50 份
```

卡片是 Markdown 文件：YAML frontmatter（来源指针、git 快照、任务快照）+ 六段正文
（目标 / 涉及文件 / 做到哪 / 还差什么 / 停在哪 / 读者警告）。消费即弃：取件后从
pending 移到 archived，二次取件报错。完整定义见 [SPEC.md](./SPEC.md)。

## 三个命令

```bash
handoff push --agent claude-code --session <会话指针> --title <标题> [--file 卡片正文.md]
handoff inbox                 # 列出 pending（id、来源、项目、推送时间、前两条任务）
handoff load <id>             # 消费即弃：打印卡片全文 + git 核验警告
handoff export-hippo          # 把 hippo 收件箱 JSON 导出成协议卡片（幂等）
```

## 仓库结构

```
SPEC.md                # 协议本体（格式 + 目录 + 语义五条 + 版本纪律）
packages/core/         # @agent-handoff/core：零依赖 TS 库，格式读写 + 目录语义 + git 核验
packages/readers/      # @agent-handoff/readers：八家 agent（claude-code / codex / opencode /
                       #   zcode / pi / workbuddy / cursor / grok）本地会话的只读发现与解析
packages/cli/          # @agent-handoff/cli：push / inbox / load / export-hippo / sessions / pull
skills/handoff/        # 10 行 SKILL.md：教 agent 按格式写卡、开局查收件箱
```

## 致谢

cursor / grok 两家读取器的存储格式调研参考了 [dsh-resume](https://github.com/aa2246740/dsh-resume)
（Apache-2.0；其 NOTICE 声明所含 session reader 逐字节来自 xAI Grok 1.0.5 的捆绑 skill）。
本仓库的适配器为自研 TypeScript 实现，只学格式、不复制代码。恢复边界纪律同样沿用：
grok 只读可见的 `updates.jsonl` 流、永不读 `chat_history.jsonl` 原始模型上下文；
cursor 只导入支持的 transcript / store 记录、永不回放存储的调用。

## 开发

```bash
pnpm install && pnpm -r build && pnpm -r test
```

许可证：MIT。
