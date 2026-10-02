# agent-handoff

agent 会话交接卡片（handoff card）的**开放文件格式** + 零依赖参考实现。
文件系统即总线：卡片落在 `~/.handoff/` 纯文件目录，任何工具直接读写，无 API、无守护进程。

> **协议声明 · handoff: 1**
> `handoff: 1` 是**版本化开放协议**——卡片 frontmatter 首行的 `handoff: 1` 就是协议版本号，
> 本仓是其 SPEC（[SPEC.md](./SPEC.md)）与零依赖参考实现。格式与语义任何人可用、可实现；
> 演进纪律见 SPEC 版本节（字段只增不破，破坏性变更换 `handoff:` 版本值）。
> **采用登记**：采用本协议的项目请到 [Issues](https://github.com/IKEASven69/agent-handoff/issues)
> 登记一下（项目名 + 链接即可，不作审批），我们在下方采用列表里挂名。
>
> **澄清**：GitHub 上的 [JarvanAI/agent-handoff](https://github.com/JarvanAI/agent-handoff)
> 与本仓同名但**无任何关联**——它不是本协议的实现，也未参与本仓的格式与语义设计。
> 判别特征：本协议的卡片是 `handoff: 1` frontmatter + 六段正文 + `~/.handoff/` 目录语义，
> 参考实现为本仓 `packages/*`。

## 采用列表

_（暂无登记。采用了 `handoff: 1` 的项目请开 issue 登记，按登记时间排序。）_

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

## 恢复边界纪律

本仓库的适配器均为自研 TypeScript 实现，对外来会话一律只读、不复活进程、不回放调用：
grok 只读可见的 `updates.jsonl` 流、永不读 `chat_history.jsonl` 原始模型上下文；
cursor 只导入支持的 transcript / store 记录、永不回放存储的调用；
系统提示、隐藏推理、加密或损坏记录一律丢弃或标明不可用。

## 开发

```bash
pnpm install && pnpm -r build && pnpm -r test
```

许可证：MIT。
