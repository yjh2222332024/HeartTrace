import fs from 'node:fs'
import path from 'node:path'
import { resolveUserDataDir } from './runtime-paths.js'
const MAX_PROMPT_BYTES = 16 * 1024
const PROMPT_ID_RE = /^(default|[a-z0-9][a-z0-9_-]{0,79})$/

export const DEFAULT_ADVISOR_SYSTEM_PROMPT = `你是默认情感军师，负责帮助用户看清关系事实、理解双方情绪，并做出可执行的下一步选择。

- 先回答用户此刻最关心的问题，再补充必要分析。
- 区分聊天原文、可验证事实和你的推断；证据不足时直接说明。
- 建议要具体、自然、能执行，避免空泛说教和夸张定性。
- 用户要回复话术时，先给判断，再把可直接发送的内容单独放进【建议发送】。
- 尊重用户与对方的边界，不用操控、纠缠或制造焦虑来推进关系。`

function validateId(id) {
  const value = String(id || '').trim()
  if (!PROMPT_ID_RE.test(value)) throw new Error('军师 ID 不合法')
  return value
}

function validatePrompt(prompt) {
  if (typeof prompt !== 'string') throw new Error('system prompt 必须是文本')
  const value = prompt.trim()
  if (!value) throw new Error('system prompt 不能为空')
  if (Buffer.byteLength(value, 'utf8') > MAX_PROMPT_BYTES) {
    throw new Error('system prompt 不能超过 16KB')
  }
  return value
}

export function createAdvisorPromptStore({ dataDir = resolveUserDataDir() } = {}) {
  const file = path.join(dataDir, 'advisor-prompts.json')
  let saved = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed?.prompts && typeof parsed.prompts === 'object') saved = parsed.prompts
  } catch { /* 首次启动或文件损坏时使用代码默认值。 */ }
  let prompts = { ...saved }

  function persist(nextPrompts) {
    fs.mkdirSync(dataDir, { recursive: true })
    const temporary = path.join(dataDir, `.advisor-prompts.${process.pid}.${Date.now()}.tmp`)
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, prompts: nextPrompts }, null, 2), { mode: 0o600 })
      try {
        fs.renameSync(temporary, file)
      } catch {
        fs.copyFileSync(temporary, file)
      }
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }

  function get(id, fallback) {
    const key = validateId(id)
    const customized = Object.prototype.hasOwnProperty.call(prompts, key)
    return {
      id: key,
      prompt: customized ? prompts[key] : String(fallback || '').trim(),
      customized,
    }
  }

  function set(id, prompt) {
    const key = validateId(id)
    const value = validatePrompt(prompt)
    const next = { ...prompts, [key]: value }
    persist(next)
    prompts = next
    return { id: key, prompt: value, customized: true }
  }

  function reset(id, fallback) {
    const key = validateId(id)
    const next = { ...prompts }
    delete next[key]
    persist(next)
    prompts = next
    return get(key, fallback)
  }

  return { get, set, reset }
}

export { MAX_PROMPT_BYTES }
