/**
 * WorkBuddy 适配器：~/.workbuddy/projects/<workspace-slug>/<uuid>.jsonl
 * 一文件 = 一会话（单 sessionId）。记录类型（2026-09-01 实测真实会话）：
 *
 *   message(role=user|assistant) → 用户/助手轮。content 是块数组，取
 *     input_text/output_text 块的 text 拼接；image_blob_ref 等其他块跳过。
 *   reasoning → 思考行，跳过（与 function_call 交织密度高，并入会打乱轮次结构；
 *     交接只要显式陈述，思考本就是过程自语）。
 *   function_call → 工具调用轮：toolName=name，text=name+arguments 摘要。
 *   function_call_result → 工具结果轮：text=output.text，status!=='completed' 即 toolFailed。
 *   file-history-snapshot / ai-title / resend-fork-notice → 跳过
 *     （ai-title 的标题在 discover 阶段取走作 SessionRef.title）。
 *
 * 移植自 dsh-hippo src/agents/workbuddy.ts；root 可用 HANDOFF_ROOT_WORKBUDDY 覆盖（测试用）。
 */
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { makeTurn, type Turn } from './transcript.js'
import type { SessionAdapter, SessionRef } from './types.js'

const ROOT = process.env['HANDOFF_ROOT_WORKBUDDY'] ?? join(homedir(), '.workbuddy', 'projects')

/** 逐行读 JSONL（坏行跳过，与 claude 适配器同策略）。 */
function* readJsonl(file: string): Generator<Record<string, unknown>> {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try {
      yield JSON.parse(t) as Record<string, unknown>
    } catch { /* 坏行跳过 */ }
  }
}

/** content 块数组 → 纯文本（取 *_text 块，其余块跳过）。 */
function blocksToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content) {
    if (b !== null && typeof b === 'object' && typeof (b as { type?: string }).type === 'string') {
      const { type, text } = b as { type: string; text?: unknown }
      if (type.endsWith('_text') && typeof text === 'string' && text !== '') parts.push(text)
    }
  }
  return parts.join('\n').trim()
}

/** function_call_result 的 output：{type:'text',text} 对象或纯字符串。 */
function resultToText(output: unknown): string {
  if (typeof output === 'string') return output
  if (output !== null && typeof output === 'object') {
    const { text } = output as { text?: unknown }
    if (typeof text === 'string') return text
  }
  return ''
}

export const workbuddyAdapter: SessionAdapter = {
  name: 'workbuddy',
  root: ROOT,
  supported: true,

  discover(): SessionRef[] {
    const out: SessionRef[] = []
    let projectDirs: string[]
    try {
      projectDirs = readdirSync(ROOT, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
    } catch {
      return out // ~/.workbuddy 不存在 = 没装 WorkBuddy，正常静默
    }
    for (const dir of projectDirs) {
      let files: string[]
      try {
        files = readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.jsonl'))
      } catch { continue }
      for (const f of files) {
        const full = join(ROOT, dir, f)
        let mtime = 0
        let size = 0
        try {
          const st = statSync(full)
          mtime = st.mtimeMs
          size = st.size
        } catch { continue }
        // 标题与 cwd：只读头部 64KB 找 ai-title / 首行 cwd（文件可能很大，别全读）
        let title = basename(f, '.jsonl')
        let cwd = ''
        try {
          const fd = openSync(full, 'r')
          const buf = Buffer.alloc(65536)
          const n = readSync(fd, buf, 0, buf.length, 0)
          closeSync(fd)
          const head = buf.slice(0, n).toString('utf8')
          const m = head.match(/"type":\s*"ai-title",[^}]*?"aiTitle":\s*"((?:[^"\\]|\\.)*)"/)
          if (m) {
            try { title = JSON.parse(`"${m[1]}"`) } catch { title = m[1] }
          }
          const cm = head.match(/"cwd":\s*"((?:[^"\\]|\\.)*)"/)
          if (cm) {
            try { cwd = JSON.parse(`"${cm[1]}"`) } catch { cwd = cm[1] }
          }
        } catch { /* 头部读失败用 basename 兜底 */ }
        out.push({
          agent: this.name,
          id: full,
          title,
          cwd,
          updatedAt: mtime,
          fingerprint: `${Math.round(mtime)}:${size}`,
          kind: 'file',
        })
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  },

  parse(id: string): Turn[] {
    let entries: Record<string, unknown>[]
    try {
      entries = [...readJsonl(id)]
    } catch {
      return []
    }
    const turns: Turn[] = []
    for (const e of entries) {
      const type = e.type
      const cwd = typeof e.cwd === 'string' ? e.cwd : ''
      const ts = typeof e.timestamp === 'number' ? new Date(e.timestamp).toISOString() : ''
      if (type === 'message') {
        const role = e.role === 'user' ? 'user' : e.role === 'assistant' ? 'assistant' : null
        if (role === null) continue
        const text = blocksToText(e.content)
        if (text === '') continue
        turns.push(makeTurn({ role, text, cwd, ts }))
      } else if (type === 'function_call') {
        const name = typeof e.name === 'string' ? e.name : ''
        if (name === '') continue
        const args = typeof e.arguments === 'string' ? e.arguments.slice(0, 400) : ''
        turns.push(makeTurn({ role: 'tool', text: args === '' ? name : `${name} ${args}`, cwd, ts, toolName: name }))
      } else if (type === 'function_call_result') {
        const name = typeof e.name === 'string' ? e.name : ''
        const status = typeof e.status === 'string' ? e.status : ''
        const text = resultToText(e.output).slice(0, 2000)
        turns.push(makeTurn({
          role: 'tool', text: text === '' ? `(${name} 无输出)` : text, cwd, ts,
          toolName: name === '' ? 'result' : name,
          toolFailed: status !== '' && status !== 'completed',
        }))
      }
      // reasoning / file-history-snapshot / ai-title / resend-fork-notice：跳过（见文件头注释）
    }
    return turns
  },
}
