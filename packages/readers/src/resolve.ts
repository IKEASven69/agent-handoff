/**
 * 会话引用解析：id 精确 / id 前缀 / 路径 / 标题模糊（大小写不敏感子串）。
 * 体验基准：匹配歧义时返回候选列表，绝不替用户猜。
 */
import type { SessionRef } from './types.js'

export type ResolveResult =
  | { kind: 'resolved'; ref: SessionRef }
  | { kind: 'ambiguous'; candidates: SessionRef[] }
  | { kind: 'not-found'; reference: string }

/** 路径形态判断：含分隔符或盘符即按路径匹配（文件系适配器的 id 就是绝对路径）。 */
function looksLikePath(reference: string): boolean {
  return /[\\/]/.test(reference) || /^[A-Za-z]:/.test(reference)
}

const normPath = (p: string): string => p.replace(/\//g, '\\').toLowerCase()

/**
 * 在 refs 中解析 reference：
 * - 'latest' / 空串 → 最新一条；
 * - id 精确命中 → 直接返回；
 * - 其余策略（id 前缀、路径、标题子串）合并候选，1 条解析、多条歧义、0 条 not-found。
 */
export function resolveReference(reference: string, refs: SessionRef[]): ResolveResult {
  const sorted = [...refs].sort((a, b) => b.updatedAt - a.updatedAt)
  const q = reference.trim()
  if (q === '' || q.toLowerCase() === 'latest') {
    return sorted.length > 0
      ? { kind: 'resolved', ref: sorted[0]! }
      : { kind: 'not-found', reference }
  }

  const exact = sorted.find((r) => r.id === q)
  if (exact !== undefined) return { kind: 'resolved', ref: exact }

  const candidates = new Map<string, SessionRef>()
  const push = (r: SessionRef): void => {
    candidates.set(r.id, r)
  }

  // id 前缀（sqlite 系短 id 的常规用法；前缀长度不设下限——歧义由候选列表兜住）
  for (const r of sorted) {
    if (r.id.startsWith(q) || (r.kind === 'file' && normPath(r.id).startsWith(normPath(q)))) push(r)
  }
  // 路径：精确（规范化）或尾段匹配（用户可能只给了路径尾部）
  if (looksLikePath(q)) {
    const nq = normPath(q)
    for (const r of sorted) {
      if (r.kind !== 'file') continue
      const nid = normPath(r.id)
      if (nid === nq || nid.endsWith(nq)) push(r)
    }
  }
  // 标题模糊：大小写不敏感子串
  const lq = q.toLowerCase()
  for (const r of sorted) {
    if (r.title.toLowerCase().includes(lq)) push(r)
  }

  const list = [...candidates.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  if (list.length === 1) return { kind: 'resolved', ref: list[0]! }
  if (list.length > 1) return { kind: 'ambiguous', candidates: list }
  return { kind: 'not-found', reference }
}
