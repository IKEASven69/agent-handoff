/**
 * opencode 适配器：三层文件存储。
 * session/<projectID>/ses_*.json（directory/title）→ message/<ses>/msg_*.json（role/time）
 * → part/<msg>/prt_*.json（text/tool，state.status=error 是失败信号）。
 * 移植自 dsh-hippo src/agents/opencode.ts；root 可用 HANDOFF_ROOT_OPENCODE 覆盖（测试用）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { makeTurn, type Turn } from './transcript.js'
import type { SessionAdapter, SessionRef } from './types.js'

const ROOT = process.env['HANDOFF_ROOT_OPENCODE'] ?? join(homedir(), '.local', 'share', 'opencode', 'storage')

function parseJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

interface OpenCodeSession { id?: string; directory?: string; title?: string; time?: { created?: number; updated?: number } }
interface OpenCodeMessage { id?: string; role?: string; time?: { created?: number } }
interface OpenCodePart { type?: string; text?: string; tool?: string; state?: { status?: string } }

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

export const opencodeAdapter: SessionAdapter = {
  name: 'opencode',
  root: ROOT,
  supported: true,
  discover(): SessionRef[] {
    const out: SessionRef[] = []
    const sessionRoot = join(ROOT, 'session')
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
  parse(id: string) {
    return parseOpenCodeSession(id, ROOT)
  },
}
