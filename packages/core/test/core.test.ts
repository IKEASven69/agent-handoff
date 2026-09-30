/** core 测试：node:test + node:assert，tsx 跑源码 */
import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  archivedDir,
  collectGitSnapshot,
  generateId,
  listArchived,
  listPending,
  loadCard,
  parseCard,
  parseCardLenient,
  renderCard,
  verifyGit,
  writeCard,
  type Card,
} from '../src/index.js'

const tmpHome = (): string => mkdtempSync(join(tmpdir(), 'handoff-test-'))

const sampleCard = (): Card => ({
  handoff: 1,
  id: generateId(),
  from: { agent: 'claude-code', session: 'sess_abc-123', title: '测试会话' },
  to: 'any',
  project: 'agent-handoff',
  cwd: 'D:\\CodingProjects\\agent-handoff',
  pushed_at: '2026-09-29T22:00:00+08:00',
  git: { branch: 'main', changed: ['src/a.ts', 'README.md'] },
  tasks: [{ text: '写测试', status: 'in_progress', priority: 'high' }],
  sections: {
    goal: '把会话交接出去',
    files: '- src/a.ts\n- README.md',
    done: 'core 写完了',
    remaining: '还差 cli',
    stopped: '停在写测试',
    warnings: '别信快照，先核对',
  },
  extras: {},
})

test('write→parse 往返：字段与六段全保真', () => {
  const home = tmpHome()
  const card = sampleCard()
  const p = writeCard(card, home)
  assert.ok(p.endsWith(`${card.id}.md`))
  const back = parseCard(readFileSync(p, 'utf-8'))
  assert.equal(back.id, card.id)
  assert.deepEqual(back.from, card.from)
  assert.equal(back.to, 'any')
  assert.equal(back.project, 'agent-handoff')
  assert.equal(back.cwd, card.cwd)
  assert.equal(back.pushed_at, card.pushed_at)
  assert.deepEqual(back.git, card.git)
  assert.deepEqual(back.tasks, card.tasks)
  assert.deepEqual(back.sections, card.sections)
})

test('宽松解析：无 frontmatter 的纯 Markdown（Matt Pocock 式卡片）', () => {
  const md = `## 目标\n\n修 bug\n\n## 停在哪\n\n第 3 步，先跑测试\n`
  const c = parseCardLenient(md, { filename: 'ho-mtsxk0u5-esin.md' })
  assert.equal(c.id, 'ho-mtsxk0u5-esin') // id 从文件名取
  assert.equal(c.handoff, 1)
  assert.equal(c.to, 'any')
  assert.equal(c.sections.goal, '修 bug')
  assert.equal(c.sections.stopped, '第 3 步，先跑测试')
  assert.equal(c.sections.done, '') // 缺段给空
  assert.deepEqual(c.git.changed, [])
  // 无文件名提示时按规则生成
  const c2 = parseCardLenient(md)
  assert.match(c2.id, /^ho-[a-z0-9]+-[a-z0-9]{4}$/)
})

test('严格模式：无 frontmatter 报中文错', () => {
  assert.throws(() => parseCard('## 目标\n\nx\n'), /frontmatter/)
})

test('消费即弃 + 二次取件报错', () => {
  const home = tmpHome()
  const card = sampleCard()
  writeCard(card, home)
  const got = loadCard(card.id, home)
  assert.equal(got.id, card.id)
  assert.equal(listPending(home).length, 0)
  assert.equal(listArchived(home).length, 1)
  assert.throws(() => loadCard(card.id, home), /收件箱无此待取件/)
})

test('archived 滚动保留 50 份', () => {
  const home = tmpHome()
  for (let i = 0; i < 55; i++) {
    const card = sampleCard()
    card.id = `ho-${(1788887000000 + i).toString(36)}-${i.toString(36).padStart(4, '0')}`
    card.pushed_at = new Date(1788887000000 + i * 1000).toISOString()
    writeCard(card, home)
  }
  for (const c of listPending(home)) loadCard(c.id, home)
  assert.equal(listPending(home).length, 0)
  assert.equal(listArchived(home).length, 50)
})

test('Windows 路径：反斜杠 cwd 渲染/解析往返不变', () => {
  const card = sampleCard()
  card.cwd = 'D:\\CodingProjects\\dsh-hippo\\src\\hippo'
  const back = parseCard(renderCard(card))
  assert.equal(back.cwd, 'D:\\CodingProjects\\dsh-hippo\\src\\hippo')
})

test('verifyGit：非 git 目录降级 UNAVAILABLE，不 throw', () => {
  const card = sampleCard()
  card.cwd = mkdtempSync(join(tmpdir(), 'handoff-notgit-'))
  const r = verifyGit(card)
  assert.ok(r.unavailable?.includes('UNAVAILABLE'))
  assert.deepEqual(r.mismatches, [])
})

test('verifyGit：cwd 不存在降级 UNAVAILABLE，不 throw', () => {
  const card = sampleCard()
  card.cwd = join(tmpdir(), 'handoff-no-such-dir-xyz')
  const r = verifyGit(card)
  assert.ok(r.unavailable?.includes('UNAVAILABLE'))
})

test('verifyGit：真实仓库一致无 mismatch，改脏后报 MISMATCH', () => {
  const repo = mkdtempSync(join(tmpdir(), 'handoff-repo-'))
  const g = (args: string[]): string =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' }).trim()
  g(['init', '-b', 'main'])
  g(['config', 'user.email', 't@t.t'])
  g(['config', 'user.name', 't'])
  writeFileSync(join(repo, 'a.txt'), 'a')
  g(['add', '.'])
  g(['commit', '-m', 'init'])
  const card = sampleCard()
  card.cwd = repo
  card.git = { branch: 'main', changed: [] }
  assert.deepEqual(verifyGit(card).mismatches, [])
  // 改脏 + 分支不一致
  writeFileSync(join(repo, 'b.txt'), 'b')
  card.git = { branch: 'other', changed: [] }
  const r = verifyGit(card)
  assert.ok(r.mismatches.some(m => m.includes('分支不一致')))
  assert.ok(r.mismatches.some(m => m.includes('b.txt')))
  assert.ok(r.mismatches.every(m => m.includes('MISMATCH')))
})

test('缺字段给默认值（版本纪律）', () => {
  const text = [
    '---',
    'handoff: 1',
    'id: ho-minimal-test1',
    'from: { agent: a, session: "sess_x" }',
    '---',
    '',
    '## 目标',
    '',
    '最小卡片',
    '',
  ].join('\n')
  const c = parseCard(text)
  assert.equal(c.to, 'any')
  assert.equal(c.from.title, '')
  assert.equal(c.project, '')
  assert.equal(c.git.branch, '')
  assert.deepEqual(c.git.changed, [])
  assert.deepEqual(c.tasks, [])
  assert.equal(c.sections.goal, '最小卡片')
  assert.equal(c.sections.warnings, '')
})

test('未知字段保留不报错，写回原样带回', () => {
  const text = [
    '---',
    'handoff: 1',
    'id: ho-extra-test01',
    'from: { agent: a, session: "s", mood: happy }',
    'custom_field: hello',
    'custom_num: 42',
    '---',
    '',
    '## 目标',
    '',
    'x',
    '',
  ].join('\n')
  const c = parseCard(text)
  assert.equal(c.extras['custom_field'], 'hello')
  assert.equal(c.extras['custom_num'], 42)
  assert.equal(c.from['mood'], 'happy')
  const out = renderCard(c)
  assert.ok(out.includes('custom_field: hello'))
  assert.ok(out.includes('mood: happy'))
  // 再解析一遍仍保留
  const c2 = parseCard(out)
  assert.equal(c2.extras['custom_field'], 'hello')
})

test('tasks 支持块式与 flow 两种写法，非法 status 归一为 pending', () => {
  const block = parseCard(
    [
      '---',
      'id: ho-tasks-block1',
      'from: { agent: a, session: "s" }',
      'tasks:',
      '  - text: "块式任务"',
      '    status: in_progress',
      '    priority: high',
      '---',
      '',
    ].join('\n'),
  )
  assert.deepEqual(block.tasks, [{ text: '块式任务', status: 'in_progress', priority: 'high' }])
  const flow = parseCard(
    [
      '---',
      'id: ho-tasks-flow01',
      'from: { agent: a, session: "s" }',
      'tasks:',
      '  - { text: "flow 任务", status: weird }',
      '---',
      '',
    ].join('\n'),
  )
  assert.deepEqual(flow.tasks, [{ text: 'flow 任务', status: 'pending' }])
})

test('可选「建议加载」段渲染与解析', () => {
  const card = sampleCard()
  card.sections.suggested = 'handoff, frontend-design'
  const back = parseCard(renderCard(card))
  assert.equal(back.sections.suggested, 'handoff, frontend-design')
  // 无该段时不渲染
  const plain = renderCard(sampleCard())
  assert.ok(!plain.includes('## 建议加载'))
})

test('listPending 按推送时间倒序', () => {
  const home = tmpHome()
  mkdirSync(home, { recursive: true })
  const mk = (id: string, at: string): void => {
    const card = sampleCard()
    card.id = id
    card.pushed_at = at
    writeCard(card, home)
  }
  mk('ho-older-0001', '2026-09-01T00:00:00+08:00')
  mk('ho-newer-0001', '2026-09-29T00:00:00+08:00')
  const list = listPending(home)
  assert.equal(list.length, 2)
  assert.equal(list[0].id, 'ho-newer-0001')
})

test('文件名规则：ho-<时间戳36进制>-<随机4位>', () => {
  const id = generateId()
  assert.match(id, /^ho-[a-z0-9]+-[a-z0-9]{4}$/)
})

// ---------- 代码审查回归（🔴1/🔴2/🟡3/🟡4/🟡5 + 顺手修） ----------

test('回归🔴1：带引号且含冒号的字符串列表项回读不炸（isKeyLine 不误判）', () => {
  const card = sampleCard()
  card.git = { branch: 'main', changed: ['weird: name.ts', 'plain.ts'] }
  const back = parseCard(renderCard(card))
  assert.deepEqual(back.git.changed, ['weird: name.ts', 'plain.ts'])
})

test('回归🔴2：含换行的标量加引号转义，emit→parse 往返保真', () => {
  const card = sampleCard()
  card.tasks = [{ text: 'a\nb', status: 'pending' }]
  const back = parseCard(renderCard(card))
  assert.equal(back.tasks[0]!.text, 'a\nb')
  // 整卡：正文「做到哪」段带换行候选 + 任务带换行，write→parse 往返
  const home = tmpHome()
  card.sections.done = '- 第一行\n  第二行续行\n- 另一条候选'
  const p = writeCard(card, home)
  const back2 = parseCard(readFileSync(p, 'utf-8'))
  assert.equal(back2.sections.done, card.sections.done)
  assert.equal(back2.tasks[0]!.text, 'a\nb')
})

test('回归🟡3：loadCard/writeCard 拒绝外来 id（路径穿越闸）', () => {
  const home = tmpHome()
  assert.throws(() => loadCard('../../x', home), /非法卡片 id/)
  const card = sampleCard()
  card.id = '../../x'
  assert.throws(() => writeCard(card, home), /非法卡片 id/)
  assert.ok(!existsSync(join(home, '..', '..', 'x.md')))
  // 宽松模式：外来文件名 id 不合规就重新生成，不沿用
  const c = parseCardLenient('## 目标\n\nx\n', { filename: '../../x.md' })
  assert.match(c.id, /^ho-[a-z0-9]+-[a-z0-9]{4}$/)
  const c2 = parseCardLenient('## 目标\n\nx\n', { filename: 'ho-NotSafe.md' })
  assert.match(c2.id, /^ho-[a-z0-9]+-[a-z0-9]{4}$/)
  assert.notEqual(c2.id, 'ho-NotSafe')
})

test('回归🟡4：archived 滚动清理失败只告警，不影响 load 结果', () => {
  const home = tmpHome()
  const card = sampleCard()
  writeCard(card, home)
  // 造一个名为 .md 的目录，mtime 最旧，trim 时 rmSync 必抛
  const ad = archivedDir(home)
  mkdirSync(ad, { recursive: true })
  for (let i = 0; i < 51; i++) writeFileSync(join(ad, `ho-f${i.toString(36)}-${i.toString(36).padStart(4, '0')}.md`), 'x')
  const trap = join(ad, 'ho-trap0-0000.md')
  mkdirSync(trap)
  const past = new Date(2000, 0, 1)
  utimesSync(trap, past, past)
  const warn = mock.method(console, 'warn', () => {})
  try {
    const got = loadCard(card.id, home)
    assert.equal(got.id, card.id, 'trim 抛错不影响取件结果')
  } finally {
    warn.mock.restore()
  }
  assert.equal(warn.mock.callCount(), 1, '失败只告警一次')
  assert.ok(String(warn.mock.calls[0]!.arguments[0]).includes('滚动清理失败'))
})

test('回归🟡5：中文文件名快照不含八进制转义（core.quotePath=false）', () => {
  const repo = mkdtempSync(join(tmpdir(), 'handoff-repo-'))
  const g = (args: string[]): string =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' }).trim()
  g(['init', '-b', 'main'])
  g(['config', 'user.email', 't@t.t'])
  g(['config', 'user.name', 't'])
  writeFileSync(join(repo, '中文文件.txt'), '中文')
  const snap = collectGitSnapshot(repo)
  assert.ok(snap.changed.includes('中文文件.txt'), `快照应含原样中文路径：${snap.changed.join(',')}`)
  assert.ok(!snap.changed.some(f => f.includes('\\')), '不得含反斜杠转义')
  // 核验端同口径：卡片记录中文路径，verifyGit 不报 MISMATCH
  const card = sampleCard()
  card.cwd = repo
  card.git = snap
  assert.deepEqual(verifyGit(card).mismatches, [])
})

test('顺手修：单引号字符串内 \'\' 转义按 YAML 规则解析', () => {
  const c = parseCard(
    ['---', 'id: ho-quote-0001', "from: { agent: a, session: 'it''s a ptr' }", '---', ''].join('\n'),
  )
  assert.equal(c.from.session, "it's a ptr")
})

test('顺手修：emitMap 拒绝含冒号的 key，不静默错位', () => {
  const card = sampleCard()
  card.extras = { 'bad:key': 'v' }
  assert.throws(() => renderCard(card), /YAML 键无法安全输出/)
})
