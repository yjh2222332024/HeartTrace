import { clb, extractJson } from './qce.js'
import { loadPrivateSession } from './profile.js'

export function citedMessageIds(selection) {
  const raw = Array.isArray(selection?.messageIds)
    ? selection.messageIds
    : (Array.isArray(selection?.messages) ? selection.messages.map(m => m?.id) : [])
  return [...new Set(raw.filter(id => Number.isSafeInteger(id) && id >= 1))].sort((a, b) => a - b)
}

export function selectionCacheKey(selection) {
  const sessionId = String(selection?.sessionId || '').trim()
  const ids = citedMessageIds(selection)
  if (!sessionId || !ids.length) return ''
  return `cite:${sessionId}:${ids.join(',')}`
}

export function compactSelection(selection) {
  const ids = citedMessageIds(selection)
  return {
    cached: true,
    key: selectionCacheKey(selection),
    sessionId: selection?.sessionId || '',
    sessionName: selection?.sessionName || '',
    messageIds: ids,
    count: ids.length,
    note: '正文未带回。需要时用 get_message_context 按 messageIds 再读。',
  }
}

export function validateSelection(selection, sessionId) {
  if (!selection || selection.sessionId !== sessionId) throw new Error('所选聊天记录与当前工作区不一致')
  const ids = selection.messageIds
  if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) {
    throw new Error('请选择 1 至 50 条有效聊天记录')
  }
  return [...new Set(ids)]
}

export async function loadSelectedMessages(selection, { loadSession = loadPrivateSession, query = clb } = {}) {
  const ids = validateSelection(selection, selection?.sessionId)
  const session = await loadSession(selection.sessionId)
  const found = new Map()
  // Fetch small batches through ChatLab's cleaned-message API, then retain only selected anchors.
  for (let i = 0; i < ids.length; i += 5) {
    const result = extractJson(await query(['messages', 'context', '--session', session.id,
      '--id', ids.slice(i, i + 5).join(','), '--window', '1', '--format', 'json', '--full']))
    if (!result.ok) throw new Error(result.error?.message || '读取所选聊天记录失败')
    for (const message of result.data?.items || []) {
      if (ids.includes(message.id)) found.set(message.id, message)
    }
  }
  if (found.size !== ids.length) throw new Error('部分聊天记录已失效，请重新选择')
  const messages = [...found.values()].sort((a, b) => String(a.time).localeCompare(String(b.time)) || a.id - b.id)
    .map(({ id, time, senderName, content }) => ({ id, time, senderName, content }))
  const selectionContext = { sessionId: session.id, sessionName: session.name, messages }
  if (Buffer.byteLength(JSON.stringify(selectionContext)) > 64 * 1024) throw new Error('所选聊天记录过长，请减少条数')
  return selectionContext
}
