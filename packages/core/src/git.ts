/** git 核验与快照：卡片快照是 HISTORY_REPORTED，核验冲突标 MISMATCH，无法核验标 UNAVAILABLE */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { Card, GitSnapshot } from './types.js'

export interface GitVerifyResult {
  mismatches: string[]
  /** 无法核验时的中文说明（UNAVAILABLE）；可核验时为空 */
  unavailable?: string
}

/** 同步跑 git，失败抛错（由调用方降级为 UNAVAILABLE，不往外 throw） */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/** `git status --porcelain` 输出 → 文件路径列表（处理改名 `old -> new`） */
export function porcelainPaths(out: string): string[] {
  return out
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => {
      let p = l.slice(3)
      const arrow = p.indexOf(' -> ')
      if (arrow !== -1) p = p.slice(arrow + 4)
      return p.replace(/^"|"$/g, '')
    })
}

/** 推送时刻快照采集：非 git 目录静默降级为空快照 */
export function collectGitSnapshot(cwd: string): GitSnapshot {
  try {
    return {
      branch: git(cwd, ['branch', '--show-current']),
      // quotePath=false：中文等非 ASCII 路径不转八进制，原样输出
      changed: porcelainPaths(git(cwd, ['-c', 'core.quotePath=false', 'status', '--porcelain'])),
    }
  } catch {
    return { branch: '', changed: [] }
  }
}

/** 取件核验：分支或 dirty 集合与卡片快照不一致 → 中文 mismatch；cwd 不在/git 失败 → UNAVAILABLE 不 throw */
export function verifyGit(card: Card): GitVerifyResult {
  const cwd = card.cwd
  if (!cwd) return { mismatches: [], unavailable: '卡片未记录 cwd，git 核验不可用（UNAVAILABLE）' }
  if (!existsSync(cwd)) {
    return { mismatches: [], unavailable: `工作目录不存在：${cwd}，git 核验不可用（UNAVAILABLE）` }
  }
  let branch: string
  let changed: string[]
  try {
    branch = git(cwd, ['branch', '--show-current'])
    changed = porcelainPaths(git(cwd, ['-c', 'core.quotePath=false', 'status', '--porcelain']))
  } catch (e) {
    const msg = (e as Error).message.split('\n')[0]
    return { mismatches: [], unavailable: `git 核验失败（${cwd} 可能不是 git 仓库）：${msg}（UNAVAILABLE）` }
  }
  const mismatches: string[] = []
  if (branch !== card.git.branch) {
    mismatches.push(`分支不一致：卡片记录「${card.git.branch || '（空）'}」，当前「${branch || '（空）'}」（MISMATCH）`)
  }
  const recorded = new Set(card.git.changed)
  const now = new Set(changed)
  const gone = [...recorded].filter(f => !now.has(f))
  const added = [...now].filter(f => !recorded.has(f))
  if (gone.length > 0) mismatches.push(`卡片记录已改动、当前已不 dirty 的文件：${gone.join('、')}（MISMATCH）`)
  if (added.length > 0) mismatches.push(`当前 dirty 但卡片未记录的文件：${added.join('、')}（MISMATCH）`)
  return { mismatches }
}
