/**
 * opencode 适配器：双布局自动探测。
 * - 新版：~/.local/share/opencode/opencode.db（SQLite）——session / message / part 三表，
 *   message.data 与 part.data 均为 JSON 文本（role / type: text | tool）。
 * - 旧版：storage/ 三层文件布局——session/<projectID>/ses_*.json → message/<ses>/msg_*.json
 *   → part/<msg>/prt_*.json。
 * opencode.db 存在即优先走 DB（node:sqlite 只读打开，不拿写锁）；node:sqlite 不可用或
 * DB 不存在时回退旧版文件布局；两者皆缺返回空列表。
 * 移植自 dsh-hippo src/agents/opencode.ts；root 可用 HANDOFF_ROOT_OPENCODE 覆盖
 * （指向包含 opencode.db 或 storage/ 的目录，测试用）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { makeTurn, type Turn } from './transcript.js'
import type { SessionAdapter, SessionRef } from './types.js'

const BASE = process.env['HANDOFF_ROOT_OPENCODE'] ?? join(homedir(), '.local', 'share', 'opencode')
const DB_PATH = join(BASE, 'opencode.db')
const LEGACY_ROOT = join(BASE, 'storage')

interface RoDatabase {
  prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] }
  close: () => void
}

/** node:sqlite 可用性：createRequire 同步加载内建模块，失败即回退文件布局（不拖垮其他适配器）。 */
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

function openDb(dbPath: string = DB_PATH): RoDatabase | null {
  if (DatabaseSync === null || !existsSync(dbPath)) return null
  try {
    return new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    return null
  }
}

function parseJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

function safeJson<T>(text: unknown): T | null {
  try {
    return JSON.parse(String(text)) as T
  } catch {
    return null
  }
}

interface OpenCodeSession { id?: string; directory?: string; title?: string; time?: { created?: number; updated?: number } }
interface OpenCodeMessage { id?: string; role?: string; time?: { created?: number } }
interface OpenCodePart { type?: string; text?: string; tool?: string; state?: { status?: string } }

/** 旧版文件布局：一个 ses_*.json 会话文件 → Turn 流 */
export function parseOpenCodeSession(sessionFile: string, storageRoot: string): Turn[] {
  const session = parseJsonFile<OpenCodeSession>(sessionFile)
  if (!session?.id) return []
  const cwd = session.directory ?? ''
  const msgDir = join(storageRoot, 'message', session.id)
  let msgFiles: string[]
  try {
    msgFiles = readdirSync(msgDir).filter((f) => f.endsWith('.json')).map((f) => join(msgDir, f))
  } catch {
    return []
  }
  const msgs = msgFiles
    .map((f) => parseJsonFile<OpenCodeMessage>(f))
    .filter((m): m is OpenCodeMessage => m !== null && (m.role === 'user' || m.role === 'assistant') && typeof m.id === 'string')
    .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
  const turns: Turn[] = []
  for (const m of msgs) {
    const partDir = join(storageRoot, 'part', m.id as string)
    let partFiles: string[]
    try {
      partFiles = readdirSync(partDir).filter((f) => f.endsWith('.json')).map((f) => join(partDir, f))
    } catch {
      partFiles = []
    }
    const parts = partFiles.map((f) => parseJsonFile<OpenCodePart>(f)).filter((p): p is OpenCodePart => p !== null)
    const body = parts.filter((p) => p.type === 'text' && p.text).map((p) => p.text as string).join('\n')
    const ts = m.time?.created ? new Date(m.time.created).toISOString() : ''
    if (body) {
      turns.push(makeTurn({ role: m.role === 'user' ? 'user' : 'assistant', text: body, cwd, ts }))
    }
    for (const p of parts) {
      if (p.type !== 'tool') continue
      turns.push(makeTurn({
        role: 'tool',
        text: (p.text ?? '').slice(0, 2000),
        cwd,
        ts,
        toolName: p.tool ?? '',
        toolFailed: p.state?.status === 'error',
      }))
    }
  }
  return turns
}

/** DB 模式：按 session id 读 opencode.db。dbPath 可注入（单测用临时库）。 */
export function parseOpenCodeDbSession(sessionId: string, dbPath: string = DB_PATH): Turn[] {
  const db = openDb(dbPath)
  if (db === null) return []
  try {
    const ses = db.prepare('SELECT directory FROM session WHERE id = ?').all(sessionId)[0] as { directory?: string } | undefined
    const cwd = ses?.directory ?? ''
    const messages = db.prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(sessionId) as Array<{ id: string; data: string }>
    const turns: Turn[] = []
    for (const m of messages) {
      const meta = safeJson<{ role?: string; time?: { created?: number } }>(m.data)
      if (!meta || (meta.role !== 'user' && meta.role !== 'assistant')) continue
      const ts = meta.time?.created ? new Date(meta.time.created).toISOString() : ''
      const parts = db.prepare('SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id').all(m.id) as Array<{ data: string }>
      const texts: string[] = []
      for (const row of parts) {
        const part = safeJson<{ type?: string; text?: string; tool?: string; state?: { status?: string } }>(row.data)
        if (!part) continue
        if (part.type === 'text' && part.text) {
          texts.push(part.text)
          continue
        }
        if (part.type === 'tool') {
          turns.push(makeTurn({
            role: 'tool',
            text: (part.text ?? '').slice(0, 2000),
            cwd,
            ts,
            toolName: part.tool ?? '',
            toolFailed: part.state?.status === 'error',
          }))
        }
      }
      const body = texts.join('\n')
      if (body) turns.push(makeTurn({ role: meta.role === 'user' ? 'user' : 'assistant', text: body, cwd, ts }))
    }
    return turns
  } finally {
    db.close()
  }
}

export const opencodeAdapter: SessionAdapter = {
  name: 'opencode',
  root: BASE,
  supported: true,
  note: DatabaseSync === null && existsSync(DB_PATH) ? '需要 Node ≥22（node:sqlite）读取新版 opencode.db' : undefined,
  discover(): SessionRef[] {
    const out: SessionRef[] = []
    const db = openDb()
    if (db !== null) {
      try {
        const rows = db.prepare('SELECT id, title, directory, time_updated FROM session ORDER BY time_updated DESC').all() as Array<{ id: string; title: string | null; directory: string | null; time_updated: number | null }>
        for (const r of rows) {
          out.push({
            agent: this.name,
            id: String(r.id),
            title: r.title ?? '',
            cwd: r.directory ?? '',
            updatedAt: Number(r.time_updated ?? 0),
            fingerprint: String(r.time_updated ?? 0),
            kind: 'sqlite',
          })
        }
        return out
      } finally {
        db.close()
      }
    }
    // 旧版三层文件布局回退
    const sessionRoot = join(LEGACY_ROOT, 'session')
    let projects: string[] = []
    try {
      projects = readdirSync(sessionRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(sessionRoot, d.name))
    } catch {
      return out
    }
    for (const projDir of projects) {
      let names: string[] = []
      try {
        names = readdirSync(projDir)
      } catch {
        continue
      }
      for (const f of names) {
        if (!f.endsWith('.json')) continue
        const file = join(projDir, f)
        const meta = parseJsonFile<OpenCodeSession>(file)
        let mtime = 0
        try {
          mtime = statSync(file).mtimeMs
        } catch {
          continue
        }
        out.push({
          agent: this.name,
          id: file,
          title: meta?.title ?? basename(f, '.json'),
          cwd: meta?.directory ?? '',
          updatedAt: meta?.time?.updated ?? mtime,
          fingerprint: `${Math.round(mtime)}`,
          kind: 'file',
        })
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  },
  parse(id: string): Turn[] {
    if (id.endsWith('.json')) return parseOpenCodeSession(id, LEGACY_ROOT)
    return parseOpenCodeDbSession(id)
  },
}
