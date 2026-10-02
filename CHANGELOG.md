# Changelog

> agent-handoff 是版本化开放协议 `handoff: 1` 的 SPEC + 参考实现仓。协议格式本身的演进以 [SPEC.md](./SPEC.md) 的版本纪律为准（字段只增不破，破坏性变更换 `handoff:` 版本值）；本文件记录仓库本体（packages/* 与文档）的变更。发版号跟随对应包（readers 当前 0.1.x）。

## [未发布] — 2026-10-03

### readers（@agent-handoff/readers）
- **假 0 哨兵**：codex / cursor / grok 三个文件布局适配器，存储根目录存在但 discover 为 0 时置 note「存储目录存在但未发现会话——上游可能已迁移存储布局（参考 opencode 1.18 迁 SQLite）」；有数据的家 note 保持空（cursor 有数据后恢复其 node:sqlite 静态说明）。opencode 已是 DB 双布局，哨兵只针对其 storage 旧版回退路径。根目录不存在（未安装）不触发——正常静默。新增 5 条哨兵单测（临时根 + `HANDOFF_ROOT_*` 覆盖 + query 串动态 import 取新鲜模块实例）

### 文档
- README（中英同步）：顶部新增 `handoff: 1` 协议声明（版本化开放协议）、采用登记节（采用者 issue 登记 + 采用列表占位）与 JarvanAI/agent-handoff 同名仓无关联的澄清
