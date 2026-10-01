/**
 * Grok 适配器（自研 TS 实现；格式为公开逆向调研，
 * Apache-2.0，其 NOTICE 声明该 reader 逐字节来自 xAI Grok 1.0.5 捆绑 skill——
 * 此处只学存储格式，不复制其代码）。
 *
 * 存储形态（root 可用 HANDOFF_ROOT_GROK 覆盖，测试用；缺省 $GROK_HOME/sessions
 * 或 ~/.grok/sessions）：
 *
 *   <root>/<urlencode(工作区路径)>/<会话id>/
 *     summary.json   会话元数据：info.id / info.cwd / generated_title /
 *                    session_summary / created_at / last_active_at / updated_at /
 *                    current_model_id / head_branch / git_root_dir
 *     updates.jsonl  可见更新流（ACP 形态）：每行 {params:{update:{...}}}，
 *                    导出流也可能直接是内层 update 对象
 *     chat_history.jsonl  原始模型上下文 —— 永不读取（恢复边界）
 *
 * updates.jsonl 的 update.sessionUpdate（或 update.type）分派：
 * - user_message_chunk / agent_message_chunk → 用户/助手文本轮；
 *   content 只取 type=text 块，非文本块标「内容不可用」；连续的同角色 chunk
 *   是流式分片，合并成一轮。
 * - agent_thought_chunk → 隐藏推理，丢弃。
 * - hook_execution → hook 执行记录，丢弃。
 * - tool_call / tool_call_update → status 缺省/pending 成 assistant 工具轮
 *   （name 取 _meta["x.ai/tool"].name/label 或 title/kind；只记摘要，永不回放）；
 *   completed/failed 成 tool 结果轮（failed → toolFailed；按 toolCallId 去重）。
 *   结果正文：content 块（字符串 / {type:content,content:{type:text}} /
 *   {type:text}）；{type:diff} 只留路径标不可用；兜底 rawOutput。
 * - plan / turn_completed / 未知类型 → 跳过。
 *
 * 只读不写、不复活 Grok 进程；损坏行静默跳过；summary.json 损坏的会话不发现。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { makeTurn, summarizeToolCall, type Turn } from './transcript.js'
import type { SessionAdapter, SessionRef } from './types.js'

const GROK_HOME = process.env['GROK_HOME'] ?? join(homedir(), '.grok')
const ROOT = process.env['HANDOFF_ROOT_GROK'] ?? join(GROK_HOME, 'sessions')

type Entry = Record<string, unknown>

/** 时间戳 → ms epoch：数字（秒/毫秒自适应）或 ISO 字符串；不可解析返回 0。 */
function toMillis(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = Math.trunc(value)
    return Math.abs(n) < 1_000_000_000_000 ? n * 1000 : n
  }
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

interface GrokSummary {
  cwd: string
  sessionId: string
  title: string
  updatedAt: number
  model: string
}

/** summary.json → 元数据；文件缺失/损坏返回 null（该会话不发现）。 */
function readSummary(sessionDir: string): GrokSummary | null {
  let value: Entry
  try {
    value = JSON.parse(readFileSync(join(sessionDir, 'summary.json'), 'utf8')) as Entry
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object') return null
  const info = value.info !== null && typeof value.info === 'object' ? (value.info as Entry) : {}
  const title = typeof value.generated_title === 'string' && value.generated_title !== ''
    ? value.generated_title
    : typeof value.session_summary === 'string' ? value.session_summary : ''
  return {
    cwd: typeof info.cwd === 'string' ? info.cwd : '',
    sessionId: typeof info.id === 'string' && info.id !== '' ? info.id : basename(sessionDir),
    title,
    updatedAt: toMillis(value.last_active_at) || toMillis(value.updated_at) || toMillis(value.created_at),
    model: typeof value.current_model_id === 'string' ? value.current_model_id : '',
  }
}

/** message chunk 的 content → 纯文本：只取 type=text 块，非文本块标不可用。 */
function grokMessageText(content: unknown): string {
  const blocks = typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : Array.isArray(content)
      ? content.filter((b): b is Entry => b !== null && typeof b === 'object')
      : content !== null && typeof content === 'object' ? [content as Entry] : []
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else {
      const label = typeof block.type === 'string' ? block.type.replace(/_/g, ' ') : 'unknown'
      parts.push(`[${label} 内容不可用]`)
    }
  }
  return parts.join('\n')
}

/** 连续同角色文本 chunk 是流式分片：并入上一轮；否则新开一轮。 */
function appendTextTurn(turns: Turn[], role: 'user' | 'assistant', content: unknown, cwd: string, model: string): void {
  const text = grokMessageText(content).trim()
  if (text === '') return
  const last = turns.at(-1)
  if (last !== undefined && last.role === role && last.toolName === '') {
    last.text = `${last.text}\n${text}`
    return
  }
  turns.push(makeTurn({ role, text, cwd, model }))
}

/** 工具名：_meta["x.ai/tool"].name/label → title → kind → 兜底 grok_tool。 */
function grokToolName(update: Entry): string {
  const meta = update._meta !== null && typeof update._meta === 'object' ? (update._meta as Entry) : {}
  const toolMeta = meta['x.ai/tool'] !== null && typeof meta['x.ai/tool'] === 'object' ? (meta['x.ai/tool'] as Entry) : {}
  for (const candidate of [toolMeta.name, toolMeta.label, update.title, update.kind]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return 'grok_tool'
}

/** 工具结果正文：content 块拼接；diff 只留路径；兜底 rawOutput。 */
function grokToolOutput(update: Entry): string {
  const content = update.content
  const blocks = Array.isArray(content) ? content : content === undefined ? [] : [content]
  const parts: string[] = []
  for (const block of blocks) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (block === null || typeof block !== 'object') continue
    const b = block as Entry
    if (b.type === 'content') {
      const nested = b.content
      if (typeof nested === 'string') parts.push(nested)
      else if (nested !== null && typeof nested === 'object') {
        const n = nested as Entry
        if (n.type === 'text' && typeof n.text === 'string') parts.push(n.text)
      }
    } else if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text)
    } else if (b.type === 'diff') {
      const path = typeof b.path === 'string' && b.path !== '' ? b.path : 'unknown path'
      parts.push(`[diff 内容不可用：${path}]`)
    }
  }
  let output = parts.join('\n')
  if (output === '' && typeof update.rawOutput === 'string') output = update.rawOutput
  return output.slice(0, 2000)
}

/**
 * updates.jsonl 文本 → Turn 流。只读可见更新流；
 * chat_history.jsonl（原始模型上下文）不在此处也永不在此处被读取。
 */
export function parseGrokUpdatesText(text: string, cwd = '', model = ''): Turn[] {
  const turns: Turn[] = []
  const emittedCalls = new Set<string>()
  const emittedResults = new Set<string>()
  const callNames = new Map<string, string>() // 结果记录常不带名字：沿用调用轮的名字
  let index = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    let record: Entry
    try {
      record = JSON.parse(line) as Entry
    } catch {
      continue // 损坏行静默跳过
    }
    index += 1
    if (record === null || typeof record !== 'object') continue
    const params = record.params !== null && typeof record.params === 'object' ? (record.params as Entry) : {}
    let update = params.update !== null && typeof params.update === 'object' ? (params.update as Entry) : null
    // 导出流 / fixture 形态：record 本身就是 update
    if (update === null && typeof record.sessionUpdate === 'string') update = record
    if (update === null) continue // 未知记录跳过

    const updateType = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : typeof update.type === 'string' ? update.type : ''
    if (updateType === 'user_message_chunk') {
      appendTextTurn(turns, 'user', update.content, cwd, model)
    } else if (updateType === 'agent_message_chunk') {
      appendTextTurn(turns, 'assistant', update.content, cwd, model)
    } else if (updateType === 'agent_thought_chunk' || updateType === 'hook_execution') {
      continue // 隐藏推理 / hook 记录：丢弃
    } else if (updateType === 'tool_call' || updateType === 'tool_call_update') {
      const callId = update.toolCallId !== undefined && update.toolCallId !== null
        ? String(update.toolCallId)
        : `grok-call-${index}`
      const status = typeof update.status === 'string' ? update.status : ''
      const name = callNames.get(callId) ?? grokToolName(update)
      if (status === 'completed' || status === 'failed') {
        if (emittedResults.has(callId)) continue
        emittedResults.add(callId)
        turns.push(makeTurn({
          role: 'tool',
          text: grokToolOutput(update),
          cwd,
          toolName: name,
          toolFailed: status === 'failed',
        }))
      } else if (!emittedCalls.has(callId)) {
        emittedCalls.add(callId)
        callNames.set(callId, name)
        const meta = update._meta !== null && typeof update._meta === 'object' ? (update._meta as Entry) : {}
        const toolMeta = meta['x.ai/tool'] !== null && typeof meta['x.ai/tool'] === 'object' ? (meta['x.ai/tool'] as Entry) : {}
        const rawInput = update.rawInput !== undefined ? update.rawInput : toolMeta.input
        turns.push(makeTurn({
          role: 'assistant',
          text: summarizeToolCall(name, rawInput),
          cwd,
          toolName: name,
        }))
      }
    }
    // plan / turn_completed / 未知类型：跳过
  }
  return turns
}

/** 解析一个会话目录（或 summary.json / updates.jsonl 路径）。 */
export function parseGrokSession(id: string): Turn[] {
  const base = basename(id)
  const dir = base === 'summary.json' || base === 'updates.jsonl' ? dirname(id) : id
  const summary = readSummary(dir)
  const cwd = summary?.cwd ?? ''
  const model = summary?.model ?? ''
  let text: string
  try {
    text = readFileSync(join(dir, 'updates.jsonl'), 'utf8')
  } catch {
    return []
  }
  return parseGrokUpdatesText(text, cwd, model)
}

export const grokAdapter: SessionAdapter = {
  name: 'grok',
  root: ROOT,
  supported: true,

  discover(): SessionRef[] {
    const out: SessionRef[] = []
    let wsDirs: string[] = []
    try {
      wsDirs = readdirSync(ROOT, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.isSymbolicLink())
        .map((d) => join(ROOT, d.name))
    } catch {
      return out // root 不存在 = 没装 Grok，正常静默
    }
    for (const ws of wsDirs) {
      let sessionDirs: string[] = []
      try {
        sessionDirs = readdirSync(ws, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.isSymbolicLink())
          .map((d) => join(ws, d.name))
      } catch {
        continue
      }
      for (const dir of sessionDirs) {
        // 只认 summary.json + updates.jsonl 齐全的会话目录
        let updatesStat: ReturnType<typeof statSync>
        try {
          updatesStat = statSync(join(dir, 'updates.jsonl'))
          if (!updatesStat.isFile()) continue
        } catch {
          continue
        }
        const summary = readSummary(dir)
        if (summary === null) continue
        const updatedAt = summary.updatedAt || updatesStat.mtimeMs
        out.push({
          agent: this.name,
          id: dir,
          title: summary.title || summary.sessionId,
          cwd: summary.cwd,
          updatedAt,
          fingerprint: `${Math.round(updatedAt)}:${updatesStat.size}`,
          kind: 'file',
        })
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  },

  parse(id: string): Turn[] {
    try {
      return parseGrokSession(id)
    } catch {
      return []
    }
  },
}
