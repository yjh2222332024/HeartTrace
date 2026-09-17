import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import express from 'express'
import { registerPrivacyGate } from './privacy.js'
import { assertSafeImportJsonNesting, MAX_IMPORT_JSON_NESTING, readBoundedDownload, runChildProcess } from './qce.js'
import { qceConfig, resolveQceDownloadUrl } from './qce.js'
import { validateSessionId, detectWindows } from './chatlab.js'

test('QCE configuration accepts loopback hosts only', () => {
  assert.equal(qceConfig({ headers: {} }).base, 'http://localhost:40653')
  assert.equal(
    qceConfig({ headers: { 'x-qce-base': 'http://127.0.0.1:40653/' } }).base,
    'http://127.0.0.1:40653'
  )
  assert.equal(
    qceConfig({ headers: { 'x-qce-base': 'http://[::1]:40653' } }).base,
    'http://[::1]:40653'
  )
  assert.throws(
    () => qceConfig({ headers: { 'x-qce-base': 'https://qce.example.com' } }),
    /本机回环地址/
  )
})

test('download cap rejects declared and streamed overflow and cancels the body', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(8)); c.enqueue(new Uint8Array(8)) },
    cancel() { cancelled = true },
  }))
  await assert.rejects(readBoundedDownload(response, 10), /100MB/)
  assert.equal(cancelled, true)
  await assert.rejects(readBoundedDownload(new Response('small', { headers: { 'content-length': '20' } }), 10), /100MB/)
  assert.equal((await readBoundedDownload(new Response('small'), 10)).toString(), 'small')
})

test('导入 JSON 在进入 ChatLab CLI 前限制嵌套深度', () => {
  assert.doesNotThrow(() => assertSafeImportJsonNesting(Buffer.from('{"message":"[{}]"}')))
  const nested = Buffer.from(`${'['.repeat(MAX_IMPORT_JSON_NESTING + 1)}${']'.repeat(MAX_IMPORT_JSON_NESTING + 1)}`)
  assert.throws(() => assertSafeImportJsonNesting(nested), /嵌套层级超过/)
})

test('ChatLab 子进程支持超时和取消', async () => {
  const waitScript = 'setTimeout(() => {}, 10000)'
  await assert.rejects(
    runChildProcess(process.execPath, ['-e', waitScript], { timeoutMs: 50 }),
    error => error.code === 'TOOL_TIMEOUT' && error.retryable === true,
  )

  const controller = new AbortController()
  const pending = runChildProcess(process.execPath, ['-e', waitScript], {
    signal: controller.signal,
    timeoutMs: 5000,
  })
  controller.abort()
  await assert.rejects(
    pending,
    error => error.code === 'TOOL_CANCELLED' && error.retryable === false,
  )
})

test('privacy gate blocks execution until explicit consent and resets on provider change', async t => {
  const app = express()
  app.use(express.json())
  const env = { BASE_URL: 'https://model.example/v1', BASE_MODEL: 'test', API_KEY: 'secret' }
  registerPrivacyGate(app, () => env)
  let calls = 0
  app.post('/api/runs', (_req, res) => { calls++; res.json({ ok: true }) })
  app.post('/api/training/scenarios', (_req, res) => { calls++; res.json({ ok: true }) })
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const post = (route, body = {}) => fetch(`http://127.0.0.1:${server.address().port}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const denied = await post('/api/runs')
  assert.equal(denied.status, 428)
  const payload = await denied.json()
  assert.doesNotMatch(JSON.stringify(payload), /secret/)
  assert.equal(calls, 0)
  assert.equal((await post('/api/training/scenarios')).status, 428)
  assert.equal(calls, 0)
  assert.equal((await post('/api/privacy/consent', { accepted: true, challenge: payload.data.challenge })).status, 200)
  assert.equal((await post('/api/runs')).status, 200)
  assert.equal((await post('/api/training/scenarios')).status, 200)
  env.BASE_URL = 'https://other.example/v1'
  assert.equal((await post('/api/runs')).status, 428)
  assert.equal((await post('/api/privacy/consent', { accepted: true, challenge: payload.data.challenge })).status, 409)
  assert.equal(calls, 2)
})

test('privacy gate does not block local-only skill package inspection', async t => {
  const app = express()
  app.use(express.json())
  registerPrivacyGate(app, () => ({ BASE_URL: 'https://model.example/v1', BASE_MODEL: 'test', API_KEY: 'secret' }))
  let calls = 0
  app.post('/api/advisor-imports/inspect', (_req, res) => { calls++; res.json({ ok: true }) })
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/advisor-imports/inspect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
  assert.equal(response.status, 200)
  assert.equal(calls, 1)
})

test('privacy gate covers every training model endpoint but leaves local-only controls available', async t => {
  const app = express()
  app.use(express.json())
  registerPrivacyGate(app, () => ({ BASE_URL: 'https://model.example/v1', BASE_MODEL: 'test', API_KEY: 'secret' }))
  let modelCalls = 0
  let localCalls = 0
  const modelRoutes = [
    '/api/training/scenarios',
    '/api/training/sessions',
    '/api/training/sessions/test/turn',
    '/api/training/sessions/test/coach',
    '/api/training/sessions/test/review',
  ]
  for (const route of modelRoutes) app.post(route, (_req, res) => { modelCalls++; res.json({ ok: true }) })
  app.post('/api/training/sessions/test/resume', (_req, res) => { localCalls++; res.json({ ok: true }) })
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const post = route => fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })

  for (const route of modelRoutes) assert.equal((await post(route)).status, 428, route)
  assert.equal(modelCalls, 0)
  assert.equal((await post('/api/training/sessions/test/resume')).status, 200)
  assert.equal(localCalls, 1)
})

test('actual API applies local guard before JSON parsing to every route', async t => {
  const previousDataDir = process.env.LOVE_ADVISOR_DATA_DIR
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'love-advisor-api-test-'))
  process.env.LOVE_ADVISOR_DATA_DIR = dataDir
  const { app } = await import('./index.js')
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(dataDir, { recursive: true, force: true })
    if (previousDataDir === undefined) delete process.env.LOVE_ADVISOR_DATA_DIR
    else process.env.LOVE_ADVISOR_DATA_DIR = previousDataDir
  })
  const base = `http://127.0.0.1:${server.address().port}`
  for (const route of ['conversations', 'cases', 'runs', 'imports', 'clb/messages', 'qq/friends', 'qq/pic/abc', 'skills']) {
    const status = await new Promise((resolve, reject) => {
      http.get(`${base}/api/${route}`, { headers: { host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode) }).on('error', reject)
    })
    assert.equal(status, 403, route)
  }
  const cross = await fetch(`${base}/api/skills`, { headers: { Origin: 'https://evil.example' } })
  assert.equal(cross.status, 403)
  const huge = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(2 * 1024 * 1024) }) })
  assert.equal(huge.status, 413)
})

test('QCE export downloads must remain on the configured origin', () => {
  const config = { base: 'http://localhost:40653', token: 'secret' }
  assert.equal(
    resolveQceDownloadUrl('/exports/chat.json', config).toString(),
    'http://localhost:40653/exports/chat.json'
  )
  assert.throws(
    () => resolveQceDownloadUrl('https://attacker.example/chat.json', config),
    /QCE 服务地址/
  )
})

test('ChatLab session IDs cannot carry shell metacharacters', () => {
  assert.equal(validateSessionId('session_2026-09-05.1'), 'session_2026-09-05.1')
  assert.throws(() => validateSessionId('valid-id & whoami'), /会话 ID 格式无效/)
})

test('ChatLab daily windows keep local calendar dates stable across timezones', () => {
  const result = detectWindows([
    { day: '2026-09-01', cnt: 10 },
    { day: '2026-09-04', cnt: 10 },
  ])
  assert.deepEqual(result.silence, [{ start: '2026-09-02', end: '2026-09-03' }])
  assert.deepEqual(result.windows[0], {
    label: '沉默期 2026-09-02 ~ 2026-09-03',
    since: '2026-09-01',
    until: '2026-09-04',
  })
})

test('validateQceExePath: 严格限制白名单文件名与受信安装根目录', async () => {
  const { validateQceExePath } = await import('./qce.js')
  // 非法文件名
  assert.throws(() => validateQceExePath('C:\\Windows\\System32\\calc.exe'), /QQ Chat Exporter.exe/)
  // 伪造在未授权目录（如 Downloads）
  assert.throws(() => validateQceExePath(path.resolve('untrusted-test-directory', 'QQ Chat Exporter.exe')), /受信任安装目录/)
})

test('assertLocalRequest: 拦截非本机 Host 与外部网站跨站请求', async () => {
  const { assertLocalRequest } = await import('./qce.js')
  const localSocket = { remoteAddress: '127.0.0.1' }
  // 本地 Host 放行
  assert.doesNotThrow(() => assertLocalRequest({ socket: localSocket, headers: { host: 'localhost:3111' } }))
  assert.doesNotThrow(() => assertLocalRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { host: '127.0.0.1:3111', origin: 'http://localhost:5173' } }))
  // 伪造本地 Host 也不能绕过真实连接来源检查
  assert.throws(() => assertLocalRequest({ socket: { remoteAddress: '192.168.1.25' }, headers: { host: '127.0.0.1:3111' } }), /请求连接必须来自本机/)
  // 非法 Host 拦截
  assert.throws(() => assertLocalRequest({ socket: localSocket, headers: { host: 'attacker.com' } }), /本机回环网络/)
  // 外部 Origin 拦截
  assert.throws(() => assertLocalRequest({ socket: localSocket, headers: { host: '127.0.0.1:3111', origin: 'http://evil.com' } }), /禁止非本地网页跨站调用/)
})
