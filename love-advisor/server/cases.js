// ── Case 路由：关系案例 CRUD + 长期记忆管理 ─────────────
// 工作区与私聊会话 1:1 绑定（store 层 assertSessionFree 保证），
// 创建/换绑会话即自动启动全量导入分析（importer 后台 Job）。
import {
  listCases, getCase, createCase, updateCase, deleteCase,
  addCaseMemory, deleteCaseMemory,
  updateCaseMemoryCandidate, acceptCaseMemoryCandidate, rejectCaseMemoryCandidate,
} from './store.js'
import { confirmWorkspaceProfile, loadPrivateSession } from './profile.js'

export function registerCaseRoutes(app, { startForSession, cancelJobsForCase } = {}) {
  app.get('/api/cases', (_req, res) => {
    res.json({ ok: true, data: { items: listCases() } })
  })

  // 从会话创建工作区：等价于「选会话 → 建工作区 → 自动分析」
  app.post('/api/cases/from-session', async (req, res) => {
    try {
      const sessionId = req.body?.sessionId
      if (!sessionId) return res.status(400).json({ ok: false, error: '缺少 sessionId' })
      if (!startForSession) return res.status(500).json({ ok: false, error: '导入分析未初始化' })
      const r = await startForSession(sessionId)
      res.json({ ok: true, data: r.case, job: r.job })
    } catch (e) {
      res.status(e.code === 'GROUP_CHAT_BLOCKED' ? 400 : 500).json({ ok: false, error: e.message })
    }
  })

  app.post('/api/cases/:id/confirm-profile', async (req, res) => {
    try {
      const item = confirmWorkspaceProfile(req.params.id, req.body || {})
      if (!item) return res.status(404).json({ ok: false, error: '案例不存在' })
      let job = null
      if (item.profileStatus?.reanalysisRequired && startForSession && item.sessionIds?.[0]) {
        job = (await startForSession(item.sessionIds[0], {
          caseId: item.id,
          force: true,
          ownerName: item.profileStatus.ownerName,
          peerName: item.profileStatus.peerName,
        })).job
      }
      res.json({ ok: true, data: item, job })
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message })
    }
  })

  app.post('/api/cases', async (req, res) => {
    try {
      const { title, sessionIds, ...rest } = req.body || {}
      // 强制导入：创建工作区必须绑定一个私聊会话
      if (!sessionIds?.[0]) {
        return res.status(400).json({ ok: false, error: '创建工作区必须绑定一个一对一私聊会话' })
      }
      const session = await loadPrivateSession(sessionIds[0])
      let item = createCase({ title, sessionIds: [session.id] })
      // 工作区档案字段（stage/riskLevel/summary/her/me/relationship）走 updateCase 校验
      const patch = Object.fromEntries(
        ['stage', 'riskLevel', 'summary', 'her', 'me', 'relationship']
          .filter(f => rest[f] !== undefined).map(f => [f, rest[f]]),
      )
      if (Object.keys(patch).length) item = updateCase(item.id, patch) || item
      // 自动启动导入分析（失败不阻塞创建，前端可通过 /api/imports 轮询重试）
      let job = null
      if (startForSession) {
        try {
          job = (await startForSession(session.id, { caseId: item.id })).job
        } catch (e) {
          job = { state: 'error', error: e.message }
        }
      }
      res.json({ ok: true, data: item, job })
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message })
    }
  })

  app.get('/api/cases/:id', (req, res) => {
    const item = getCase(req.params.id)
    if (!item) return res.status(404).json({ ok: false, error: '案例不存在' })
    res.json({ ok: true, data: item })
  })

  app.patch('/api/cases/:id', async (req, res) => {
    try {
      if (req.body?.sessionIds?.[0]) await loadPrivateSession(req.body.sessionIds[0])
      const item = updateCase(req.params.id, req.body || {})
      if (!item) return res.status(404).json({ ok: false, error: '案例不存在' })
      res.json({ ok: true, data: item })
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message })
    }
  })

  app.delete('/api/cases/:id', (req, res) => {
    cancelJobsForCase?.(req.params.id)
    const deleted = deleteCase(req.params.id)
    if (!deleted) return res.status(404).json({ ok: false, error: '案例不存在' })
    res.json({ ok: true, data: { deleted: true } })
  })

  // 记忆：手动添加（分析结论 / 用户偏好 / 风险标记）
  app.post('/api/cases/:id/memories', (req, res) => {
    try {
      const memory = addCaseMemory(req.params.id, req.body || {})
      if (!memory) return res.status(404).json({ ok: false, error: '案例不存在' })
      res.json({ ok: true, data: memory })
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message })
    }
  })

  app.delete('/api/cases/:id/memories/:mid', (req, res) => {
    const deleted = deleteCaseMemory(req.params.id, req.params.mid)
    if (!deleted) return res.status(404).json({ ok: false, error: '记忆不存在' })
    res.json({ ok: true, data: { deleted: true } })
  })

  app.get('/api/cases/:id/memory-candidates', (req, res) => {
    const item = getCase(req.params.id)
    if (!item) return res.status(404).json({ ok: false, error: '案例不存在' })
    res.json({ ok: true, data: { items: item.memoryCandidates || [] } })
  })

  app.patch('/api/cases/:id/memory-candidates/:cid', (req, res) => {
    try {
      const candidate = updateCaseMemoryCandidate(req.params.id, req.params.cid, req.body || {})
      if (!candidate) return res.status(404).json({ ok: false, error: '候选记忆不存在' })
      res.json({ ok: true, data: candidate })
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message })
    }
  })

  app.post('/api/cases/:id/memory-candidates/:cid/accept', (req, res) => {
    try {
      const result = acceptCaseMemoryCandidate(req.params.id, req.params.cid, req.body || {})
      if (!result) return res.status(404).json({ ok: false, error: '候选记忆不存在' })
      res.json({ ok: true, data: result })
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message })
    }
  })

  app.post('/api/cases/:id/memory-candidates/:cid/reject', (req, res) => {
    try {
      const candidate = rejectCaseMemoryCandidate(req.params.id, req.params.cid)
      if (!candidate) return res.status(404).json({ ok: false, error: '候选记忆不存在' })
      res.json({ ok: true, data: candidate })
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message })
    }
  })
}
