/**
 * pi 适配器（badlogic/pi-mono）：~/.pi/agent/sessions/<路径转义>/时间戳_uuid.jsonl
 * 事件流格式：type=session 给 cwd；type=message 的 message.content[] 是文本块。
 * 标题取首条用户消息前 40 字（发现期限量读首 64KB，不整文件解析）。
 * 移植自 dsh-hippo src/agents/pi.ts；root 可用 HANDOFF_ROOT_PI 覆盖（测试用）。
 */
import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { makeTurn, type Turn } from './transcript.js'
import type { SessionAdapter, SessionRef } from './types.js'

const ROOT = process.env['HANDOFF_ROOT_PI'] ?? join(homedir(), '.pi', 'agent', 'sessions')

interface PiEvent { type?: string; cwd?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } }

/** 限量读文件头（标题/cwd 用，避免发现期整读大会话）。 */
function readHead(path: string, bytes = 65536): string {
  try {
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(bytes)
      const n = readSync(fd, buf, 0, bytes, 0)
      return buf.toString('utf8', 0, n)
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

function cwdOf(headText: string): string {
  for (const raw of headText.split('\n')) {
    if (raw.trim() === '') continue
    try {
      const ev = JSON.parse(raw) as PiEvent
      if (ev.type === 'session' && typeof ev.cwd === 'string') return ev.cwd
    } catch {
      continue
    }
  }
  return ''
}

function titleOf(headText: string): string {
  for (const raw of headText.split('\n')) {
    if (raw.trim() === '') continue
    try {
      const ev = JSON.parse(raw) as PiEvent
      if (ev.type === 'message' && ev.message?.role === 'user') {
        const text = (ev.message.content ?? []).map((c) => c.text ?? '').join(' ').trim()
        if (text) return text.slice(0, 40)
      }
    } catch {
      continue
    }
  }
  return ''
}

export function parsePiText(text: string): Turn[] {
  let cwd = ''
  const turns: Turn[] = []
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    let ev: PiEvent
    try {
      ev = JSON.parse(raw) as PiEvent
    } catch {
      continue
    }
    if (ev.type === 'session' && typeof ev.cwd === 'string') {
      cwd = ev.cwd
      continue
    }
    if (ev.type !== 'message' || !ev.message) continue
    const role = ev.message.role === 'user' ? 'user' : ev.message.role === 'assistant' ? 'assistant' : ''
    if (!role) continue
    const body = (ev.message.content ?? [])
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text as string)
      .join('\n')
    if (body) turns.push(makeTurn({ role, text: body, cwd }))
  }
  return turns
}

export const piAdapter: SessionAdapter = {
  name: 'pi',
  root: ROOT,
  supported: true,
  discover(): SessionRef[] {
    const out: SessionRef[] = []
    let dirs: string[] = []
    try {
      dirs = readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(ROOT, d.name))
    } catch {
      return out
    }
    for (const dir of dirs) {
      let files: string[] = []
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      } catch {
        continue
      }
      for (const f of files) {
        const file = join(dir, f)
        let mtime = 0, size = 0
        try {
          const st = statSync(file)
          mtime = st.mtimeMs
          size = st.size
        } catch {
          continue
        }
        const head = readHead(file)
        out.push({
          agent: this.name,
          id: file,
          title: titleOf(head) || basename(f, '.jsonl'),
          cwd: cwdOf(head),
          updatedAt: mtime,
          fingerprint: `${Math.round(mtime)}:${size}`,
          kind: 'file',
        })
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  },
  parse(id: string) {
    try {
      return parsePiText(readFileSync(id, 'utf8'))
    } catch {
      return []
    }
  },
}
