import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTEXT_PATHS, contextCacheKey, paginateList, clampLimit, normalizeMemoryTypes,
  renderWorkspaceSlice, filterMemories, buildMemoryIndex, buildRuntimeCard, createContextSession,
  MAX_CONTEXT_READS, MAX_CONTEXT_BYTES, MAX_PATHS_PER_CALL, MEMORY_CONTENT_CAP,
  MEMORY_INDEX_CHAR_CAP, toolResultCacheKey,
} from './context.js'

const sampleCase = {
  id: 'case_1',
  title: '工作区A',
  stage: '暧昧',
  riskLevel: 'normal',
  summary: '认识两个月',
  her: { persona: '慢热', traits: ['独立'], likes: ['猫'], dislikes: ['连续追问'], commStyle: '短句' },
  me: { goal: '确定关系', style: '直', pitfalls: ['过度热情'] },
  relationship: {
    keyEvents: [{ date: '2026-08-01', event: '首约' }],
    openLoops: ['看展'],
    boundaries: ['工作时间不要连续打电话'],
  },
  baseline: { replyLatencyP50: 3600, initiationRatio: 0.6, msgFrequency: '3条/天', updatedAt: '2026-09-01' },
  profileStatus: { status: 'confirmed', ownerName: '我', peerName: '她', ownerConfirmed: true },
  memories: [
    { id: 'm1', type: 'risk', content: '她不喜欢被连续追问', createdAt: '2026-08-02' },
    { id: 'm2', type: 'preference', content: '喜欢悬疑片', createdAt: '2026-08-03' },
    { id: 'm3', type: 'semantic', content: '在同一家公司', createdAt: '2026-08-04' },
  ],
}

test('cache key 含 path + 规范化参数，不只看 path', () => {
  assert.equal(contextCacheKey('her'), 'her')
  assert.equal(contextCacheKey('memories', { memoryTypes: ['risk'] }), 'memories?types=risk&status=active&limit=80')
  assert.equal(contextCacheKey('memories', { memoryTypes: ['preference', 'risk'] }), 'memories?types=preference,risk&status=active&limit=80')
  assert.notEqual(
    contextCacheKey('memories', { memoryTypes: ['risk'] }),
    contextCacheKey('memories', { memoryTypes: ['preference'] }),
  )
  assert.equal(
    contextCacheKey('memories', { memoryTopics: ['risk'], memoryStatuses: ['archived'], memoryIds: ['m2', 'm1'] }),
    'memories?topics=risk&status=archived&ids=m1,m2&limit=80',
  )
  assert.equal(contextCacheKey('evidence.recent', { limit: 80 }), 'evidence.recent?limit=80')
  assert.equal(contextCacheKey('evidence.recent', { limit: 80, cursor: 'abc' }), 'evidence.recent?limit=80&cursor=abc')
  assert.notEqual(
    contextCacheKey('evidence.recent', { limit: 80 }),
    contextCacheKey('evidence.recent', { limit: 20 }),
  )
})

test('paginateList 保留 hasMore / nextCursor', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ id: i }))
  const p1 = paginateList(items, { limit: 2 })
  assert.deepEqual(p1.items.map(x => x.id), [0, 1])
  assert.equal(p1.hasMore, true)
  assert.equal(p1.nextCursor, '2')
  const p2 = paginateList(items, { limit: 2, cursor: p1.nextCursor })
  assert.deepEqual(p2.items.map(x => x.id), [2, 3])
  const p3 = paginateList(items, { limit: 2, cursor: p2.nextCursor })
  assert.deepEqual(p3.items.map(x => x.id), [4])
  assert.equal(p3.hasMore, false)
  assert.equal(p3.nextCursor, null)
  assert.equal(clampLimit(9999), 200)
  assert.equal(clampLimit(0), 1)
})

test('workspace 切片语义：her.dislikes ≠ relationship.boundaries', () => {
  const her = renderWorkspaceSlice(sampleCase, 'her')
  const rel = renderWorkspaceSlice(sampleCase, 'relationship')
  assert.deepEqual(her.dislikes, ['连续追问'])
  assert.deepEqual(rel.boundaries, ['工作时间不要连续打电话'])
  assert.match(her.note, /不是 relationship.boundaries/)
  assert.match(rel.note, /不要与 her.dislikes/)
  assert.equal(renderWorkspaceSlice(sampleCase, 'meta').stage, '暧昧')
  assert.equal(filterMemories(sampleCase.memories, ['risk']).length, 1)
  assert.deepEqual(normalizeMemoryTypes(['risk', 'hack', 'risk']), ['risk'])
})

test('runtime card：上一轮 path 只是入口提示，不是已掌握正文', () => {
  const memoryIndex = buildMemoryIndex(sampleCase)
  const card = buildRuntimeCard({
    caseId: 'case_1', caseTitle: '工作区A', stage: '暧昧', riskLevel: 'normal',
    sessionId: 'chat_1', lastReads: ['her', 'evidence.recent'],
    lastCites: ['cite:chat_1:12,15'],
    memoryIndex,
  })
  assert.match(card, /工作区A/)
  assert.match(card, /chat_1/)
  assert.match(card, /正文未带回/)
  assert.match(card, /her、evidence.recent/)
  assert.match(card, /cite:chat_1:12,15/)
  assert.match(card, /记忆索引/)
  assert.match(card, /risk：/)
  assert.doesNotMatch(card, /慢热/)
})

test('memory index：只注入小型导航，旧记忆可自动路由', () => {
  const index = buildMemoryIndex({
    memories: [
      ...sampleCase.memories,
      ...Array.from({ length: 80 }, (_, i) => ({
        id: `many_${i}`, type: 'semantic', content: `关系结论 ${i} ${'长'.repeat(100)}`,
        createdAt: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`,
      })),
    ],
  })
  assert.ok(Array.from(index).length <= MEMORY_INDEX_CHAR_CAP)
  assert.match(index, /her：/)
  assert.match(index, /relationship：/)
  assert.match(index, /risk：/)
  assert.match(index, /详细记忆正文|完整记忆正文/)
  assert.doesNotMatch(index, /关系结论 0 长长长长长长长长长长/)
})

test('memories 默认只读 active，并支持 topic/status/id 路由', () => {
  const memories = [
    { id: 'old_her', type: 'preference', content: '喜欢悬疑片' },
    { id: 'active_me', type: 'semantic', topic: 'me', status: 'active', content: '容易连续追问' },
    { id: 'archived_me', type: 'semantic', topic: 'me', status: 'archived', content: '旧结论' },
  ]
  assert.deepEqual(filterMemories(memories).map(m => m.id), ['old_her', 'active_me'])
  assert.equal(filterMemories(memories, [], { topics: ['her'] })[0].id, 'old_her')
  assert.equal(filterMemories(memories, [], { statuses: ['archived'], ids: ['archived_me'] })[0].content, '旧结论')
})

test('cite / tool cache：相同 key 只存一份，命中不回嵌正文', () => {
  const session = makeSession()
  const selection = { sessionId: 'chat_1', messages: [{ id: 9, content: 'quoted body' }] }
  assert.equal(session.rememberCite(selection), 'cite:chat_1:9')
  assert.equal(session.rememberCite(selection), 'cite:chat_1:9')
  assert.deepEqual(session.usedCites(), ['cite:chat_1:9'])
  assert.equal(session.lookupCite('cite:chat_1:9').messages[0].content, 'quoted body')

  const key = toolResultCacheKey('search_messages', { sessionId: 'chat_1', keywords: ['约会'] })
  assert.equal(key, toolResultCacheKey('search_messages', { keywords: ['约会'], sessionId: 'chat_1' }))
  session.rememberTool(key, { items: [{ content: '搜到的原文' }] })
  const hit = session.lookupTool(key)
  assert.equal(hit.cached, true)
  assert.equal(hit.key, key)
  assert.doesNotMatch(JSON.stringify(hit), /搜到的原文/)
})

function makeSession(overrides = {}) {
  const memories = [...sampleCase.memories]
  const caseStore = { ...sampleCase, memories }
  const added = []
  return createContextSession({
    caseId: 'case_1',
    sessionId: 'chat_1',
    runId: 'run_1',
    getCase: () => caseStore,
    addCaseMemory: (_id, payload) => {
      const memory = { id: `m_${added.length + 1}`, ...payload, createdAt: '2026-09-15' }
      added.push(memory)
      memories.push(memory)
      return memory
    },
    loadEvidencePack: async () => ({
      sessionId: 'chat_1',
      generatedAt: '2026-09-15T00:00:00.000Z',
      baseline: { overview: { messageCount: 10 } },
      metrics: { silencePeriods: [], burstDays: [] },
      evidence: {
        anomalyWindows: [
          { label: '沉默期 09-01 ~ 09-03', since: '2026-08-31', until: '2026-09-04' },
        ],
      },
      warnings: [],
    }),
    listMessages: async ({ since, last, cursor, limit }) => {
      const pool = last === '14d'
        ? Array.from({ length: 5 }, (_, i) => ({ id: i + 1, content: `recent-${i + 1}` }))
        : [{ id: 90, content: `window-${since}` }]
      return paginateList(pool, { limit, cursor })
    },
    searchMessages: async ({ limit, cursor }) => paginateList(
      [{ id: 7, content: '下次一定' }],
      { limit, cursor },
    ),
    ...overrides,
  })
}

test('同一 path 再读走缓存；不同 memories types 不算同一键', async () => {
  const session = makeSession()
  const first = await session.read({ paths: ['her'] })
  assert.equal(first.ok, true)
  assert.equal(first.slices[0].data.persona, '慢热')
  assert.equal(session.snapshot().reads, 1)

  const again = await session.read({ paths: ['her'] })
  assert.equal(again.slices[0].cached, true)
  assert.equal(session.snapshot().reads, 1)

  const risk = await session.read({ paths: ['memories'], memoryTypes: ['risk'] })
  assert.equal(risk.slices[0].data.items.length, 1)
  const pref = await session.read({ paths: ['memories'], memoryTypes: ['preference'] })
  assert.equal(pref.slices[0].data.items[0].type, 'preference')
  assert.equal(session.snapshot().reads, 3)
})

test('单次最多 3 path；Run 最多 4 次 read_context', async () => {
  const session = makeSession()
  await assert.rejects(() => session.read({ paths: ['meta', 'her', 'me', 'baseline'] }), /最多 3/)
  await session.read({ paths: ['meta'] })
  await session.read({ paths: ['her'] })
  await session.read({ paths: ['me'] })
  await session.read({ paths: ['baseline'] })
  await assert.rejects(
    () => session.read({ paths: ['relationship'] }),
    error => error.code === 'LIMIT_EXCEEDED'
      && error.recovery === 'USE_ALTERNATIVE'
      && /4 次上限/.test(error.message),
  )
  assert.equal(MAX_PATHS_PER_CALL, 3)
  assert.equal(MAX_CONTEXT_READS, 4)
})

test('字节预算截断后续 path，已读结果保留', async () => {
  const huge = {
    ...sampleCase,
    her: { ...sampleCase.her, persona: '长'.repeat(6000) },
    me: { ...sampleCase.me, goal: '也长'.repeat(6000) },
  }
  const session = makeSession({ getCase: () => huge })
  const out = await session.read({ paths: ['her', 'me'] })
  assert.equal(out.ok, true)
  assert.equal(out.slices.length, 1)
  assert.equal(out.skipped[0].path, 'me')
  assert.ok(session.snapshot().bytes <= MAX_CONTEXT_BYTES)
})

test('evidence.recent 分页，path 不是全文保证', async () => {
  const session = makeSession()
  const page1 = await session.read({ paths: ['evidence.recent'], limit: 2 })
  assert.equal(page1.slices[0].data.returned, 2)
  assert.equal(page1.slices[0].data.hasMore, true)
  assert.ok(page1.slices[0].data.nextCursor)
  const page2 = await session.read({ paths: ['evidence.recent'], limit: 2, cursor: page1.slices[0].data.nextCursor })
  assert.deepEqual(page2.slices[0].data.items.map(i => i.id), [3, 4])
})

test('propose_memory 只生成候选，并校验长度和已读取证据', () => {
  const session = makeSession()
  session.rememberCite({ sessionId: 'chat_1', messages: [{ id: 42, content: '工作很忙' }] })
  const proposed = session.proposeMemory({
    content: '近期工作繁忙可能影响回复节奏',
    type: 'semantic',
    sourceMessageIds: [42],
    confidence: 0.8,
  })
  assert.equal(proposed.ok, true)
  assert.equal(proposed.proposal.type, 'semantic')
  assert.equal(session.memoryProposals().length, 1)
  assert.throws(
    () => session.proposeMemory({ content: '未经读取的证据', sourceMessageIds: [99] }),
    error => error.code === 'INVALID_ARGUMENT'
      && error.recovery === 'REVISE_INPUT'
      && /未在本轮读取/.test(error.message),
  )
  assert.throws(
    () => session.proposeMemory({ content: 'x'.repeat(MEMORY_CONTENT_CAP + 1) }),
    error => error.code === 'INVALID_ARGUMENT' && /最多/.test(error.message),
  )
})

test('propose_memory 每 Run 最多两条，候选不会提前进入正式记忆', async () => {
  const session = makeSession()
  const before = await session.read({ paths: ['memories'] })
  assert.equal(before.slices[0].data.items.length, 3)
  session.proposeMemory({ content: '我容易把回复延迟理解成降温', topic: 'me', title: '对回复延迟敏感' })
  session.proposeMemory({ content: '她更接受直接邀约', topic: 'her' })
  assert.throws(
    () => session.proposeMemory({ content: '第三条候选' }),
    error => error.code === 'LIMIT_EXCEEDED'
      && error.recovery === 'USE_ALTERNATIVE'
      && /最多提出 2 条/.test(error.message),
  )
  const after = await session.read({ paths: ['memories'] })
  assert.equal(after.slices[0].cached, true)
  assert.equal(session.memoryProposals().length, 2)
  assert.equal(session.snapshot().reads, 1)
})

test('propose_memory 跳过已有正式记忆和本 Run 重复候选', () => {
  const session = makeSession()
  const existing = session.proposeMemory({ content: '她不喜欢被连续追问', topic: 'risk' })
  assert.equal(existing.duplicate, true)
  const first = session.proposeMemory({ content: '她更接受提前约时间', topic: 'her' })
  const duplicate = session.proposeMemory({ content: '她更接受提前约时间。', topic: 'her' })
  assert.equal(first.ok, true)
  assert.equal(duplicate.duplicate, true)
  assert.equal(session.memoryProposals().length, 1)
})

test('未绑定工作区 / 私聊时拒绝对应切片', async () => {
  const none = createContextSession({
    getCase: () => null,
    loadEvidencePack: async () => ({}),
    listMessages: async () => ({ items: [], nextCursor: null }),
    searchMessages: async () => paginateList([], {}),
  })
  await assert.rejects(
    () => none.read({ paths: ['her'] }),
    error => error.code === 'PRECONDITION_FAILED'
      && error.recovery === 'ASK_USER'
      && /未绑定工作区/.test(error.message),
  )
  await assert.rejects(
    () => none.read({ paths: ['evidence.stats'] }),
    error => error.code === 'PRECONDITION_FAILED' && /未绑定私聊/.test(error.message),
  )
  assert.throws(
    () => none.proposeMemory({ content: 'x' }),
    error => error.code === 'PRECONDITION_FAILED' && /未绑定工作区/.test(error.message),
  )
})

test('catalog 覆盖全部约定 path', () => {
  assert.deepEqual(Object.keys(CONTEXT_PATHS), [
    'meta', 'her', 'me', 'relationship', 'baseline', 'memories',
    'evidence.stats', 'evidence.recent', 'evidence.windows', 'evidence.keywords',
  ])
})
