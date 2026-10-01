/**
 * sessions / pull 命令：从八家 agent 的本地会话直接生成协议卡片。
 * 卡片是确定性骨架（不调 LLM），内容均为 HISTORY_REPORTED；
 * from.session 存适配器 id（指针不是原文），git 快照走 core.collectGitSnapshot。
 */
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import { collectGitSnapshot, generateId, writeCard, type Card } from '@agent-handoff/core'
import {
  AGENTS,
  listSessions,
  readSession,
  resolveAgentReference,
  type SessionRef,
  type Turn,
} from '@agent-handoff/readers'

/** 固定读者警告：骨架卡的口径声明（语义：需蒸馏层） */
export const SKELETON_WARNING = '本卡为确定性骨架，未经 LLM 润色；内容均为 HISTORY_REPORTED'

function die(msg: string): never {
  console.error(msg)
  process.exit(1)
}

const fmtTime = (ms: number): string =>
  ms > 0 ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : '（未知）'

// ---------- sessions ----------

export function cmdSessions(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      filter: { type: 'string' },
      limit: { type: 'string' },
    },
  })
  const agent = positionals[0]
  const filter = values.filter?.toLowerCase()
  const limit = values.limit !== undefined ? Number.parseInt(values.limit, 10) : 30
  if (agent !== undefined && !AGENTS.some((a) => a.name === agent)) {
    die(`未知 agent：${agent}（支持：${AGENTS.map((a) => a.name).join(' / ')}）`)
  }

  let sessions = listSessions(agent)
  if (filter !== undefined) {
    sessions = sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(filter) ||
        s.id.toLowerCase().includes(filter) ||
        s.cwd.toLowerCase().includes(filter),
    )
  }
  if (sessions.length === 0) {
    console.log(agent !== undefined ? `${agent} 无已发现会话` : '无已发现会话（八家适配器均为空）')
    return
  }
  const shown = sessions.slice(0, Math.max(1, limit))
  console.log(`共 ${sessions.length} 个会话${shown.length < sessions.length ? `，显示前 ${shown.length} 个` : ''}：`)
  for (const s of shown) {
    // 轮数需解析会话本体，只对展示行计算；解析失败不拖垮列表
    let turns: number | '-' = '-'
    try {
      turns = readSession(s.agent, s).length
    } catch { /* 保持 '-' */ }
    console.log(`${s.agent}  「${s.title}」  更新:${fmtTime(s.updatedAt)}  轮数:${turns}  id:${s.id}`)
  }
}

// ---------- 骨架卡 ----------

/** Windows 绝对路径 / POSIX 绝对路径 / 相对路径（带扩展名）三种形态 */
const PATH_RES = [
  /[A-Za-z]:[\\/](?:[^\s\\/:*?"<>|，。；：、（）"'`[\]{}]+[\\/])*[^\s\\/:*?"<>|，。；：、（）"'`[\]{}]*\.[A-Za-z0-9]{1,10}/g,
  /(?<![\w/])\/(?:[^\s/:*?"'`，。；：()（）]+\/)*[^\s/:*?"'`，。；：()（）]+\.[A-Za-z0-9]{1,10}/g,
  /(?<![\w/.:])(?:\.{1,2}\/)?(?:[\w@+-]+\/)+[\w@+.-]+\.[A-Za-z0-9]{1,10}/g,
]

/** 从 turns 文本提取文件路径：首次出现顺序去重，最多 15 条（确定性启发式，宁可少不可编） */
export function extractFilePaths(turns: Turn[], cap = 15): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of turns) {
    for (const re of PATH_RES) {
      re.lastIndex = 0
      for (const m of t.text.matchAll(re)) {
        const p = m[0]
        if (seen.has(p)) continue
        seen.add(p)
        out.push(p)
        if (out.length >= cap) return out
      }
    }
  }
  return out
}

/** 截取文本尾部若干段（结论通常在末尾），总长约 cap 字 */
function tailExcerpt(text: string, cap: number): string {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p !== '')
  let acc = ''
  for (let i = paras.length - 1; i >= 0; i--) {
    const next = acc === '' ? paras[i]! : paras[i] + '\n\n' + acc
    if (next.length > cap && acc !== '') break
    acc = next
    if (acc.length > cap) break
  }
  if (acc === '') return ''
  return acc.length > cap ? '…' + acc.slice(-cap) : acc
}

const clip = (text: string, cap: number): string =>
  text.length > cap ? text.slice(0, cap) + '…' : text

const REMAINING_HINT = /待办|TODO|FIXME|下一步|还差|未完成|待处理|接下来/i

/** 从尾部 turns 提取「还差什么」线索：命中关键词的行，去重最多 5 条 */
function remainingHints(turns: Turn[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const t of turns.slice(-12)) {
    for (const line of t.text.split('\n')) {
      const l = line.trim().replace(/^[-*>\s\[\]x]+/, '')
      if (l.length < 4 || l.length > 200 || !REMAINING_HINT.test(l)) continue
      if (seen.has(l)) continue
      seen.add(l)
      out.push(l)
      if (out.length >= 5) return out
    }
  }
  return out
}

/** 会话 → 协议卡片（确定性骨架，不调 LLM） */
export function buildSkeletonCard(ref: SessionRef, turns: Turn[]): Card {
  const firstUser = turns.find((t) => t.role === 'user' && t.text.trim() !== '')
  const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant' && t.text.trim() !== '')
  const lastTurn = turns[turns.length - 1]

  const files = extractFilePaths(turns)
  const hints = remainingHints(turns)
  const doneExcerpt = lastAssistant !== undefined ? tailExcerpt(lastAssistant.text, 300) : ''
  const stoppedDesc = lastTurn !== undefined
    ? `最后一轮：${lastTurn.role}${lastTurn.ts !== '' ? `（${lastTurn.ts}）` : ''}${lastTurn.toolFailed ? ' ⚠ 工具调用失败' : ''}：${clip(lastTurn.text.replace(/\s+/g, ' ').trim(), 120)}`
    : '（会话无有效轮次）'

  return {
    handoff: 1,
    id: generateId(),
    from: { agent: ref.agent, session: ref.id, title: ref.title },
    to: 'any',
    project: ref.cwd !== '' ? basename(ref.cwd) : '',
    cwd: ref.cwd,
    pushed_at: new Date().toISOString(),
    git: ref.cwd !== '' && existsSync(ref.cwd) ? collectGitSnapshot(ref.cwd) : { branch: '', changed: [] },
    tasks: [],
    sections: {
      goal:
        `接手会话「${ref.title}」（${ref.agent}）的后续工作` +
        (firstUser !== undefined ? `\n\n首条用户消息：\n> ${clip(firstUser.text.trim(), 200)}` : ''),
      files: files.length > 0 ? files.map((f) => `- ${f}`).join('\n') : '（未从会话轮次中识别到文件路径）',
      done: doneExcerpt !== '' ? doneExcerpt : '（无 assistant 结论可截取——请按 from.session 指针反查原文）',
      remaining: hints.length > 0 ? hints.map((h) => `- ${h}`).join('\n') : '（未能从尾部轮次提取——请按 from.session 指针反查原文）',
      stopped: stoppedDesc,
      warnings: SKELETON_WARNING,
    },
    extras: {},
  }
}

// ---------- pull ----------

export function cmdPull(args: string[]): void {
  const { positionals } = parseArgs({ args, allowPositionals: true })
  const [agent, reference = 'latest'] = positionals
  if (agent === undefined) {
    die(`用法：handoff pull <agent> [reference]\n  agent 支持：${AGENTS.map((a) => a.name).join(' / ')}\n  reference：会话 id / id 前缀 / 路径 / 标题关键词，缺省 latest（最新会话）`)
  }
  if (!AGENTS.some((a) => a.name === agent)) {
    die(`未知 agent：${agent}（支持：${AGENTS.map((a) => a.name).join(' / ')}）`)
  }
  const adapter = AGENTS.find((a) => a.name === agent)!
  if (!adapter.supported) {
    die(`agent ${agent} 当前不可用：${adapter.note ?? '运行环境不支持'}`)
  }

  const result = resolveAgentReference(agent, reference)
  if (result.kind === 'not-found') {
    die(`未找到匹配「${reference}」的 ${agent} 会话（可先跑 handoff sessions ${agent} 看列表）`)
  }
  if (result.kind === 'ambiguous') {
    // 歧义不猜：列出候选，让用户用更精确的引用重跑
    console.error(`「${reference}」匹配到 ${result.candidates.length} 个会话，请用更精确的 id / 路径 / 标题重跑：`)
    for (const c of result.candidates) {
      console.error(`  ${c.id}  「${c.title}」  更新:${fmtTime(c.updatedAt)}`)
    }
    process.exit(1)
  }

  const ref = result.ref
  const turns = readSession(agent, ref)
  if (turns.length === 0) {
    die(`会话「${ref.title}」解析为空（记录可能损坏或加密，标不可用；请按 id 人工核查：${ref.id}）`)
  }
  const card = buildSkeletonCard(ref, turns)
  const p = writeCard(card)
  console.log(`已拉取：${card.id} ← ${agent}「${ref.title}」（${turns.length} 轮）→ ${p}`)
}
