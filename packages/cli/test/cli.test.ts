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

/** 跑 CLI，捕获退出码（不 throw） */
function run(home: string, args: string[], input?: string): RunResult {
  const opts: ExecFileSyncOptions & { input?: string } = {
    encoding: 'utf-8',
    env: { ...process.env, HANDOFF_HOME: home },
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
