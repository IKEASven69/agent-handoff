/**
 * @agent-handoff/readers：八家 agent 会话的只读读取层。
 * 移植自 dsh-hippo src/agents/，零三方运行时依赖（zcode / cursor store 用 Node 内建 node:sqlite）。
 * cursor / grok 两家为自研实现，格式调研参考 dsh-resume（Apache-2.0）。
 *
 * 公共 API：
 *   listSessions(agent?) → SessionRef[]   发现 + 按更新时间倒序
 *   readSession(agent, ref) → Turn[]      解析一个会话为 Turn 流
 *   resolveReference(agent, reference)    引用解析（歧义返回候选列表，不猜）
 */
import type { Turn } from './transcript.js'
import type { AgentInventory, SessionAdapter, SessionRef } from './types.js'
import { resolveReference, type ResolveResult } from './resolve.js'
import { claudeAdapter } from './claude.js'
import { codexAdapter } from './codex.js'
import { opencodeAdapter } from './opencode.js'
import { zcodeAdapter } from './zcode.js'
import { piAdapter } from './pi.js'
import { workbuddyAdapter } from './workbuddy.js'
import { cursorAdapter } from './cursor.js'
import { grokAdapter } from './grok.js'

export const AGENTS: SessionAdapter[] = [
  claudeAdapter,
  codexAdapter,
  opencodeAdapter,
  zcodeAdapter,
  piAdapter,
  workbuddyAdapter,
  cursorAdapter,
  grokAdapter,
]

const byName = new Map(AGENTS.map((a) => [a.name, a]))

/** 取适配器；未知名抛中文错（CLI 层转成用户可读信息）。 */
function adapterFor(agent: string): SessionAdapter {
  const a = byName.get(agent)
  if (a === undefined) {
    throw new Error(`未知 agent：${agent}（支持：${AGENTS.map((x) => x.name).join(' / ')}）`)
  }
  return a
}

/** 发现会话：给 agent 名只查该家；不给则查全部支持的家，单家失败不拖垮整体。 */
export function listSessions(agent?: string): SessionRef[] {
  if (agent !== undefined) {
    const a = adapterFor(agent)
    if (!a.supported) return []
    return a.discover().sort((x, y) => y.updatedAt - x.updatedAt)
  }
  const out: SessionRef[] = []
  for (const a of AGENTS) {
    if (!a.supported) continue
    try {
      out.push(...a.discover())
    } catch {
      // 单家失败不拖垮整体发现
    }
  }
  return out.sort((x, y) => y.updatedAt - x.updatedAt)
}

/** 解析一个会话为 Turn 流；ref 可以是 SessionRef 或适配器 id 字符串。 */
export function readSession(agent: string, ref: SessionRef | string): Turn[] {
  const a = adapterFor(agent)
  if (!a.supported) return []
  const id = typeof ref === 'string' ? ref : ref.id
  try {
    return a.parse(id)
  } catch {
    return []
  }
}

/** 引用解析：先发现该 agent 的会话，再按 id/路径/标题规则匹配。 */
export function resolveAgentReference(agent: string, reference: string): ResolveResult {
  return resolveReference(reference, listSessions(agent))
}

/** 各 agent 的 inventory（root / 会话数 / 支持情况）。 */
export function inventory(): AgentInventory[] {
  return AGENTS.map((a) => ({
    agent: a.name,
    root: a.root,
    sessions: a.supported ? a.discover().length : 0,
    supported: a.supported,
    note: a.note,
  }))
}

export type { Turn } from './transcript.js'
export { makeTurn, parseJsonl, entryToTurns, summarizeToolCall } from './transcript.js'
export type { SessionAdapter, SessionRef, AgentInventory } from './types.js'
export { resolveReference, type ResolveResult } from './resolve.js'
export { parseCodexText } from './codex.js'
export { parseOpenCodeSession } from './opencode.js'
export { parseZcodeSession } from './zcode.js'
export { parsePiText } from './pi.js'
export { parseCursorTranscriptText, parseCursorStore, renderCursorValue, decodeCursorBlob } from './cursor.js'
export { parseGrokSession, parseGrokUpdatesText } from './grok.js'
