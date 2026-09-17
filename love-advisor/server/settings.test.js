// ── settings：LLM 运行时配置（覆盖 .env、校验、持久化） ──
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'love-advisor-settings-test-'))
process.env.LOVE_ADVISOR_DATA_DIR = tmpDir

const { createSettingsStore } = await import('./settings.js')

beforeEach(() => {
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { force: true })
})

test('默认值来自 process.env / fileEnv，set 覆盖并持久化，get 脱敏而 getRaw 保持明文', () => {
  const s = createSettingsStore({ fileEnv: { BASE_URL: 'http://from-env', API_KEY: 'sk-1234567890abcdef', BASE_MODEL: 'm-env', TOOL_TIMEOUT_MS: '45000' } })
  assert.equal(s.get().BASE_URL, 'http://from-env')
  assert.equal(s.get().hasApiKey, true)
  assert.match(s.get().API_KEY, /\*\*\*\*/) // get() 返回脱敏密钥
  assert.equal(s.getRaw().API_KEY, 'sk-1234567890abcdef') // getRaw() 保持完整真实密钥
  assert.equal(s.get().TOOL_TIMEOUT_MS, 45000)

  s.set({ BASE_URL: 'http://new', BASE_MODEL: 'm2', TOOL_TIMEOUT_MS: 60000 })
  assert.equal(s.get().BASE_URL, 'http://new')
  assert.equal(s.getRaw().API_KEY, 'sk-1234567890abcdef') // 未传的键保持

  // 前端回传脱敏后的掩码字符串时，不覆盖已有的真实密钥
  s.set({ API_KEY: s.get().API_KEY })
  assert.equal(s.getRaw().API_KEY, 'sk-1234567890abcdef')

  // 落盘：新实例读到相同值（重启恢复）
  const s2 = createSettingsStore({ fileEnv: { BASE_URL: 'http://from-env', BASE_MODEL: 'm-env' } })
  assert.equal(s2.get().BASE_URL, 'http://new')
  assert.equal(s2.get().BASE_MODEL, 'm2')
  assert.equal(s2.getRaw().API_KEY, 'sk-1234567890abcdef')
  assert.equal(s2.get().TOOL_TIMEOUT_MS, 60000)
})

test('校验：BASE_URL 必须 http(s)、BASE_MODEL 非空，拒绝时不落盘', () => {
  const s = createSettingsStore({ fileEnv: { BASE_URL: 'http://a', BASE_MODEL: 'm' } })
  assert.throws(() => s.set({ BASE_URL: 'ftp://x' }), /http\(s\)/)
  assert.throws(() => s.set({ BASE_MODEL: '  ' }), /BASE_MODEL/)
  assert.throws(() => s.set({ MAX_TOOL_ROUNDS: 0 }), /MAX_TOOL_ROUNDS/)
  assert.throws(() => s.set({ MAX_TOOL_ROUNDS: 50 }), /MAX_TOOL_ROUNDS/)
  assert.throws(() => s.set({ TOOL_TIMEOUT_MS: 999 }), /TOOL_TIMEOUT_MS/)
  assert.throws(() => s.set({ TOOL_TIMEOUT_MS: 120001 }), /TOOL_TIMEOUT_MS/)
  s.set({ MAX_TOOL_ROUNDS: 12 })
  assert.equal(s.get().MAX_TOOL_ROUNDS, 12)
  assert.equal(s.get().BASE_URL, 'http://a') // 非法 patch 不生效
})

test('无任何来源时为空串（服务未配置态）', () => {
  const savedUrl = process.env.BASE_URL
  const savedModel = process.env.BASE_MODEL
  const savedRounds = process.env.MAX_TOOL_ROUNDS
  const savedToolTimeout = process.env.TOOL_TIMEOUT_MS
  delete process.env.BASE_URL
  delete process.env.BASE_MODEL
  delete process.env.MAX_TOOL_ROUNDS
  delete process.env.TOOL_TIMEOUT_MS
  try {
    const s = createSettingsStore({ fileEnv: {} })
    assert.equal(s.get().BASE_URL, '')
    assert.equal(s.get().BASE_MODEL, '')
    assert.equal(s.get().MAX_TOOL_ROUNDS, 12)
    assert.equal(s.get().TOOL_TIMEOUT_MS, 30000)
  } finally {
    if (savedUrl !== undefined) process.env.BASE_URL = savedUrl
    if (savedModel !== undefined) process.env.BASE_MODEL = savedModel
    if (savedRounds !== undefined) process.env.MAX_TOOL_ROUNDS = savedRounds
    if (savedToolTimeout !== undefined) process.env.TOOL_TIMEOUT_MS = savedToolTimeout
  }
})

test('首次保存创建数据目录，落盘失败不修改生效配置', () => {
  fs.rmdirSync(tmpDir)
  const store = createSettingsStore()
  store.set({ BASE_MODEL: 'first-save' })
  assert.equal(createSettingsStore().get().BASE_MODEL, 'first-save')
  const settingsPath = path.join(tmpDir, 'settings.json')
  fs.unlinkSync(settingsPath)
  fs.mkdirSync(settingsPath)
  try {
    assert.throws(() => store.set({ BASE_MODEL: 'failed-save' }))
    assert.equal(store.get().BASE_MODEL, 'first-save')
  } finally {
    fs.rmdirSync(settingsPath)
  }
})
