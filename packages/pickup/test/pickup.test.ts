/** pickup 端到端测试：tsx 跑 src/cli.ts，HANDOFF_HOME 指到临时目录，不碰真实 ~/.handoff */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts')

// --import 的裸名 'tsx' 相对子进程 cwd 解析；skill 用例的 cwd 是裸临时目录，必须给绝对 URL
const TSX = String(import.meta.resolve('tsx'))

interface RunResult {
  stdout: string
  stderr: string
  code: number
}

/** 跑 CLI，捕获退出码（不 throw）；cwd 覆盖用于 skill 写当前目录的用例 */
function run(home: string, args: string[], opts?: { cwd?: string }): RunResult {
  const o: ExecFileSyncOptions = {
    encoding: 'utf-8',
    env: { ...process.env, HANDOFF_HOME: home },
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
  }
  try {
    const stdout = String(execFileSync(process.execPath, ['--import', TSX, CLI, ...args], o))
    return { stdout, stderr: '', code: 0 }
  } catch (e) {
    const err = e as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number }
    return { stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? ''), code: err.status ?? 1 }
  }
}

const tmpHome = (): string => mkdtempSync(join(tmpdir(), 'pickup-home-'))

/** 六段齐全的卡片源文件（frontmatter 无 id：save 生成；cwd 指向必不存在目录→load 时 UNAVAILABLE） */
const GOOD_CARD = [
  '---',
  'handoff: 1',
  'from: { agent: tester-agent, session: "sess_pickup1", title: 取件冒烟 }',
  'to: any',
  'project: pickup-lab',
  'cwd: D:\\definitely-not-exists- pickup-test',
  'pushed_at: 2026-10-30T12:00:00+08:00',
  '---',
  '',
  '## 目标',
  '',
  '验证 pickup 四命令',
  '',
  '## 涉及文件',
  '',
  '- src/cli.ts',
  '',
  '## 做到哪',
  '',
  '- HISTORY_REPORTED：守门写完',
  '',
  '## 还差什么',
  '',
  '- 冒烟验证',
  '',
  '## 停在哪',
  '',
  '停在测试，第一步先跑 npm test',
  '',
  '## 读者警告',
  '',
  '无',
  '',
].join('\n')

test('空收件箱：打印协议一行简介 + npx 用法', () => {
  const home = tmpHome()
  const r = run(home, [])
  assert.equal(r.code, 0, r.stderr)
  assert.ok(r.stdout.includes('收件箱为空'))
  assert.ok(r.stdout.includes('handoff: 1'), '协议一行简介')
  assert.ok(r.stdout.includes('npx handoff-pickup save <card.md>'))
  assert.ok(r.stdout.includes('npx handoff-pickup load <id>'))
})

test('save→list→load 全流程：信封落盘、消费即弃、信任边界 footer', () => {
  const home = tmpHome()
  const src = join(tmpdir(), `pickup-src-${Date.now()}.md`)
  writeFileSync(src, GOOD_CARD, 'utf-8')

  const saved = run(home, ['save', src])
  assert.equal(saved.code, 0, saved.stderr)
  const id = /已保存：(ho-\S+) →/.exec(saved.stdout)?.[1]
  assert.ok(id, saved.stdout)
  assert.ok(existsSync(join(home, 'pending', `${id}.md`)), '卡片写入 pending/')
  assert.ok(existsSync(join(home, 'pending', `${id}.envelope.json`)), '最小信封写入 pending/')
  const env = JSON.parse(readFileSync(join(home, 'pending', `${id}.envelope.json`), 'utf-8'))
  assert.equal(env['handoff'], 1)
  assert.equal(env['id'], id)
  assert.equal(env['file'], `${id}.md`)
  assert.equal(env['from'], 'tester-agent')

  const list = run(home, [])
  assert.equal(list.code, 0, list.stderr)
  assert.ok(list.stdout.includes(id), '列表含 id')
  assert.ok(list.stdout.includes('tester-agent「取件冒烟」'), '列表含来源')
  assert.ok(list.stdout.includes('2026-10-30T12:00:00+08:00'), '列表含推送时间')

  const load = run(home, ['load', id])
  assert.equal(load.code, 0, load.stderr)
  for (const h of ['## 目标', '## 涉及文件', '## 做到哪', '## 还差什么', '## 停在哪', '## 读者警告']) {
    assert.ok(load.stdout.includes(h), `六段渲染含 ${h}`)
  }
  assert.ok(load.stdout.includes('HISTORY_REPORTED：守门写完'))
  assert.ok(load.stdout.includes('UNAVAILABLE'), 'cwd 不存在 → UNAVAILABLE 警告')
  assert.ok(
    load.stdout.trimEnd().endsWith('「停在哪」不明确时，先问一个聚焦问题再动手。'),
    '信任边界 footer 在输出尾部',
  )
  assert.ok(!existsSync(join(home, 'pending', `${id}.md`)), '消费即弃：卡片离开 pending/')
  assert.ok(existsSync(join(home, 'archived', `${id}.md`)), '卡片进 archived/')
  assert.ok(!existsSync(join(home, 'pending', `${id}.envelope.json`)), '信封随消费清走')

  const again = run(home, ['load', id])
  assert.notEqual(again.code, 0)
  assert.ok(again.stderr.includes('收件箱无此待取件'))
})

test('load：git 分支与 dirty 集合漂移 → MISMATCH 警告', () => {
  const home = tmpHome()
  const repo = mkdtempSync(join(tmpdir(), 'pickup-repo-'))
  const g = (args: string[]): void => {
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' })
  }
  g(['init', '-b', 'main'])
  g(['config', 'user.email', 't@t.t'])
  g(['config', 'user.name', 't'])
  writeFileSync(join(repo, 'a.txt'), 'a')
  g(['add', '.'])
  g(['commit', '-m', 'init'])

  // 卡片声称分支 other、b.txt 已改；实际在 main 且 b.txt 从未 dirty
  const card = GOOD_CARD.replace(
    'cwd: D:\\definitely-not-exists- pickup-test',
    `cwd: ${repo.replace(/\\/g, '\\\\')}`,
  )
    .replace('pushed_at: 2026-10-30T12:00:00+08:00', 'pushed_at: 2026-10-30T12:00:00+08:00\ngit: { branch: other, changed: ["b.txt"] }')
  const src = join(tmpdir(), `pickup-src-mismatch-${Date.now()}.md`)
  writeFileSync(src, card, 'utf-8')
  const saved = run(home, ['save', src])
  assert.equal(saved.code, 0, saved.stderr)
  const id = /已保存：(ho-\S+) →/.exec(saved.stdout)?.[1]
  assert.ok(id, saved.stdout)

  const load = run(home, ['load', id])
  assert.equal(load.code, 0, load.stderr)
  assert.ok(load.stdout.includes('⚠ 分支不一致'), '分支漂移警告')
  assert.ok(load.stdout.includes('b.txt'), 'dirty 集合漂移警告')
  assert.ok(load.stdout.includes('MISMATCH'))
})

test('save 拒绝：缺段逐条回喂，不落盘', () => {
  const home = tmpHome()
  const bad = GOOD_CARD
    .replace('## 还差什么', '## 还差什么呢占位') // 改标题 → 该段按缺失计
    .replace('## 读者警告', '## 读者须知')
  const src = join(tmpdir(), `pickup-src-missing-${Date.now()}.md`)
  writeFileSync(src, bad, 'utf-8')
  const r = run(home, ['save', src])
  assert.notEqual(r.code, 0)
  assert.ok(r.stderr.includes('已拒绝写入'), '逐条理由回喂')
  assert.ok(r.stderr.includes('「还差什么」'), '缺段 1 点名')
  assert.ok(r.stderr.includes('「读者警告」'), '缺段 2 点名')
  assert.equal(existsSync(join(home, 'pending')), false, '拒绝时不落盘')
})

test('save 拒绝：密钥命中回喂（AWS/GitHub/私钥头/JWT），掩码预览不泄全串', () => {
  const home = tmpHome()
  const leaky = GOOD_CARD.replace('- HISTORY_REPORTED：守门写完', [
    '- HISTORY_REPORTED：守门写完',
    '- 里面不小心带了：AKIAIOSFODNN7EXAMPLE',
    '- ghp_TESTTESTTESTTESTTEST0',
    '-----BEGIN RSA PRIVATE KEY-----',
    '- eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fWPmeZZZZZ999',
  ].join('\n'))
  const src = join(tmpdir(), `pickup-src-leaky-${Date.now()}.md`)
  writeFileSync(src, leaky, 'utf-8')
  const r = run(home, ['save', src])
  assert.notEqual(r.code, 0)
  assert.ok(r.stderr.includes('AWS Access Key'), 'AWS 命中')
  assert.ok(r.stderr.includes('GitHub token'), 'GitHub 命中')
  assert.ok(r.stderr.includes('私钥文件头'), '私钥头命中')
  assert.ok(r.stderr.includes('JWT'), 'JWT 命中')
  assert.ok(r.stderr.includes(`AKIA${'*'.repeat(14)}LE`), '掩码：只露前 4 后 2')
  assert.ok(!r.stderr.includes('AKIAIOSFODNN7EXAMPLE'), '回喂不给完整泄漏串')
  assert.equal(existsSync(join(home, 'pending')), false, '拒绝时不落盘')
})

test('save 拒绝：frontmatter id 非法（id 形态闸，防路径穿越）', () => {
  const home = tmpHome()
  const evil = GOOD_CARD.replace(
    'from: { agent: tester-agent',
    'id: ../../evil\nfrom: { agent: tester-agent',
  )
  const src = join(tmpdir(), `pickup-src-evil-${Date.now()}.md`)
  writeFileSync(src, evil, 'utf-8')
  const r = run(home, ['save', src])
  assert.notEqual(r.code, 0)
  assert.ok(r.stderr.includes('id 闸'))
  assert.ok(r.stderr.includes('不合法'))
  assert.equal(existsSync(join(home, 'evil.md')), false, '不得写出 pending/ 之外')
  assert.equal(existsSync(join(home, 'pending')), false, '拒绝时不落盘')
})

test('skill：SKILL.md 写进当前目录 .claude/skills/handoff/；--print 输出 AGENTS.md 片段不落盘', () => {
  const home = tmpHome()
  const workA = mkdtempSync(join(tmpdir(), 'pickup-cwd-a-'))
  const w = run(home, ['skill'], { cwd: workA })
  assert.equal(w.code, 0, w.stderr)
  const skillPath = join(workA, '.claude', 'skills', 'handoff', 'SKILL.md')
  assert.ok(existsSync(skillPath))
  const skill = readFileSync(skillPath, 'utf-8')
  for (const kw of ['证据账本四态', '原文不进卡片', '不重复已有产物', 'redact 是生产者义务', '建议加载', '反向锚定']) {
    assert.ok(skill.includes(kw), `SKILL.md 含纪律关键词：${kw}`)
  }
  assert.ok(skill.includes('50%'), '纪律含回测数据')
  assert.ok(skill.includes('信任边界'), '含读侧安全规则')

  const workB = mkdtempSync(join(tmpdir(), 'pickup-cwd-b-'))
  const p = run(home, ['skill', '--print'], { cwd: workB })
  assert.equal(p.code, 0, p.stderr)
  assert.ok(p.stdout.includes('## Handoff 交接纪律'))
  assert.ok(p.stdout.includes('50%'))
  assert.equal(existsSync(join(workB, '.claude')), false, '--print 不落盘')
})

test('load 缺 id / save 缺文件 / 未知命令 → 中文报错', () => {
  const home = tmpHome()
  const noId = run(home, ['load'])
  assert.notEqual(noId.code, 0)
  assert.ok(noId.stderr.includes('用法'))

  const noFile = run(home, ['save', join(tmpdir(), 'pickup-no-such-card.md')])
  assert.notEqual(noFile.code, 0)
  assert.ok(noFile.stderr.includes('不存在'))

  const bad = run(home, ['frobnicate'])
  assert.notEqual(bad.code, 0)
  assert.ok(bad.stderr.includes('未知命令'))
})
