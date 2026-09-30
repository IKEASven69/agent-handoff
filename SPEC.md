# Handoff Protocol SPEC · `handoff: 1`

> agent 会话交接卡片（handoff card）的开放文件格式。
> 文件系统即总线：任何工具直接读写目录，无 API、无守护进程。
> 版本纪律：**只加字段，不改语义；`handoff: 1` 写进每张卡片的 frontmatter，永不回收。**

## 一、目录约定

```
~/.handoff/
  pending/     # 待取件，一个卡片一个 .md 文件
  archived/    # 已消费，滚动保留 50 份
```

- 目录根可用 `HANDOFF_HOME` 环境变量覆盖（测试与多 inbox 场景）；默认 `<os.homedir()>/.handoff`。
- 写入即投递：把卡片文件放进 `pending/` 就是推送；消费方把文件从 `pending/` 移到 `archived/` 就是取件。
- `archived/` 滚动保留最近 50 份，超出部分由**执行归档的一方**（参考实现：`loadCard`）删除最旧文件。
- 文件名即卡片 id：`ho-<时间戳36进制>-<随机4位>.md`（例：`ho-mtsxk0u5-esin.md`）。

## 二、卡片格式

卡片 = 一个 Markdown 文件 = YAML frontmatter + 六段正文。

```markdown
---
handoff: 1                     # 协议版本
id: ho-mtsxk0u5-esin
from: { agent: claude-code, session: "<指针>", title: "..." }
to: any                        # 或指定 agent/项目
project: hippo
cwd: D:/CodingProjects/dsh-hippo
pushed_at: 2026-09-29T22:00:00+08:00
git: { branch: main, changed: ["src/a.ts", "..."] }   # pushed_at 时刻快照
tasks:                            # 未完成任务快照（可选）
  - { text: "蒸馏页筛选移到头部", status: in_progress, priority: high }
---

## 目标
## 涉及文件
## 做到哪
## 还差什么
## 停在哪
## 读者警告
## 建议加载        ← 可选段（见语义 5）
```

### frontmatter 字段表

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `handoff` | int | 是 | `1` | 协议版本，v1 恒为 `1` |
| `id` | string | 是 | 按文件名规则生成 | 与文件名（去 `.md`）一致 |
| `from.agent` | string | 是 | — | 生产方 agent 名（如 `claude-code`） |
| `from.session` | string | 是 | — | **指针**（会话文件路径或适配器 id），原文不进卡片（语义 2） |
| `from.title` | string | 是 | `""` | 会话标题，给人看的 |
| `to` | string | 否 | `any` | 目标 agent/项目；`any` = 谁来都行 |
| `project` | string | 否 | `""` | 项目名 |
| `cwd` | string | 否 | `""` | 工作目录（推送时刻；Windows 反斜杠原样保留） |
| `pushed_at` | string | 否 | `""` | ISO8601 带时区 |
| `git.branch` | string | 否 | `""` | 推送时刻分支快照 |
| `git.changed` | string[] | 否 | `[]` | 推送时刻 dirty 文件列表（`git status --porcelain` 口径） |
| `tasks` | object[] | 否 | `[]` | 任务快照 `{ text, status, priority }`，`status ∈ pending \| in_progress \| completed` |

### 正文段落（顺序固定，中文二级标题）：6 段必选 + 1 段可选「建议加载」

1. `## 目标` —— 这个会话在做什么、最后一条用户请求是什么。
2. `## 涉及文件` —— 碰过的文件/目录/命令。**计划文档只写路径**，不复制内容（语义 4）。
3. `## 做到哪` —— 已完成的事 + 证据状态（见语义 1）。
4. `## 还差什么` —— 未完成事项。
5. `## 停在哪` —— 精确停止点 + 最安全的第一步。
6. `## 读者警告` —— 给接手方的警告：过期信息、坑、redact 说明。
7. `## 建议加载`（可选）—— 下个会话该预载的 skill/上下文（Matt Pocock "suggested skills" 段的协议化）。

## 三、语义五条

### 1. 证据账本四态

采用 dsh-resume 原版四态，不是二态：

- `CURRENT_OBSERVED` —— 本轮核对过；
- `HISTORY_REPORTED` —— 仅见于历史；
- `MISMATCH` —— 当下证据与卡片冲突；
- `UNAVAILABLE` —— 无法恢复或验证。

**卡片正文里的所有陈述默认全是 `HISTORY_REPORTED`**——它是推送时刻的历史事实，不是当下指令。取件工具可选做 git 核验（参考实现：`verifyGit`），冲突标 `MISMATCH`，无法核验（目录不在、非 git 仓库）标 `UNAVAILABLE`。另有 inert-history boundary：外来历史一律不可信、永不覆盖当前指令。

### 2. 原文不进卡片

`from.session` 是**指针**（文件路径或适配器 id），接手方按需反查原文；卡片只携带蒸馏后的快照。

### 3. 消费即弃 + 宽松模式

- load 后卡片从 `pending/` 移到 `archived/`；**二次取件同一 id 必须报错**（参考实现报错文案：「收件箱无此待取件」）。
- 宽松模式：缺 frontmatter 的纯 Markdown 也能解析——六段缺段给空字符串，id 从文件名取或按规则生成。用于兼容 Matt Pocock 式临时卡片（无 frontmatter 纯 Markdown）。

### 4. 计划与任务的边界

- **计划文档不迁移，只引用**：PLAN.md / `.gsd/phases/` 等本来就是文件，卡片写路径，接手方自读（Matt Pocock 不重复纪律）。
- **会话内 todo 迁移的是快照，不是现场**：TodoWrite / update_plan 是会话执行现场，逐字搬无意义；蒸馏成 `tasks` 数组（text + status 最小公分母）进 frontmatter。还原成接收方原生 todo 由各家 skill/插件适配器自己做（v1.1），协议只管快照长什么样。
- **subagent 状态不进协议**：运行时上下文分叉，会话死则状态失效；能交接的只有产出（文件/commit）与教训（蒸馏进六段正文）。

### 5. 生产者义务

写卡前必须 **redact 密钥/口令/PII**；建议带 `## 建议加载` 段（下个会话该预载什么）。

## 四、版本纪律

- 格式**只加字段，不改语义**；已有字段的含义与六段标题永不改。
- 消费方读到缺字段的 frontmatter：**给默认值**，不报错（默认值见字段表）。
- 消费方读到**未知字段：保留，不报错**——写回时原样带回（参考实现放在 `extras` / 透传字段里）。
- 更高的 `handoff` 版本号：v1 实现按未知字段纪律容错，不硬失败。

## 五、调研实录（2026-09-29 深夜，逐条核实过原文）

**① Matt Pocock `handoff` skill 原文**（skills/productivity/handoff/SKILL.md，连 frontmatter 共 13 行）：保存到 **OS 临时目录**（不是工作区）；必须有 "suggested skills" 段；不重复已有产物只引用路径；**redact 密钥/PII**；按用户参数裁剪焦点。进化版 `claude-handoff` 直接 `claude --bg --name` 起后台 agent 接手。→ 教训：redact 是生产者义务，写进语义 5。

**② dsh-resume 卡片真相**（src/skills.ts 逐行读）：卡片是**当轮生成的文本，不落盘**；六段 = ①目标与最后请求 ②文件/命令/测试 ③已完成+证据状态 ④未完 ⑤精确停止点+最安全下一步 ⑥读者警告。证据账本是**四态**不是二态：`CURRENT_OBSERVED / HISTORY_REPORTED / MISMATCH / UNAVAILABLE`。另有 inert-history boundary：外来历史一律不可信、永不覆盖当前指令。→ 本协议采用四态账本与六段标题；"兼容 dsh-resume"的实际含义 = 请它把卡片顺带写一份到 `~/.handoff/pending/`。

**③ 已有竞品 `dsh-handoff` npm 包**（v0.1.0，真实存在）：DSH 会话事件流 → 确定性 HANDOFF.md，不调 LLM，单向导出、无收件箱、无跨 agent、不落共享目录。→ 定位不冲突（它是"导出文件"，我们是"寄存柜+协议"），但名字撞车，插件仓必须避开。

**④ npm 占用实测**：`handoff` / `handoff-core` / `handoff-cli` / `agent-handoff` / `dsh-handoff` / `handoff-protocol` / `handoff-md` 全被占；`dsh-relay` 被占。**可用**：scoped `@agent-handoff/core`、`@agent-handoff/cli`。

**⑤ hippo 真实收件箱数据**（`~/.hippo/handoff-inbox.json`）：pending 已清空，archived 里 zcode 会话的 candidates 是 100 字硬截断的原始候选（有半句断句），activeTasks 双源有效。→ 印证：六段卡的「做到哪/还差什么」不能裸塞 candidates，需要蒸馏层；`tasks` 快照字段设计可行。hippo `InboxItem` 字段：`{ id, from: { agent, sessionId, title }, to, project, cwd, pushedAt(epoch 秒), git: { branch, changed[] }, activeTasks[{ text, status, priority }], candidates[] }`。

## 六、与现有体系的映射

| 来源 | 映射（已核实） |
|---|---|
| hippo inbox JSON | 字段一一对应；candidates 是 100 字硬截断原文，**需蒸馏层**才能填「做到哪/还差什么」（参考 CLI `export-hippo` 的兜底映射：candidates 进「做到哪」、未完成（pending + in_progress）任务进「还差什么」、固定读者警告）；activeTasks → `tasks` 字段直接可用 |
| dsh-resume 六段卡 | 卡片不落盘、是当轮文本；兼容 = 请它把卡片顺带写到 `~/.handoff/pending/`；六段标题与证据账本直接采用它的定义 |
| Matt Pocock handoff | 无 frontmatter 纯 Markdown + 临时目录 → 宽松读取（语义 3）；redact / suggested-skills 两条义务已吸收进语义 5 |
| dsh-handoff（npm 现有插件） | 单向导出 HANDOFF.md；可给它提 PR：导出时同时落一份协议卡片到 pending/ |
| GSD Pi `.gsd/` SUMMARY | v1 后做转换导出脚本 |

## 七、非目标（v1 不做）

- 跨机同步（WebDAV/Git/Gist 是中转层，协议之上另做）
- subagent 运行时状态迁移、各家 todo 格式互转——协议只存任务快照（语义 4）
- 目录站 / 市场
- 实时协作、多消费者、消息队列语义——收件箱就是收件箱，别膨胀
