// ── ChatLab 数据可视化接口：消息分页 + 指标聚合 ─────────
// 前端聊天浏览器与洞察面板的数据源；均为只读，直接透传 clb 结果。
// clb() 在 qce.js 内已全局串行化（防 .chatlab-meta 竞争），此处并发发起即可。
import express from 'express'
import { clb, extractJson } from './qce.js'
import { validateSessionId } from './chatlab.js'

async function clbJson(args) {
  const j = extractJson(await clb(args))
  if (!j.ok) throw new Error(j.error?.message || `clb ${args.join(' ')} 失败`)
  return j
}

// ── 机主识别（缓存）：clb 未配置 owner 档案时用启发式 ──
// 私聊会话名 = 对方昵称 → 机主 = members 里名字 ≠ 会话名的那个；群聊无机主概念
const ownerCache = new Map() // sid -> { name, at }

async function resolveOwner(sessionId) {
  const hit = ownerCache.get(sessionId)
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.name
  const sessions = await clbJson(['sessions', 'list', '--format', 'json'])
  const s = sessions.data?.items?.find(x => x.id === sessionId)
  if (!s || s.type !== 'private') return ''
  const members = await clbJson(['members', 'list', '--session', sessionId, '--limit', '10', '--format', 'json'])
  const names = (members.data?.items || []).map(i => i.name)
  const name = names.find(n => n && n !== s.name) || ''
  if (name) ownerCache.set(sessionId, { name, at: Date.now() })
  return name
}

async function resolveSessionId(rawId) {
  if (!rawId) throw new Error('缺少会话 ID')
  const str = String(rawId).trim()
  if (/^[a-zA-Z0-9_-]+$/.test(str)) return str
  // 传入非纯英文/数字格式（如中文名称），尝试从会话列表中反查对应会话 ID
  try {
    const sessions = await clbJson(['sessions', 'list', '--format', 'json'])
    const list = sessions.data?.items || []
    const hit = list.find(x => x.name === str || x.id === str)
    if (hit?.id) return hit.id
  } catch {}
  return validateSessionId(str)
}

// ── 路由注册 ─────────────────────────────────────────────
export function registerInsightRoutes(app) {
  // 消息分页：list 模式（时间窗/成员/游标）+ search 模式（关键词）
  app.get('/api/clb/messages', async (req, res) => {
    try {
      const sid = await resolveSessionId(req.query.sessionId)
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500)
      const q = String(req.query.q || '').trim()
      const keywords = q ? q.split(/\s+/).map(s => s.trim()).filter(Boolean) : []
      const args = keywords.length
        ? ['messages', 'search', '--session', sid, '--limit', String(limit), '--format', 'json']
        : ['messages', 'list', '--session', sid, '--limit', String(limit), '--format', 'json']
      args.push('--full')
      if (req.query.cursor) args.push('--cursor', String(req.query.cursor))
      {
        // list 模式独有过滤：成员 / 时间窗
        if (req.query.member) args.push('--member', String(req.query.member))
        if (req.query.since) args.push('--since', String(req.query.since))
        if (req.query.until) args.push('--until', String(req.query.until))
      }
      if (keywords.length) {
        // POSIX 终止符 '--'：确保以 '-' 或 '--' 开头的关键词不会被误解析为 CLI 选项
        args.push('--', ...keywords)
      }
      const j = await clbJson(args)
      const [ownerName, meError] = await resolveOwner(sid)
        .then(n => [n, '']).catch(e => ['', e.message])
      res.json({ ok: true, data: j.data, meta: { ...j.meta, ownerName, meError } })
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message })
    }
  })

  // 洞察指标聚合（按会话+小时缓存，避免重复跑 CLI）
  const cache = new Map()
  app.get('/api/insight/:sessionId', async (req, res) => {
    try {
      const sid = await resolveSessionId(req.params.sessionId)
      const key = `${sid}:${new Date().toISOString().slice(0, 13)}`
      if (cache.has(key)) return res.json(cache.get(key))

      // 单项失败不拖垮整体：该项返回 { __warning } 供前端展示占位
      const run = (args, label) =>
        clbJson(args).then(j => j.data).catch(e => ({ __warning: `${label}: ${e.message}` }))

      const [daily, hour, weekday, activity, response, keywords] = await Promise.all([
        run(['stats', 'time', '--session', sid, '--by', 'day', '--last', '30d', '--format', 'json'], '每日趋势'),
        run(['stats', 'time', '--session', sid, '--by', 'hour', '--last', '30d', '--format', 'json'], '时段分布'),
        run(['stats', 'time', '--session', sid, '--by', 'weekday', '--last', '30d', '--format', 'json'], '周分布'),
        run(['stats', 'activity', '--session', sid, '--last', '30d', '--top', '10', '--format', 'json'], '活跃占比'),
        run(['stats', 'response', '--session', sid, '--last', '30d', '--top', '10', '--format', 'json'], '回复速度'),
        run(['stats', 'keywords', '--session', sid, '--last', '30d', '--top', '15', '--format', 'json'], '高频词'),
      ])

      const payload = {
        ok: true,
        data: { sessionId: sid, daily, hour, weekday, activity, response, keywords },
        generatedAt: new Date().toISOString(),
      }
      if (cache.size > 12) cache.clear()
      cache.set(key, payload)
      res.json(payload)
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message })
    }
  })
}
