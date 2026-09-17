import { test } from 'node:test'
import assert from 'node:assert/strict'
import { consumeSse, applyRunEvent } from './sse.js'

test('consumeSse：完整事件入列，半行留在 rest', () => {
  const { rest, events } = consumeSse('', 'data: {"type":"run.created","runId":"r1"}\n\ndata: {"ty')
  assert.deepEqual(events, [{ type: 'run.created', runId: 'r1' }])
  assert.equal(rest, 'data: {"ty')
})

test('consumeSse：忽略 [DONE] 与非 data 行', () => {
  const { events } = consumeSse('', ': ping\n\ndata: [DONE]\n\ndata: {"type":"run.completed"}\n\n')
  assert.deepEqual(events, [{ type: 'run.completed' }])
})

test('consumeSse：与 Run 流契约一致（created → delta → completed → DONE）', () => {
  const chunk = 'data: {"type":"run.created","runId":"run_ui","conversationId":"conv_ui"}\n\ndata: {"type":"message.delta","t":"Verified answer"}\n\ndata: {"type":"run.completed"}\n\ndata: [DONE]\n\n'
  const { rest, events } = consumeSse('', chunk)
  assert.equal(rest, '')
  assert.deepEqual(events.map(e => e.type), ['run.created', 'message.delta', 'run.completed'])
  assert.equal(events[1].t, 'Verified answer')
})

test('applyRunEvent：增量文本 / 工具 / 失败写入助手消息', () => {
  const session = {
    aiMsg: { role: 'assistant', content: '', reasoning: '', tools: [] },
    activeRunId: { value: null },
    autoSkillName: { value: '' },
    runState: { value: '' },
  }
  applyRunEvent({ type: 'run.created', runId: 'run_1' }, session)
  applyRunEvent({ type: 'skill.loaded', auto: true, skillName: '恋爱军师' }, session)
  applyRunEvent({ type: 'run.state', state: 'streaming' }, session)
  applyRunEvent({ type: 'message.delta', t: '你好', r: '想了想' }, session)
  applyRunEvent({ type: 'tool.completed', tool: 'search_messages', args: '{}', round: 1, summary: '命中 2 条' }, session)
  applyRunEvent({ type: 'run.failed', error: '上游超时' }, session)

  assert.equal(session.activeRunId.value, 'run_1')
  assert.equal(session.autoSkillName.value, '恋爱军师')
  assert.equal(session.runState.value, 'failed')
  assert.equal(session.aiMsg.content, '你好\n\n(错误：上游超时)')
  assert.equal(session.aiMsg.reasoning, '想了想')
  assert.equal(session.aiMsg.tools.length, 1)
  assert.equal(session.aiMsg.tools[0].ok, true)
})

test('applyRunEvent：候选记忆挂到当前助手消息，失败只提示不污染正文', () => {
  const notices = []
  const session = {
    aiMsg: { role: 'assistant', content: '分析完成', reasoning: '', tools: [] },
    activeRunId: { value: null },
    autoSkillName: { value: '' },
    runState: { value: '' },
    showToast: message => notices.push(message),
  }
  const candidate = { id: 'cand_1', content: '她忙时回复会变慢', status: 'pending' }

  applyRunEvent({ type: 'memory.candidate', messageId: 'msg_1', candidate }, session)
  applyRunEvent({ type: 'memory.candidate', messageId: 'msg_1', candidate }, session)
  applyRunEvent({ type: 'memory.candidate.failed', error: '候选已满' }, session)

  assert.equal(session.aiMsg.id, 'msg_1')
  assert.deepEqual(session.aiMsg.memoryCandidateIds, ['cand_1'])
  assert.deepEqual(session.aiMsg.memoryCandidates, [candidate])
  assert.equal(session.aiMsg.content, '分析完成')
  assert.deepEqual(notices, ['记忆建议未保存：候选已满'])
})

test('applyRunEvent：工具重试更新同一条时间线记录并保留结构化错误', () => {
  const session = {
    aiMsg: { role: 'assistant', content: '', reasoning: '', tools: [] },
    activeRunId: { value: null },
    autoSkillName: { value: '' },
    runState: { value: '' },
  }

  applyRunEvent({
    type: 'tool.retrying', tool: 'search_messages', args: '{}', round: 0,
    error: '暂时繁忙', errorCode: 'TEMPORARY_FAILURE', nextAttempt: 2,
  }, session)
  assert.equal(session.aiMsg.tools.length, 1)
  assert.equal(session.aiMsg.tools[0].state, 'retrying')

  applyRunEvent({
    type: 'tool.failed', tool: 'search_messages', args: '{}', round: 0,
    error: '执行超时', errorCode: 'TOOL_TIMEOUT', recovery: 'USE_ALTERNATIVE',
    retryable: false, retryExhausted: true, attempts: 2,
  }, session)
  assert.equal(session.aiMsg.tools.length, 1)
  assert.equal(session.aiMsg.tools[0].state, 'failed')
  assert.equal(session.aiMsg.tools[0].errorCode, 'TOOL_TIMEOUT')
  assert.equal(session.aiMsg.tools[0].recovery, 'USE_ALTERNATIVE')
  assert.equal(session.aiMsg.tools[0].retryable, false)
  assert.equal(session.aiMsg.tools[0].retryExhausted, true)
  assert.equal(session.aiMsg.tools[0].attempts, 2)
})
