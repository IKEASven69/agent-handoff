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
import { assertSafeId, generateId, parseCardLenient, renderCard, SAFE_ID } from './card.js'
import type { Card } from './types.js'

/** archived 滚动保留份数（SPEC 第一节） */
export const ARCHIVED_KEEP = 50

/** 单卡读取尺寸闸：收件箱按设计是多写方共享目录，读侧对外来巨文件必须有界（8 MiB 足够任何合法六段卡） */
export const MAX_CARD_BYTES = 8 * 1024 * 1024

/** 目录解析：显式 dir 优先，其次 HANDOFF_HOME（空串/空白视同未设——`??` 不滤空串，
 * 曾让收件箱静默重定向到宿主进程 cwd 的相对路径 pending/，跨进程/重启即丢卡），否则 ~/.handoff */
export function resolveHome(dir?: string): string {
  if (dir !== undefined && dir.trim() !== '') return dir
  const env = process.env['HANDOFF_HOME']
  if (env !== undefined && env.trim() !== '') return env
  return join(homedir(), '.handoff')
}

export const pendingDir = (dir?: string): string => join(resolveHome(dir), 'pending')
export const archivedDir = (dir?: string): string => join(resolveHome(dir), 'archived')

/** 渲染卡片写入 pending/，返回文件路径 */
export function writeCard(card: Card, dir?: string): string {
  const id = card.id || generateId()
  assertSafeId(id) // 外来 id 不过闸不落盘（防路径穿越）
  card.id = id
  const pd = pendingDir(dir)
  mkdirSync(pd, { recursive: true })
  const p = join(pd, `${id}.md`)
  writeFileSync(p, renderCard(card), 'utf-8')
  return p
}

/** 目录扫描报告：坏卡不拖垮列表，但逐个计数+告警（此前空 catch 静默吞掉，无跳过线索） */
export interface DirCardsReport {
  cards: Card[]
  skipped: Array<{ file: string; reason: string }>
}

function listDirCards(d: string): DirCardsReport {
  const report: DirCardsReport = { cards: [], skipped: [] }
  if (!existsSync(d)) return report
  for (const f of readdirSync(d)) {
    if (!f.endsWith('.md')) continue
    try {
      // 读侧尺寸闸：外来巨卡不整体读进内存（同步读会放大进宿主事件循环），按坏卡跳过
      if (statSync(join(d, f)).size > MAX_CARD_BYTES) {
        report.skipped.push({ file: f, reason: `卡片超过 ${MAX_CARD_BYTES} 字节上限（疑似异常文件，跳过）` })
        continue
      }
      const card = parseCardLenient(readFileSync(join(d, f), 'utf-8'), { filename: f })
      if (!SAFE_ID.test(card.id)) {
        // id 不合法的卡取件必败：列表照常给出只会造出「永远可见、永远取不走」的僵尸卡
        report.skipped.push({ file: f, reason: `卡片 id「${card.id}」不合法（load 必败，跳过）` })
        continue
      }
      // id 必须对应盘上文件（loadCard 按 <id>.md 取件）：无 frontmatter 且文件名非法的卡
      // 每次读取都现场 generateId——列表给出的 id 逐次漂移且必败，同样按坏卡跳过
      if (!existsSync(join(d, `${card.id}.md`))) {
        report.skipped.push({ file: f, reason: `卡内 id「${card.id}」与文件名不对应（load 无从取件，跳过）` })
        continue
      }
      report.cards.push(card)
    } catch (e) {
      report.skipped.push({ file: f, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  if (report.skipped.length > 0) {
    console.warn(`[handoff] ${d}：跳过 ${report.skipped.length} 张坏卡——${report.skipped.map((s) => `${s.file}（${s.reason}）`).join('；')}`)
  }
  report.cards.sort((a, b) => (b.pushed_at || '').localeCompare(a.pushed_at || '') || b.id.localeCompare(a.id))
  return report
}

/** 列 pending/（只读不消费） */
export const listPending = (dir?: string): Card[] => listPendingReport(dir).cards
/** 列 archived/（只读不消费） */
export const listArchived = (dir?: string): Card[] => listArchivedReport(dir).cards
/** 列 pending/ 并附坏卡清单（inboxList/state 用它暴露 skipped 计数） */
export const listPendingReport = (dir?: string): DirCardsReport => listDirCards(pendingDir(dir))
/** 列 archived/ 并附坏卡清单 */
export const listArchivedReport = (dir?: string): DirCardsReport => listDirCards(archivedDir(dir))

/**
 * 消费即弃（语义 3）：pending → archived，返回卡片。
 * 二次取件同一 id 报错「收件箱无此待取件」。
 */
export function loadCard(id: string, dir?: string): Card {
  assertSafeId(id) // 外来 id 不过闸不拼路径（防路径穿越）
  const src = join(pendingDir(dir), `${id}.md`)
  if (!existsSync(src)) {
    throw new Error(`收件箱无此待取件：${id}（可能已取过——消费即弃）`)
  }
  if (statSync(src).size > MAX_CARD_BYTES) {
    // 巨卡拒载不消费：报规范错误值，卡片原地保留（渲染先于归档的同一契约——失败=无副作用）
    throw new Error(`卡片超过 ${MAX_CARD_BYTES} 字节上限，拒载（卡片保留在收件箱）`)
  }
  const card = parseCardLenient(readFileSync(src, 'utf-8'), { filename: `${id}.md` })
  // 渲染先于归档：失败=无副作用的契约——不能让「报失败」与「已消费」同时发生
  try {
    renderCard(card)
  } catch (e) {
    throw new Error(`卡片无法渲染，取件被拒绝（卡片保留在收件箱）：${e instanceof Error ? e.message : String(e)}`)
  }
  const ad = archivedDir(dir)
  mkdirSync(ad, { recursive: true })
  renameSync(src, join(ad, `${id}.md`))
  // 归档滚动是善后动作：失败只告警，不把「已成功归档」表现为失败
  try {
    trimArchived(ad)
  } catch (e) {
    console.warn(`archived 滚动清理失败（取件本身已成功）：${(e as Error).message}`)
  }
  return card
}

/** archived 滚动：按 mtime 留最新 ARCHIVED_KEEP 份，其余删除；*.md 目录等异常项不进候选 */
function trimArchived(ad: string): void {
  const files: Array<{ f: string; mtime: number }> = []
  for (const f of readdirSync(ad)) {
    if (!f.endsWith('.md')) continue
    const p = join(ad, f)
    try {
      const st = statSync(p)
      if (!st.isFile()) continue // 目录等异常项不进滚动窗口（清理交人工/上层）
      files.push({ f, mtime: st.mtimeMs })
    } catch {
      continue // 单项 stat 失败跳过，不拖垮滚动
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  for (const x of files.slice(ARCHIVED_KEEP)) {
    try {
      rmSync(join(ad, x.f))
    } catch {
      // 单个删除失败跳过，尽力保持上限
    }
  }
}
