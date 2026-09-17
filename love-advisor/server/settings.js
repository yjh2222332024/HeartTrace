// ── LLM 运行时配置：前端设置覆盖根 .env，持久化到用户数据目录 ──
// 供 /api/chat、/api/runs、importer 同源读取；PUT 即时生效（无需重启）
import fs from 'node:fs'
import path from 'node:path'
import { resolveUserDataDir } from './runtime-paths.js'

function maskApiKey(key) {
  const s = String(key || '').trim()
  if (!s) return ''
  if (s.length <= 8) return '****'
  return `${s.slice(0, 3)}****${s.slice(-4)}`
}

export function createSettingsStore({ fileEnv = {}, dataDir = resolveUserDataDir() } = {}) {
  const settingsFile = path.join(dataDir, 'settings.json')
  const defaults = {
    BASE_URL: process.env.BASE_URL || fileEnv.BASE_URL || '',
    API_KEY: process.env.API_KEY || fileEnv.API_KEY || '',
    BASE_MODEL: process.env.BASE_MODEL || fileEnv.BASE_MODEL || '',
    MAX_TOOL_ROUNDS: Number(process.env.MAX_TOOL_ROUNDS || fileEnv.MAX_TOOL_ROUNDS || 12),
    TOOL_TIMEOUT_MS: Number(process.env.TOOL_TIMEOUT_MS || fileEnv.TOOL_TIMEOUT_MS || 30000),
  }
  let saved = {}
  try { saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) || {} } catch { /* 首次启动无文件 */ }
  const state = { ...defaults, ...saved }

  // 外部/HTTP 读取：脱敏 API_KEY，带 hasApiKey 标记
  function get() {
    return {
      ...state,
      API_KEY: maskApiKey(state.API_KEY),
      hasApiKey: !!state.API_KEY,
    }
  }

  // 内部/服务端专用：读取完整明文配置（供 LLM 调用）
  function getRaw() {
    return { ...state }
  }

  function set(patch = {}) {
    const next = { ...state }
    if (patch.BASE_URL !== undefined) {
      const v = String(patch.BASE_URL).trim()
      if (!/^https?:\/\//i.test(v)) throw new Error('BASE_URL 必须是 http(s) 地址')
      next.BASE_URL = v
    }
    if (patch.API_KEY !== undefined) {
      const v = String(patch.API_KEY).trim()
      // 如果提交的是掩码占位符（说明用户未修改密钥），保持已有密钥不覆盖
      if (!v.includes('****')) {
        next.API_KEY = v
      }
    }
    if (patch.BASE_MODEL !== undefined) {
      const v = String(patch.BASE_MODEL).trim()
      if (!v) throw new Error('BASE_MODEL 不能为空')
      next.BASE_MODEL = v
    }
    if (patch.MAX_TOOL_ROUNDS !== undefined) {
      const n = Number(patch.MAX_TOOL_ROUNDS)
      if (!Number.isInteger(n) || n < 1 || n > 30) throw new Error('MAX_TOOL_ROUNDS 需为 1~30 的整数')
      next.MAX_TOOL_ROUNDS = n
    }
    if (patch.TOOL_TIMEOUT_MS !== undefined) {
      const n = Number(patch.TOOL_TIMEOUT_MS)
      if (!Number.isInteger(n) || n < 1000 || n > 120000) throw new Error('TOOL_TIMEOUT_MS 需为 1000~120000 的整数')
      next.TOOL_TIMEOUT_MS = n
    }
    fs.mkdirSync(dataDir, { recursive: true })
    const temporary = `${settingsFile}.${process.pid}.tmp`
    try {
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 })
      fs.renameSync(temporary, settingsFile)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
    Object.assign(state, next)
    return get()
  }

  return { get, getRaw, set }
}
