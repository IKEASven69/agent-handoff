/**
 * Gemini CLI 适配器（自研 TS 实现；格式为公开逆向调研，2026-10 核实）。
 *
 * 存储形态（root 可用 HANDOFF_ROOT_GEMINI 覆盖，测试用；缺省 ~/.gemini/tmp）：
 *
 *   <root>/<项目标识>/                 项目标识 = slug 或旧版 sha256 哈希（不做格式判断，直接枚举）
 *     .project_root                    明文 cwd（读不到留空，调用方有空 cwd 警告兜底）
 *     chats/
 *       session-<timestamp>-<8位id>.jsonl   新格式（2026-10-01 起）
 *       session-<timestamp>-<8位id>.json    旧格式（整块 JSON：metadata+messages 单对象）
 *       <parentShortId>/session-*.jsonl     子代理会话再嵌一层（metadata.kind='subagent'）
 *
 * JSONL 行法：首行 metadata（sessionId/startTime/lastUpdated/summary/directories/kind）
 * → 每行一条 MessageRecord → 穿插控制行——已知类型分派、未知行静默跳过：
 * - MessageRecord.type: user | gemini | info | error | warning；
 * - content 是字符串或 Part 数组（取 text 部分）；info / error / warning 是 CLI UI
 *   消息，不计用户轮也不进 Turn；
 * - user 文本以 '/' 或 '?' 开头是斜杠命令/快捷键，跳过（首条用户消息口径对齐全包）；
 * - gemini 轮带 toolCalls[{name,args,result,status,timestamp}]：每个调用出一个
 *   assistant 工具轮（toolName=原生名，text=summarizeToolCall 摘要；write_file /
 *   replace / read_file 是文件类、run_shell_command args.command 是命令类——与 grok
 *   适配器同口径：原生名直透 toolName，不做改名）；result/status 再出一个 tool 结果
 *   轮，status==='error' 记 toolFailed。
 * - $patch / $set / $rewindTo 控制行跳过。
 *
 * 只读不写、不复活 Gemini CLI 进程；坏行/损坏文件静默跳过或返回空流。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { makeTurn, summarizeToolCall, type Turn } from './transcript.js'
import { FAKE_ZERO_NOTE, type SessionAdapter, type SessionRef } from './types.js'

const ROOT = process.env['HANDOFF_ROOT_GEMINI'] ?? join(homedir(), '.gemini', 'tmp')

type Entry = Record<string, unknown>

/** ISO 时间戳 → ms epoch；不可解析返回 0。 */
function toMillis(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/** 控制行（$patch / $set / $rewindTo）：顶层带 $ 键，或 type 以 $ 开头。 */
function isControlLine(record: Entry): boolean {
  if ('$patch' in record || '$set' in record || '$rewindTo' in record) return true
  const type = record.type
  return typeof type === 'string' && type.startsWith('$')
}

/** content（字符串或 Part 数组）→ 纯文本：取 text 部分，其余块跳过。 */
function geminiContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && typeof (block as Entry).text === 'string') {
      parts.push((block as Entry).text as string)
    }
  }
  return parts.join('\n')
}

/** user 文本以 '/' 或 '?' 开头 = 斜杠命令/快捷输入，不是对话内容。 */
function isSlashCommand(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('/') || t.startsWith('?')
}

/** toolCall 的 result：字符串直用；对象取 output/text 字符串字段；其余空。 */
function toolResultText(result: unknown): string {
  if (typeof result === 'string') return result
  if (result !== null && typeof result === 'object') {
    const r = result as Entry
    for (const key of ['output', 'text']) {
      if (typeof r[key] === 'string') return r[key] as string
    }
  }
  return ''
}

/** 单条 MessageRecord → Turn 列表。info/error/warning 与斜杠命令不产生 Turn。 */
function recordToTurns(record: Entry, cwd: string): Turn[] {
  const type = typeof record.type === 'string' ? record.type : ''
  const ts = typeof record.timestamp === 'string' ? record.timestamp : ''
  const model = typeof record.model === 'string' ? record.model : ''
  const turns: Turn[] = []

  if (type === 'user') {
    const text = geminiContentText(record.content).trim()
    if (text !== '' && !isSlashCommand(text)) {
      turns.push(makeTurn({ role: 'user', text, cwd, ts }))
    }
    return turns
  }

  if (type === 'gemini') {
    const text = geminiContentText(record.content).trim()
    if (text !== '') turns.push(makeTurn({ role: 'assistant', text, cwd, ts, model }))
    const toolCalls = Array.isArray(record.toolCalls) ? record.toolCalls : []
    for (const call of toolCalls) {
      if (call === null || typeof call !== 'object') continue
      const c = call as Entry
      const name = typeof c.name === 'string' && c.name !== '' ? c.name : 'gemini_tool'
      const args = c.args
      const status = typeof c.status === 'string' ? c.status : ''
      // 调用轮：toolName=原生名（write_file/replace/read_file/run_shell_command 直透）
      turns.push(makeTurn({
        role: 'assistant',
        text: summarizeToolCall(name, args),
        cwd,
        ts,
        model,
        toolName: name,
      }))
      // 结果轮：有 result 或失败态才出（status==='error' 记 toolFailed）
      const result = toolResultText(c.result)
      if (result !== '' || status === 'error') {
        turns.push(makeTurn({
          role: 'tool',
          text: result.slice(0, 2000),
          cwd,
          ts: typeof c.timestamp === 'string' ? c.timestamp : ts,
          toolName: name,
          toolFailed: status === 'error',
        }))
      }
    }
  }
  // info / error / warning / 未知 type：CLI UI 消息，不进 Turn
  return turns
}

/** JSONL 文本 → Turn 流：已知类型分派，控制行与未知行静默跳过。 */
export function parseGeminiText(text: string, cwd = ''): Turn[] {
  const turns: Turn[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    let record: Entry
    try {
      record = JSON.parse(line) as Entry
    } catch {
      continue // 坏行静默跳过
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue
    if (isControlLine(record)) continue
    // 首行 metadata（无 type、带 sessionId/kind 等元字段）：不产生 Turn
    if (typeof record.type !== 'string') continue
    turns.push(...recordToTurns(record, cwd))
  }
  return turns
}

/** 旧 .json（metadata+messages 单对象）→ Turn 流。 */
export function parseGeminiJson(text: string, cwd = ''): Turn[] {
  let value: Entry
  try {
    value = JSON.parse(text) as Entry
  } catch {
    return []
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const messages = value.messages
  if (!Array.isArray(messages)) return []
  const turns: Turn[] = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) continue
    if (isControlLine(message as Entry)) continue
    turns.push(...recordToTurns(message as Entry, cwd))
  }
  return turns
}

/**
 * cwd 反查：会话文件所在目录到 <root>/<项目标识> 沿途找 .project_root 明文文件
 * （主会话在项目目录、子代理在 chats/<parent>/ 下——子到父逐层找，都不越过项目目录）。
 * 读不到留空（调用方有空 cwd 警告兜底）。
 */
function projectCwd(file: string): string {
  let dir = dirname(file)
  // 越界保险：最多向上走 6 层（实际布局最多 chats/<parent>/ → 项目目录 2 层）
  for (let depth = 0; depth < 6; depth += 1) {
    let raw = ''
    try {
      raw = readFileSync(join(dir, '.project_root'), 'utf8')
    } catch {
      raw = ''
    }
    const cwd = raw.trim()
    if (cwd !== '') return cwd
    const parent = dirname(dir)
    if (parent === dir || basename(parent) === 'tmp' || depth + 1 >= 6) return ''
    dir = parent
  }
  return ''
}

/** 会话文件路径（.jsonl 新格式 / .json 旧格式）→ Turn 流。文件缺失/损坏返回 []。 */
export function parseGeminiSession(id: string): Turn[] {
  let text: string
  try {
    text = readFileSync(id, 'utf8')
  } catch {
    return []
  }
  const cwd = projectCwd(id)
  return id.toLowerCase().endsWith('.json') ? parseGeminiJson(text, cwd) : parseGeminiText(text, cwd)
}

/** 会话文件是否为 gemini 会话命名：session-*.jsonl / session-*.json。 */
function isSessionFile(name: string): boolean {
  return name.startsWith('session-') && (name.endsWith('.jsonl') || name.endsWith('.json'))
}

/** 头部 64KB 抠 metadata：summary（标题）/ lastUpdated（更新时间）——别全读大文件。 */
function readHeadMeta(file: string, isJson: boolean): { summary: string; lastUpdated: number } {
  let head = ''
  try {
    const buf = readFileSync(file)
    head = buf.subarray(0, Math.min(buf.length, 65536)).toString('utf8')
  } catch {
    return { summary: '', lastUpdated: 0 }
  }
  let summary = ''
  let lastUpdated = 0
  if (isJson) {
    // 旧 .json：整块解析拿 summary / lastUpdated（失败退 regex 抠头部）
    try {
      const meta = JSON.parse(head) as Entry
      if (typeof meta.summary === 'string') summary = meta.summary
      lastUpdated = toMillis(meta.lastUpdated)
    } catch {
      // 截断的头部解析不了，退 regex
    }
  }
  if (summary === '') {
    const m = head.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    if (m) {
      try { summary = JSON.parse(`"${m[1]}"`) as string } catch { summary = m[1] }
    }
  }
  if (lastUpdated === 0) {
    const m = head.match(/"lastUpdated"\s*:\s*"([^"]*)"/)
    if (m) lastUpdated = toMillis(m[1])
  }
  return { summary, lastUpdated }
}

function refFromFile(file: string): SessionRef | null {
  let mtime = 0
  let size = 0
  try {
    const st = statSync(file)
    if (!st.isFile()) return null
    mtime = st.mtimeMs
    size = st.size
  } catch {
    return null
  }
  const isJson = file.toLowerCase().endsWith('.json')
  const meta = readHeadMeta(file, isJson)
  return {
    agent: 'gemini',
    id: file,
    title: meta.summary !== '' ? meta.summary : basename(file),
    cwd: projectCwd(file),
    updatedAt: meta.lastUpdated || mtime,
    fingerprint: `${Math.round(mtime)}:${size}`,
    kind: 'file',
  }
}

export const geminiAdapter: SessionAdapter = {
  name: 'gemini',
  root: ROOT,
  supported: true,

  discover(): SessionRef[] {
    const out: SessionRef[] = []
    let projectDirs: string[] = []
    try {
      projectDirs = readdirSync(ROOT, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.isSymbolicLink())
        .map((d) => join(ROOT, d.name))
    } catch {
      return out // ~/.gemini 不存在 = 没装 Gemini CLI，正常静默
    }
    for (const projectDir of projectDirs) {
      let chatEntries: ReturnType<typeof readdirSync> = []
      const chatsDir = join(projectDir, 'chats')
      try {
        chatEntries = readdirSync(chatsDir, { withFileTypes: true })
      } catch {
        continue // 无 chats/ 层：老布局或非会话项目目录，跳过
      }
      const files: string[] = []
      for (const entry of chatEntries) {
        const full = join(chatsDir, entry.name)
        if (entry.isFile() && isSessionFile(entry.name)) {
          files.push(full)
        } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
          // 子代理会话：chats/<parentShortId>/session-*.jsonl 再嵌一层
          try {
            for (const name of readdirSync(full)) {
              if (isSessionFile(name)) files.push(join(full, name))
            }
          } catch {
            continue
          }
        }
      }
      for (const file of files) {
        const ref = refFromFile(file)
        if (ref !== null) out.push(ref)
      }
    }
    // 假 0 哨兵：根目录在但一个会话都没有——布局可能已迁移（root 缺席在上方已静默返回，不触发）
    this.note = out.length === 0 ? FAKE_ZERO_NOTE : undefined
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  },

  parse(id: string): Turn[] {
    try {
      return parseGeminiSession(id)
    } catch {
      return []
    }
  },
}
