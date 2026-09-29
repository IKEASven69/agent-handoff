/** 卡片渲染与解析：严格模式（parseCard）与宽松模式（parseCardLenient，语义 3） */
import type { Card, CardFrom, CardSections, GitSnapshot, TaskSnapshot, TaskStatus } from './types.js'
import { yamlEmit, yamlParse, type YamlValue } from './yaml.js'

/** 六段固定顺序 + 可选「建议加载」 */
export const SECTION_KEYS = ['goal', 'files', 'done', 'remaining', 'stopped', 'warnings'] as const

const HEADING_TO_KEY: Record<string, keyof CardSections> = {
  目标: 'goal',
  涉及文件: 'files',
  做到哪: 'done',
  还差什么: 'remaining',
  停在哪: 'stopped',
  读者警告: 'warnings',
  建议加载: 'suggested',
}

const KEY_TO_HEADING: Record<string, string> = Object.fromEntries(
  Object.entries(HEADING_TO_KEY).map(([h, k]) => [k, h]),
)

/** 生成卡片 id：ho-<时间戳36进制>-<随机4位> */
export function generateId(): string {
  return `ho-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** 拆分 frontmatter 与正文；无 frontmatter 返回 null */
function splitFrontmatter(text: string): { front: string; body: string } | null {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return null
  return { front: m[1], body: m[2] }
}

/** 解析正文六段：按 `## 标题` 切，缺段给空，未知段忽略 */
export function parseSections(body: string): CardSections {
  const sections: CardSections = {
    goal: '',
    files: '',
    done: '',
    remaining: '',
    stopped: '',
    warnings: '',
  }
  const re = /^##\s+(.+?)\s*$/gm
  const hits: Array<{ key: keyof CardSections; start: number; end: number }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const key = HEADING_TO_KEY[m[1].trim()]
    if (key !== undefined) hits.push({ key, start: m.index, end: re.lastIndex })
  }
  hits.forEach((h, i) => {
    const next = i + 1 < hits.length ? hits[i + 1].start : body.length
    sections[h.key] = body.slice(h.end, next).trim()
  })
  return sections
}

const VALID_STATUS: TaskStatus[] = ['pending', 'in_progress', 'completed']

const asStr = (v: YamlValue | undefined, dflt = ''): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : dflt

const asMap = (v: YamlValue | undefined): Record<string, YamlValue> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, YamlValue>) : {}

/** frontmatter map → Card：缺字段给默认值，未知字段保留（版本纪律） */
export function frontmatterToCard(
  obj: Record<string, YamlValue>,
  sections: CardSections,
  fallbackId?: string,
): Card {
  const { handoff, id, from, to, project, cwd, pushed_at, git, tasks, ...rest } = obj
  const fromMap = asMap(from)
  const gitMap = asMap(git)
  const taskList = Array.isArray(tasks) ? tasks : []
  return {
    handoff: typeof handoff === 'number' ? handoff : 1,
    id: asStr(id) || fallbackId || generateId(),
    from: {
      agent: asStr(fromMap.agent),
      session: asStr(fromMap.session),
      title: asStr(fromMap.title),
      ...restOf(fromMap, ['agent', 'session', 'title']),
    } as CardFrom,
    to: asStr(to, 'any'),
    project: asStr(project),
    cwd: asStr(cwd),
    pushed_at: asStr(pushed_at),
    git: {
      branch: asStr(gitMap.branch),
      changed: Array.isArray(gitMap.changed) ? gitMap.changed.map(x => asStr(x)) : [],
      ...restOf(gitMap, ['branch', 'changed']),
    } as GitSnapshot,
    tasks: taskList.map(t => {
      const tm = asMap(t)
      const status = asStr(tm.status)
      const snap: TaskSnapshot = {
        text: asStr(tm.text),
        status: (VALID_STATUS as string[]).includes(status) ? (status as TaskStatus) : 'pending',
        ...restOf(tm, ['text', 'status']),
      }
      return snap
    }),
    sections,
    extras: rest as Record<string, unknown>,
  }
}

/** 已知键之外的透传部分 */
function restOf(obj: Record<string, YamlValue>, known: string[]): Record<string, YamlValue> {
  const out: Record<string, YamlValue> = {}
  for (const [k, v] of Object.entries(obj)) if (!known.includes(k)) out[k] = v
  return out
}

/** Card → frontmatter map（键序固定，extras 殿后） */
export function cardToFrontmatter(card: Card): Record<string, YamlValue> {
  const { agent, session, title, ...fromRest } = card.from
  const { branch, changed, ...gitRest } = card.git
  const fm: Record<string, YamlValue> = {
    handoff: card.handoff,
    id: card.id,
    from: { agent, session, title, ...(fromRest as Record<string, YamlValue>) },
    to: card.to,
    project: card.project,
    cwd: card.cwd,
    pushed_at: card.pushed_at,
    git: { branch, changed: changed as YamlValue[], ...(gitRest as Record<string, YamlValue>) },
  }
  if (card.tasks.length > 0) {
    fm.tasks = card.tasks.map(t => {
      const { text, status, ...rest } = t
      return { text, status, ...(rest as Record<string, YamlValue>) }
    })
  }
  for (const [k, v] of Object.entries(card.extras)) fm[k] = v as YamlValue
  return fm
}

/** 渲染规范卡片文本：frontmatter（块式 YAML）+ 六段正文（顺序固定） */
export function renderCard(card: Card): string {
  const parts: string[] = ['---', yamlEmit(cardToFrontmatter(card)), '---', '']
  for (const key of SECTION_KEYS) {
    parts.push(`## ${KEY_TO_HEADING[key]}`, '', card.sections[key].trim(), '')
  }
  if (card.sections.suggested?.trim()) {
    parts.push('## 建议加载', '', card.sections.suggested.trim(), '')
  }
  return parts.join('\n')
}

/** 严格模式：必须有 frontmatter；缺字段仍给默认值（版本纪律） */
export function parseCard(text: string): Card {
  const split = splitFrontmatter(text)
  if (!split) {
    throw new Error('卡片缺少 YAML frontmatter（严格模式）；无 frontmatter 的纯 Markdown 卡片请用 parseCardLenient')
  }
  let obj: Record<string, YamlValue>
  try {
    obj = yamlParse(split.front)
  } catch (e) {
    throw new Error(`frontmatter 解析失败：${(e as Error).message}`)
  }
  return frontmatterToCard(obj, parseSections(split.body))
}

/**
 * 宽松模式（语义 3）：无 frontmatter 的纯 Markdown 也能解析——
 * 六段缺段给空，id 从文件名取或按规则生成。兼容 Matt Pocock 式临时卡片。
 */
export function parseCardLenient(text: string, hint?: { filename?: string }): Card {
  const split = splitFrontmatter(text)
  if (split) return parseCard(text)
  const fromFile = hint?.filename?.replace(/\.md$/i, '')
  const fallbackId = fromFile && /^ho-.+/.test(fromFile) ? fromFile : generateId()
  return frontmatterToCard({}, parseSections(text), fallbackId)
}
