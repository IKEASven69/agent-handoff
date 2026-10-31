/**
 * readers 单测：九家适配器喂最小真实形态样例出预期 Turn 流；
 * zcode / cursor store 用 node:sqlite 造临时库（零 better-sqlite3）；引用解析歧义返回候选。
 * cursor / grok 以 fixtures 为准（本机无真实安装，无实机验证）；
 * gemini 全部手工构造临时目录 fixture（新旧双格式 / 子代理嵌套 / 坏行跳过 / 中文），不依赖真实安装。
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
  parseCursorTranscriptText,
  parseCursorStore,
  renderCursorValue,
  decodeCursorBlob,
  parseGrokSession,
  parseGrokUpdatesText,
  parseGeminiText,
  parseGeminiJson,
  parseGeminiSession,
  type SessionRef,
} from '../src/index.js'
import { claudeAdapter } from '../src/claude.js'
import { workbuddyAdapter } from '../src/workbuddy.js'
import { cursorAdapter } from '../src/cursor.js'
import { grokAdapter } from '../src/grok.js'
import { geminiAdapter } from '../src/gemini.js'
import { opencodeAdapter as opencodeAdapterReal } from '../src/opencode.js'
import { FAKE_ZERO_NOTE } from '../src/types.js'

/** 适配器 note 是否已被置为假 0 哨兵（不比对整个字符串，出错时再展开） */
function assertSentinel(note: string | undefined, label: string): void {
  assert.equal(note, FAKE_ZERO_NOTE, `${label} 应置假 0 哨兵，got ${JSON.stringify(note)}`)
}

/**
 * 假 0 哨兵测试基建：适配器 ROOT 是模块加载时读的环境变量常量，
 * 用「设 env + query 串 bust 缓存」拿一份以临时目录为根的新鲜模块实例。
 */
async function freshAdapter<T>(module: 'codex' | 'cursor' | 'grok' | 'opencode' | 'gemini', envKey: string, root: string, query: string): Promise<T> {
  process.env[envKey] = root
  try {
    const m = await import(`../src/${module}.ts?sentinel-${module}-${query}`)
    const key = `${module}Adapter` as keyof typeof m
    return m[key] as T
  } finally {
    delete process.env[envKey]
  }
}

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
    assert.equal(turns[1]!.text, '[thinking] 我采用方案 X 因为 Y') // reasoning → assistant（带标记，蒸馏可剔除）
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

// ── cursor：transcript JSONL（role value 流，恢复边界纪律）───────────

test('cursor_parse_transcript_text', () => {
  const text = [
    // 系统提示 / 前言 / 隐藏推理：整条跳过
    JSON.stringify({ role: 'system', content: [{ type: 'text', text: '你是助手' }] }),
    JSON.stringify({ role: 'preamble', content: 'preamble 注入' }),
    JSON.stringify({ type: 'thinking', role: 'assistant', content: [{ type: 'text', text: '隐藏推理' }] }),
    // user：<user_query> 抽取优先
    JSON.stringify({ role: 'user', content: [{ type: 'text', text: '<environment_context>os: win</environment_context>\n<user_query> 修一下登录页 </user_query>' }] }),
    // user：包装注入开头整条丢弃
    JSON.stringify({ role: 'user', content: [{ type: 'text', text: '<user_instructions>注入指令</user_instructions>' }] }),
    // assistant：生成元文本（XML 标签开头）丢弃，正常正文保留；thinking/signature 块跳过
    JSON.stringify({ role: 'assistant', content: [
      { type: 'thinking', thinking: '先想想' },
      { type: 'text', text: '<system_reminder>元文本</system_reminder>' },
      { type: 'text', text: '好的，我来改' },
      { type: 'tool_use', name: 'Edit', input: { file_path: 'src/login.ts' } },
    ] }),
    // 顶层 tool_calls（OpenAI 形态，arguments 是 JSON 字符串）
    JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'Bash', arguments: '{"command":"pnpm test"}' } }] }),
    // tool_result 块：is_error → toolFailed
    JSON.stringify({ role: 'user', content: [{ type: 'tool_result', content: 'Error: boom', is_error: true }] }),
    // role=tool 裸记录：整条 content 就是输出
    JSON.stringify({ role: 'tool', content: [{ type: 'text', text: 'ok done' }] }),
    // 嵌套容器：messages 数组递归展开
    JSON.stringify({ messages: [
      { role: 'user', content: [{ type: 'text', text: '嵌套的用户消息' }] },
      { role: 'assistant', content: [{ type: 'text', text: '嵌套的助手回复' }] },
    ] }),
    '{broken-line',
  ].join('\n')
  const turns = parseCursorTranscriptText(text)
  assert.deepEqual(turns.map((t) => t.role), [
    'user', 'assistant', 'assistant', 'assistant', 'tool', 'tool', 'user', 'assistant',
  ])
  assert.equal(turns[0]!.text, '修一下登录页') // <user_query> 抽取 + 环境包装剔除
  assert.equal(turns[1]!.text, '好的，我来改')
  assert.equal(turns[2]!.toolName, 'Edit')
  assert.equal(turns[3]!.toolName, 'Bash')
  assert.equal(turns[3]!.text, 'pnpm test')
  assert.equal(turns[4]!.toolFailed, true)
  assert.equal(turns[5]!.text, 'ok done')
  assert.equal(turns[6]!.text, '嵌套的用户消息')
})

test('cursor_render_value_rejects_non_object_and_unknown_role', () => {
  assert.deepEqual(renderCursorValue('not-an-object'), [])
  assert.deepEqual(renderCursorValue({ role: 'developer', content: 'x' }), [])
  assert.deepEqual(renderCursorValue({ role: 'assistant' }), []) // 无内容
  assert.deepEqual(decodeCursorBlob(Buffer.from([0xff, 0xfe, 0xfd])), null) // 二进制标不可用
  assert.deepEqual(decodeCursorBlob(''), null)
})

// ── cursor：CLI store.db（node:sqlite 临时库；JSON / hex / 二进制三种 blob）──

test('cursor_parse_store_db', () => {
  withTempDir((dir) => {
    const dbPath = join(dir, 'store.db')
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)')
    const insert = db.prepare('INSERT INTO blobs VALUES (?, ?)')
    insert.run('b1', JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'store 里的用户消息' }] }))
    // 十六进制编码的 JSON（cursor 偶发形态）
    insert.run('b2', Buffer.from(JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'hex 编码的助手回复' }] }), 'utf8').toString('hex'))
    // 二进制 / protobuf：标不可用（跳过），不臆造
    insert.run('b3', Buffer.from([0x00, 0xff, 0xfe, 0xfd, 0x01]))
    db.close()

    const turns = parseCursorStore(dbPath)
    assert.equal(turns.length, 2)
    assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant'])
    assert.equal(turns[0]!.text, 'store 里的用户消息')
    assert.equal(turns[1]!.text, 'hex 编码的助手回复')

    // 缺库静默为空（标不可用，不 throw）
    assert.deepEqual(parseCursorStore(join(dir, 'nonexistent.db')), [])
  })
})

test('cursor_adapter_parse_routes_by_id_shape', () => {
  withTempDir((dir) => {
    const file = join(dir, 'sid-1.jsonl')
    writeFileSync(file, JSON.stringify({ role: 'user', content: '走 transcript 分支' }) + '\n', 'utf8')
    const turns = cursorAdapter.parse(file)
    assert.equal(turns.length, 1)
    assert.equal(turns[0]!.role, 'user')
    // 只有 meta.json 没有 store.db：无正文可恢复
    const meta = join(dir, 'meta.json')
    writeFileSync(meta, JSON.stringify({ title: 'x' }), 'utf8')
    assert.deepEqual(cursorAdapter.parse(meta), [])
    assert.deepEqual(cursorAdapter.parse(join(dir, 'missing.jsonl')), [])
  })
})

// ── grok：updates.jsonl 可见更新流（chat_history 永不读）─────────────

test('grok_parse_updates_text', () => {
  const text = [
    // JSON-RPC 包裹形态：params.update
    JSON.stringify({ params: { update: { sessionUpdate: 'user_message_chunk', content: [{ type: 'text', text: '帮我看下' }] } } }),
    // 流式分片：连续同角色 chunk 合并成一轮
    JSON.stringify({ params: { update: { sessionUpdate: 'user_message_chunk', content: [{ type: 'text', text: '这个报错' }] } } }),
    // 导出流形态：record 本身就是 update；非文本块标不可用
    JSON.stringify({ sessionUpdate: 'agent_message_chunk', content: [{ type: 'text', text: '我看看' }, { type: 'image', url: 'x' }] }),
    // 隐藏推理 / hook 记录：丢弃
    JSON.stringify({ sessionUpdate: 'agent_thought_chunk', content: [{ type: 'text', text: '隐藏推理不外泄' }] }),
    JSON.stringify({ sessionUpdate: 'hook_execution', hook: 'pre' }),
    // 工具调用：pending → assistant 工具轮（name 取 _meta["x.ai/tool"].name）
    JSON.stringify({ sessionUpdate: 'tool_call', toolCallId: 't1', status: 'pending', _meta: { 'x.ai/tool': { name: 'read_file' } }, rawInput: { path: 'src/a.ts' } }),
    // 完成态去重 + diff 只留路径
    JSON.stringify({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'diff', path: 'src/a.ts' }] }),
    JSON.stringify({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'text', text: '重复结果' }] }),
    // 失败态：toolFailed；rawOutput 兜底
    JSON.stringify({ sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'failed', title: 'run_tests', rawOutput: '2 failed' }),
    // plan / turn_completed / 未知类型：跳过
    JSON.stringify({ sessionUpdate: 'plan', entries: [{ content: '第一步' }] }),
    JSON.stringify({ sessionUpdate: 'turn_completed' }),
    JSON.stringify({ sessionUpdate: 'some_future_update' }),
    '{broken',
  ].join('\n')
  const turns = parseGrokUpdatesText(text, 'D:\\proj', 'grok-4')
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'assistant', 'tool', 'tool'])
  assert.equal(turns[0]!.text, '帮我看下\n这个报错') // 流式分片合并
  assert.equal(turns[0]!.cwd, 'D:\\proj')
  assert.equal(turns[1]!.text, '我看看\n[image 内容不可用]')
  assert.equal(turns[2]!.toolName, 'read_file')
  assert.equal(turns[2]!.text, 'read_file: src/a.ts')
  assert.equal(turns[3]!.toolName, 'read_file')
  assert.equal(turns[3]!.text, '[diff 内容不可用：src/a.ts]')
  assert.equal(turns[3]!.toolFailed, false)
  assert.equal(turns[4]!.toolName, 'run_tests')
  assert.equal(turns[4]!.text, '2 failed')
  assert.equal(turns[4]!.toolFailed, true)
  assert.ok(!turns.some((t) => t.text.includes('隐藏推理')), 'agent_thought_chunk 不进 Turn')
})

test('grok_never_reads_chat_history', () => {
  withTempDir((dir) => {
    const sesDir = join(dir, 'sessions', 'D%3A%5Cproj', 'ses-001')
    mkdirSync(sesDir, { recursive: true })
    writeFileSync(join(sesDir, 'summary.json'), JSON.stringify({
      info: { id: 'ses-001', cwd: 'D:\\proj' },
      generated_title: '修报错',
      current_model_id: 'grok-4',
      last_active_at: '2026-08-22T10:00:00Z',
    }), 'utf8')
    writeFileSync(join(sesDir, 'updates.jsonl'), [
      JSON.stringify({ sessionUpdate: 'user_message_chunk', content: [{ type: 'text', text: '可见流里的消息' }] }),
      JSON.stringify({ sessionUpdate: 'agent_message_chunk', content: [{ type: 'text', text: '可见流里的回复' }] }),
    ].join('\n') + '\n', 'utf8')
    // 原始模型上下文：放毒标记，恢复边界要求永不读取
    writeFileSync(join(sesDir, 'chat_history.jsonl'), JSON.stringify({ role: 'system', content: 'POISON_NEVER_READ' }) + '\n', 'utf8')

    const turns = grokAdapter.parse(sesDir)
    assert.equal(turns.length, 2)
    assert.equal(turns[0]!.cwd, 'D:\\proj') // cwd 来自 summary.json
    assert.equal(turns[0]!.model, 'grok-4')
    assert.ok(!turns.some((t) => t.text.includes('POISON_NEVER_READ')), 'chat_history.jsonl 永不进 Turn')

    // 也接受指向 summary.json / updates.jsonl 的路径
    assert.equal(grokAdapter.parse(join(sesDir, 'updates.jsonl')).length, 2)
    // updates.jsonl 缺失：空流不 throw
    const emptyDir = join(dir, 'sessions', 'D%3A%5Cproj', 'ses-002')
    mkdirSync(emptyDir, { recursive: true })
    assert.deepEqual(grokAdapter.parse(emptyDir), [])
  })
})

test('grok_parse_session_direct_function', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ info: { cwd: 'D:\\x' } }), 'utf8')
    writeFileSync(join(dir, 'updates.jsonl'), JSON.stringify({ sessionUpdate: 'user_message_chunk', content: '字符串 content' }) + '\n', 'utf8')
    const turns = parseGrokSession(dir)
    assert.equal(turns.length, 1)
    assert.equal(turns[0]!.text, '字符串 content')
    assert.equal(turns[0]!.cwd, 'D:\\x')
  })
})

// ── opencode：新版 opencode.db（SQLite 双布局） ────────────────────
test('opencode_db_sessions_sqlite_layout', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { parseOpenCodeDbSession } = await import('../src/opencode.ts')
  const dir = mkdtempSync(join(tmpdir(), 'oc-db-'))
  const dbPath = join(dir, 'opencode.db')
  const db = new DatabaseSync(dbPath)
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER)")
  db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)")
  db.exec("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)")
  db.prepare("INSERT INTO session VALUES ('ses_db1', 't', 'D:/w', 111)").run()
  db.prepare("INSERT INTO message VALUES ('msg_1', 'ses_db1', 100, '{\"role\":\"user\",\"time\":{\"created\":100}}')").run()
  db.prepare("INSERT INTO part VALUES ('prt_1', 'msg_1', 'ses_db1', 101, '{\"type\":\"text\",\"text\":\"你好 db\"}')").run()
  db.close()
  const turns = parseOpenCodeDbSession('ses_db1', dbPath)
  assert.equal(turns.length, 1)
  assert.equal(turns[0]!.role, 'user')
  assert.equal(turns[0]!.text, '你好 db')
  assert.equal(turns[0]!.cwd, 'D:/w')
})

// ── 假 0 哨兵：存储根目录存在但 discover 为 0 → note 提示布局可能迁移 ──

test('sentinel: codex 根存在但 0 会话 → 哨兵；有数据 → note 保持空', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-codex-'))
  try {
    const root = join(dir, 'sessions')
    mkdirSync(root, { recursive: true })
    const adapter = await freshAdapter<typeof codexAdapter>('codex', 'HANDOFF_ROOT_CODEX', root, 'empty')
    assert.deepEqual(adapter.discover(), [])
    assertSentinel(adapter.note, 'codex 空根')
    // 有数据的家：note 保持空
    writeFileSync(join(root, 'rollout-1.jsonl'), JSON.stringify({ type: 'session_meta', payload: { cwd: 'D:\\x' } }) + '\n', 'utf8')
    assert.equal(adapter.discover().length, 1)
    assert.equal(adapter.note, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sentinel: codex 根不存在 → 不触发（没装 = 正常静默）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-codex-missing-'))
  try {
    const adapter = await freshAdapter<typeof codexAdapter>('codex', 'HANDOFF_ROOT_CODEX', join(dir, 'absent'), 'missing')
    assert.deepEqual(adapter.discover(), [])
    assert.equal(adapter.note, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sentinel: cursor 根存在但 0 会话 → 哨兵；有 transcript → 恢复静态说明', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-cursor-'))
  try {
    const adapter = await freshAdapter<typeof cursorAdapter>('cursor', 'HANDOFF_ROOT_CURSOR', dir, 'empty')
    assert.deepEqual(adapter.discover(), [])
    assertSentinel(adapter.note, 'cursor 空根')
    // 有数据（transcript 形态）：哨兵撤下，note 回到静态说明（node:sqlite 可用时为空）
    const atDir = join(dir, 'projects', 'D%3A%5Cproj', 'agent-transcripts', 'sid-1')
    mkdirSync(atDir, { recursive: true })
    writeFileSync(join(atDir, 'sid-1.jsonl'), JSON.stringify({ role: 'user', content: 'transcript 在' }) + '\n', 'utf8')
    assert.equal(adapter.discover().length, 1)
    assert.notEqual(adapter.note, FAKE_ZERO_NOTE)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sentinel: grok 根存在但 0 会话 → 哨兵；有数据 → note 保持空', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-grok-'))
  try {
    const root = join(dir, 'sessions')
    mkdirSync(root, { recursive: true })
    const adapter = await freshAdapter<typeof grokAdapter>('grok', 'HANDOFF_ROOT_GROK', root, 'empty')
    assert.deepEqual(adapter.discover(), [])
    assertSentinel(adapter.note, 'grok 空根')
    const sesDir = join(root, 'D%3A%5Cproj', 'ses-001')
    mkdirSync(sesDir, { recursive: true })
    writeFileSync(join(sesDir, 'summary.json'), JSON.stringify({ info: { id: 'ses-001', cwd: 'D:\\proj' } }), 'utf8')
    writeFileSync(join(sesDir, 'updates.jsonl'), JSON.stringify({ sessionUpdate: 'user_message_chunk', content: 'hi' }) + '\n', 'utf8')
    assert.equal(adapter.discover().length, 1)
    assert.equal(adapter.note, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sentinel: opencode storage/ 在但 0 会话 → 哨兵（只针对 storage 回退路径）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-oc-'))
  try {
    // storage/ 存在但 session/ 层缺席
    const adapterA = await freshAdapter<typeof opencodeAdapterReal>('opencode', 'HANDOFF_ROOT_OPENCODE', dir, 'storage-no-session')
    mkdirSync(join(dir, 'storage'), { recursive: true })
    assert.deepEqual(adapterA.discover(), [])
    assertSentinel(adapterA.note, 'opencode storage 无 session 层')
    // storage/session 在但空的会话文件层
    const adapterB = await freshAdapter<typeof opencodeAdapterReal>('opencode', 'HANDOFF_ROOT_OPENCODE', dir, 'storage-empty-session')
    mkdirSync(join(dir, 'storage', 'session', 'proj1'), { recursive: true })
    assert.deepEqual(adapterB.discover(), [])
    assertSentinel(adapterB.note, 'opencode session 层为空')
    // 有数据：哨兵撤下
    writeFileSync(join(dir, 'storage', 'session', 'proj1', 'ses_1.json'), JSON.stringify({ id: 'ses_1', title: 't' }), 'utf8')
    assert.equal(adapterB.discover().length, 1)
    assert.notEqual(adapterB.note, FAKE_ZERO_NOTE)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── gemini：新 JSONL 双格式（metadata 首行 + MessageRecord + 控制行/坏行跳过）──

test('gemini_parse_jsonl_new_format', () => {
  const text = [
    // 首行 metadata：不产生 Turn
    JSON.stringify({ sessionId: 'ses-g1', startTime: '2026-10-02T09:00:00Z', lastUpdated: '2026-10-02T09:05:00Z', summary: '修登录页', directories: ['D:\\proj'], kind: 'main' }),
    // 用户消息（中文）
    JSON.stringify({ type: 'user', content: '帮我修一下登录页的报错', timestamp: '2026-10-02T09:00:01Z' }),
    // 斜杠命令 / 快捷输入：不是用户轮
    JSON.stringify({ type: 'user', content: '/help', timestamp: '2026-10-02T09:00:02Z' }),
    JSON.stringify({ type: 'user', content: '?', timestamp: '2026-10-02T09:00:03Z' }),
    // info / warning / error：CLI UI 消息，不计用户轮也不进 Turn
    JSON.stringify({ type: 'info', content: '正在加载扩展' }),
    JSON.stringify({ type: 'warning', content: '配额告警' }),
    JSON.stringify({ type: 'error', content: '上游超时' }),
    // gemini 文本轮（中文，Part 数组）
    JSON.stringify({ type: 'gemini', content: [{ text: '我先看看代码' }], timestamp: '2026-10-02T09:01:00Z' }),
    // gemini 工具轮：write_file（文件类）+ run_shell_command（命令类），结果轮跟随
    JSON.stringify({ type: 'gemini', content: [{ text: '改好了，跑下测试' }], toolCalls: [
      { name: 'write_file', args: { file_path: 'src/login.ts', content: '...' }, result: '写入成功', status: 'success', timestamp: '2026-10-02T09:01:30Z' },
      { name: 'run_shell_command', args: { command: 'pnpm test' }, result: '3 passed', status: 'success', timestamp: '2026-10-02T09:02:00Z' },
    ], timestamp: '2026-10-02T09:01:20Z' }),
    // 失败态工具调用：status==='error' → toolFailed
    JSON.stringify({ type: 'gemini', toolCalls: [
      { name: 'read_file', args: { file_path: 'src/missing.ts' }, result: 'No such file', status: 'error', timestamp: '2026-10-02T09:03:00Z' },
    ], timestamp: '2026-10-02T09:02:50Z' }),
    // $patch / $set / $rewindTo 控制行 + 未知行：跳过
    JSON.stringify({ $patch: { messages: [] } }),
    JSON.stringify({ $set: { summary: '修登录页（更新）' } }),
    JSON.stringify({ $rewindTo: 3 }),
    JSON.stringify({ type: '$patch', payload: {} }),
    JSON.stringify({ someFutureRecord: true }),
    '{broken-json',
    '',
  ].join('\n')
  const turns = parseGeminiText(text, 'D:\\proj')
  assert.deepEqual(turns.map((t) => t.role), [
    'user', 'assistant', 'assistant', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool',
  ])
  assert.equal(turns[0]!.text, '帮我修一下登录页的报错')
  assert.equal(turns[0]!.cwd, 'D:\\proj')
  assert.equal(turns[0]!.ts, '2026-10-02T09:00:01Z')
  assert.equal(turns[1]!.text, '我先看看代码')
  assert.equal(turns[2]!.text, '改好了，跑下测试')
  assert.equal(turns[3]!.toolName, 'write_file')
  assert.equal(turns[3]!.text, 'write_file: src/login.ts')
  assert.equal(turns[4]!.text, '写入成功')
  assert.equal(turns[4]!.toolFailed, false)
  assert.equal(turns[5]!.toolName, 'run_shell_command')
  assert.equal(turns[5]!.text, 'pnpm test')
  assert.equal(turns[8]!.toolName, 'read_file')
  assert.equal(turns[8]!.toolFailed, true)
  assert.ok(!turns.some((t) => t.text.includes('/help') || t.text.includes('配额告警') || t.text.includes('上游超时')), '斜杠命令与 info/warning/error 不进 Turn')
})

// ── gemini：旧 .json 整块格式（metadata+messages 单对象，中文）────────

test('gemini_parse_old_json_format', () => {
  const legacy = {
    sessionId: 'ses-old',
    startTime: '2026-09-20T10:00:00Z',
    lastUpdated: '2026-09-20T10:02:00Z',
    summary: '旧格式会话',
    directories: ['D:\\legacy'],
    messages: [
      { type: 'user', content: '盘点一下旧格式（中文）', timestamp: '2026-09-20T10:00:01Z' },
      { type: 'user', content: '/init', timestamp: '2026-09-20T10:00:02Z' },
      { type: 'gemini', content: [{ text: '旧格式也读得出' }], timestamp: '2026-09-20T10:01:00Z' },
      { type: 'gemini', toolCalls: [
        { name: 'replace', args: { file_path: 'old.ts', old_string: 'a', new_string: 'b' }, result: '工具执行失败', status: 'error', timestamp: '2026-09-20T10:02:00Z' },
      ], timestamp: '2026-09-20T10:01:50Z' },
      { type: 'info', content: '存档完成' },
      '{embedded-broken',
    ],
  }
  const turns = parseGeminiJson(JSON.stringify(legacy), 'D:\\legacy')
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'assistant', 'tool'])
  assert.equal(turns[0]!.text, '盘点一下旧格式（中文）')
  assert.equal(turns[2]!.toolName, 'replace')
  assert.equal(turns[2]!.text, 'replace: old.ts')
  assert.equal(turns[3]!.toolFailed, true)
  // 损坏 .json：空流不 throw
  assert.deepEqual(parseGeminiJson('{nope'), [])
  assert.deepEqual(parseGeminiJson('[]'), [])
})

// ── gemini：发现层——双后缀 + 子代理嵌套 + slug/sha256 项目标识 + .project_root ──

test('gemini_discover_dual_format_subagent_and_cwd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gemini-disc-'))
  try {
    const root = join(dir, 'tmp') // 目录名叫 tmp，对齐真实布局（cwd 反查不越界）
    const slug = join(root, 'my-project') // slug 形项目标识
    const hashed = join(root, 'a'.repeat(64)) // 旧 sha256 形项目标识
    const slugChats = join(slug, 'chats')
    const subDir = join(slugChats, 'ab12cd34') // 子代理嵌套层
    const hashedChats = join(hashed, 'chats')
    mkdirSync(subDir, { recursive: true })
    mkdirSync(hashedChats, { recursive: true })
    mkdirSync(join(hashed, 'notchats'), { recursive: true })
    writeFileSync(join(slug, '.project_root'), 'D:\\工作区\\新项目\n', 'utf8')

    const metaLine = (extra: Entry): string => JSON.stringify({ sessionId: 'x', kind: 'main', ...extra })
    // 新 JSONL（slug 项目）：summary 作标题
    writeFileSync(join(slugChats, 'session-1000-abcd1234.jsonl'), [
      metaLine({ sessionId: 'ses-a', summary: '修登录页', lastUpdated: '2026-10-02T09:05:00Z' }),
      JSON.stringify({ type: 'user', content: '第一条' }),
    ].join('\n') + '\n', 'utf8')
    // 旧 .json（sha256 项目）：无 .project_root → cwd 留空
    writeFileSync(join(hashedChats, 'session-1001-1234abcd.json'), JSON.stringify({
      sessionId: 'ses-b', summary: '老项目', lastUpdated: '2026-09-20T10:00:00Z', messages: [],
    }), 'utf8')
    // 子代理会话：chats/<parentShortId>/ 再嵌一层，kind='subagent'
    writeFileSync(join(subDir, 'session-1002-aaaabbbb.jsonl'), [
      metaLine({ sessionId: 'ses-c', kind: 'subagent', lastUpdated: '2026-10-01T08:00:00Z' }),
      JSON.stringify({ type: 'user', content: '子代理任务' }),
    ].join('\n') + '\n', 'utf8')
    // 诱饵：非 session- 前缀、非双后缀、错层（不在 chats/ 下）——都不发现
    writeFileSync(join(slugChats, 'notes.json'), '{}', 'utf8')
    writeFileSync(join(slugChats, 'session-1003-xxxxxxxx.txt'), 'not a session', 'utf8')
    writeFileSync(join(hashed, 'notchats', 'session-1004-zzzzzzzz.jsonl'), '{}', 'utf8')

    const adapter = await freshAdapter<typeof geminiAdapter>('gemini', 'HANDOFF_ROOT_GEMINI', root, 'dual')
    const refs = adapter.discover()
    assert.equal(refs.length, 3, `slug/.jsonl + sha256/.json + 子代理嵌套各一，got ${JSON.stringify(refs.map((r) => r.id))}`)
    // 按更新时间倒序：1000(10-02) > 1002(10-01) > 1001(09-20)；子代理无 summary → 标题回退文件名
    assert.deepEqual(refs.map((r) => r.title), ['修登录页', 'session-1002-aaaabbbb.jsonl', '老项目'])
    const main = refs.find((r) => r.id.endsWith('session-1000-abcd1234.jsonl'))!
    assert.equal(main.title, '修登录页', 'summary 作标题')
    assert.equal(main.cwd, 'D:\\工作区\\新项目', '.project_root 明文反查（去尾换行）')
    const sub = refs.find((r) => r.id.endsWith('session-1002-aaaabbbb.jsonl'))!
    assert.equal(sub.cwd, 'D:\\工作区\\新项目', '子代理沿父目录反查到项目 .project_root')
    const oldJson = refs.find((r) => r.id.endsWith('session-1001-1234abcd.json'))!
    assert.equal(oldJson.title, '老项目')
    assert.equal(oldJson.cwd, '', '读不到 .project_root 留空（调用方有空 cwd 警告兜底）')
    assert.ok(oldJson.updatedAt < sub.updatedAt, 'lastUpdated 参与 updatedAt 排序')

    // adapter.parse 走同一条 cwd 反查：主会话 / 子代理 / 缺文件
    const mainTurns = adapter.parse(main.id)
    assert.equal(mainTurns.length, 1)
    assert.equal(mainTurns[0]!.cwd, 'D:\\工作区\\新项目')
    const subTurns = parseGeminiSession(sub.id)
    assert.equal(subTurns[0]!.cwd, 'D:\\工作区\\新项目')
    assert.deepEqual(parseGeminiSession(join(dir, 'absent', 'session-1-a.jsonl')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── gemini：假 0 哨兵（根存在 0 会话 → 哨兵；根缺席 → 正常静默）────────

test('sentinel: gemini 根存在但 0 会话 → 哨兵；有数据 → note 保持空', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-gemini-'))
  try {
    const root = join(dir, 'tmp')
    mkdirSync(join(root, 'proj', 'chats'), { recursive: true })
    const adapter = await freshAdapter<typeof geminiAdapter>('gemini', 'HANDOFF_ROOT_GEMINI', root, 'empty')
    assert.deepEqual(adapter.discover(), [])
    assertSentinel(adapter.note, 'gemini 空根')
    // 有数据：哨兵撤下
    writeFileSync(join(root, 'proj', 'chats', 'session-1-abcd1234.jsonl'), JSON.stringify({ type: 'user', content: 'hi' }) + '\n', 'utf8')
    assert.equal(adapter.discover().length, 1)
    assert.equal(adapter.note, undefined)
    // 根不存在：没装 = 正常静默，不触发哨兵
    const adapter2 = await freshAdapter<typeof geminiAdapter>('gemini', 'HANDOFF_ROOT_GEMINI', join(dir, 'absent'), 'missing')
    assert.deepEqual(adapter2.discover(), [])
    assert.equal(adapter2.note, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
