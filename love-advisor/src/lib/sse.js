// Run Runtime SSE：把字节流拆成 JSON 事件，再应用到当前助手消息。

export function consumeSse(buffer, chunk) {
  const buf = buffer + chunk
  const lines = buf.split('\n')
  const rest = lines.pop()
  const events = []
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue
    const payload = line.slice(6)
    if (payload === '[DONE]') continue
    try { events.push(JSON.parse(payload)) } catch { /* 半包或坏行忽略 */ }
  }
  return { rest, events }
}

export function applyRunEvent(j, session) {
  if (j.type === 'run.created') session.activeRunId.value = j.runId
  else if (j.type === 'skill.loaded') session.autoSkillName.value = j.auto ? j.skillName : ''
  else if (j.type === 'run.state') session.runState.value = j.state
  else if (j.type === 'tool.retrying') {
    const retrying = session.aiMsg.tools.find(tool => tool.tool === j.tool && tool.round === (j.round ?? 0))
    const next = {
      tool: j.tool, ok: null, state: 'retrying', args: j.args || '', round: j.round ?? 0,
      error: j.error || '', errorCode: j.errorCode || '', retryable: true,
      attempts: j.nextAttempt || 2, recovery: j.recovery || '', retryExhausted: false,
    }
    if (retrying) Object.assign(retrying, next)
    else session.aiMsg.tools.push(next)
  }
  else if (j.type === 'tool.completed' || j.type === 'tool.failed') {
    const existing = session.aiMsg.tools.find(tool => tool.tool === j.tool
      && tool.round === (j.round ?? 0) && tool.state === 'retrying')
    const completed = {
      tool: j.tool, ok: j.type === 'tool.completed', args: j.args || '',
      round: j.round ?? 0, error: j.error || '', summary: j.summary,
      errorCode: j.errorCode || '', retryable: j.retryable === true,
      recovery: j.recovery || '', retryExhausted: j.retryExhausted === true,
      attempts: j.attempts || 1, state: j.type === 'tool.completed' ? 'completed' : 'failed',
    }
    if (existing) Object.assign(existing, completed)
    else session.aiMsg.tools.push(completed)
  }
  else if (j.type === 'message.delta' || j.t || j.r) {
    if (j.t) session.aiMsg.content += j.t
    if (j.r) session.aiMsg.reasoning += j.r
  }
  else if (j.type === 'memory.candidate' && j.candidate) {
    if (j.messageId) session.aiMsg.id = j.messageId
    if (!Array.isArray(session.aiMsg.memoryCandidateIds)) session.aiMsg.memoryCandidateIds = []
    if (!Array.isArray(session.aiMsg.memoryCandidates)) session.aiMsg.memoryCandidates = []
    if (!session.aiMsg.memoryCandidateIds.includes(j.candidate.id)) {
      session.aiMsg.memoryCandidateIds.push(j.candidate.id)
      session.aiMsg.memoryCandidates.push(j.candidate)
    }
  }
  else if (j.type === 'memory.candidate.failed') {
    session.showToast?.(`记忆建议未保存：${j.error || '请稍后重试'}`)
  }
  else if (j.type === 'run.completed') session.runState.value = 'completed'
  else if (j.type === 'run.cancelled') session.runState.value = 'cancelled'
  else if (j.type === 'run.failed') {
    session.runState.value = 'failed'
    session.aiMsg.content += '\n\n(错误：' + j.error + ')'
  }
  else if (j.error) session.aiMsg.content += '\n\n(错误：' + j.error + ')'
}

export async function readSseStream(body, onEvent) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const { rest, events } = consumeSse(buf, decoder.decode(value, { stream: true }))
    buf = rest
    for (const event of events) onEvent(event)
  }
}
