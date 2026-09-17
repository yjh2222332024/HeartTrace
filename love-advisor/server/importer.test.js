// ── importer：导入分析 Agent 管线（mock LLM/clb，依赖注入） ──
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import express from 'express'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'love-advisor-importer-test-'))
process.env.LOVE_ADVISOR_DATA_DIR = tmpDir

const store = await import('./store.js')
const { createCase, getCase } = store
const {
  createImportRuntime, buildChunks, sanitizeDigest, sanitizeFinal,
  LLM_TIMEOUT_MS, MAP_RETRY, MAP_CONCURRENCY, abortableSleep,
} = await import('./importer.js')

const ENV = { BASE_URL: 'http://mock', API_KEY: 'k', BASE_MODEL: 'mock-model' }

// ── mock clb 数据：一个 20 条消息的会话，cursor 翻 2 页 ──
// 每个测试用独立 sessionId：store 是进程内存缓存，beforeEach 清文件不会清内存
const mkSession = id => ({ id, name: '小美', type: 'private' })
const MSGS = Array.from({ length: 20 }, (_, i) => ({
  id: `m${i}`,
  time: `2026-0${Math.floor(i / 10) + 1}-${String(i % 28 + 1).padStart(2, '0')}T1${i % 10}:00:00`,
  senderName: i % 2 === 0 ? '我本人' : '小美',
  content: i % 5 === 0 ? `[图片:abcd1234abcd1234abcd1234abcd1234.jpg] 看看` : `消息内容 ${i}，今天约了周末看展还没定时间`,
}))

const mkDeps = session => ({
  env: ENV,
  loadSession: async sid => {
    if (sid !== session.id) throw new Error('ChatLab 中找不到该会话')
    return session
  },
  resolveOwners: async () => ({ ownerName: '我本人', peerName: '小美' }),
  baselineFn: async () => ({ baseline: { replyLatencyP50: 120, initiationRatio: 0.5, msgFrequency: '10 条/天' }, warnings: [] }),
  fetchPage: async (_sid, cursor) => {
    const page = cursor ? MSGS.slice(10) : MSGS.slice(0, 10)
    return { items: page, meta: cursor ? { hasMore: false, nextCursor: '' } : { hasMore: true, nextCursor: 'cur2' } }
  },
})

// mock LLM：Map 返回 digest JSON；Reduce 组归并返回 digest；终稿返回 final JSON
function mockStreamChat(kindLog) {
  return async ({ messages }) => {
    const sys = messages[0].content
    kindLog.push(sys.slice(0, 20))
    if (sys.includes('取证分析器')) {
      return { content: JSON.stringify({ events: [{ date: '2026-01-01', event: '约了周末看展', quote: '约了周末看展' }], herTraits: ['慢热'], stageHint: '暧昧' }) }
    }
    if (sys.includes('合并同一关系')) {
      return { content: JSON.stringify({ herTraits: ['慢热', '嘴硬心软'], stageHint: '暧昧' }) }
    }
    if (sys.includes('档案终稿')) {
      return {
        content: JSON.stringify({
          stage: '暧昧',
          summary: '几个月从陌生到暧昧，最近约展未定时间。',
          her: { persona: '慢热但真诚', traits: ['慢热'], likes: ['看展'], commStyle: '回复短但秒回' },
          me: { style: '热情但有时连环追问' },
          keyEvents: [{ date: '2026-01-01', event: '约了周末看展' }],
          openLoops: ['周末看展时间未定'],
          memories: [
            { type: 'episodic', content: '2026-01-01 约了周末看展，时间未定' },
            { type: 'preference', content: '她喜欢看展' },
            { type: 'risk', content: '无' },
          ],
        }),
      }
    }
    throw new Error('未知 prompt')
  }
}

beforeEach(() => {
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { force: true })
})

async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error('waitFor 超时')
}

test('importer: 分片器按 双约束切片且时间升序', async () => {
  const page = {
    items: Array.from({ length: 300 }, (_, i) => ({ time: `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00`, senderName: 'A', content: 'x'.repeat(40) })),
    meta: { hasMore: false },
  }
  const chunks = await buildChunks('s', 'A', async () => page)
  assert.ok(chunks.length >= 2, '300 条 40 字应切多片')
  for (const c of chunks) {
    assert.ok(c.text.length <= 9000 + 320, `单片字符预算内: ${c.text.length}`)
    assert.ok(c.text.split('\n').length <= 240)
  }
})

test('importer: digest/final 清洗截断', () => {
  const d = sanitizeDigest({ events: [{ date: 'x', event: '  事件  ' }], herTraits: Array(20).fill('t'), stageHint: '非法' })
  assert.equal(d.events[0].event, '事件')
  assert.equal(d.herTraits.length, 10)
  assert.equal(d.stageHint, '')

  const f = sanitizeFinal({ stage: '暧昧', her: { traits: ['a'] }, keyEvents: [{ date: 'd', event: 'e' }], memories: [{ type: 'risk', content: '  内容 ' }, { type: 'bad', content: 'x' }] }, { ownerName: 'o', peerName: 'p' })
  assert.equal(f.draft.stage, '暧昧')
  assert.deepEqual(f.draft.her.dislikes, [])
  assert.deepEqual(f.draft.me.pitfalls, [])
  assert.equal(f.memories[0].type, 'risk')
  assert.equal(f.memories[1].type, 'semantic') // 非法 type 归为 semantic
})

test('importer: 全管线 queued→analyzing→done，档案/基线/记忆落库', async () => {
  const S = mkSession('chat_t1')
  const kinds = []
  const rt = createImportRuntime({ ...mkDeps(S), streamChat: mockStreamChat(kinds) })
  const r = await rt.startForSession(S.id)
  assert.equal(r.job.state, 'queued')
  assert.ok(r.case.id.startsWith('case_'))
  assert.equal(r.case.sessionIds[0], S.id)
  await waitFor(() => store.getImportJob(r.job.id).state === 'done')

  const job = store.getImportJob(r.job.id)
  assert.equal(job.mapTotal, 1, '20 条消息合为 1 片')
  assert.equal(job.mapDone, 1)
  assert.equal(job.phase, 'done')
  assert.ok(kinds.filter(k => k.includes('取证分析器')).length >= 1, 'Map 被调用')
  assert.ok(job.chunks[0].digest.events.length >= 1, 'Map 抽取结果真实进入 job.chunks（防 EMPTY 回退回归）')

  const item = getCase(r.case.id)
  assert.equal(item.profileStatus.status, 'draft')
  assert.equal(item.profileStatus.peerName, '小美')
  assert.equal(item.profileStatus.draft.stage, '暧昧')
  assert.ok(item.profileStatus.draft.summary.includes('暧昧'))
  assert.equal(item.baseline.replyLatencyP50, 120)
  assert.equal(item.memories.length, 0)
  assert.equal(item.memoryCandidates.length, 3)
  assert.ok(item.memoryCandidates.every(m => m.runId === `import:${job.id}` && m.status === 'pending'))
  assert.equal(item.memoryCandidates.find(m => m.type === 'risk').content, '无')
})

test('importer: LLM 失败 → job error + 档案保持 empty；重跑复用分片', async () => {
  const S = mkSession('chat_t2')
  let fail = true
  const rt = createImportRuntime({
    ...mkDeps(S),
    streamChat: async () => { if (fail) throw new Error('上游炸了'); return { content: '{}' } },
  })
  const r = await rt.startForSession(S.id)
  await waitFor(() => store.getImportJob(r.job.id).state !== 'queued' && store.getImportJob(r.job.id).state !== 'analyzing')
  const bad = store.getImportJob(r.job.id)
  assert.equal(bad.state, 'error')
  assert.ok(bad.error.includes('上游炸了'))
  assert.equal(getCase(r.case.id).profileStatus.status, 'empty')

  fail = false
  const r2 = await rt.startForSession(S.id)
  await waitFor(() => store.getImportJob(r2.job.id).state === 'done')
  const good = store.getImportJob(r2.job.id)
  assert.equal(good.mapDone, good.mapTotal, '重跑全片成功')
})

test('importer: 运行中重复发起返回同一 Job（幂等）', async () => {
  const S = mkSession('chat_t3')
  const rt = createImportRuntime({ ...mkDeps(S), streamChat: mockStreamChat([]) })
  const a = await rt.startForSession(S.id)
  const b = await rt.startForSession(S.id)
  assert.equal(a.job.id, b.job.id)
  await waitFor(() => store.getImportJob(a.job.id).state === 'done')
})

test('importer: 断点续跑复用上次分片 digest，不再调 Map LLM', async () => {
  const S = mkSession('chat_t5')
  let mapCalls = 0
  const rt = createImportRuntime({
    ...mkDeps(S),
    streamChat: async ({ messages }) => {
      const sys = messages[0].content
      if (sys.includes('取证分析器')) { mapCalls++; return { content: JSON.stringify({ herTraits: ['慢热'], stageHint: '暧昧' }) } }
      if (sys.includes('档案终稿')) return { content: JSON.stringify({ stage: '暧昧', summary: 'x', memories: [] }) }
      return { content: JSON.stringify({ herTraits: ['慢热'] }) }
    },
  })
  // 第一次：完整跑（写 checkpoint）
  const r1 = await rt.startForSession(S.id)
  await waitFor(() => store.getImportJob(r1.job.id).state === 'done')
  const calls1 = mapCalls
  assert.ok(calls1 >= 1)

  // 只有中断后的“重试”才能复用断点；正常完成后再发起属于重新分析。
  store.upsertImportJob({ ...store.getImportJob(r1.job.id), state: 'error', error: '服务重启中断' })

  // 第二次：Map 阶段全复用，一次 Map LLM 都不能调
  mapCalls = 0
  const r2 = await rt.startForSession(S.id)
  await waitFor(() => store.getImportJob(r2.job.id).state === 'done')
  assert.equal(mapCalls, 0, '重跑不应再调用 Map LLM')
  assert.equal(store.getImportJob(r2.job.id).mapDone, store.getImportJob(r2.job.id).mapTotal)

  // 中间插一个 prepare 阶段就死掉的空 Job（chunks=[]），续跑要跨过它找到上一个有效 Job
  store.upsertImportJob({ id: 'imp_empty_dead', caseId: r2.case.id, sessionId: S.id, state: 'error', phase: 'prepare', mapDone: 0, mapTotal: 0, reduceDone: 0, reduceTotal: 0, chunks: [], warnings: [], error: '服务重启中断', createdAt: new Date().toISOString() })
  mapCalls = 0
  const r3 = await rt.startForSession(S.id)
  await waitFor(() => store.getImportJob(r3.job.id).state === 'done')
  assert.equal(mapCalls, 0, '空 Job 不应阻断断点复用')
})

test('importer: 已完成后重新分析会重读聊天，断点重试也会用内容指纹拒绝旧终稿', async () => {
  const S = mkSession('chat_content_version_test')
  const messages = MSGS.slice()
  let fetchCalls = 0
  let mapCalls = 0
  const rt = createImportRuntime({
    ...mkDeps(S),
    fetchPage: async () => {
      fetchCalls++
      return { items: messages, meta: { hasMore: false, nextCursor: '' } }
    },
    streamChat: async ({ messages: promptMessages }) => {
      const sys = promptMessages[0].content
      if (sys.includes('取证分析器')) {
        mapCalls++
        return { content: JSON.stringify({ herTraits: ['慢热'], stageHint: '暧昧' }) }
      }
      if (sys.includes('档案终稿')) return { content: JSON.stringify({ stage: '暧昧', summary: 'x', memories: [] }) }
      return { content: JSON.stringify({ herTraits: ['慢热'] }) }
    },
  })

  const first = await rt.startForSession(S.id)
  await waitFor(() => store.getImportJob(first.job.id).state === 'done')

  messages.push({
    id: 'm_new', time: '2026-09-17T23:59:00', senderName: '小美', content: '新增的最新聊天',
  })
  fetchCalls = 0
  mapCalls = 0
  const reanalyzed = await rt.startForSession(S.id)
  await waitFor(() => store.getImportJob(reanalyzed.job.id).state === 'done')
  assert.ok(fetchCalls > 0, '重新分析必须重新读取聊天')
  assert.ok(mapCalls > 0, '已完成任务不能直接复用旧终稿')
  assert.equal(store.getImportJob(reanalyzed.job.id).until, '2026-09-17T23:59:00')

  store.upsertImportJob({ ...store.getImportJob(reanalyzed.job.id), state: 'error', error: '服务中断' })
  messages.push({
    id: 'm_newer', time: '2026-09-18T00:01:00', senderName: '我本人', content: '断点后又新增了一条',
  })
  mapCalls = 0
  const retried = await rt.startForSession(S.id)
  await waitFor(() => store.getImportJob(retried.job.id).state === 'done')
  assert.ok(mapCalls > 0, '内容指纹变化后，断点重试不得复用旧终稿')
  assert.equal(store.getImportJob(retried.job.id).until, '2026-09-18T00:01:00')
})

test('importer: 路由 POST /api/imports + GET 进度 + 404', async (t) => {
  const S = mkSession('chat_t4')
  const rt = createImportRuntime({ ...mkDeps(S), streamChat: mockStreamChat([]) })
  const app = express()
  app.use(express.json())
  rt.registerRoutes(app)
  const server = app.listen(0, '127.0.0.1')
  t.after(() => server.close())
  await new Promise(r => server.on('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`

  const created = createCase({ title: 'x', sessionIds: [S.id] })
  const r1 = await fetch(`${base}/api/imports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId: created.id }) })
  assert.equal(r1.status, 200)
  const { data: started } = await r1.json()
  assert.ok(started.job.id.startsWith('imp_'))

  const r2 = await fetch(`${base}/api/imports?caseId=${created.id}`)
  const { data: prog } = await r2.json()
  assert.equal(prog.id, started.job.id)

  const r3 = await fetch(`${base}/api/imports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId: 'case_missing' }) })
  assert.equal(r3.status, 404)

  await waitFor(() => store.getImportJob(started.job.id).state === 'done')
})

test('importer: 任务取消立即中止上游 HTTP 请求并标记 cancelled', async () => {
  const S = mkSession('chat_cancel_test')
  let receivedSignal = null
  const rt = createImportRuntime({
    ...mkDeps(S),
    streamChat: async ({ signal }) => {
      receivedSignal = signal
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ content: '{}' }), 5000)
        signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          const err = new Error('The operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    },
  })

  const { job } = await rt.startForSession(S.id)
  await waitFor(() => store.getImportJob(job.id).state === 'analyzing')
  assert.ok(receivedSignal)
  assert.equal(receivedSignal.aborted, false)

  const cancelled = rt.cancelJob(job.id)
  assert.equal(cancelled, true)

  await waitFor(() => store.getImportJob(job.id).state === 'cancelled')
  const finalJob = store.getImportJob(job.id)
  assert.equal(finalJob.state, 'cancelled')
  assert.equal(finalJob.error, '已取消')
  assert.equal(receivedSignal.aborted, true)
})

test('importer: 删除工作区时取消分析，任务结束后不会重新写回导入记录', async () => {
  const S = mkSession('chat_delete_case_import_test')
  let receivedSignal = null
  const rt = createImportRuntime({
    ...mkDeps(S),
    streamChat: async ({ signal }) => {
      receivedSignal = signal
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ content: '{}' }), 5000)
        signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          const error = new Error('The operation was aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })
    },
  })

  const { job, case: workspace } = await rt.startForSession(S.id)
  await waitFor(() => store.getImportJob(job.id)?.state === 'analyzing')
  assert.equal(rt.cancelJobsForCase(workspace.id), 1)
  assert.ok(store.deleteCase(workspace.id))
  await waitFor(() => receivedSignal?.aborted === true)
  await new Promise(resolve => setTimeout(resolve, 25))

  assert.equal(store.getCase(workspace.id), null)
  assert.equal(store.getImportJob(job.id), null)
})

test('parseMultipartFile: 零拷贝 Buffer 解析、中文文件名与二进制换行尾部保留', async () => {
  const { parseMultipartFile } = await import('./multipart.js')
  const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW'
  const fileContent = Buffer.from('hello\r\nworld\r\n', 'utf8')

  const multipartRaw = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="file"; filename="聊天记录_测试.json"\r\n`),
    Buffer.from(`Content-Type: application/json\r\n\r\n`),
    fileContent,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])

  const parsed = parseMultipartFile(multipartRaw, boundary)
  assert.ok(parsed)
  assert.equal(parsed.filename, '聊天记录_测试.json')
  assert.equal(parsed.fileBuf.toString('utf8'), 'hello\r\nworld\r\n')

  // 空 / 无文件测试
  const emptyRaw = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="other"\r\n\r\nval\r\n--${boundary}--\r\n`)
  assert.equal(parseMultipartFile(emptyRaw, boundary), null)
})

test('importer: 机主身份变更或 force: true 时，跳过旧分片缓存重新抽取', async () => {
  const S = mkSession('chat_cache_owner_test')
  let currentOwner = '我本人'
  let mapCalls = 0
  const deps = {
    ...mkDeps(S),
    resolveOwners: async () => ({ ownerName: currentOwner, peerName: currentOwner === '我本人' ? '小美' : '我本人' }),
    streamChat: async ({ messages }) => {
      const sys = messages[0].content
      if (sys.includes('取证分析器')) {
        mapCalls++
        return { content: JSON.stringify({ herTraits: ['慢热'], stageHint: '暧昧' }) }
      }
      if (sys.includes('档案终稿')) return { content: JSON.stringify({ stage: '暧昧', summary: 'x', memories: [] }) }
      return { content: JSON.stringify({ herTraits: ['慢热'] }) }
    },
  }
  const rt = createImportRuntime(deps)

  // 1. 首次跑：执行 Map 抽取
  const r1 = await rt.startForSession(S.id)
  await waitFor(() => store.getImportJob(r1.job.id).state === 'done')
  assert.equal(mapCalls, 1, '首次分析应调用 1 次 Map')

  // 2. 机主变更：纠正机主为“小美”，旧分片缓存不能复用
  currentOwner = '小美'
  mapCalls = 0
  const r2 = await rt.startForSession(S.id)
  await waitFor(() => store.getImportJob(r2.job.id).state === 'done')
  assert.equal(mapCalls, 1, '机主变更后必须重新抽取，不能复用相反角色的旧缓存')

  // 3. force: true 强制重跑：即使机主相同也不复用
  mapCalls = 0
  const r3 = await rt.startForSession(S.id, { force: true })
  await waitFor(() => store.getImportJob(r3.job.id).state === 'done')
  assert.equal(mapCalls, 1, 'force: true 必须跳过缓存重新抽取')
})

test('importer: 任务在 Phase 4 落库阶段取消，绝不写入工作区草稿与记忆', async () => {
  const S = mkSession('chat_cancel_phase4_test')
  let baselineCalled = false
  let releaseBaseline
  const baselinePromise = new Promise(resolve => { releaseBaseline = resolve })

  const rt = createImportRuntime({
    ...mkDeps(S),
    baselineFn: async () => {
      baselineCalled = true
      await baselinePromise
      return { baseline: { replyLatencyP50: 999 }, warnings: [] }
    },
    streamChat: mockStreamChat([]),
  })

  const { job, case: caseObj } = await rt.startForSession(S.id)
  // 等待执行到 Phase 4 baselineFn
  await waitFor(() => baselineCalled)

  // 此时立即取消任务
  rt.cancelJob(job.id)
  releaseBaseline()

  await waitFor(() => store.getImportJob(job.id).state === 'cancelled')
  const finalJob = store.getImportJob(job.id)
  assert.equal(finalJob.state, 'cancelled')
  assert.equal(finalJob.error, '已取消')

  // 验证工作区没有被落库写入
  const c = getCase(caseObj.id)
  assert.equal(c.profileStatus.status, 'empty', '已取消的任务绝不能将草稿落库为 draft')
  assert.equal(c.baseline.replyLatencyP50, null, '已取消的任务绝不能更新基线')
  assert.equal(c.memories.length, 0, '已取消的任务绝不能写入长期记忆')
})

test('importer: 参数约束 — 3并发、5次重试、240秒超时', async () => {
  assert.equal(MAP_CONCURRENCY, 3, 'LLM 必须维持 3 并发')
  assert.equal(MAP_RETRY, 5, '重试次数必须为 5 次')
  assert.equal(LLM_TIMEOUT_MS, 240000, '超时时间必须增加 1 倍至 240000ms（4分钟）')

  const S = mkSession('chat_timeout_check')
  let passedTimeout = 0
  const rt = createImportRuntime({
    ...mkDeps(S),
    streamChat: async ({ timeoutMs }) => {
      passedTimeout = timeoutMs
      return { content: JSON.stringify({ herTraits: ['温柔'], stageHint: '初识' }) }
    },
  })
  const { job } = await rt.startForSession(S.id)
  await waitFor(() => store.getImportJob(job.id).state === 'done')
  assert.equal(passedTimeout, 240000, 'streamChat 必须接收到 240000ms 超时配置')
})

test('importer: abortableSleep 遇 abort 信号立即拒绝，不延误取消流程', async () => {
  const ac = new AbortController()
  const start = Date.now()
  const sleepPromise = abortableSleep(5000, ac.signal)
  setTimeout(() => ac.abort(), 20)
  await assert.rejects(sleepPromise, { name: 'AbortError' })
  assert.ok(Date.now() - start < 1000, 'abort 后应迅速抛错，不能等待 5000ms')
})

test('importer: 指数退避重试 — 失败4次第5次成功，或重试5次超限跳过', async () => {
  const S = mkSession('chat_retry_backoff')
  let attempts = 0
  const rt = createImportRuntime({
    ...mkDeps(S),
    retryBaseDelay: 5, // 测试中使用 5ms 避免耗时
    streamChat: async ({ messages }) => {
      const sys = messages[0].content
      if (sys.includes('取证分析器')) {
        attempts++
        if (attempts < 5) throw new Error(`模拟第 ${attempts} 次网络/超时失败`)
        return { content: JSON.stringify({ herTraits: ['独立'], stageHint: '交往' }) }
      }
      if (sys.includes('档案终稿')) return { content: JSON.stringify({ stage: '交往', summary: 'ok', memories: [] }) }
      return { content: JSON.stringify({ herTraits: ['独立'] }) }
    },
  })
  const { job } = await rt.startForSession(S.id)
  await waitFor(() => store.getImportJob(job.id).state === 'done')
  assert.equal(attempts, 5, '第 5 次重试应当成功')
  const finished = store.getImportJob(job.id)
  assert.equal(finished.chunks[0].digest.herTraits[0], '独立')
})

test('importer: 阶段检查点保存与断点复跑 — Phase 3 完成后跳过 Map 和 Reduce 直接落库', async () => {
  const S = mkSession('chat_checkpoint_phase3_skip')
  let mapCalls = 0
  let reduceCalls = 0

  const rt = createImportRuntime({
    ...mkDeps(S),
    streamChat: async ({ messages }) => {
      const sys = messages[0].content
      if (sys.includes('取证分析器')) {
        mapCalls++
        return { content: JSON.stringify({ events: [{ date: '2026-02-01', event: '吃饭' }], stageHint: '交往' }) }
      }
      if (sys.includes('档案终稿')) {
        reduceCalls++
        return { content: JSON.stringify({ stage: '交往', summary: '关系良好', memories: [{ type: 'episodic', content: '吃饭' }] }) }
      }
      reduceCalls++
      return { content: JSON.stringify({ stageHint: '交往' }) }
    },
  })

  // 1. 首次完整运行
  const { job: job1, case: case1 } = await rt.startForSession(S.id)
  await waitFor(() => store.getImportJob(job1.id).state === 'done')
  store.upsertImportJob({ ...store.getImportJob(job1.id), state: 'error', error: '持久化后服务中断' })

  const j1 = store.getImportJob(job1.id)
  assert.ok(j1.checkpoints?.prepare?.completedAt, '应有 prepare checkpoint')
  assert.ok(j1.checkpoints?.map?.completedAt, '应有 map checkpoint')
  assert.ok(j1.checkpoints?.reduce?.completedAt, '应有 reduce checkpoint')
  assert.ok(j1.checkpoints?.persist?.completedAt, '应有 persist checkpoint')
  assert.ok(j1.final?.draft, '终稿应当保存于 job.final')

  // 2. 模拟服务断点复跑（无 force），已有完整的 Phase 3 checkpoint
  mapCalls = 0
  reduceCalls = 0
  const { job: job2 } = await rt.startForSession(S.id)
  await waitFor(() => store.getImportJob(job2.id).state === 'done')

  assert.equal(mapCalls, 0, 'Phase 3 已完成的复跑，Map LLM 调用次数必须为 0')
  assert.equal(reduceCalls, 0, 'Phase 3 已完成的复跑，Reduce LLM 调用次数必须为 0')

  const j2 = store.getImportJob(job2.id)
  assert.equal(j2.checkpoints?.resumedFrom, job1.id, '应当标注从 job1 断点复跑')
  assert.equal(j2.mapDone, j2.mapTotal)
  assert.equal(j2.reduceDone, j2.reduceTotal)
})

test('importer: 阶段检查点断点复跑 — Phase 2 完成但 Phase 3 未完成时跳过 Map 并执行 Reduce', async () => {
  const S = mkSession('chat_checkpoint_phase2_skip')
  let mapCalls = 0
  let reduceCalls = 0

  const rt = createImportRuntime({
    ...mkDeps(S),
    streamChat: async ({ messages }) => {
      const sys = messages[0].content
      if (sys.includes('取证分析器')) {
        mapCalls++
        return { content: JSON.stringify({ events: [{ date: '2026-03-01', event: '散步' }], stageHint: '暧昧' }) }
      }
      if (sys.includes('档案终稿')) {
        reduceCalls++
        return { content: JSON.stringify({ stage: '暧昧', summary: '散步', memories: [] }) }
      }
      reduceCalls++
      return { content: JSON.stringify({ stageHint: '暧昧' }) }
    },
  })

  // 创建一个模拟的 job：Phase 2 Map 已经完成，但 Phase 3 未完成
  const c = createCase({ title: '测试断点', sessionIds: [S.id] })
  const mockChunks = (await buildChunks(S.id, '我本人', mkDeps(S).fetchPage)).map(chunk => ({
    since: chunk.since,
    until: chunk.until,
    sourceHash: chunk.sourceHash,
    digest: { events: [{ date: '2026-03-01', event: '散步', quote: '' }], herTraits: ['开朗'], herLikes: [], herDislikes: [], herStyle: '', myStyle: '', myPitfalls: [], openLoops: [], riskSignals: [], stageHint: '暧昧' },
    warning: '',
  }))

  const prevHalfJob = {
    id: 'imp_mock_half_finished',
    caseId: c.id,
    sessionId: S.id,
    force: false,
    state: 'error',
    phase: 'reduce',
    mapDone: mockChunks.length,
    mapTotal: mockChunks.length,
    reduceDone: 0,
    reduceTotal: 1,
    ownerName: '我本人',
    peerName: '小美',
    since: mockChunks[0].since,
    until: mockChunks[mockChunks.length - 1].until,
    chunks: mockChunks,
    warnings: [],
    error: '服务中断',
    checkpoints: {
      prepare: { completedAt: '2026-03-01T00:00:00Z', chunkCount: mockChunks.length },
      map: { completedAt: '2026-03-01T00:01:00Z', mapTotal: mockChunks.length, mapDone: mockChunks.length },
    },
    createdAt: new Date(Date.now() - 10000).toISOString(),
    updatedAt: new Date(Date.now() - 10000).toISOString(),
  }
  store.upsertImportJob(prevHalfJob)

  // 启动新任务进行断点续跑
  mapCalls = 0
  reduceCalls = 0
  const { job: resumedJob } = await rt.startForSession(S.id, { caseId: c.id })
  await waitFor(() => store.getImportJob(resumedJob.id).state === 'done')

  assert.equal(mapCalls, 0, 'Phase 2 已完成时，Map LLM 应直接跳过，调用次数为 0')
  assert.ok(reduceCalls >= 1, 'Phase 3 应当继续执行并调用 Reduce LLM')

  const jResumed = store.getImportJob(resumedJob.id)
  assert.equal(jResumed.state, 'done')
  assert.ok(jResumed.checkpoints?.reduce?.completedAt, '应产生新的 reduce checkpoint')
  assert.ok(jResumed.checkpoints?.persist?.completedAt, '应产生新的 persist checkpoint')
})
