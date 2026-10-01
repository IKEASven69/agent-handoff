#!/usr/bin/env node
/**
 * handoff CLI：push / inbox / load / export-hippo。
 * 零三方依赖（node:util parseArgs），核心逻辑全在 @agent-handoff/core。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  archivedDir,
  assertSafeId,
  collectGitSnapshot,
  generateId,
  listPending,
  loadCard,
  parseSections,
  pendingDir,
  renderCard,
  verifyGit,
  writeCard,
  type Card,
  type TaskSnapshot,
  type TaskStatus,
} from '@agent-handoff/core'
import { cmdPull, cmdSessions } from './sessions.js'

/** 报错退出（面向用户的信息一律中文） */
function die(msg: string): never {
  console.error(msg)
  process.exit(1)
}

const USAGE = `用法：
  handoff push --agent <名> --session <指针> --title <标题> [--to <目标>] [--project <名>] [--cwd <路径>] [--file <md>]
      正文六段从 --file 或 stdin 读入；cwd 是 git 仓库时自动补 git 快照
  handoff inbox
      列出 pending（id、来源、项目、推送时间、前两条任务）
  handoff load <id>
      消费即弃：打印卡片全文 + git 核验警告
  handoff export-hippo [--file <路径>]
      把 hippo 收件箱 JSON（默认 ~/.hippo/handoff-inbox.json）转成协议卡片（幂等）
  handoff sessions [agent] [--filter <词>] [--limit <N>]
      列出发现的会话（agent/标题/更新时间/轮数）；agent 支持 claude-code / codex / opencode / zcode / pi / workbuddy / cursor / grok
  handoff pull <agent> [reference]
      读会话（id / id 前缀 / 路径 / 标题关键词，缺省 latest）→ 确定性骨架卡片写入 ~/.handoff/pending/；
      匹配歧义时列候选，不猜`

/** 读 stdin 全文 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf-8')
}

// ---------- push ----------

async function cmdPush(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      agent: { type: 'string' },
      session: { type: 'string' },
      title: { type: 'string' },
      to: { type: 'string' },
      project: { type: 'string' },
      cwd: { type: 'string' },
      file: { type: 'string' },
    },
  })
  if (!values.agent || !values.session || !values.title) {
    die('缺参数：push 必须带 --agent、--session、--title\n\n' + USAGE)
  }
  if (values.file !== undefined && !existsSync(values.file)) die(`正文文件不存在：${values.file}`)
  const body = values.file !== undefined ? readFileSync(values.file, 'utf-8') : await readStdin()
  if (body.trim() === '') die('正文为空：请用 --file <md> 或 stdin 提供六段正文')
  const cwd = values.cwd ?? process.cwd()
  const card: Card = {
    handoff: 1,
    id: generateId(),
    from: { agent: values.agent, session: values.session, title: values.title },
    to: values.to ?? 'any',
    project: values.project ?? basename(cwd),
    cwd,
    pushed_at: new Date().toISOString(),
    git: collectGitSnapshot(cwd), // 非 git 目录自动降级为空快照
    tasks: [],
    sections: parseSections(body),
    extras: {},
  }
  const p = writeCard(card)
  console.log(`已推送：${card.id} → ${p}`)
}

// ---------- inbox ----------

function cmdInbox(): void {
  const cards = listPending()
  if (cards.length === 0) {
    console.log('收件箱为空（pending/ 无待取件）')
    return
  }
  for (const c of cards) {
    console.log(
      `${c.id}  ${c.from.agent}「${c.from.title}」  项目:${c.project || '（未标）'}  推送:${c.pushed_at || '（未知）'}`,
    )
    for (const t of c.tasks.slice(0, 2)) console.log(`    [${t.status}] ${t.text}`)
  }
}

// ---------- load ----------

function cmdLoad(args: string[]): void {
  const { positionals } = parseArgs({ args, allowPositionals: true })
  const id = positionals[0]
  if (!id) die('用法：handoff load <id>')
  let card: Card
  try {
    card = loadCard(id) // 消费即弃：pending → archived
  } catch (e) {
    die((e as Error).message)
  }
  process.stdout.write(renderCard(card) + '\n')
  const v = verifyGit(card)
  if (v.unavailable !== undefined) console.error(`⚠ ${v.unavailable}`)
  for (const m of v.mismatches) console.error(`⚠ ${m}`)
}

// ---------- export-hippo ----------

/** hippo 收件箱条目（字段以方案文档调研实录⑤为准） */
interface HippoItem {
  id: string
  from: { agent: string; sessionId: string; title: string }
  to: string
  project: string
  cwd: string
  pushedAt: number // epoch 秒
  git: { branch: string; changed: string[] }
  activeTasks: Array<{ text: string; status: string; priority: string }>
  candidates: string[] // 100 字硬截断的原始候选（未经蒸馏）
}

const VALID_STATUS: TaskStatus[] = ['pending', 'in_progress', 'completed']

/** hippo InboxItem → 协议卡片（兜底映射，蒸馏层缺位时的保守填法） */
function hippoToCard(item: HippoItem): Card {
  const iso = new Date(item.pushedAt * 1000).toISOString()
  const changed = item.git?.changed ?? []
  const tasks: TaskSnapshot[] = (item.activeTasks ?? []).map(t => ({
    text: t.text,
    status: (VALID_STATUS as string[]).includes(t.status) ? (t.status as TaskStatus) : 'pending',
    priority: t.priority,
  }))
  const open = tasks.filter(t => t.status !== 'completed') // 「还差什么」= pending + in_progress
  return {
    handoff: 1,
    id: item.id,
    from: { agent: item.from.agent, session: item.from.sessionId, title: item.from.title },
    to: item.to || 'any',
    project: item.project ?? '',
    cwd: item.cwd ?? '',
    pushed_at: iso,
    git: { branch: item.git?.branch ?? '', changed },
    tasks,
    sections: {
      goal: `接手会话「${item.from.title}」（${item.from.agent}）的后续工作`,
      files: changed.length > 0 ? changed.map(f => `- ${f}`).join('\n') : '（无 git 改动记录）',
      // candidates 是 100 字截断原文，只能进「做到哪」并配固定警告（语义：需蒸馏层）
      done:
        item.candidates.length > 0
          ? item.candidates.map(c => `- ${c}`).join('\n')
          : '（无会话候选记录）',
      remaining:
        open.length > 0 ? open.map(t => `- ${t.text}`).join('\n') : '（无未完成任务）',
      stopped: `推送于 ${iso}；精确停止点请按 from.session 指针反查原文`,
      warnings: '候选为规则抽取的原始文本，未经蒸馏',
    },
    extras: {},
  }
}

function cmdExportHippo(args: string[]): void {
  const { values } = parseArgs({ args, options: { file: { type: 'string' } } })
  const file = values.file ?? join(homedir(), '.hippo', 'handoff-inbox.json')
  if (!existsSync(file)) die(`hippo 收件箱不存在：${file}`)
  const store = JSON.parse(readFileSync(file, 'utf-8')) as {
    pending?: HippoItem[]
    archived?: HippoItem[]
  }
  const pd = pendingDir()
  const ad = archivedDir()
  mkdirSync(pd, { recursive: true })
  mkdirSync(ad, { recursive: true })
  let [pNew, pSkip, aNew, aSkip] = [0, 0, 0, 0]
  /** 外来 id 过安全闸：不合规跳过并告警，不拼路径（防路径穿越） */
  const safeId = (id: string): boolean => {
    try {
      assertSafeId(id)
      return true
    } catch (e) {
      console.warn(`跳过非法 id（${(e as Error).message}）`)
      return false
    }
  }
  for (const item of store.pending ?? []) {
    if (!safeId(item.id)) continue
    const p = join(pd, `${item.id}.md`)
    if (existsSync(p)) {
      pSkip++
      continue // 幂等：已存在的 id 跳过
    }
    writeFileSync(p, renderCard(hippoToCard(item)), 'utf-8')
    pNew++
  }
  for (const item of store.archived ?? []) {
    if (!safeId(item.id)) continue
    const p = join(ad, `${item.id}.md`)
    if (existsSync(p)) {
      aSkip++
      continue
    }
    writeFileSync(p, renderCard(hippoToCard(item)), 'utf-8')
    aNew++
  }
  console.log(
    `导出完成：pending 新增 ${pNew} 份（跳过 ${pSkip} 份已存在），archived 新增 ${aNew} 份（跳过 ${aSkip} 份已存在）`,
  )
}

// ---------- 入口 ----------

async function main(): Promise<void> {
  const cmd = process.argv[2]
  const rest = process.argv.slice(3)
  switch (cmd) {
    case 'push':
      await cmdPush(rest)
      break
    case 'inbox':
      cmdInbox()
      break
    case 'load':
      cmdLoad(rest)
      break
    case 'export-hippo':
      cmdExportHippo(rest)
      break
    case 'sessions':
      cmdSessions(rest)
      break
    case 'pull':
      cmdPull(rest)
      break
    default:
      console.error(USAGE)
      process.exit(cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 1)
  }
}

await main()
