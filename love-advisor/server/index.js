import express from 'express'
import { registerQceRoutes } from './qce.js'
import { clbImportBuffer } from './qce.js'
import { registerChatlabRoutes, buildEvidencePack } from './chatlab.js'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json({ limit: '200mb' }))

// ── 配置：读取项目根 .env ─────────────────────────────
const ROOT_ENV = path.join(__dirname, '..', '..', '.env')
function loadEnv() {
  try {
    const env = {}
    for (const line of fs.readFileSync(ROOT_ENV, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/)
      if (m) env[m[1]] = m[2]
    }
    return env
  } catch { return {} }
}
const ENV = loadEnv()

// ── Skill 加载：@ 选择时注入 system prompt ────────────
// 注意：只注入 SKILL.md 会让其中「加载 references/xxx.md」变成无法执行的死指令，
// 模型会假装读过并编造内容。因此改为递归展开 skill 目录下的全部 md。
const SKILL_ROOT = path.join(__dirname, '..', '..')
const SKILL_REGISTRY = {
  'relationship-advisor': path.join(SKILL_ROOT, 'relationship-advisor-skill', 'SKILL.md'),
}
const MAX_SKILL_BYTES = 120 * 1024

// 收集 references/ 与 style/ 下的所有 md，按路径排序保证注入顺序稳定。
// README / EVALUATION 等是给人看的项目文档，不进上下文。
const SKILL_DOC_DIRS = ['references', 'style']
function collectSkillDocs(skillPath) {
  const root = path.dirname(skillPath)
  const out = []
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (e.name.toLowerCase().endsWith('.md')) out.push(p)
    }
  }
  for (const sub of SKILL_DOC_DIRS) walk(path.join(root, sub))
  return out.sort()
}

function loadSkillPrompt(skillIds) {
  const parts = []
  for (const id of skillIds) {
    const p = SKILL_REGISTRY[id]
    if (!p) continue
    let text
    try { text = fs.readFileSync(p, 'utf8') } catch { continue }

    const docs = []
    let total = Buffer.byteLength(text)
    for (const f of collectSkillDocs(p)) {
      const rel = path.relative(path.dirname(p), f).split(path.sep).join('/')
      let body
      try { body = fs.readFileSync(f, 'utf8') } catch { continue }
      const size = Buffer.byteLength(body)
      if (total + size > MAX_SKILL_BYTES) {
        docs.push(`<skill_doc path="${rel}" truncated="true">（体积超限，未注入）</skill_doc>`)
        continue
      }
      total += size
      docs.push(`<skill_doc path="${rel}">\n${body}\n</skill_doc>`)
    }

    // 显式声明「已全部注入」，避免模型仍去尝试读取文件而产生幻觉
    if (docs.length) {
      text +=
        '\n\n<skill_references injected="true">\n' +
        '以下是本 Skill 的 references / style 全文，已全部注入上下文。\n' +
        '不要尝试读取、请求或引用任何未在本块中出现的文件路径；' +
        '正文中提到的模块名请以本块内容为准。\n\n' +
        docs.join('\n\n') +
        '\n</skill_references>'
    }
    parts.push(text)
  }
  return parts.join('\n\n---\n\n')
}

// ── /api/import/dry-run 与 /api/import（文件上传路径） ──
app.post('/api/import/dry-run', (req, res) => handleImport(req, res, true))
app.post('/api/import', (req, res) => handleImport(req, res, false))

async function handleImport(req, res, dryRun) {
  try {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const buf = Buffer.concat(chunks)

    // 简易 multipart 解析（只取第一个 file 字段，避免引 multer）
    const m = (req.headers['content-type'] || '').match(/boundary=(?:"([^"]+)"|([^;]+))/)
    const boundary = m ? (m[1] || m[2]) : null
    if (!boundary) return res.status(400).json({ ok: false, error: '缺少 multipart boundary' })

    const raw = buf.toString('latin1')
    let fileBuf = null, filename = 'upload.json'
    for (const part of raw.split(`--${boundary}`)) {
      if (!part.includes('filename=')) continue
      const headerEnd = part.indexOf('\r\n\r\n')
      if (headerEnd < 0) continue
      const nameMatch = part.slice(0, headerEnd).match(/filename="([^"]*)"/)
      if (nameMatch) filename = nameMatch[1]
      fileBuf = Buffer.from(part.slice(headerEnd + 4, part.lastIndexOf('\r\n')), 'latin1')
    }
    if (!fileBuf) return res.status(400).json({ ok: false, error: '未找到文件' })

    const data = await clbImportBuffer(fileBuf, filename, dryRun)
    res.json({ ok: true, data })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
}

// ── QQ 直连（QCE 代理路由） ───────────────────────────
registerQceRoutes(app)

// ── ChatLab：会话列表 + 证据包 ─────────────────────────
registerChatlabRoutes(app)

// ── /api/chat （真实 LLM，OpenAI 兼容流式转发） ────────
app.post('/api/chat', async (req, res) => {
  const { messages = [], skills = [], sessionId = '' } = req.body
  const skillPrompt = loadSkillPrompt(skills)
  const systemParts = []
  if (skillPrompt) systemParts.push(skillPrompt)
  if (sessionId) {
    try {
      const pack = await buildEvidencePack(sessionId)
      const missing =
        !pack.evidence.recent14d && !(pack.evidence.anomalyWindows || []).some(w => w.text) && !pack.evidence.keywordHits
      systemParts.push(
        `【聊天记录证据包】以下是用户选定会话（${pack.sessionId}）的结构化分析证据：` +
        `baseline 为统计底盘，metrics 为恋爱特化指标（话题先手/冷启动/沉默期），` +
        `evidence 为原文切片（近14天/异常窗口）与关键词命中。\n` +
        `使用规则：时间趋势与投入类结论必须引用统计数字；语言与边界类结论必须引用 evidence 中的原话并注明时间；` +
        `证据不足时明确说明，不要臆测。\n` +
        (missing
          ? `【注意】本次原文证据层采集失败（${pack.warnings.join('；') || '未知原因'}），证据包中缺少对话原文。` +
            `回复开头必须先告知用户"聊天数据暂时加载不完整，建议稍后重试"，再基于现有统计作答。\n`
          : '') +
        JSON.stringify(pack)
      )
    } catch (e) {
      systemParts.push(`【警告】聊天数据加载失败：${e.message}。请在回复开头告知用户该情况。`)
    }
  }
  // 合并为单条 system：部分 OpenAI 兼容后端只认第一条 system 消息
  const upstreamMessages = systemParts.length
    ? [{ role: 'system', content: systemParts.join('\n\n=====\n\n') }, ...messages]
    : messages

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  try {
    const upstream = await fetch(ENV.BASE_URL + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ENV.API_KEY}`,
      },
      body: JSON.stringify({
        model: ENV.BASE_MODEL,
        messages: upstreamMessages,
        stream: true,
      }),
      signal: AbortSignal.timeout(300000),
    })

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '')
      res.write(`data: ${JSON.stringify({ error: `上游 ${upstream.status}: ${errText.slice(0, 200)}` })}\n\n`)
      res.write('data: [DONE]\n\n')
      return res.end()
    }

    // 解析上游 SSE：reasoning_content → {r}，content → {t}，逐段转发
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() // 半行留待下轮
      for (const line of lines) {
        const l = line.trim()
        if (!l.startsWith('data:')) continue
        const payload = l.slice(5).trim()
        if (payload === '[DONE]') continue
        try {
          const delta = JSON.parse(payload).choices?.[0]?.delta || {}
          if (delta.reasoning_content) res.write(`data: ${JSON.stringify({ r: delta.reasoning_content })}\n\n`)
          if (delta.content) res.write(`data: ${JSON.stringify({ t: delta.content })}\n\n`)
        } catch { /* 非 JSON 行忽略 */ }
      }
    }
    res.write('data: [DONE]\n\n')
    res.end()
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  }
})

app.listen(3111, () => {
  console.log('[love-advisor] server ready at http://localhost:3111')
})
