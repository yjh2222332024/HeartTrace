// ── 静态军师包上传路由 ───────────────────────────────────
import { parseMultipartFile } from './multipart.js'
import { createSkillImportRuntime, SKILL_PACKAGE_LIMITS } from './skill-import.js'

async function readUpload(req) {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > SKILL_PACKAGE_LIMITS.maxArchiveBytes + 1024 * 1024) {
    throw Object.assign(new Error('军师包超过 30MB 上传上限'), { status: 413 })
  }
  let total = 0
  const chunks = []
  for await (const chunk of req) {
    total += chunk.length
    if (total > SKILL_PACKAGE_LIMITS.maxArchiveBytes + 1024 * 1024) {
      throw Object.assign(new Error('军师包超过 30MB 上传上限'), { status: 413 })
    }
    chunks.push(chunk)
  }
  const body = Buffer.concat(chunks, total)
  const match = String(req.headers['content-type'] || '').match(/boundary=(?:"([^"]+)"|([^;]+))/)
  const boundary = match?.[1] || match?.[2]
  if (!boundary) throw Object.assign(new Error('缺少 multipart boundary'), { status: 400 })
  const parsed = parseMultipartFile(body, boundary)
  if (!parsed?.fileBuf?.length) throw Object.assign(new Error('未找到军师包文件'), { status: 400 })
  return parsed
}

export function registerSkillImportRoutes(app, { skillsDir } = {}) {
  const runtime = createSkillImportRuntime({ skillsDir })

  app.post('/api/advisor-imports/inspect', async (req, res) => {
    try {
      const { fileBuf, filename } = await readUpload(req)
      const result = await runtime.inspect(fileBuf, filename)
      res.json({ ok: true, data: result })
    } catch (error) {
      res.status(error.status || 400).json({ ok: false, error: error.message || '军师包检查失败' })
    }
  })

  app.post('/api/advisor-imports/:token/install', (req, res) => {
    try {
      res.json({ ok: true, data: runtime.install(req.params.token) })
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message || '军师包安装失败' })
    }
  })

  app.delete('/api/advisor-imports/:token', (req, res) => {
    runtime.discard(req.params.token)
    res.json({ ok: true })
  })

  return runtime
}
