/** 协议卡片类型（handoff: 1）。未知字段不丢：顶层进 extras，嵌套对象透传。 */

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

/** 任务快照：text + status 最小公分母（语义 4：迁快照不迁现场） */
export interface TaskSnapshot {
  text: string
  status: TaskStatus
  priority?: string
  [k: string]: unknown // 未知字段透传
}

/** 推送时刻的 git 快照（HISTORY_REPORTED，不是当下事实） */
export interface GitSnapshot {
  branch: string
  changed: string[]
  [k: string]: unknown
}

/** 来源：session 是指针不是原文（语义 2） */
export interface CardFrom {
  agent: string
  session: string
  title: string
  [k: string]: unknown
}

/** 六段正文 + 可选「建议加载」段 */
export interface CardSections {
  goal: string       // 目标
  files: string      // 涉及文件
  done: string       // 做到哪
  remaining: string  // 还差什么
  stopped: string    // 停在哪
  warnings: string   // 读者警告
  suggested?: string // 建议加载（可选）
}

export interface Card {
  handoff: number
  id: string
  from: CardFrom
  to: string
  project: string
  cwd: string
  pushed_at: string
  git: GitSnapshot
  tasks: TaskSnapshot[]
  sections: CardSections
  extras: Record<string, unknown> // 顶层未知字段（版本纪律：保留不报错）
}
