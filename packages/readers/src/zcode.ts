/**
 * zcode 适配器：~/.zcode/cli/db/db.sqlite 的 session/message/part 三层表。
 * 活库（当前会话在写）——一律 readonly 打开，随开随关。
 * part 类型：text（正文）/ reasoning（思考，映射为 assistant 轮）/ tool（state.status=error
 * 是失败信号）/ step-start（跳过）。
 *
 * 移植自 dsh-hippo src/agents/zcode.ts，依赖消除：better-sqlite3 → Node 内置
 * node:sqlite（DatabaseSync，Node ≥22 自带；不支持则 supported=false 优雅降级，
 * 不引入任何原生模块）。dbPath 可用 HANDOFF_ROOT_ZCODE 覆盖（测试用）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { makeTurn, type Turn } from './transcript.js'
import type { SessionAdapter, SessionRef } from './types.js'

const DB_PATH = process.env['HANDOFF_ROOT_ZCODE'] ?? join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')

interface ZSession { id: string; path: string | null; title: string | null; time_created: number; time_updated: number }
interface ZMessage { id: string; data: string }
interface ZPart { data: string }

interface RoDatabase {
  prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] }
  close: () => void
}

/** node:sqlite 可用性：createRequire 同步加载内建模块，失败即不支持（不拖垮其他适配器）。 */
function loadSqlite(): (new (path: string, opts?: { readOnly?: boolean }) => RoDatabase) | null {
  try {
    const req = createRequire(import.meta.url)
    const mod = req('node:sqlite') as { DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => RoDatabase }
    return mod.DatabaseSync
  } catch {
    return null
  }
}

const DatabaseSync = loadSqlite()

function openReadonly(dbPath: string = DB_PATH): RoDatabase | null {
  if (DatabaseSync === null || !existsSync(dbPath)) return null
  try {
    return new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    return null
  }
}

/** dbPath 可注入（单测用临时库），缺省真实 ~/.zcode/cli/db/db.sqlite。 */
export function parseZcodeSession(sessionId: string, dbPath: string = DB_PATH): Turn[] {
  const db = openReadonly(dbPath)
  if (db === null) return []
  try {
    const ses = db.prepare('SELECT id, path FROM session WHERE id = ?').all(sessionId)[0] as { id: string; path: string | null } | undefined
    const cwd = ses?.path ?? ''
    const messages = db.prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY sequence').all(sessionId) as unknown as ZMessage[]
    const turns: Turn[] = []
    for (const m of messages) {
      let role: 'user' | 'assistant' | null = null
      let created = 0
      try {
        const d = JSON.parse(m.data) as { role?: string; time?: { created?: number } }
        role = d.role === 'user' ? 'user' : d.role === 'assistant' ? 'assistant' : null
        created = d.time?.created ?? 0
      } catch {
        continue
      }
      if (role === null) continue
      const ts = created ? new Date(created).toISOString() : ''
      const parts = db.prepare('SELECT data FROM part WHERE message_id = ? ORDER BY sequence').all(m.id) as unknown as ZPart[]
      for (const p of parts) {
        let pd: { type?: string; text?: string; tool?: string; state?: { status?: string; input?: unknown; output?: unknown } }
        try {
          pd = JSON.parse(p.data) as typeof pd
        } catch {
          continue
        }
        if (pd.type === 'text' && pd.text) {
          turns.push(makeTurn({ role, text: pd.text, cwd, ts }))
        } else if (pd.type === 'reasoning' && pd.text) {
          // 思考流含大量决策信号（"我采用 X 因为 Y"），按 assistant 轮保留
          turns.push(makeTurn({ role: 'assistant', text: pd.text.slice(0, 4000), cwd, ts }))
        } else if (pd.type === 'tool') {
          const failed = pd.state?.status === 'error'
          const input = typeof pd.state?.input === 'object' && pd.state?.input !== null
            ? JSON.stringify(pd.state.input).slice(0, 300)
            : ''
          const output = typeof pd.state?.output === 'string' ? pd.state.output.slice(0, 2000) : ''
          turns.push(makeTurn({
            role: 'tool',
            text: (input + '\n' + output).trim(),
            cwd,
            ts,
            toolName: pd.tool ?? '',
            toolFailed: failed,
          }))
        }
      }
    }
    return turns
  } finally {
    db.close()
  }
}

export const zcodeAdapter: SessionAdapter = {
  name: 'zcode',
  root: DB_PATH,
  supported: DatabaseSync !== null,
  note: DatabaseSync === null ? '需要 Node ≥22（node:sqlite 内建模块）' : undefined,
  discover(): SessionRef[] {
    const db = openReadonly()
    if (db === null) return []
    try {
      const rows = db.prepare('SELECT id, path, title, time_created, time_updated FROM session').all() as unknown as ZSession[]
      return rows
        .map((r) => ({
          agent: this.name,
          id: r.id,
          title: r.title ?? r.id.slice(0, 18),
          cwd: r.path ?? '',
          updatedAt: r.time_updated ?? r.time_created ?? 0,
          fingerprint: String(r.time_updated ?? r.time_created ?? 0),
          kind: 'sqlite' as const,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    } catch {
      return []
    } finally {
      db.close()
    }
  },
  parse(id: string) {
    return parseZcodeSession(id)
  },
}
