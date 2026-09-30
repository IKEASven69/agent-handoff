/**
 * 会话适配器统一类型（移植自 dsh-hippo src/agents/types.ts）：
 * 所有 agent 的会话统一为 SessionRef（发现层）+ Turn 流（解析层）。
 * 读取纪律：只读、不复活进程、不回放调用；损坏/加密记录跳过或标不可用。
 */
import type { Turn } from './transcript.js'

/** 一个已发现的会话（发现层产物，轻量：不含内容）。 */
export interface SessionRef {
  /** 归属适配器名：claude-code | codex | opencode | zcode | pi | workbuddy */
  agent: string
  /** 稳定 id：文件系=绝对路径；SQLite 系=会话 id。 */
  id: string
  title: string
  cwd: string
  /** 最近更新时间（ms epoch），排序用。 */
  updatedAt: number
  /** 增量指纹：文件系="mtime:size"；SQLite 系=String(time_updated)。 */
  fingerprint: string
  kind: 'file' | 'sqlite'
}

/** 一个 agent 的会话发现结果（inventory）。 */
export interface AgentInventory {
  agent: string
  root: string
  sessions: number
  supported: boolean
  note?: string
}

/** 会话适配器：发现 + 解析两段。 */
export interface SessionAdapter {
  readonly name: string
  readonly root: string
  readonly supported: boolean
  note?: string
  /** 发现本机全部会话（轻量，不读内容主体；zcode 只查 session 表元数据）。 */
  discover(): SessionRef[]
  /** 解析一个会话为 Turn 流。id 必须来自 discover()。 */
  parse(id: string): Turn[]
}
