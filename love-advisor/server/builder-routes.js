// ── 军师构建工作流路由（Builder Routes）─────────────────
import { createBuilderRuntime, STYLE_PRESETS } from './builder.js'
import {
  fetchVideoInfo,
  fetchSubtitle,
  parseAnySubtitleInput,
  extractBvId,
  getBilibiliGuestCookie,
  mergeBilibiliCookies,
  normalizeBilibiliSessionCookie,
  BILIBILI_ERROR_CODES,
  fingerprintSubtitle,
} from './bilibili.js'

export function registerBuilderRoutes(app, { getEnv, skillsDir } = {}) {
  const builderRuntime = createBuilderRuntime({
    skillsDir,
    getEnv,
  })

  // 风格预设列表
  app.get('/api/builder/styles', (_req, res) => {
    res.json({ ok: true, data: Object.values(STYLE_PRESETS) })
  })

  // 快速探测/解析素材源（获取标题、时长、行数预览）
  app.post('/api/builder/parse-source', async (req, res) => {
    try {
      const { source, content, type, bilibiliCookie = '' } = req.body || {}
      const bvid = extractBvId(source)

      if (type === 'bilibili' || bvid) {
        const id = bvid || source
        const sessionCookie = normalizeBilibiliSessionCookie(bilibiliCookie)
        const guestCookie = await getBilibiliGuestCookie().catch(() => '')
        const cookie = mergeBilibiliCookies(sessionCookie, guestCookie)
        try {
          // 尝试同时探测字幕
          const sub = await fetchSubtitle(id, { cookie })
          return res.json({
            ok: true,
            data: {
              type: 'bilibili',
              bvid: id,
              title: sub.videoInfo.title,
              ownerName: sub.videoInfo.ownerName,
              duration: sub.videoInfo.duration,
              lineCount: sub.items.length,
              previewLines: sub.items.slice(0, 8).map(i => i.content),
              subtitleFingerprint: fingerprintSubtitle(sub.items),
              hasSubtitle: true,
              subtitleAccess: sessionCookie ? 'login' : 'public',
            },
          })
        } catch (subErr) {
          // 若字幕未能获取，尝试至少获取视频元信息
          const info = await fetchVideoInfo(id, { cookie }).catch(() => null)
          return res.json({
            ok: true,
            data: {
              type: 'bilibili',
              bvid: id,
              title: info?.title || id,
              ownerName: info?.ownerName || '',
              duration: info?.duration || 0,
              hasSubtitle: false,
              requiresLogin: subErr.code === BILIBILI_ERROR_CODES.LOGIN_REQUIRED_FOR_SUBTITLE,
              errorCode: subErr.code || 'BILIBILI_SUBTITLE_UNAVAILABLE',
              warning: subErr.message || '该视频未检测到官方或 AI 字幕',
            },
          })
        }
      }

      // 纯文本 / SRT / JSON 素材
      const textToParse = content || source || ''
      const items = parseAnySubtitleInput(textToParse, 'custom_text')
      res.json({
        ok: true,
        data: {
          type: 'text',
          title: '自定义文本素材',
          lineCount: items.length,
          previewLines: items.slice(0, 8).map(i => i.content),
          subtitleFingerprint: fingerprintSubtitle(items),
          hasSubtitle: items.length > 0,
        },
      })
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message })
    }
  })

  // 启动构建任务
  app.post('/api/builder/tasks', async (req, res) => {
    try {
      const { name, id, sources, styleType, customStyleText, bilibiliCookie = '' } = req.body || {}
      const job = await builderRuntime.startJob({
        name,
        id,
        sources,
        styleType,
        customStyleText,
        bilibiliCookie,
      })
      res.json({ ok: true, data: job })
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message })
    }
  })

  // 查询任务列表
  app.get('/api/builder/tasks', (_req, res) => {
    try {
      res.json({ ok: true, data: { items: builderRuntime.listJobs() } })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  // 查询单个任务详情与草稿
  app.get('/api/builder/tasks/:id', (req, res) => {
    try {
      const job = builderRuntime.getJob(req.params.id)
      if (!job) return res.status(404).json({ ok: false, error: '任务不存在' })
      res.json({ ok: true, data: job })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  // 取消任务
  app.post('/api/builder/tasks/:id/cancel', (req, res) => {
    try {
      const ok = builderRuntime.cancelJob(req.params.id)
      res.json({ ok })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  // 修改草稿
  app.put('/api/builder/tasks/:id/draft', (req, res) => {
    try {
      const job = builderRuntime.updateDraft(req.params.id, req.body || {})
      res.json({ ok: true, data: job })
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message })
    }
  })

  // 确认发布到 skills 目录
  app.post('/api/builder/tasks/:id/publish', (req, res) => {
    try {
      const result = builderRuntime.publishSkill(req.params.id)
      res.json({ ok: true, data: result })
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message })
    }
  })

  return builderRuntime
}
