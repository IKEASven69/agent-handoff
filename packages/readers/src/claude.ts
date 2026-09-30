/**
 * Claude Code 适配器：~/.claude/projects 下递归的全部 .jsonl（引擎原生格式）。
 * 移植自 dsh-hippo src/agents/claude.ts；root 可用 HANDOFF_ROOT_CLAUDE 覆盖（测试用）。
 */
import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { entryToTurns, parseJsonl } from './transcript.js'
import type { SessionAdapter, SessionRef } from './types.js'

const ROOT = process.env['HANDOFF_ROOT_CLAUDE'] ?? join(homedir(), '.claude', 'projects')

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

/** 从转录头部几行取真实 cwd（用户条目带 cwd 字段）。
 * 目录名解码有歧义（连字符 vs 路径分隔符），首行才是权威来源。 */
function realCwd(file: string, fallback: string): string {
  try {
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(8192)
      const n = readSync(fd, buf, 0, 8192, 0)
      const head = buf.toString('utf8', 0, n)
      const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head)
      if (m) return JSON.parse(`"${m[1]}"`)
    } finally {
      closeSync(fd)
    }
  } catch { /* 读失败回退 */ }
  return fallback
}

export const claudeAdapter: SessionAdapter = {
  name: 'claude-code',
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
        cwd: realCwd(file, basename(join(file, '..'))),
        updatedAt: mtime,
        fingerprint: `${Math.round(mtime)}:${size}`,
        kind: 'file',
      })
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  },
  parse(id: string) {
    let text: string
    try {
      text = readFileSync(id, 'utf8')
    } catch {
      return []
    }
    const turns = []
    for (const entry of parseJsonl(text)) turns.push(...entryToTurns(entry))
    return turns
  },
}
