/**
 * Cursor 适配器（自研 TS 实现；格式调研参考 dsh-resume resources/session_reader.py，
 * Apache-2.0，其 NOTICE 声明该 reader 逐字节来自 xAI Grok 1.0.5 捆绑 skill——
 * 此处只学存储格式，不复制其代码）。
 *
 * 两种本地存储形态（root 可用 HANDOFF_ROOT_CURSOR 覆盖，测试用）：
 *
 * 1) transcript 文件：<root>/projects/<工作区目录>/agent-transcripts/<会话id>/<会话id>.jsonl
 *    逐行 JSON，每行是一个带 role 的 value（与 store blob 同构）。
 * 2) CLI chats：<root>/chats/<md5(cwd)>/<uuid>/，内含 meta.json（标题/cwd/更新时间）
 *    与 store.db（SQLite：meta 表存元数据、blobs 表存 value，value 可能是
 *    UTF-8 JSON 或十六进制编码的 JSON；二进制 / protobuf 块标不可用、不臆造）。
 *
 * value 渲染纪律：
 * - value.type 为 thinking / reasoning / redacted_thinking → 整条跳过（隐藏推理）。
 * - role 归一后不在 user / assistant / tool 内（system / developer / instruction /
 *   preamble 等）→ 整条跳过（系统提示不进交接）。
 * - content 块：text / input_text / output_text 取正文；thinking / signature 跳过；
 *   tool_use / tool_call 成 assistant 工具轮（只记 name+input 摘要，永不回放）；
 *   tool_result / tool_output 成 tool 轮（is_error → toolFailed）。
 * - 顶层 value.tool_calls（OpenAI 形态）同样只记摘要。
 * - user 正文：优先抽 <user_query>…</user_query>；以 <environment_context /
 *   <user_instructions / <system_reminder / <manually_attached_skills / <timestamp
 *   等包装开头的一律丢弃；生成元文本（XML 标签开头 / [Request interrupted by user）丢弃。
 * - value 里的 messages / turns / conversation / bubbles 嵌套数组递归展开。
 *
 * 只读不写：store.db 一律 readonly 打开随开随关；不复活 Cursor、不回放存储的调用。
 */
import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { makeTurn, summarizeToolCall, type Turn } from './transcript.js'
import type { SessionAdapter, SessionRef } from './types.js'

const ROOT = process.env['HANDOFF_ROOT_CURSOR'] ?? join(homedir(), '.cursor')

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** 系统提示 / 前言 / 指令类 role：整条跳过 */
const SKIPPED_ROLES = new Set(['system', 'developer', 'instruction', 'instructions', 'preamble'])

/** 隐藏推理块 / 签名块：跳过 */
const SKIPPED_BLOCK_TYPES = new Set(['thinking', 'reasoning', 'redacted_thinking', 'signature'])

/** user 正文里这些包装开头 = 环境/指令注入，不是用户原话 */
const BLOCKED_USER_WRAPPERS = [
  '<environment_context',
  '<user_instructions',
  '<system_reminder',
  '<manually_attached_skills',
  '<timestamp',
]

/** 生成元文本：XML 标签开头，或 "[Request interrupted by user" */
const GENERATED_META_RE = /^\s*<[a-z][A-Za-z0-9_.:-]*(?:\s|\/?>)/
const INTERRUPTED_RE = /^\s*\[Request interrupted by user/i

interface RoDatabase {
  prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] }
  close: () => void
}

/** node:sqlite 可用性（与 zcode 适配器同策略）：缺失时 store.db 形态不可用，transcript 不受影响。 */
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

/** content 归一为块数组：字符串 → 单 text 块；对象 → 单块；数组过滤非对象。 */
function blocksOf(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (Array.isArray(content)) return content.filter((b): b is Record<string, unknown> => b !== null && typeof b === 'object')
  if (content !== null && typeof content === 'object') return [content as Record<string, unknown>]
  return []
}

/** tool_result 块的 content → 纯文本（字符串 / 块数组 / {text} 对象）。 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content) {
      if (typeof item === 'string') parts.push(item)
      else if (item !== null && typeof item === 'object') {
        const t = (item as { text?: unknown }).text
        if (typeof t === 'string') parts.push(t)
      }
    }
    return parts.join('\n')
  }
  if (content !== null && typeof content === 'object') {
    const t = (content as { text?: unknown }).text
    if (typeof t === 'string') return t
  }
  return ''
}

/** user 正文清洗：抽 <user_query>；包装注入丢弃；其余原样。 */
function cursorUserText(text: string): string | null {
  const matches = [...text.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/g)]
  if (matches.length > 0) {
    const joined = matches.map((m) => (m[1] ?? '').trim()).filter((s) => s !== '').join('\n')
    return joined === '' ? null : joined
  }
  const stripped = text.trimStart()
  if (BLOCKED_USER_WRAPPERS.some((w) => stripped.startsWith(w))) return null
  return text
}

/**
 * 渲染一个 Cursor value 为 Turn 流（text 轮 + 工具调用轮 + 工具结果轮）。
 * 返回空数组 = 该 value 是系统提示 / 隐藏推理 / 空内容（调用方计数即可）。
 */
export function renderCursorValue(value: unknown): Turn[] {
  if (value === null || typeof value !== 'object') return []
  const v = value as Record<string, unknown>

  const vtype = typeof v.type === 'string' ? v.type : ''
  if (SKIPPED_BLOCK_TYPES.has(vtype)) return [] // 整条是隐藏推理，不看 role 直接跳过

  const role = typeof v.role === 'string' ? v.role.toLowerCase() : ''
  if (role === '' || SKIPPED_ROLES.has(role)) {
    // 无 role 的容器：messages / turns / conversation / bubbles 嵌套数组递归展开
    for (const key of ['messages', 'turns', 'conversation', 'bubbles']) {
      const nested = v[key]
      if (Array.isArray(nested)) return nested.flatMap((item) => renderCursorValue(item))
    }
    return []
  }
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') return []

  const ts = typeof v.timestamp === 'string' ? v.timestamp : typeof v.timestamp === 'number' ? new Date(v.timestamp).toISOString() : ''
  const message = v.message !== null && typeof v.message === 'object' ? (v.message as Record<string, unknown>) : null
  const content = message !== null && 'content' in message ? message.content : v.content

  const texts: string[] = []
  const callTurns: Turn[] = []
  const resultTurns: Turn[] = []
  for (const block of blocksOf(content)) {
    const btype = typeof block.type === 'string' ? block.type : ''
    if (SKIPPED_BLOCK_TYPES.has(btype)) continue
    if (btype === 'text' || btype === 'input_text' || btype === 'output_text') {
      const raw = typeof block.text === 'string' ? block.text : ''
      if (raw === '') continue
      const rendered = role === 'user'
        ? cursorUserText(raw)
        : GENERATED_META_RE.test(raw) || INTERRUPTED_RE.test(raw) ? null : raw
      if (rendered !== null && rendered.trim() !== '') texts.push(rendered)
    } else if (btype === 'tool_use' || btype === 'tool_call') {
      const name = typeof block.name === 'string' ? block.name : 'unknown'
      const input = 'input' in block ? block.input : block.arguments
      callTurns.push(makeTurn({ role: 'assistant', text: summarizeToolCall(name, input), ts, toolName: name }))
    } else if (btype === 'tool_result' || btype === 'tool_output') {
      resultTurns.push(makeTurn({
        role: 'tool',
        text: contentText(block.content).slice(0, 2000),
        ts,
        toolFailed: Boolean(block.is_error),
      }))
    }
  }

  // 顶层 tool_calls（OpenAI 形态：call.function.name / arguments）
  if (Array.isArray(v.tool_calls)) {
    for (const call of v.tool_calls) {
      if (call === null || typeof call !== 'object') continue
      const c = call as Record<string, unknown>
      const fn = c.function !== null && typeof c.function === 'object' ? (c.function as Record<string, unknown>) : c
      const name = typeof fn.name === 'string' ? fn.name : 'unknown'
      let input: unknown = 'arguments' in fn ? fn.arguments : fn.input
      if (typeof input === 'string') {
        try { input = JSON.parse(input) } catch { /* 保留字符串原样 */ }
      }
      callTurns.push(makeTurn({ role: 'assistant', text: summarizeToolCall(name, input), ts, toolName: name }))
    }
  }

  // role=tool 且无显式结果块：整条 content 就是工具输出
  if (role === 'tool' && resultTurns.length === 0) {
    resultTurns.push(makeTurn({
      role: 'tool',
      text: contentText(content).slice(0, 2000),
      ts,
      toolFailed: Boolean(v.is_error),
    }))
    texts.length = 0
  }

  const turns: Turn[] = []
  const text = texts.join('\n').trim()
  if (text !== '') turns.push(makeTurn({ role: role === 'tool' ? 'tool' : role, text, ts }))
  turns.push(...callTurns, ...resultTurns)
  return turns
}

/** transcript JSONL 文本 → Turn 流（坏行静默跳过）。 */
export function parseCursorTranscriptText(text: string): Turn[] {
  const turns: Turn[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue // 损坏记录跳过，不拖垮整会话
    }
    turns.push(...renderCursorValue(value))
  }
  return turns
}

/** store blob 解码：Buffer/字符串 → JSON；偶数长度纯十六进制串先试 hex 解码；失败 = 二进制/protobuf，返回 null。 */
export function decodeCursorBlob(raw: unknown): unknown | null {
  let text: string
  if (raw instanceof Uint8Array) {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    } catch {
      return null
    }
  } else if (typeof raw === 'string') {
    text = raw
  } else if (raw !== null && typeof raw === 'object') {
    return raw
  } else {
    return null
  }
  const stripped = text.trim()
  if (stripped === '') return null
  if (stripped.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(stripped)) {
    try {
      return JSON.parse(Buffer.from(stripped, 'hex').toString('utf-8'))
    } catch {
      // 落回直接 JSON 解析
    }
  }
  try {
    return JSON.parse(stripped)
  } catch {
    return null
  }
}

/** store.db（blobs 表：id/data 或 key/value 等列名）→ Turn 流；缺库/缺 sqlite 返回 []。 */
export function parseCursorStore(dbPath: string): Turn[] {
  if (DatabaseSync === null || !existsSync(dbPath)) return []
  let db: RoDatabase
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    return []
  }
  try {
    const cols = new Set(
      (db.prepare('PRAGMA table_info("blobs")').all() as unknown as Array<{ name: string }>).map((c) => c.name),
    )
    const keyCol = ['id', 'key', 'hash'].find((c) => cols.has(c))
    const valCol = ['data', 'value', 'blob'].find((c) => cols.has(c))
    if (keyCol === undefined || valCol === undefined) return []
    const rows = db.prepare(`SELECT "${valCol}" FROM blobs ORDER BY "${keyCol}"`).all() as unknown as unknown[]
    const turns: Turn[] = []
    for (const row of rows) {
      const raw = Array.isArray(row) ? row[0] : (row as Record<string, unknown>)[valCol]
      const value = decodeCursorBlob(raw)
      if (value === null) continue // 二进制 / protobuf：标不可用（跳过），不臆造
      turns.push(...renderCursorValue(value))
    }
    return turns
  } catch {
    return []
  } finally {
    db.close()
  }
}

/** 限量读文件头（发现期取标题用）。 */
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

/** 头部文本里第一条 user 正文前 40 字作标题。 */
function transcriptTitle(head: string): string {
  for (const turn of parseCursorTranscriptText(head)) {
    if (turn.role === 'user' && turn.text.trim() !== '') return turn.text.trim().slice(0, 40)
  }
  return ''
}

interface CursorMeta { title: string; cwd: string; updatedAt: number }

/** meta.json → 标题 / cwd / 更新时间（尽力而为，字段缺失留空）。 */
function readMetaJson(path: string): CursorMeta {
  const meta: CursorMeta = { title: '', cwd: '', updatedAt: 0 }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (typeof value.title === 'string') meta.title = value.title
    else if (typeof value.name === 'string') meta.title = value.name
    if (typeof value.cwd === 'string') meta.cwd = value.cwd
    else if (typeof value.workspacePath === 'string') meta.cwd = value.workspacePath
    const ws = value.workspaceIdentifier
    if (meta.cwd === '' && ws !== null && typeof ws === 'object') {
      const w = ws as Record<string, unknown>
      const uri = w.uri !== null && typeof w.uri === 'object' ? (w.uri as Record<string, unknown>) : null
      const candidate = (typeof uri?.fsPath === 'string' && uri.fsPath)
        || (typeof uri?.path === 'string' && uri.path)
        || (typeof w.fsPath === 'string' && w.fsPath)
        || ''
      meta.cwd = candidate
    }
    for (const key of ['updatedAtMs', 'lastUpdatedAt', 'updated_at_ms']) {
      const t = value[key]
      if (typeof t === 'number' && t > 0) {
        meta.updatedAt = t < 1_000_000_000_000 ? t * 1000 : t
        break
      }
    }
  } catch {
    // meta.json 损坏：留空，调用方用 mtime 兜底
  }
  return meta
}

export const cursorAdapter: SessionAdapter = {
  name: 'cursor',
  root: ROOT,
  supported: true,
  note: DatabaseSync === null ? 'CLI store.db 形态需要 Node ≥22（node:sqlite）；transcript 形态不受影响' : undefined,

  discover(): SessionRef[] {
    const out: SessionRef[] = []
    const seenSessions = new Set<string>()

    // 形态 1：projects/<ws>/agent-transcripts/<sid>/<sid>.jsonl
    const projects = join(ROOT, 'projects')
    let wsDirs: string[] = []
    try {
      wsDirs = readdirSync(projects, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.isSymbolicLink())
        .map((d) => join(projects, d.name))
    } catch {
      wsDirs = []
    }
    for (const ws of wsDirs) {
      const atDir = join(ws, 'agent-transcripts')
      let sidDirs: string[] = []
      try {
        sidDirs = readdirSync(atDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.isSymbolicLink())
          .map((d) => d.name)
      } catch {
        continue
      }
      for (const sid of sidDirs) {
        const file = join(atDir, sid, `${sid}.jsonl`)
        let mtime = 0, size = 0
        try {
          const st = statSync(file)
          mtime = st.mtimeMs
          size = st.size
        } catch {
          continue
        }
        seenSessions.add(sid.toLowerCase())
        out.push({
          agent: this.name,
          id: file,
          title: transcriptTitle(readHead(file)) || sid,
          cwd: '',
          updatedAt: mtime,
          fingerprint: `${Math.round(mtime)}:${size}`,
          kind: 'file',
        })
      }
    }

    // 形态 2：chats/<md5(cwd)>/<uuid>/（meta.json + store.db）
    const chats = join(ROOT, 'chats')
    let hashDirs: string[] = []
    try {
      hashDirs = readdirSync(chats, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.isSymbolicLink())
        .map((d) => join(chats, d.name))
    } catch {
      hashDirs = []
    }
    for (const hashDir of hashDirs) {
      let sessionDirs: string[] = []
      try {
        sessionDirs = readdirSync(hashDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.isSymbolicLink() && UUID_RE.test(d.name))
          .map((d) => d.name)
      } catch {
        continue
      }
      for (const sid of sessionDirs) {
        if (seenSessions.has(sid.toLowerCase())) continue // transcript 优先，同会话不重复
        const dir = join(hashDir, sid)
        const storePath = join(dir, 'store.db')
        const metaPath = join(dir, 'meta.json')
        const hasStore = existsSync(storePath)
        if (!hasStore && !existsSync(metaPath)) continue
        const meta = readMetaJson(metaPath)
        let mtime = meta.updatedAt, size = 0
        try {
          const st = statSync(hasStore ? storePath : metaPath)
          if (mtime === 0) mtime = st.mtimeMs
          size = st.size
        } catch {
          continue
        }
        out.push({
          agent: this.name,
          id: hasStore ? storePath : metaPath,
          title: meta.title || sid,
          cwd: meta.cwd,
          updatedAt: mtime,
          fingerprint: `${Math.round(mtime)}:${size}`,
          kind: hasStore ? 'sqlite' : 'file',
        })
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  },

  parse(id: string): Turn[] {
    try {
      if (id.endsWith('.jsonl')) {
        return parseCursorTranscriptText(readFileSync(id, 'utf8'))
      }
      if (basename(id) === 'store.db') {
        return parseCursorStore(id)
      }
      if (basename(id) === 'meta.json') {
        // 只有 meta.json 没有 store.db：无正文可恢复，不臆造
        return []
      }
      return []
    } catch {
      return []
    }
  },
}
