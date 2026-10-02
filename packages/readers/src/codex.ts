/**
 * Codex 适配器：~/.codex/sessions 下递归的 rollout-*.jsonl。
 * session_meta 给 cwd；response_item 是权威消息流（event_msg 为 UI 事件，跳过避免重复）。
 * 移植自 dsh-hippo src/agents/codex.ts；root 可用 HANDOFF_ROOT_CODEX 覆盖（测试用）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { makeTurn, type Turn } from './transcript.js'
import { FAKE_ZERO_NOTE, type SessionAdapter, type SessionRef } from './types.js'

const ROOT = process.env['HANDOFF_ROOT_CODEX'] ?? join(homedir(), '.codex', 'sessions')

function* walkJsonl(dir: string): Generator<string> {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walkJsonl(p)
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p
  }
}

interface CodexLine { timestamp?: string; type?: string; payload?: Record<string, unknown> }

export function parseCodexText(text: string): Turn[] {
  let cwd = ''
  const turns: Turn[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    let obj: CodexLine
    try {
      obj = JSON.parse(line) as CodexLine
    } catch {
      continue
    }
    const ts = obj.timestamp ?? ''
    if (obj.type === 'session_meta') {
      cwd = typeof obj.payload?.cwd === 'string' ? (obj.payload.cwd as string) : ''
      continue
    }
    if (obj.type !== 'response_item' || obj.payload === undefined) continue
    const p = obj.payload
    if (p.type === 'message') {
      const role = p.role === 'user' ? 'user' : p.role === 'assistant' ? 'assistant' : ''
      if (!role) continue // system/developer 基线提示是噪声
      const content = Array.isArray(p.content) ? p.content : []
      const body = content
        .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
        .filter(Boolean)
        .join('\n')
      if (body) turns.push(makeTurn({ role, text: body, cwd, ts, model: typeof p.model === 'string' ? p.model : '' }))
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      const name = typeof p.name === 'string' ? p.name : String(p.type)
      turns.push(makeTurn({ role: 'tool', text: name, cwd, ts, toolName: name }))
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '')
      turns.push(makeTurn({ role: 'tool', text: out.slice(0, 2000), cwd, ts, toolFailed: /\berror\b/i.test(out.slice(0, 400)) }))
    }
  }
  return turns
}

export const codexAdapter: SessionAdapter = {
  name: 'codex',
  root: ROOT,
  supported: true,
  discover(): SessionRef[] {
    const out: SessionRef[] = []
    for (const file of walkJsonl(ROOT)) {
      let mtime = 0, size = 0
      try {
        const st = statSync(file)
        mtime = st.mtimeMs
        size = st.size
      } catch {
        continue
      }
      out.push({
        agent: this.name,
        id: file,
        title: basename(file, '.jsonl'),
        cwd: '',
        updatedAt: mtime,
        fingerprint: `${Math.round(mtime)}:${size}`,
        kind: 'file',
      })
    }
    // 假 0 哨兵：根目录在但一个会话都没有——布局可能已迁移（有数据的家 note 保持空）
    this.note = out.length === 0 && existsSync(ROOT) ? FAKE_ZERO_NOTE : undefined
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  },
  parse(id: string) {
    try {
      return parseCodexText(readFileSync(id, 'utf8'))
    } catch {
      return []
    }
  },
}
