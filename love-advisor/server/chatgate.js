const GROUP_TYPES = new Set(['group', 'groups', 'guild', 'channel'])

export function isGroupChat(session) {
  if (!session || typeof session !== 'object') return false
  const type = String(session.type || session.chatType || '').toLowerCase()
  if (GROUP_TYPES.has(type) || type.includes('group')) return true
  if (Number(session.chatType) === 2) return true
  const members = session.memberCount ?? session.members?.length
  if (Number.isFinite(Number(members)) && Number(members) > 2) return true
  return false
}

export function assertPrivateChat(session, fallbackName = '该会话') {
  if (isGroupChat(session)) {
    const name = session.name || session.title || fallbackName
    const err = new Error(`「${name}」是群聊。恋爱军师只分析一对一私聊，请改选好友会话。`)
    err.code = 'GROUP_CHAT_BLOCKED'
    throw err
  }
  return session
}
