/** ~/.handoff 目录语义：pending 待取件 / archived 已消费（滚动 50）/ 消费即弃 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { generateId, parseCardLenient, renderCard } from './card.js'
import type { Card } from './types.js'

/** archived 滚动保留份数（SPEC 第一节） */
export const ARCHIVED_KEEP = 50

/** 目录解析：HANDOFF_HOME 环境变量优先，否则 ~/.handoff */
export function resolveHome(dir?: string): string {
  return dir ?? process.env['HANDOFF_HOME'] ?? join(homedir(), '.handoff')
}

export const pendingDir = (dir?: string): string => join(resolveHome(dir), 'pending')
export const archivedDir = (dir?: string): string => join(resolveHome(dir), 'archived')

/** 渲染卡片写入 pending/，返回文件路径 */
export function writeCard(card: Card, dir?: string): string {
  const id = card.id || generateId()
  card.id = id
  const pd = pendingDir(dir)
  mkdirSync(pd, { recursive: true })
  const p = join(pd, `${id}.md`)
  writeFileSync(p, renderCard(card), 'utf-8')
  return p
}

/** 读目录下全部 .md 卡片（宽容跳过坏文件），按推送时间倒序 */
function listDirCards(d: string): Card[] {
  if (!existsSync(d)) return []
  const cards: Card[] = []
  for (const f of readdirSync(d)) {
    if (!f.endsWith('.md')) continue
    try {
      cards.push(parseCardLenient(readFileSync(join(d, f), 'utf-8'), { filename: f }))
    } catch {
      // 坏卡片不拖垮列表
    }
  }
  cards.sort((a, b) => (b.pushed_at || '').localeCompare(a.pushed_at || '') || b.id.localeCompare(a.id))
  return cards
}

export const listPending = (dir?: string): Card[] => listDirCards(pendingDir(dir))
export const listArchived = (dir?: string): Card[] => listDirCards(archivedDir(dir))

/**
 * 消费即弃（语义 3）：pending → archived，返回卡片。
 * 二次取件同一 id 报错「收件箱无此待取件」。
 */
export function loadCard(id: string, dir?: string): Card {
  const src = join(pendingDir(dir), `${id}.md`)
  if (!existsSync(src)) {
    throw new Error(`收件箱无此待取件：${id}（可能已取过——消费即弃）`)
  }
  const card = parseCardLenient(readFileSync(src, 'utf-8'), { filename: `${id}.md` })
  const ad = archivedDir(dir)
  mkdirSync(ad, { recursive: true })
  renameSync(src, join(ad, `${id}.md`))
  trimArchived(ad)
  return card
}

/** archived 滚动：按 mtime 留最新 ARCHIVED_KEEP 份，其余删除 */
function trimArchived(ad: string): void {
  const files = readdirSync(ad)
    .filter(f => f.endsWith('.md'))
    .map(f => ({ f, mtime: statSync(join(ad, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const x of files.slice(ARCHIVED_KEEP)) rmSync(join(ad, x.f))
}
