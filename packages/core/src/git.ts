/** git 核验与快照：卡片快照是 HISTORY_REPORTED，核验冲突标 MISMATCH，无法核验标 UNAVAILABLE */
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Card, GitSnapshot } from './types.js'

export interface GitVerifyResult {
  mismatches: string[]
  /** 无法核验时的中文说明（UNAVAILABLE）；可核验时为空 */
  unavailable?: string
}

/** 同步跑 git，失败抛错（由调用方降级为 UNAVAILABLE，不往外 throw）。
 * `-c core.fsmonitor=false`：卡片 cwd 是外来输入，仓库本地 fsmonitor 钩子是卡片作者
 * 可布置的命令执行面（读一张卡 = 执行一段卡片作者的 shell）——快照与核验一律禁用。 */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], {
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

/** 随卡补丁上限：截断的补丁不能 apply（半截 hunk 比没有更危险），超限就整份拒带 */
export const PATCH_MAX_BYTES = 512 * 1024
/** untracked 清单上限（只列清单不带货，防 node_modules 级噪音进卡） */
export const UNTRACKED_LIST_MAX = 20

export interface UntrackedFile { file: string; bytes: number }
export interface PatchBundle {
  /** git diff HEAD 的输出；空串 = 无改动或拒带（看 truncated） */
  patch: string
  bytes: number
  /** true = diff 超 PATCH_MAX_BYTES 被整份拒带（patch 为空串）；false 且 patch 空 = 工作区干净 */
  truncated: boolean
  /** 未跟踪且未被 ignore 的新文件清单（内容不随卡，接手方需自行处理） */
  untracked: UntrackedFile[]
}

/** 推送时刻采集未提交改动补丁：git diff HEAD（已暂存+未暂存）。
 * 非 git 目录返回 null（调用方静默跳过）；unborn 分支（无 HEAD）按干净处理——
 * 没有基线就没有 diff，新文件走 untracked 清单提示。复用 fsmonitor=false 闸：
 * 卡片 cwd 是外来输入，本地钩子是卡片作者可布置的命令执行面。 */
export function collectPatch(cwd: string, maxBytes: number = PATCH_MAX_BYTES): PatchBundle | null {
  try {
    git(cwd, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    return null
  }
  let patch = ''
  try {
    patch = git(cwd, ['-c', 'core.quotePath=false', 'diff', 'HEAD'])
  } catch {
    patch = '' // unborn HEAD 等：没有可比基线，按干净处理
  }
  let untracked: UntrackedFile[] = []
  try {
    const files = git(cwd, ['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard'])
      .split('\n').filter((l) => l.trim() !== '')
    untracked = files.slice(0, UNTRACKED_LIST_MAX).map((f) => {
      let bytes = 0
      try {
        if (existsSync(join(cwd, f))) bytes = statSync(join(cwd, f)).size
      } catch { /* 单项 stat 失败按 0 */ }
      return { file: f, bytes }
    })
  } catch { /* ls-files 失败：清单留空，不挡 push */ }
  const bytes = Buffer.byteLength(patch, 'utf-8')
  if (bytes > maxBytes) return { patch: '', bytes, truncated: true, untracked }
  return { patch, bytes, truncated: false, untracked }
}
