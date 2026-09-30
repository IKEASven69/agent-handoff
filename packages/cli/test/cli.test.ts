/** CLI 端到端测试：tsx 跑 src/cli.ts，HANDOFF_HOME 指到临时目录，不碰真实 ~/.handoff */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts')

interface RunResult {
  stdout: string
  stderr: string
  code: number
}

/** 跑 CLI，捕获退出码（不 throw）；extraEnv 注入适配器 root 覆盖等 */
function run(home: string, args: string[], input?: string, extraEnv?: Record<string, string>): RunResult {
  const opts: ExecFileSyncOptions & { input?: string } = {
    encoding: 'utf-8',
    env: { ...process.env, HANDOFF_HOME: home, ...extraEnv },
    input,
  }
  try {
    const stdout = String(execFileSync(process.execPath, ['--import', 'tsx', CLI, ...args], opts))
    return { stdout, stderr: '', code: 0 }
  } catch (e) {
    const err = e as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number }
    return { stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? ''), code: err.status ?? 1 }
  }
}

const tmpHome = (): string => mkdtempSync(join(tmpdir(), 'handoff-cli-'))

const BODY = ['## 目标', '', '交接测试', '', '## 涉及文件', '', '- src/cli.ts', '', '## 做到哪', '', '一半', '', '## 还差什么', '', '另一半', '', '## 停在哪', '', '这里', '', '## 读者警告', '', '无', ''].join('\n')

test('push → inbox → load 全流程；二次 load 报错', () => {
  const home = tmpHome()
  const push = run(home, ['push', '--agent', 'tester', '--session', 'sess_t1', '--title', '测试', '--cwd', home], BODY)
  assert.equal(push.code, 0, push.stderr)
  const id = /已推送：(ho-\S+)/.exec(push.stdout)?.[1]
  assert.ok(id, push.stdout)
  assert.ok(existsSync(join(home, 'pending', `${id}.md`)))

  const inbox = run(home, ['inbox'])
  assert.ok(inbox.stdout.includes(id))
  assert.ok(inbox.stdout.includes('tester「测试」'))

  const load = run(home, ['load', id])
  assert.equal(load.code, 0, load.stderr)
  assert.ok(load.stdout.includes('## 目标'))
  assert.ok(load.stdout.includes('交接测试'))
  assert.ok(existsSync(join(home, 'archived', `${id}.md`))) // 消费即弃
  assert.ok(!existsSync(join(home, 'pending', `${id}.md`)))

  const again = run(home, ['load', id])
  assert.notEqual(again.code, 0)
  assert.ok(again.stderr.includes('收件箱无此待取件'))
})

test('export-hippo：pending/archived 全转卡片，二次运行幂等跳过', () => {
  const home = tmpHome()
  const fixture = {
    pending: [
      {
        id: 'ho-e2e0-pend',
        from: { agent: 'zcode', sessionId: 'sess_x', title: '小说插件' },
        to: 'any',
        project: 'CodingProjects',
        cwd: 'D:\\CodingProjects',
        pushedAt: 1788887712.317,
        git: { branch: '', changed: [] },
        activeTasks: [
          { text: '进行中的事', status: 'in_progress', priority: 'high' },
          { text: '待办的事', status: 'pending', priority: 'mid' },
        ],
        candidates: ['候选一', '候选二'],
      },
    ],
    archived: [
      {
        id: 'ho-e2e0-arch',
        from: { agent: 'zcode', sessionId: 'sess_y', title: '旧会话' },
        to: 'any',
        project: 'p',
        cwd: '/tmp',
        pushedAt: 1788880000,
        git: { branch: 'main', changed: ['a.ts'] },
        activeTasks: [],
        candidates: [],
      },
    ],
  }
  const fixturePath = join(home, 'inbox.json')
  writeFileSync(fixturePath, JSON.stringify(fixture), 'utf-8')

  const first = run(home, ['export-hippo', '--file', fixturePath])
  assert.equal(first.code, 0, first.stderr)
  assert.ok(first.stdout.includes('pending 新增 1 份（跳过 0 份已存在）'))
  assert.ok(first.stdout.includes('archived 新增 1 份（跳过 0 份已存在）'))

  // 映射断言：candidates 进「做到哪」、pending + in_progress 都进「还差什么」、固定读者警告
  const cardText = readFileSync(join(home, 'pending', 'ho-e2e0-pend.md'), 'utf-8')
  assert.ok(cardText.includes('session: sess_x'))
  assert.ok(cardText.includes('- 候选一'))
  const remaining = cardText.split('## 还差什么')[1]!.split('## 停在哪')[0]!
  assert.ok(remaining.includes('- 进行中的事'))
  assert.ok(remaining.includes('- 待办的事'), 'pending 也进「还差什么」')
  assert.ok(cardText.includes('候选为规则抽取的原始文本，未经蒸馏'))

  const second = run(home, ['export-hippo', '--file', fixturePath])
  assert.ok(second.stdout.includes('pending 新增 0 份（跳过 1 份已存在）'))
  assert.ok(second.stdout.includes('archived 新增 0 份（跳过 1 份已存在）'))
})

test('export-hippo：非法 id 跳过并告警，不拼路径', () => {
  const home = tmpHome()
  const fixture = {
    pending: [
      {
        id: '../../evil',
        from: { agent: 'x', sessionId: 's', title: 't' },
        to: 'any',
        project: 'p',
        cwd: '/tmp',
        pushedAt: 1788880000,
        git: { branch: '', changed: [] },
        activeTasks: [],
        candidates: [],
      },
    ],
    archived: [],
  }
  const fixturePath = join(home, 'inbox.json')
  writeFileSync(fixturePath, JSON.stringify(fixture), 'utf-8')
  const r = run(home, ['export-hippo', '--file', fixturePath])
  assert.equal(r.code, 0, r.stderr)
  assert.ok(r.stdout.includes('pending 新增 0 份'), '非法 id 不计入新增')
  assert.ok(!existsSync(join(home, 'evil.md')), '不得写出 pending/ 之外')
})

test('push 缺必填参数报中文用法错', () => {
  const home = tmpHome()
  const r = run(home, ['push', '--agent', 'a'])
  assert.notEqual(r.code, 0)
  assert.ok(r.stderr.includes('缺参数'))
})

// ---------- sessions / pull（readers 集成，HANDOFF_ROOT_* 隔离真实数据） ----------

import { mkdirSync, utimesSync } from 'node:fs'

/** 造一个 claude-code 形态的项目目录：proj/<name>.jsonl，mtime 可控 */
function fakeClaudeRoot(): { root: string; env: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), 'handoff-claude-root-'))
  const proj = join(root, 'D--demo')
  mkdirSync(proj, { recursive: true })
  const mkSession = (name: string, userText: string, assistantText: string, mtimeSec: number): string => {
    const file = join(proj, `${name}.jsonl`)
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: userText }, cwd: 'D:\\demo', timestamp: '2026-08-22T10:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] }, cwd: 'D:\\demo', timestamp: '2026-08-22T10:00:05Z' }),
    ]
    writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
    utimesSync(file, mtimeSec, mtimeSec)
    return file
  }
  mkSession('插件-alpha', '帮我改造 src/cli.ts，下一步：补集成测试', '已把 src/cli.ts 的入口拆好，测试通过', 1000)
  mkSession('插件-beta', '看看 D:\\demo\\README.md 要不要更新', 'README 已更新到最新用法', 2000)
  return { root, env: { HANDOFF_ROOT_CLAUDE: root } }
}

test('sessions claude：列出发现的会话（标题/更新时间/轮数）', () => {
  const home = tmpHome()
  const { env } = fakeClaudeRoot()
  const r = run(home, ['sessions', 'claude-code'], undefined, env)
  assert.equal(r.code, 0, r.stderr)
  assert.ok(r.stdout.includes('共 2 个会话'))
  assert.ok(r.stdout.includes('「插件-alpha」'))
  assert.ok(r.stdout.includes('「插件-beta」'))
  assert.ok(r.stdout.includes('轮数:2'))
  // 按更新时间倒序：beta 在前
  assert.ok(r.stdout.indexOf('插件-beta') < r.stdout.indexOf('插件-alpha'))
})

test('sessions 过滤与未知 agent', () => {
  const home = tmpHome()
  const { env } = fakeClaudeRoot()
  const filtered = run(home, ['sessions', 'claude-code', '--filter', 'alpha'], undefined, env)
  assert.ok(filtered.stdout.includes('插件-alpha'))
  assert.ok(!filtered.stdout.includes('插件-beta'))

  const bad = run(home, ['sessions', 'not-an-agent'])
  assert.notEqual(bad.code, 0)
  assert.ok(bad.stderr.includes('未知 agent'))
})

test('pull claude-code latest：骨架卡落盘，六段非空，session 存指针', () => {
  const home = tmpHome()
  const { env } = fakeClaudeRoot()
  const r = run(home, ['pull', 'claude-code', 'latest'], undefined, env)
  assert.equal(r.code, 0, r.stderr)
  assert.ok(r.stdout.includes('已拉取：'))
  const id = /已拉取：(ho-\S+)/.exec(r.stdout)?.[1]
  assert.ok(id, r.stdout)

  const card = readFileSync(join(home, 'pending', `${id}.md`), 'utf-8')
  assert.ok(card.includes('agent: claude-code'))
  assert.ok(card.includes('session: '), 'from.session 存适配器 id（指针）')
  assert.ok(card.includes('.jsonl'), '文件系 id 是 jsonl 路径')
  const sec = (name: string, next: string): string => card.split(`## ${name}`)[1]!.split(`## ${next}`)[0]!.trim()
  assert.ok(sec('目标', '涉及文件').includes('首条用户消息'))
  assert.ok(sec('涉及文件', '做到哪').includes('README.md'), 'turns 里的文件路径进「涉及文件」')
  assert.ok(sec('做到哪', '还差什么').includes('README 已更新'))
  assert.ok(sec('还差什么', '停在哪').length > 0)
  assert.ok(sec('停在哪', '读者警告').includes('最后一轮'))
  assert.ok(card.includes('本卡为确定性骨架，未经 LLM 润色；内容均为 HISTORY_REPORTED'))
})

test('pull 歧义：标题前缀命中多个会话 → 列候选不猜，退出码非 0', () => {
  const home = tmpHome()
  const { env } = fakeClaudeRoot()
  const r = run(home, ['pull', 'claude-code', '插件'], undefined, env)
  assert.notEqual(r.code, 0)
  assert.ok(r.stderr.includes('匹配到 2 个会话'))
  assert.ok(r.stderr.includes('插件-alpha'))
  assert.ok(r.stderr.includes('插件-beta'))
  assert.equal(existsSync(join(home, 'pending')), false, '歧义时不得落盘任何卡片')
})

test('pull 歧义后用唯一前缀成功；找不到报中文错', () => {
  const home = tmpHome()
  const { env } = fakeClaudeRoot()
  const ok = run(home, ['pull', 'claude-code', '插件-alpha'], undefined, env)
  assert.equal(ok.code, 0, ok.stderr)
  assert.ok(ok.stdout.includes('「插件-alpha」'))

  const miss = run(home, ['pull', 'claude-code', '不存在'], undefined, env)
  assert.notEqual(miss.code, 0)
  assert.ok(miss.stderr.includes('未找到匹配'))
})
