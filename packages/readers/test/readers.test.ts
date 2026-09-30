/**
 * readers 单测：六家适配器喂最小真实形态样例出预期 Turn 流；
 * zcode 用 node:sqlite 造临时库（零 better-sqlite3）；引用解析歧义返回候选。
 * 运行：pnpm test（node --import tsx --test test/readers.test.ts）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

import {
  listSessions,
  readSession,
  resolveReference,
  parseCodexText,
  parseOpenCodeSession,
  parseZcodeSession,
  parsePiText,
  type SessionRef,
} from '../src/index.js'
import { claudeAdapter } from '../src/claude.js'
import { workbuddyAdapter } from '../src/workbuddy.js'

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-readers-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── claude：一条 assistant 多 content block 拆多 Turn ─────────────

test('claude_parse_splits_blocks_into_turns', () => {
  withTempDir((dir) => {
    const file = join(dir, 'ses-demo.jsonl')
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '帮我修个 bug' }, cwd: 'D:\\demo', timestamp: '2026-08-22T10:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-x', content: [
        { type: 'thinking', thinking: '先看日志' },
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
      ] }, cwd: 'D:\\demo', timestamp: '2026-08-22T10:00:05Z' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', content: 'all pass', is_error: false },
      ] }, cwd: 'D:\\demo', timestamp: '2026-08-22T10:00:06Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-x', content: [
        { type: 'text', text: '修好了' },
      ] }, cwd: 'D:\\demo', timestamp: '2026-08-22T10:00:07Z' }),
      '{not-json', // 坏行静默跳过
    ]
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')

    const turns = claudeAdapter.parse(file)
    assert.equal(turns.length, 5)
    assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'assistant', 'tool', 'assistant'])
    assert.equal(turns[1]!.text, '[thinking] 先看日志')
    assert.equal(turns[2]!.toolName, 'Bash')
  })
})

// ── codex：session_meta 给 cwd，response_item 是权威流 ────────────

test('codex_parse_text', () => {
  const text = [
    JSON.stringify({ type: 'session_meta', payload: { cwd: 'D:\\proj' } }),
    JSON.stringify({ timestamp: '2026-08-22T10:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: '做个功能' }] } }),
    JSON.stringify({ timestamp: '2026-08-22T10:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: '做个功能' } }), // UI 事件跳过
    JSON.stringify({ timestamp: '2026-08-22T10:00:02Z', type: 'response_item', payload: { type: 'function_call', name: 'shell' } }),
    JSON.stringify({ timestamp: '2026-08-22T10:00:03Z', type: 'response_item', payload: { type: 'function_call_output', output: 'Error: boom' } }),
    JSON.stringify({ timestamp: '2026-08-22T10:00:04Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: '已修复' }] } }),
  ].join('\n')
  const turns = parseCodexText(text)
  assert.equal(turns.length, 4)
  assert.deepEqual(turns.map((t) => t.role), ['user', 'tool', 'tool', 'assistant'])
  assert.equal(turns[0]!.cwd, 'D:\\proj')
  assert.equal(turns[2]!.toolFailed, true)
})

// ── opencode：三层文件存储 ────────────────────────────────────────

test('opencode_parse_three_layer_storage', () => {
  withTempDir((dir) => {
    const sesDir = join(dir, 'session', 'proj1')
    const msgDir = join(dir, 'message', 'ses_1')
    const partDir = join(dir, 'part', 'msg_1')
    mkdirSync(sesDir, { recursive: true })
    mkdirSync(msgDir, { recursive: true })
    mkdirSync(partDir, { recursive: true })
    const sesFile = join(sesDir, 'ses_1.json')
    writeFileSync(sesFile, JSON.stringify({ id: 'ses_1', directory: 'D:\\proj', title: '演示', time: { created: 1, updated: 2 } }), 'utf8')
    writeFileSync(join(msgDir, 'msg_1.json'), JSON.stringify({ id: 'msg_1', role: 'user', time: { created: 1000 } }), 'utf8')
    writeFileSync(join(partDir, 'prt_1.json'), JSON.stringify({ type: 'text', text: '你好 opencode' }), 'utf8')
    writeFileSync(join(partDir, 'prt_2.json'), JSON.stringify({ type: 'tool', tool: 'bash', text: 'ls', state: { status: 'error' } }), 'utf8')

    const turns = parseOpenCodeSession(sesFile, dir)
    assert.equal(turns.length, 2)
    assert.deepEqual(turns.map((t) => t.role), ['user', 'tool'])
    assert.equal(turns[0]!.text, '你好 opencode')
    assert.equal(turns[1]!.toolFailed, true)
  })
})

// ── pi：事件流（session 给 cwd，message.content[] 是文本块）─────────

test('pi_parse_text', () => {
  const text = [
    JSON.stringify({ type: 'session', cwd: 'D:\\pi-proj' }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '第一条消息做标题' }] } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } }),
    '{broken',
  ].join('\n')
  const turns = parsePiText(text)
  assert.equal(turns.length, 2)
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant'])
  assert.equal(turns[0]!.cwd, 'D:\\pi-proj')
})

// ── workbuddy：真实样本 fixture ──────────────────────────────────

test('workbuddy_parse_real_fixture', () => {
  const fixture = join(import.meta.dirname, '__fixtures__', 'workbuddy-sample.jsonl')
  const turns = workbuddyAdapter.parse(fixture)
  assert.ok(turns.length > 5, `应有实质轮次，got ${turns.length}`)
  assert.ok(turns.some((t) => t.role === 'user'))
  assert.ok(turns.some((t) => t.role === 'assistant'))
  assert.ok(turns.filter((t) => t.role === 'tool').length >= 4, '工具调用+结果都在')
  assert.ok(!turns.some((t) => t.text.includes('__truncated')), 'file-history-snapshot 不进 Turn')
})

// ── zcode：node:sqlite 临时库（依赖消除的验证路径）─────────────────

test('zcode_parse_temp_sqlite_db', () => {
  withTempDir((dir) => {
    const dbPath = join(dir, 'db.sqlite')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, path TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, sequence INTEGER, data TEXT);
    `)
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run('sess_t1', 'D:\\proj', '测试会话', 1000, 2000)
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m1', 'sess_t1', 1, JSON.stringify({ role: 'user', time: { created: 1500 } }))
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m2', 'sess_t1', 2, JSON.stringify({ role: 'assistant', time: { created: 1600 } }))
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run('p1', 'm1', 1, JSON.stringify({ type: 'text', text: '帮我看看 src/main.ts 的问题' }))
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run('p2', 'm2', 1, JSON.stringify({ type: 'reasoning', text: '我采用方案 X 因为 Y' }))
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run('p3', 'm2', 2, JSON.stringify({ type: 'text', text: '已修复' }))
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run('p4', 'm2', 3, JSON.stringify({ type: 'tool', tool: 'edit', state: { status: 'error', input: { file: 'a.ts' }, output: 'permission denied' } }))
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run('p5', 'm2', 4, JSON.stringify({ type: 'step-start' })) // 跳过
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run('p6', 'm2', 5, '{corrupt-json') // 损坏记录跳过
    db.close()

    const turns = parseZcodeSession('sess_t1', dbPath)
    assert.equal(turns.length, 4)
    assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'assistant', 'tool'])
    assert.equal(turns[0]!.cwd, 'D:\\proj')
    assert.equal(turns[1]!.text, '我采用方案 X 因为 Y') // reasoning → assistant
    assert.equal(turns[3]!.toolFailed, true)
    assert.equal(turns[3]!.toolName, 'edit')

    // 缺库静默为空（标不可用，不 throw）
    assert.deepEqual(parseZcodeSession('sess_t1', join(dir, 'nonexistent.sqlite')), [])
  })
})

// ── 引用解析：歧义返回候选列表，不猜 ──────────────────────────────

const mkRef = (id: string, title: string, updatedAt: number, kind: 'file' | 'sqlite' = 'sqlite'): SessionRef => ({
  agent: 'zcode', id, title, cwd: 'D:\\proj', updatedAt, fingerprint: String(updatedAt), kind,
})

test('resolveReference: latest / id 精确 / id 前缀', () => {
  const refs = [mkRef('sess_aaa111', '小说插件', 100), mkRef('sess_bbb222', '周报', 200)]
  const latest = resolveReference('latest', refs)
  assert.equal(latest.kind, 'resolved')
  assert.equal(latest.kind === 'resolved' && latest.ref.id, 'sess_bbb222')

  const exact = resolveReference('sess_aaa111', refs)
  assert.equal(exact.kind, 'resolved')
  assert.equal(exact.kind === 'resolved' && exact.ref.title, '小说插件')

  const prefix = resolveReference('sess_bbb', refs)
  assert.equal(prefix.kind, 'resolved')
  assert.equal(prefix.kind === 'resolved' && prefix.ref.id, 'sess_bbb222')
})

test('resolveReference: 歧义返回候选（按更新时间倒序），not-found 不猜', () => {
  const refs = [
    mkRef('sess_aaa111', '插件开发讨论', 100),
    mkRef('sess_aaa222', '插件发布', 300),
    mkRef('sess_ccc333', '无关会话', 200),
  ]
  const amb = resolveReference('sess_aaa', refs)
  assert.equal(amb.kind, 'ambiguous')
  assert.deepEqual(amb.kind === 'ambiguous' && amb.candidates.map((c) => c.id), ['sess_aaa222', 'sess_aaa111'])

  const titleAmb = resolveReference('插件', refs)
  assert.equal(titleAmb.kind, 'ambiguous')
  assert.equal(titleAmb.kind === 'ambiguous' && titleAmb.candidates.length, 2)

  const none = resolveReference('不存在的东西', refs)
  assert.equal(none.kind, 'not-found')

  const empty = resolveReference('latest', [])
  assert.equal(empty.kind, 'not-found')
})

test('resolveReference: 路径匹配（文件系 id=绝对路径，尾段也可命中）', () => {
  const refs = [
    { ...mkRef('D:\\home\\.claude\\projects\\p\\aaa.jsonl', '甲', 100), kind: 'file' as const },
    { ...mkRef('D:\\home\\.claude\\projects\\p\\bbb.jsonl', '乙', 200), kind: 'file' as const },
  ]
  const r = resolveReference('p\\bbb.jsonl', refs) // 路径尾段命中 → 唯一
  assert.equal(r.kind, 'resolved')
  assert.equal(r.kind === 'resolved' && r.ref.title, '乙')

  const full = resolveReference('D:\\home\\.claude\\projects\\p\\aaa.jsonl', refs) // 精确路径
  assert.equal(full.kind, 'resolved')
  assert.equal(full.kind === 'resolved' && full.ref.title, '甲')
})

// ── 公共 API：未知 agent 抛中文错；readSession 接受 id 字符串 ──────

test('listSessions/readSession: 未知 agent 抛错', () => {
  assert.throws(() => listSessions('not-an-agent'), /未知 agent/)
  assert.throws(() => readSession('not-an-agent', 'x'), /未知 agent/)
})
