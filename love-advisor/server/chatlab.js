import { clb, extractJson } from './qce.js'
import { assertPrivateChat } from './chatgate.js'

// ── ChatLab 多维度分析：三层证据包采集器 ───────────────
// L0 统计底盘（stats + 恋爱特化 SQL） → 定位异常窗口
// L1 原文切片（近14天 + 异常窗口 ±1 天）
// L2 关键词命中兜底（道歉/告白/推脱等高信号短语）
// 全程不读 message.content 原始列（sql 层自动脱敏，原文走官方清洗命令）

export async function clbJson(args) {
  const j = extractJson(await clb(args))
  if (!j.ok) throw new Error(j.error?.message || `clb ${args[0]} 失败`)
  return j.data
}

async function safe(fn, warning) {
  try { return await fn() } catch (e) { return { __warning: `${warning}: ${e.message}` } }
}

const isWarn = x => x && x.__warning

export function validateSessionId(sessionId) {
  const value = String(sessionId || '')
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
    throw new Error('会话 ID 格式无效')
  }
  return value
}

// 说明：clb() 已在 qce.js 内全局串行化（防 meta 竞争），此处无需再排队

// ── 恋爱特化 SQL（不触碰 content，无需 --raw；ts 为秒级时间戳） ─────────
export const SQL_TOPIC_INIT = `
WITH m AS (SELECT ts, sender_account_name AS member, LAG(ts) OVER (ORDER BY ts) AS prev FROM message)
SELECT COALESCE(NULLIF(member,''),'unknown') AS member, COUNT(*) AS initiations
FROM m WHERE prev IS NULL OR ts - prev > 14400
GROUP BY member ORDER BY initiations DESC`

const SQL_COLD_START = `
WITH m AS (SELECT ts, sender_account_name AS member, ts - LAG(ts) OVER (ORDER BY ts) AS gap FROM message)
SELECT ROUND(gap/3600.0, 1) AS gapHours, member,
       datetime(ts, 'unixepoch', 'localtime') AS brokeAt
FROM m WHERE gap IS NOT NULL
ORDER BY gap DESC LIMIT 5`

const SQL_DAILY = `
SELECT date(ts, 'unixepoch', 'localtime') AS day, COUNT(*) AS cnt
FROM message GROUP BY day ORDER BY day`

// ── 异常窗口检测（统计层给原文"划重点"） ────────────────
export function detectWindows(dailyRows) {
  const map = new Map(dailyRows.map(r => [r.day, r.cnt]))
  if (!dailyRows.length) return { silence: [], bursts: [], windows: [] }
  const days = []
  // The SQL query already returns local calendar dates. Use UTC only as a
  // calendar arithmetic container so the host timezone cannot shift a day.
  const calendar = day => {
    const [year, month, date] = String(day).split('-').map(Number)
    return new Date(Date.UTC(year, month - 1, date))
  }
  let d = calendar(dailyRows[0].day)
  const end = calendar(dailyRows[dailyRows.length - 1].day)
  while (d <= end) {
    const key = d.toISOString().slice(0, 10)
    days.push({ day: key, cnt: map.get(key) || 0 })
    d.setUTCDate(d.getUTCDate() + 1)
  }
  const nz = days.filter(x => x.cnt > 0).map(x => x.cnt).sort((a, b) => a - b)
  const median = nz.length ? nz[Math.floor(nz.length / 2)] : 0

  // 沉默期：连续 0 消息天（>=2 天才算，跳过开头结尾的边缘零星）
  const silence = []
  let run = null
  for (const { day, cnt } of days) {
    if (cnt === 0) { run = run || { start: day, end: day }; run.end = day }
    else { if (run && run.start !== run.end) silence.push(run); run = null }
  }
  if (run && run.start !== run.end) silence.push(run)

  // 爆发日：>= 2.5 倍中位数 且绝对值 >= 30
  const bursts = days.filter(x => x.cnt >= 30 && x.cnt >= median * 2.5).map(x => ({ day: x.day, cnt: x.cnt }))

  // 组窗口：最近的优先，最多 3 个
  const windows = []
  for (const s of silence.slice(-3).reverse()) {
    windows.push({ label: `沉默期 ${s.start} ~ ${s.end}`, since: shift(s.start, -1), until: shift(s.end, 1) })
  }
  for (const b of bursts.slice(-2).reverse()) {
    windows.push({ label: `爆发日 ${b.day}（${b.cnt} 条）`, since: shift(b.day, -1), until: shift(b.day, 1) })
  }
  return { silence, bursts, windows: windows.slice(0, 3) }
}

function shift(dateStr, delta) {
  const [year, month, date] = String(dateStr).split('-').map(Number)
  const d = new Date(Date.UTC(year, month - 1, date))
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

// ── 证据包主流程（按会话+小时缓存，避免每条消息重算） ────
const cache = new Map()

export async function buildEvidencePack(sessionId) {
  sessionId = validateSessionId(sessionId)
  const key = `${sessionId}:${new Date().toISOString().slice(0, 13)}`
  if (cache.has(key)) return cache.get(key)
  if (cache.size > 8) cache.clear()
  const p = _build(sessionId)
  cache.set(key, p)
  try { return await p } catch (e) { cache.delete(key); throw e }
}

async function _build(sessionId) {
  const sessions = await clbJson(['sessions', 'list', '--format', 'json'])
  const session = (sessions.items || []).find(x => x.id === sessionId)
  if (session) assertPrivateChat(session)
  const warnings = []

  // L0：统计底盘 + SQL 指标（串行队列防 meta 竞争，仍一次发起、并发收集）
  const [overview, response, topicInit, coldStart, dailyRows] = await Promise.all([
    safe(() => clb(['stats', 'overview', '--session', sessionId, '--format', 'json']).then(extractJson).then(j => { if (!j.ok) throw new Error(j.error?.message); return j.data }), 'stats overview'),
    safe(() => clb(['stats', 'response', '--session', sessionId, '--last', '30d', '--format', 'json']).then(extractJson).then(j => { if (!j.ok) throw new Error(j.error?.message); return j.data }), 'stats response'),
    safe(() => clb(['sql', SQL_TOPIC_INIT, '--session', sessionId, '--format', 'json']).then(extractJson).then(j => { if (!j.ok) throw new Error(j.error?.message); return j.data }), '话题先手'),
    safe(() => clb(['sql', SQL_COLD_START, '--session', sessionId, '--format', 'json']).then(extractJson).then(j => { if (!j.ok) throw new Error(j.error?.message); return j.data }), '冷启动'),
    safe(() => clb(['sql', SQL_DAILY, '--session', sessionId, '--format', 'json', '--limit', '1000']).then(extractJson).then(j => { if (!j.ok) throw new Error(j.error?.message); return j.data }), '每日消息量'),
  ])
  for (const x of [overview, response, topicInit, coldStart, dailyRows]) if (isWarn(x)) warnings.push(x.__warning)

  const { windows, silence, bursts } = detectWindows(dailyRows?.rows || [])

  // L1：原文切片（近 14 天 + 异常窗口，经队列串行执行）
  const recentP = safe(
    () => clb(['messages', 'list', '--last', '14d', '--session', sessionId, '--format', 'agent', '--max-tokens', '3000']),
    '近14天原文'
  )
  const windowPs = windows.map(w => safe(
    () => clb(['messages', 'list', '--since', w.since, '--until', w.until, '--session', sessionId, '--format', 'agent', '--max-tokens', '1800']),
    `窗口原文 ${w.label}`
  ))

  // L2：关键词命中兜底
  const keywordP = safe(
    () => clb(['messages', 'search', '对不起', '喜欢你', '想你', '在吗', '下次一定', '分手', '异地', '见面', '--session', sessionId, '--format', 'agent', '--max-tokens', '1200']),
    '关键词检索'
  )

  const [recentText, ...windowTexts] = await Promise.all([recentP, ...windowPs])
  const keywordText = await keywordP
  if (isWarn(recentText)) warnings.push(recentText.__warning)
  for (const w of windowTexts) if (isWarn(w)) warnings.push(w.__warning)
  if (isWarn(keywordText)) warnings.push(keywordText.__warning)

  return {
    sessionId,
    generatedAt: new Date().toISOString(),
    baseline: {
      overview: isWarn(overview) ? null : strip(overview),
      responseLast30d: isWarn(response) ? null : strip(response),
    },
    metrics: {
      topicInitiation: topicInit?.rows || null,
      coldStartsTop5: coldStart?.rows || null,
      silencePeriods: silence,
      burstDays: bursts,
    },
    evidence: {
      recent14d: isWarn(recentText) ? null : recentText,
      anomalyWindows: windows.map((w, i) => ({ ...w, text: isWarn(windowTexts[i]) ? null : windowTexts[i] })),
      keywordHits: isWarn(keywordText) ? null : keywordText,
    },
    warnings,
  }
}

// stats 返回体里可能有冗余 meta，做一层瘦身
function strip(data) {
  if (!data || typeof data !== 'object') return data
  const { meta, ...rest } = data
  return rest
}

// ── 路由：会话列表 + 证据包预览 ────────────────────────
export function registerChatlabRoutes(app) {
  app.get('/api/sessions', async (_req, res) => {
    try {
      const data = await clbJson(['sessions', 'list', '--format', 'json'])
      res.json({ ok: true, data: { items: data.items || [] } })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  app.get('/api/analyze/evidence', async (req, res) => {
    const { sessionId } = req.query
    if (!sessionId) return res.status(400).json({ ok: false, error: '缺少 sessionId' })
    let validSessionId
    try {
      validSessionId = validateSessionId(sessionId)
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message })
    }
    try {
      const pack = await buildEvidencePack(validSessionId)
      res.json({ ok: true, data: pack })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })
}
