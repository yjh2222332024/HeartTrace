import express from 'express'
import { registerQceRoutes, clbImportBuffer, assertLocalRequest } from './qce.js'
import { registerChatlabRoutes, buildEvidencePack } from './chatlab.js'
import { registerInsightRoutes } from './insight.js'
import { buildUpstreamMessages } from './prompt.js'
import { registerRunRoutes } from './runs.js'
import { streamChatCompletion } from './llm.js'
import { loadSelectedMessages } from './selection.js'
import { registerPrivacyGate } from './privacy.js'
import { createSkillRuntime } from './skill.js'
import { createToolRegistry } from './tools.js'
import { registerCaseRoutes } from './cases.js'
import { createImportRuntime } from './importer.js'
import { registerQqMediaRoutes } from './qqmedia.js'
import { createSettingsStore } from './settings.js'
import { createAdvisorPromptStore } from './advisor-prompts.js'
import { isGroupChat } from './chatgate.js'
import { parseMultipartFile } from './multipart.js'
import { registerSkillImportRoutes } from './skill-import-routes.js'
import { registerTrainingRoutes } from './training.js'
import { migrateLegacyData } from './runtime-paths.js'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use('/api', (req, res, next) => {
  try { assertLocalRequest(req); next() }
  catch (e) { res.status(e.status || 403).json({ ok: false, error: e.message }) }
})
app.use(express.json({ limit: '2mb' }))

// ── 配置：读取项目 .env ───────────────────────────────
function loadEnv() {
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '..', '.env'),
  ]
  const env = {}
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue
    try {
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/)
        if (m && env[m[1]] === undefined) env[m[1]] = m[2]
      }
    } catch {}
  }
  return env
}
const FILE_ENV = loadEnv()
for (const [key, value] of Object.entries(FILE_ENV)) {
  if (process.env[key] === undefined) process.env[key] = value
}

// npm 更新会替换安装目录。首次启动只复制旧版 server/.data 中尚未迁移的文件，
// 不覆盖新目录，也不删除旧数据，便于异常时手动恢复。
const migration = migrateLegacyData()
if (migration.copied.length) {
  console.log(`[love-advisor] migrated ${migration.copied.length} data files to ${migration.target}`)
}

// ── LLM 运行时配置：根 .env 为默认值，前端设置（settings.json）覆盖并即时生效 ──
const llmSettings = createSettingsStore({ fileEnv: FILE_ENV })
registerPrivacyGate(app, () => llmSettings.getRaw())

// ── Skill Runtime：渐进披露 ────
// L0 安全常驻；L1 注入 SKILL.md / alwaysLoad / style；L2 由模型 read_skill_doc
// 仅用户本次 @ 选择时装配军师技能。
const advisorPrompts = createAdvisorPromptStore()
const skillRuntime = createSkillRuntime({ promptStore: advisorPrompts })
const toolRegistry = createToolRegistry({ skillRuntime })

// ── 导入分析 Runtime：工作区 ↔ 私聊 1:1，创建即后台分析全量记录 ──
const importer = createImportRuntime({ env: () => llmSettings.getRaw() })

// ── LLM 设置：查看 / 更新（即时生效，回环安全防护 + API Key 脱敏） ────
app.get('/api/settings', (req, res) => {
  try {
    res.json({ ok: true, data: llmSettings.get() })
  } catch (e) {
    res.status(e.status || 403).json({ ok: false, error: e.message })
  }
})
app.put('/api/settings', (req, res) => {
  try {
    res.json({ ok: true, data: llmSettings.set(req.body || {}) })
  } catch (e) {
    const status = e.status || (e.message?.includes('地址') || e.message?.includes('BASE_MODEL') ? 400 : 500)
    res.status(status).json({ ok: false, error: e.message })
  }
})

// ── /api/import/dry-run 与 /api/import（文件上传路径） ──
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024 // 100MB 限制防 OOM
app.post('/api/import/dry-run', (req, res) => handleImport(req, res, true))
app.post('/api/import', (req, res) => handleImport(req, res, false))

async function handleImport(req, res, dryRun) {
  try {
    const cl = Number(req.headers['content-length'])
    if (Number.isFinite(cl) && cl > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ ok: false, error: '上传文件过大，超出 100MB 限制' })
    }

    let total = 0
    const chunks = []
    for await (const c of req) {
      total += c.length
      if (total > MAX_UPLOAD_BYTES) {
        return res.status(413).json({ ok: false, error: '上传文件过大，超出 100MB 限制' })
      }
      chunks.push(c)
    }
    const buf = Buffer.concat(chunks)

    // 提取 boundary
    const m = (req.headers['content-type'] || '').match(/boundary=(?:"([^"]+)"|([^;]+))/)
    const boundary = m ? (m[1] || m[2]) : null
    if (!boundary) return res.status(400).json({ ok: false, error: '缺少 multipart boundary' })

    const parsed = parseMultipartFile(buf, boundary)
    if (!parsed || !parsed.fileBuf.length) return res.status(400).json({ ok: false, error: '未找到文件' })

    const { fileBuf, filename } = parsed
    const preview = await clbImportBuffer(fileBuf, filename, true)
    if (isGroupChat(preview)) {
      return res.status(400).json({ ok: false, error: `「${preview.name || filename}」是群聊。恋爱军师只分析一对一私聊。` })
    }
    if (dryRun) return res.json({ ok: true, data: preview })
    const data = await clbImportBuffer(fileBuf, filename, false)
    if (data.sessionId) {
      const attached = await attachWorkspace(data)
      return res.json({ ok: true, data: attached })
    }
    res.json({ ok: true, data })
  } catch (e) {
    res.status(e.code === 'GROUP_CHAT_BLOCKED' ? 400 : 500).json({ ok: false, error: e.message })
  }
}

async function attachWorkspace(imported) {
  try {
    // 创建即自动启动导入分析（后台 Job），返回创建/复用的工作区与任务快照
    const { case: workspace, job } = await importer.startForSession(imported.sessionId)
    return { ...imported, workspace, importJob: job }
  } catch (e) {
    if (e.code === 'GROUP_CHAT_BLOCKED') throw e
    return { ...imported, workspaceError: e.message }
  }
}

// ── QQ 直连（QCE 代理路由） ───────────────────────────
registerQceRoutes(app, { afterImport: attachWorkspace })

// ── QQ 媒体还原（NTQQ 本地缓存图片） ───────────────────
registerQqMediaRoutes(app)

// ── ChatLab：会话列表 + 证据包 ─────────────────────────
registerChatlabRoutes(app)

// ── 导入分析：发起 / 进度 / 取消 ───────────────────────
importer.registerRoutes(app)

// ── Insight：消息分页 + 指标聚合（可视化数据源） ────────
registerInsightRoutes(app)

// ── Cases：关系案例 + 长期记忆 ─────────────────────────
registerCaseRoutes(app, {
  startForSession: importer.startForSession,
  cancelJobsForCase: importer.cancelJobsForCase,
})

// ── Skill 列表（前端 @ 菜单数据源） ────────────────────
app.get('/api/skills', (_req, res) => {
  res.json({ ok: true, data: { items: skillRuntime.list() } })
})

app.get('/api/advisor-prompts/:id', (req, res) => {
  try {
    const result = skillRuntime.promptConfigFor(req.params.id)
    if (!result.ok) return res.status(404).json(result)
    res.json({ ok: true, data: result })
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message })
  }
})

app.put('/api/advisor-prompts/:id', (req, res) => {
  try {
    res.json({ ok: true, data: skillRuntime.setPrompt(req.params.id, req.body?.prompt) })
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message })
  }
})

app.delete('/api/advisor-prompts/:id', (req, res) => {
  try {
    res.json({ ok: true, data: skillRuntime.resetPrompt(req.params.id) })
  } catch (e) {
    const status = e.message === '军师不存在' ? 404 : 400
    res.status(status).json({ ok: false, error: e.message })
  }
})

// ── 军师包导入：只校验和安装静态 Skill 文件，不执行包内脚本 ──
registerSkillImportRoutes(app, {
  skillsDir: process.env.LOVE_ADVISOR_SKILLS_DIR,
})

// ── 模拟聊天训练场：与普通咨询会话独立 ───────────────────
registerTrainingRoutes(app, {
  getEnv: () => llmSettings.getRaw(),
  streamChat: streamChatCompletion,
  buildEvidencePack,
  skillRuntime,
})

// ── 工具列表（Tool Registry 调试/前端时间线数据源） ────
app.get('/api/tools', (_req, res) => {
  res.json({ ok: true, data: { items: toolRegistry.list() } })
})

// ── Run Runtime：POST /api/runs + Run 查询/取消 + 会话 CRUD ──
registerRunRoutes(app, {
  assembleSkills: (selectedIds) => skillRuntime.assemble({ selectedIds }),
  buildEvidencePack,
  loadSelectedMessages,
  buildUpstreamMessages,
  getEnv: () => llmSettings.getRaw(),
  toolRegistry,
  streamChat: streamChatCompletion,
})

// ── 静态资源托管：若 dist 目录存在，Express 直接托管单页应用 ──
const distDir = path.resolve(__dirname, '../dist')
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir))
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next()
    if (req.path.startsWith('/api/')) return next()
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

app.use((err, _req, res, _next) => {
  if (res.headersSent) return
  if (err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'JSON 请求超过 2MB 限制' })
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: '请求 JSON 格式无效' })
  }
  res.status(500).json({ ok: false, error: '服务器内部错误' })
})

export function startServer({ port = Number(process.env.PORT || 3111), host = process.env.HOST || '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      resolve({ server, port, host, url: `http://${host}:${port}` })
    })
    server.on('error', reject)
  })
}

export { app }

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  startServer().then(({ url }) => {
    console.log(`[love-advisor] server ready at ${url}`)
  }).catch(e => {
    console.error(`[love-advisor] failed to start:`, e)
    process.exit(1)
  })
}
