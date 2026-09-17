import { clb, extractJson } from './qce.js'
import { validateSessionId, SQL_TOPIC_INIT } from './chatlab.js'
import { assertPrivateChat } from './chatgate.js'
import { getCase, updateCase } from './store.js'

async function clbJson(args) {
  const j = extractJson(await clb(args))
  if (!j.ok) throw new Error(j.error?.message || `clb ${args.join(' ')} 失败`)
  return j.data
}

async function safe(fn, warning) {
  try { return await fn() } catch (e) { return { __warning: `${warning}: ${e.message}` } }
}

const isWarn = x => x && x.__warning

export async function loadPrivateSession(sessionId) {
  const sid = validateSessionId(sessionId)
  const sessions = await clbJson(['sessions', 'list', '--format', 'json'])
  const session = (sessions.items || []).find(x => x.id === sid)
  if (!session) throw new Error('ChatLab 中找不到该会话')
  assertPrivateChat(session)
  return session
}

export async function resolveOwnerCandidates(session) {
  if (session.type && session.type !== 'private') assertPrivateChat(session)
  const members = await clbJson(['members', 'list', '--session', session.id, '--limit', '10', '--format', 'json'])
  const names = [...new Set((members.items || []).map(i => i.name).filter(Boolean))]
  const peerName = session.name || names.find(n => n !== names[0]) || ''
  const ownerName = names.find(n => n && n !== peerName) || names[0] || ''
  return { ownerName, peerName, names }
}

export function pickLatency(response, ownerName = '') {
  const items = response?.items || response?.rows || []
  const seconds = i => Number(i.medianSeconds ?? i.p50 ?? i.median ?? i.latency ?? i.value)
  const mine = ownerName ? items.find(i => i.name === ownerName || i.member === ownerName) : null
  if (mine && Number.isFinite(seconds(mine))) return Math.round(seconds(mine))
  const nums = items.map(seconds).filter(n => Number.isFinite(n))
  if (!nums.length) return null
  return Math.round(nums.sort((a, b) => a - b)[Math.floor(nums.length / 2)])
}

function pickInitiation(rows, ownerName) {
  if (!Array.isArray(rows) || !rows.length) return null
  const total = rows.reduce((s, r) => s + Number(r.initiations || 0), 0)
  if (!total) return null
  const mine = rows.find(r => r.member === ownerName)
  const n = mine ? Number(mine.initiations) : Number(rows[0].initiations)
  return Number.isFinite(n) ? n / total : null
}

export function pickFrequency(overview) {
  const total = Number(overview?.messageCount ?? overview?.totalMessages ?? overview?.count)
  const first = overview?.firstMessage || overview?.firstTs || overview?.since || overview?.start
  const last = overview?.lastMessage || overview?.lastTs || overview?.until || overview?.end
  if (!Number.isFinite(total) || total <= 0) return total ? `${total} 条` : null
  if (first && last) {
    const a = Date.parse(String(first).length < 12 ? new Date(Number(first) * 1000).toISOString() : first)
    const b = Date.parse(String(last).length < 12 ? new Date(Number(last) * 1000).toISOString() : last)
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
      const days = Math.max(1, Math.round((b - a) / 86400000))
      return `约 ${(total / days).toFixed(1)} 条/天（共 ${total} 条 / ${days} 天）`
    }
  }
  return `${total} 条`
}


export async function computeBaseline(sessionId, ownerName = '') {
  const sid = validateSessionId(sessionId)
  const [overview, response, topicInit] = await Promise.all([
    safe(() => clbJson(['stats', 'overview', '--session', sid, '--format', 'json']), 'overview'),
    safe(() => clbJson(['stats', 'response', '--session', sid, '--last', '90d', '--format', 'json']), 'response'),
    safe(() => clbJson(['sql', SQL_TOPIC_INIT, '--session', sid, '--format', 'json']), 'topicInit'),
  ])
  const warnings = [overview, response, topicInit].filter(isWarn).map(x => x.__warning)
  return {
    baseline: {
      replyLatencyP50: isWarn(response) ? null : pickLatency(response, ownerName),
      initiationRatio: isWarn(topicInit) ? null : pickInitiation(topicInit.rows, ownerName),
      msgFrequency: isWarn(overview) ? null : pickFrequency(overview),
    },
    warnings,
    overview: isWarn(overview) ? null : overview,
    topicInit: isWarn(topicInit) ? null : topicInit.rows,
  }
}

export function confirmWorkspaceProfile(caseId, { ownerName, peerName, applyDraft = true, patch = {} } = {}) {
  const item = getCase(caseId)
  if (!item) throw new Error('工作区不存在')
  const draft = item.profileStatus?.draft || {}
  const nextOwner = ownerName ?? item.profileStatus?.ownerName ?? ''
  const nextPeer = peerName ?? item.profileStatus?.peerName ?? ''
  const body = {
    profileStatus: {
      ...item.profileStatus,
      status: 'confirmed',
      ownerName: nextOwner,
      peerName: nextPeer,
      ownerConfirmed: true,
      draft: item.profileStatus?.draft || null,
    },
  }
  if (applyDraft) {
    body.stage = patch.stage || draft.stage || item.stage
    if (patch.summary !== undefined || draft.summary) {
      body.summary = patch.summary ?? draft.summary ?? item.summary
    }

    const draftHer = draft.her || {}
    const patchHer = patch.her || {}
    const curHer = item.her || {}
    body.her = {
      persona: patchHer.persona ?? (draftHer.persona || curHer.persona || ''),
      traits: patchHer.traits ?? (draftHer.traits?.length ? draftHer.traits : (curHer.traits || [])),
      likes: patchHer.likes ?? (draftHer.likes?.length ? draftHer.likes : (curHer.likes || [])),
      // 雷区与通话：草稿中不自动覆盖，优先保留已有数据，仅在 patch 显式指定时修改
      dislikes: patchHer.dislikes ?? (curHer.dislikes?.length ? curHer.dislikes : (draftHer.dislikes || [])),
      commStyle: patchHer.commStyle ?? (draftHer.commStyle || curHer.commStyle || ''),
      replyStyle: patchHer.replyStyle ?? (draftHer.replyStyle || curHer.replyStyle || ''),
      callHistory: patchHer.callHistory ?? (curHer.callHistory?.length ? curHer.callHistory : (draftHer.callHistory || [])),
    }

    const draftMe = draft.me || {}
    const patchMe = patch.me || {}
    const curMe = item.me || {}
    body.me = {
      goal: patchMe.goal ?? (curMe.goal || draftMe.goal || ''),
      style: patchMe.style ?? (draftMe.style || curMe.style || ''),
      pitfalls: patchMe.pitfalls ?? (curMe.pitfalls?.length ? curMe.pitfalls : (draftMe.pitfalls || [])),
    }

    const draftRel = draft.relationship || {}
    const patchRel = patch.relationship || {}
    const curRel = item.relationship || {}
    body.relationship = {
      keyEvents: patchRel.keyEvents ?? (draftRel.keyEvents?.length ? draftRel.keyEvents : (curRel.keyEvents || [])),
      openLoops: patchRel.openLoops ?? (draftRel.openLoops?.length ? draftRel.openLoops : (curRel.openLoops || [])),
      // 边界与承诺：草稿不自动生成，保留现有工作区数据
      boundaries: patchRel.boundaries ?? (curRel.boundaries?.length ? curRel.boundaries : (draftRel.boundaries || [])),
    }
  }
  return updateCase(caseId, body)
}
