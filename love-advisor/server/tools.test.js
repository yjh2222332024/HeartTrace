// ── tools.js：Tool Registry 元数据 / 校验 / 截断 / 真实 clb 冒烟 ──
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createToolRegistry, truncateResult, TOOL_DEFS } from './tools.js'
import {
  TOOL_ERROR_CODES, TOOL_RECOVERY_STRATEGIES, toolError,
} from './tool-errors.js'

const rt = createToolRegistry()

test('ToolError：错误码只映射到四种共性恢复策略', () => {
  assert.equal(
    toolError(TOOL_ERROR_CODES.INVALID_ARGUMENT, '参数错误').recovery,
    TOOL_RECOVERY_STRATEGIES.REVISE_INPUT,
  )
  assert.equal(
    toolError(TOOL_ERROR_CODES.PRECONDITION_FAILED, '缺少前置条件').recovery,
    TOOL_RECOVERY_STRATEGIES.ASK_USER,
  )
  assert.equal(
    toolError(TOOL_ERROR_CODES.PERMISSION_DENIED, '禁止访问').recovery,
    TOOL_RECOVERY_STRATEGIES.STOP,
  )
  assert.equal(
    toolError(TOOL_ERROR_CODES.LIMIT_EXCEEDED, '达到上限').recovery,
    TOOL_RECOVERY_STRATEGIES.USE_ALTERNATIVE,
  )
})

test('registry：聊天工具预注册，元数据完整且 id 唯一', () => {
  const tools = rt.list()
  assert.equal(tools.length, 10)
  const ids = tools.map(t => t.function.name)
  assert.equal(new Set(ids).size, tools.length)
  assert.ok(ids.includes('read_context'))
  assert.ok(ids.includes('propose_memory'))
  for (const t of tools) {
    assert.ok(t.function.description, `${t.function.name} 缺描述`)
    assert.ok(['read', 'sensitive', 'write'].includes(t.function.riskLevel), `${t.function.name} riskLevel 非法`)
    assert.equal(t.function.parameters.type, 'object')
  }
  const sensitive = tools.filter(t => t.function.riskLevel === 'sensitive')
  assert.deepEqual(sensitive.map(t => t.function.name).sort(),
    ['browse_messages', 'get_message_context', 'query_sql', 'search_messages'])
})

test('registry：未知工具拒绝', async () => {
  await assert.rejects(
    () => rt.execute('not_exist', {}),
    error => error.code === 'UNKNOWN_TOOL'
      && error.recovery === 'USE_ALTERNATIVE'
      && error.retryable === false
      && /未知工具/.test(error.message),
  )
})

test('read_context 脱离 Run 调用被拒绝', async () => {
  await assert.rejects(() => rt.execute('read_context', { paths: ['her'] }), /只能在咨询 Run 内调用/)
})

test('咨询 Run：ChatLab 工具只能访问当前绑定私聊，且不能枚举会话', async () => {
  const scope = { sessionScope: { enforced: true, sessionId: 'chat_current' } }
  await assert.rejects(
    () => rt.execute('search_messages', { sessionId: 'chat_other', keywords: ['约会'] }, scope),
    /只能访问当前工作区绑定的私聊/,
  )
  await assert.rejects(
    () => rt.execute('list_chat_sessions', {}, scope),
    /不能枚举其他聊天会话/,
  )
  await assert.rejects(
    () => rt.execute('browse_messages', { sessionId: 'chat_other' }, {
      sessionScope: { enforced: true, sessionId: '' },
    }),
    error => error.code === 'PRECONDITION_FAILED'
      && error.recovery === 'ASK_USER'
      && /未绑定私聊/.test(error.message),
  )

  await assert.rejects(
    () => rt.execute('search_messages', { sessionId: 'chat_other', keywords: ['约会'] }, scope),
    error => error.code === 'PERMISSION_DENIED' && error.retryable === false,
  )
})

test('参数校验：缺 sessionId / 非法 metric / 非法窗口', async () => {
  await assert.rejects(
    () => rt.execute('get_chat_stats', { metric: 'activity' }),
    error => error.code === 'INVALID_ARGUMENT'
      && error.recovery === 'REVISE_INPUT'
      && error.retryable === false
      && /sessionId/.test(error.message),
  )
  await assert.rejects(() => rt.execute('get_chat_stats', { sessionId: 's:1', metric: 'hack' }), /metric/)
  await assert.rejects(() => rt.execute('get_chat_stats', { sessionId: 's:1', metric: 'activity', last: '7x' }), /last/)
  await assert.rejects(() => rt.execute('search_messages', { sessionId: 's:1', keywords: [] }), /keywords/)
  await assert.rejects(() => rt.execute('get_message_context', { sessionId: 's:1', ids: ['a'] }), /整数/)
})

test('参数校验：last 与 since 互斥', async () => {
  await assert.rejects(
    () => rt.execute('get_chat_stats', { sessionId: 's:1', metric: 'activity', last: '7d', since: '2026-01-01' }),
    /不能同时使用/
  )
})

test('参数校验：query_sql 只允许单条 SELECT/WITH', async () => {
  await assert.rejects(() => rt.execute('query_sql', { sessionId: 's:1', query: 'DROP TABLE message' }), /SELECT\/WITH/)
  await assert.rejects(() => rt.execute('query_sql', { sessionId: 's:1', query: 'SELECT 1; SELECT 2' }), /单条/)
  await assert.rejects(() => rt.execute('query_sql', { sessionId: 's:1', query: 'DELETE FROM message' }), /SELECT\/WITH/)
  await assert.rejects(
    () => rt.execute('query_sql', { sessionId: 's:1', query: 'WITH x AS (SELECT 1) DELETE FROM message' }),
    /只允许只读/
  )
})

test('truncateResult：超限裁剪数组并保留总数标记', () => {
  const big = { items: Array.from({ length: 1000 }, (_, i) => ({ i, pad: 'x'.repeat(50) })) }
  const { result, truncated } = truncateResult(big, 4000)
  assert.equal(truncated, true)
  assert.ok(result.items.length < 1000)
  assert.equal(result.items_total, 1000)
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4000 + 200) // 元数据余量
  const small = { items: [{ a: 1 }] }
  assert.deepEqual(truncateResult(small, 4000), { result: small, truncated: false })

  const scalar = truncateResult({ text: 'x'.repeat(10000) }, 4000)
  assert.equal(scalar.truncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(scalar.result)) <= 4000)
})

test('ChatLab 原文工具：同一 Run 缓存命中返回 stub，不回嵌正文', async () => {
  const key = 'search_messages:hit'
  const session = {
    toolCacheKey: () => key,
    lookupTool: () => ({ cached: true, key, note: '本轮已加载，见先前的 tool 结果。' }),
    rememberTool() { throw new Error('cache hit 不应再写入') },
  }
  const { result, truncated } = await rt.execute(
    'search_messages',
    { sessionId: 's:1', keywords: ['约会'] },
    { contextSession: session },
  )
  assert.equal(truncated, false)
  assert.equal(result.cached, true)
  assert.equal(result.key, key)
  assert.doesNotMatch(JSON.stringify(result), /约会原文/)
})

// ── 真实 clb 冒烟（依赖本机已导入会话；无会话则跳过） ──
test('真实 clb：list_chat_sessions', async t => {
  const { result } = await rt.execute('list_chat_sessions', {})
  assert.ok(Array.isArray(result.items))
  if (!result.items.length) return t.skip('本机无已导入会话')
})

test('真实 clb：get_chat_stats + query_sql（取真实 sessionId）', async t => {
  const { result } = await rt.execute('list_chat_sessions', {})
  const sid = result.items?.[0]?.id
  if (!sid) return t.skip('本机无已导入会话')

  const stats = await rt.execute('get_chat_stats', { sessionId: sid, metric: 'activity', last: '90d', top: 3 })
  assert.equal(stats.tool, 'get_chat_stats')
  assert.ok(stats.result)

  const sql = await rt.execute('query_sql', { sessionId: sid, query: 'SELECT COUNT(*) AS n FROM message' })
  assert.ok(sql.result.rows?.length >= 1)
})

test('read_skill_doc：有 skillRuntime 时注册；路径逃逸拒绝', async () => {
  const skillRuntime = {
    list: () => [{ id: 'advisor-a', default: true }],
    readDocFor(id, rel) {
      if (String(rel).includes('..')) return { ok: false, error: '路径无效或不在本军师目录内' }
      return { ok: true, path: rel, truncated: false, content: '沟通规则' }
    },
  }
  const withSkill = createToolRegistry({ skillRuntime })
  assert.ok(withSkill.list().some(t => t.function.name === 'read_skill_doc'))
  const { result } = await withSkill.execute('read_skill_doc', { path: 'references/playbooks/communication.md' })
  assert.equal(result.content, '沟通规则')
  await assert.rejects(
    () => withSkill.execute('read_skill_doc', { path: '../../secret.md' }),
    /路径无效/,
  )
})

test('read_skill_doc：手册超过聊天工具 8KB 上限仍保留正文', async () => {
  const content = '沟通规则\n' + '哈'.repeat(5000)
  const withSkill = createToolRegistry({
    skillRuntime: {
      list: () => [{ id: 'advisor-a', default: true }],
      readDocFor: () => ({ ok: true, path: 'references/playbooks/communication.md', truncated: false, content }),
    },
  })
  const { result, truncated } = await withSkill.execute('read_skill_doc', { path: 'references/playbooks/communication.md' })
  assert.equal(truncated, false)
  assert.equal(result.content, content)
})
