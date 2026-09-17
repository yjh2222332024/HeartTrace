import { randomUUID } from 'node:crypto'

export function registerPrivacyGate(app, getEnv) {
  let fingerprint = ''
  let challenge = ''
  let approved = false
  function disclosure() {
    const env = getEnv()
    const next = JSON.stringify([env.BASE_URL, env.BASE_MODEL, env.API_KEY])
    if (next !== fingerprint) {
      fingerprint = next
      challenge = randomUUID()
      approved = false
    }
    let provider = ''
    try { provider = new URL(env.BASE_URL).hostname } catch {}
    return { challenge, provider, baseUrl: env.BASE_URL || '', model: env.BASE_MODEL || '',
      scope: '自动建档会分段发送所导入私聊的全部文本；咨询会发送提问、历史对话、工作区资料、所选聊天片段及按需检索的证据；训练场会发送人物档案、记忆、聊天证据和本局训练记录。军师包导入仅在本机检查并安装 ZIP，不会发送给模型。', approved }
  }
  app.post('/api/privacy/consent', (req, res) => {
    const info = disclosure()
    if (req.body?.challenge !== info.challenge || req.body?.accepted !== true) {
      return res.status(409).json({ ok: false, error: '模型配置已变化，请重新确认' })
    }
    approved = true
    res.json({ ok: true })
  })
  app.use('/api', (req, res, next) => {
    const triggers = new Set(['/runs', '/imports', '/import', '/qq/import', '/cases', '/cases/from-session'])
    const route = req.path.toLowerCase().replace(/\/+$/, '')
    const trainingModelCall = route === '/training/scenarios'
      || route === '/training/sessions'
      || /^\/training\/sessions\/[^/]+\/(turn|coach|review)$/.test(route)
    if (req.method !== 'POST' || (!triggers.has(route) && !trainingModelCall)) return next()
    const info = disclosure()
    if (approved) return next()
    res.status(428).json({ ok: false, code: 'AI_CONSENT_REQUIRED', error: '请先确认 AI 分析的数据发送范围', data: info })
  })
}
