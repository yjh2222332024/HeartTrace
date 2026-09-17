// ── store.js / Run 记录的单元测试（使用临时数据目录）──────
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import express from 'express'

// store.js 在模块加载时读取 LOVE_ADVISOR_DATA_DIR，必须先设置再动态 import
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'love-advisor-store-test-'))
process.env.LOVE_ADVISOR_DATA_DIR = tmpDir

const { createConversation, getConversation, appendMessage, updateConversation, deleteConversation, importConversations, createRun, getRun, updateRun, appendRunEvent, listConversations, listConversationSummaries, createCase, getCase, updateCase, addCaseMemory } = await import('./store.js')
const { registerRunRoutes } = await import('./runs.js')

beforeEach(() => {
  // 每个用例前清空数据目录，保证隔离
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { force: true })
})

afterEach(() => {})

function convFile() {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'conversations.json'), 'utf8'))
}

function runFile() {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'runs.json'), 'utf8'))
}

test('会话创建 → 追加消息 → 落盘可回读', () => {
  const conv = createConversation({ title: '测试会话' })
  assert.match(conv.id, /^conv_/)
  assert.equal(conv.messages.length, 0)

  appendMessage(conv.id, { role: 'user', content: '你好' })
  const msg = appendMessage(conv.id, { role: 'assistant', content: '你好呀', reasoning: '思考', runId: 'run_x' })

  const reloaded = getConversation(conv.id)
  assert.equal(reloaded.messages.length, 2)
  assert.equal(reloaded.messages[0].content, '你好')
  assert.equal(reloaded.messages[1].id, msg.id)
  assert.equal(reloaded.messages[1].runId, 'run_x')

  // 磁盘文件与内存一致（原子落盘生效）
  assert.equal(convFile().length, 1)
  assert.equal(convFile()[0].messages.length, 2)
})

test('会话更新标题 / 删除 / 不存在返回 null', () => {
  const conv = createConversation({ title: '旧标题' })
  const updated = updateConversation(conv.id, { title: '新标题' })
  assert.equal(updated.title, '新标题')
  assert.ok(deleteConversation(conv.id))
  assert.equal(getConversation(conv.id), null)
  assert.equal(updateConversation(conv.id, { title: 'x' }), null)
  assert.equal(deleteConversation(conv.id), false)
})

test('切换工作区会清空旧 context hint，避免跨工作区串联', () => {
  const first = createCase({ title: '工作区 A' })
  const second = createCase({ title: '工作区 B' })
  const conv = createConversation({ title: '带 hint 的会话', caseId: first.id })
  updateConversation(conv.id, {
    lastContextReads: ['her', 'evidence.recent'],
    lastCitedChats: ['cite:chat_a:1,2'],
  })

  updateConversation(conv.id, {
    caseId: second.id,
    // 即使调用方把旧 hint 一起带上，也必须被 case 切换逻辑清掉。
    lastContextReads: ['memories'],
    lastCitedChats: ['cite:chat_a:1,2'],
  })

  const switched = getConversation(conv.id)
  assert.equal(switched.caseId, second.id)
  assert.deepEqual(switched.lastContextReads, [])
  assert.deepEqual(switched.lastCitedChats, [])
})

test('listConversations 按 updatedAt 倒序返回', () => {
  const a = createConversation({ title: 'A' })
  const b = createConversation({ title: 'B' })
  // 触碰 a 使其更新时间更新
  appendMessage(a.id, { role: 'user', content: 'hi' })
  const items = listConversations()
  assert.equal(items[0].id, a.id)
  assert.equal(items[1].id, b.id)
})

test('会话导航摘要不携带历史正文', () => {
  const conv = createConversation({ title: '按需加载' })
  appendMessage(conv.id, { role: 'user', content: '这段正文不应该出现在列表接口中' })
  appendMessage(conv.id, { role: 'assistant', content: '只在打开会话后返回' })

  const [summary] = listConversationSummaries()
  assert.deepEqual(Object.keys(summary).sort(), [
    'caseId', 'createdAt', 'id', 'messageCount', 'title', 'updatedAt',
  ])
  assert.equal(summary.id, conv.id)
  assert.equal(summary.messageCount, 2)
  assert.doesNotMatch(JSON.stringify(summary), /这段正文|打开会话/)
})

test('importConversations 迁移旧前端数据（含非法角色过滤）', () => {
  const legacy = [{
    id: 1788607045388, // 旧前端用数字 id
    title: '历史对话',
    messages: [
      { role: 'user', content: '在吗' },
      { role: 'assistant', content: '在的' },
      { role: 'system', content: '应被过滤' },
      null,
    ],
  }]
  const out = importConversations(legacy)
  assert.equal(out.length, 1)
  assert.equal(out[0].id, '1788607045388') // 数字 id 转字符串保留
  assert.equal(out[0].messages.length, 2) // system/null 被过滤
  const reloaded = getConversation('1788607045388')
  assert.equal(reloaded.title, '历史对话')
})

test('Run 创建 → 状态推进 → 事件追加并截断', () => {
  const conv = createConversation({ title: 'run 测试' })
  const run = createRun({ conversationId: conv.id, selectedSkillIds: ['relationship-advisor'], skillId: 'relationship-advisor', evidenceSessionId: 'chat_1' })

  assert.match(run.id, /^run_/)
  assert.equal(run.state, 'created')

  updateRun(run.id, { state: 'context_build', startedAt: new Date().toISOString() })
  updateRun(run.id, { state: 'streaming' })
  for (let i = 0; i < 250; i++) appendRunEvent(run.id, { type: 'message.delta', t: 'x' })
  updateRun(run.id, { state: 'completed', finishedAt: new Date().toISOString() })

  const reloaded = getRun(run.id)
  assert.equal(reloaded.state, 'completed')
  assert.equal(reloaded.skillId, 'relationship-advisor') // skillId 持久化（重启后 read_skill_doc 仍能补默认军师）
  assert.equal(reloaded.events.length, 200) // 超过上限被截断
  assert.equal(reloaded.events.at(-1).type, 'message.delta')

  // 不允许 patch 任意字段（如 id）
  updateRun(run.id, { id: 'hacked', conversationId: 'hacked' })
  assert.equal(getRun(run.id).id, run.id)
  assert.equal(getRun(run.id).conversationId, conv.id)

  // run 文件落盘
  assert.equal(runFile().length, 1)
})

test('非法 ID 被拒绝', () => {
  assert.throws(() => getConversation('../etc/passwd'))
  assert.throws(() => getRun('not exist!'))
})

test('重新生成替换最后回答，保留用户消息和原军师，失败保留旧回答', async t => {
  const conv = createConversation()
  const user = appendMessage(conv.id, { role: 'user', content: '原问题' })
  const previous = createRun({ conversationId: conv.id, selectedSkillIds: ['advisor-a'] })
  updateRun(previous.id, { state: 'completed' })
  const answer = appendMessage(conv.id, { role: 'assistant', content: '旧回答', runId: previous.id })
  const m = mockDeps({ streamScript: [{ content: '新回答' }] })
  let selected
  const assemble = m.deps.assembleSkills
  m.deps.assembleSkills = ids => { selected = ids; return assemble(ids) }
  const { server, port } = await startServer(m.deps)
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  await postRun(port, { conversationId: conv.id, regenerateMessageId: answer.id, text: '忽略此问题' })
  assert.deepEqual(selected, ['advisor-a'])
  assert.equal(conv.messages.length, 2)
  assert.equal(conv.messages[0].id, user.id)
  assert.equal(conv.messages[1].content, '新回答')
  assert.equal(m.calls[0].some(message => message.content === '旧回答'), false)
  const replacementId = conv.messages[1].id
  m.deps.streamChat = async () => { throw new Error('模拟失败') }
  await postRun(port, { conversationId: conv.id, regenerateMessageId: replacementId })
  assert.equal(conv.messages.length, 2)
  assert.equal(conv.messages[1].id, replacementId)
})

for (const code of ['PERMISSION_DENIED', 'PRECONDITION_FAILED']) {
  test(`${code} 停止同批后续工具并关闭下一次模型调用的工具`, async t => {
    const m = mockDeps({
      toolExecute: () => { const error = new Error('停止条件'); error.code = code; throw error },
      streamScript: [{ toolCalls: [
        { id: 'a', name: 'mock_tool', arguments: '{}' },
        { id: 'b', name: 'mock_tool', arguments: '{"page":2}' },
      ] }],
    })
    const { server, port } = await startServer(m.deps)
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
    await postRun(port, { text: '测试停止' })
    assert.equal(m.executeLog.length, 1)
    assert.deepEqual(m.toolsPassed[1], [])
    assert.equal(m.calls[1].filter(message => message.role === 'tool').length, 2)
  })
}

// ── Agent loop 集成测试（mock 上游 streamChat + mock 工具注册表）──
// deps 注入点在 registerRunRoutes，无需真实 LLM / clb
function mockDeps({ streamScript, toolFail = false, toolExecute = null, env = {} }) {
  const calls = []       // 每轮 streamChat 收到的 messages
  const toolsPassed = [] // 每轮收到的 tools 列表
  let i = 0
  const streamChat = async ({ messages, tools, onDelta }) => {
    calls.push(messages)
    toolsPassed.push(tools || [])
    const isFinalSynthesis = Array.isArray(tools) && tools.length === 0
    let step = streamScript[Math.min(i++, streamScript.length - 1)]
    if (isFinalSynthesis) {
      step = {
        content: '基于已有全部证据直接给出的最终回答',
        toolCalls: [],
      }
    }
    if (step.reasoning) onDelta({ reasoning: step.reasoning, content: '' })
    if (step.content) onDelta({ reasoning: '', content: step.content })
    return {
      finishReason: step.toolCalls?.length ? 'tool_calls' : (step.loopDetected ? 'loop_detected' : 'stop'),
      toolCalls: step.toolCalls || [],
      content: step.content || '',
      reasoning: step.reasoning || '',
      loopDetected: step.loopDetected || false,
    }
  }
  const executeLog = []
  const executeScopes = []
  const toolRegistry = {
    list: () => [{ type: 'function', function: { name: 'mock_tool', description: '测试工具', parameters: { type: 'object', properties: {} } } }],
    execute: async (id, input, extras) => {
      executeLog.push({ id, input })
      executeScopes.push(extras?.sessionScope)
      if (toolExecute) return toolExecute({ id, input, extras, attempt: executeLog.length })
      if (toolFail) throw new Error('工具炸了')
      return { tool: id, riskLevel: 'read', truncated: false, result: { echo: input } }
    },
  }
  return {
    calls, toolsPassed, executeLog, executeScopes,
    deps: {
      assembleSkills: () => ({ prompt: 'SYSTEM_PROMPT', skillId: null, skillName: '', auto: false, loadedDocs: [] }),
      buildEvidencePack: async () => ({}),
      buildUpstreamMessages: ({ skillPrompt, messages, runtimeCard }) => [
        { role: 'system', content: [skillPrompt, runtimeCard].filter(Boolean).join('\n') },
        ...messages.map(m => ({ role: m.role, content: m.content })),
      ],
      getEnv: () => ({ BASE_URL: 'http://mock', API_KEY: 'k', BASE_MODEL: 'm', ...env }),
      toolRegistry,
      streamChat,
    },
  }
}

function startServer(deps) {
  const app = express()
  app.use(express.json())
  registerRunRoutes(app, deps)
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

test('skill tools require explicit selection on each run and cannot load another skill', async t => {
  for (const selected of [false, true]) {
    const m = mockDeps({ streamScript: [
      { toolCalls: [{ id: 'doc', name: 'read_skill_doc', arguments: JSON.stringify({ path: 'references/topic.md' }) }] },
      { content: 'Answer' },
    ] })
    m.deps.assembleSkills = ids => ({ prompt: 'BASE', skillId: ids.includes('advisor-a') ? 'advisor-a' : null,
      skillName: 'Advisor', auto: false, loadedDocs: [] })
    m.deps.toolRegistry.list = () => [{ type: 'function', function: { name: 'read_skill_doc' } },
      { type: 'function', function: { name: 'mock_tool' } }]
    const { server, port } = await startServer(m.deps)
    t.after(() => new Promise(r => server.close(r)))
    const events = await postRun(port, { text: 'Question', skills: selected ? ['advisor-a'] : [] })
    assert.equal(m.toolsPassed[0].some(t => t.function.name === 'read_skill_doc'), selected)
    assert.equal(events.some(e => e.type === 'skill.loaded'), selected)
    assert.equal(m.executeLog.length, selected ? 1 : 0)
    if (selected) assert.equal(m.executeLog[0].input.skillId, 'advisor-a')
    else assert.doesNotMatch(m.calls[0][0].content, /按目录用 read_skill_doc|先 read_skill_doc/)
    const conversationId = events.find(e => e.type === 'run.created').conversationId
    await postRun(port, { conversationId, text: 'Without mention' })
    assert.equal(m.toolsPassed.at(-1).some(t => t.function.name === 'read_skill_doc'), false)
  }
  const m = mockDeps({ streamScript: [
    { toolCalls: [{ id: 'doc', name: 'read_skill_doc', arguments: '{"path":"references/topic.md","skillId":"other"}' }] },
    { content: 'Answer' },
  ] })
  m.deps.assembleSkills = () => ({ prompt: 'BASE', skillId: 'advisor-a', loadedDocs: [] })
  const { server, port } = await startServer(m.deps)
  t.after(() => new Promise(r => server.close(r)))
  const events = await postRun(port, { text: 'Question', skills: ['advisor-a'] })
  assert.equal(m.executeLog.length, 0)
  assert.ok(events.some(e => e.type === 'tool.failed'))
})

test('selected messages reach the model, persist for follow-ups, and reject another workspace', async t => {
  const { buildUpstreamMessages } = await import('./prompt.js')
  const workspace = createCase({ title: 'Selection', sessionIds: ['chat_selection'] })
  const m = mockDeps({ streamScript: [{ content: 'Answer' }] })
  m.deps.buildUpstreamMessages = buildUpstreamMessages
  m.deps.loadSelectedMessages = async selection => ({ sessionId: selection.sessionId, sessionName: 'Peer',
    messages: [{ id: 42, content: 'Selected original message', senderName: 'Peer', time: '2026-09-10' }] })
  const { server, port } = await startServer(m.deps)
  t.after(() => new Promise(r => server.close(r)))
  const events = await postRun(port, { caseId: workspace.id, sessionId: 'chat_selection', text: 'Explain',
    selection: { sessionId: 'chat_selection', messageIds: [42] } })
  const conversationId = events.find(e => e.type === 'run.created').conversationId
  assert.match(JSON.stringify(m.calls[0]), /Selected original message/)
  assert.equal(getConversation(conversationId).messages[0].selectionContext.messages[0].id, 42)
  assert.deepEqual(getConversation(conversationId).lastCitedChats, ['cite:chat_selection:42'])
  await postRun(port, { conversationId, text: 'Follow-up' })
  const follow = JSON.stringify(m.calls.at(-1))
  assert.doesNotMatch(follow, /Selected original message/)
  assert.match(follow, /cite:chat_selection:42/)
  assert.match(follow, /get_message_context/)
  const before = getConversation(conversationId).messages.length
  const rejected = await fetch(`http://127.0.0.1:${port}/api/runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, selection: { sessionId: 'wrong', messageIds: [42] } }),
  })
  assert.equal(rejected.status, 400)
  assert.equal(getConversation(conversationId).messages.length, before)
})

test('agent loop：ChatLab 工具按当前私聊裁剪，并把服务端会话作用域传给执行器', async t => {
  const workspace = createCase({ title: 'Scoped tools', sessionIds: ['chat_scoped'] })
  const m = mockDeps({ streamScript: [{
    toolCalls: [{ id: 'call', name: 'search_messages', arguments: '{"sessionId":"chat_scoped","keywords":["约会"]}' }],
  }, { content: 'Answer' }] })
  m.deps.toolRegistry.list = () => [
    { type: 'function', function: { name: 'list_chat_sessions' } },
    { type: 'function', function: { name: 'search_messages' } },
    { type: 'function', function: { name: 'mock_tool' } },
  ]
  const { server, port } = await startServer(m.deps)
  t.after(() => new Promise(r => server.close(r)))

  await postRun(port, { caseId: workspace.id, text: '分析当前聊天' })
  const boundNames = m.toolsPassed[0].map(tool => tool.function.name)
  assert.deepEqual(boundNames.sort(), ['mock_tool', 'search_messages'])
  assert.deepEqual(m.executeScopes[0], { enforced: true, sessionId: 'chat_scoped' })
  assert.match(m.calls[0][0].content, /只能查询当前绑定私聊/)
  assert.doesNotMatch(m.calls[0][0].content, /列出会话/)

  await postRun(port, { text: '没有绑定私聊' })
  const unboundNames = m.toolsPassed.at(-1).map(tool => tool.function.name)
  assert.deepEqual(unboundNames, ['mock_tool'])
})

async function postRun(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.equal(res.status, 200)
  const events = []
  for (const block of (await res.text()).split('\n\n')) {
    const line = block.split('\n').find(l => l.startsWith('data:'))
    if (!line) continue
    const p = line.slice(5).trim()
    if (p === '[DONE]') { events.push('[DONE]'); continue }
    try { events.push(JSON.parse(p)) } catch { /* 忽略残块 */ }
  }
  return events
}

test('agent loop：无工具调用 → 单轮完成并落库', async t => {
  const m = mockDeps({ streamScript: [{ content: '最终回答' }] })
  const { server, port } = await startServer(m.deps)
  t.after(() => new Promise(r => server.close(r)))
  const events = await postRun(port, { text: '你好' })

  const types = events.map(e => (e.type) || e)
  assert.ok(types.includes('run.created'))
  assert.deepEqual(
    events.filter(e => e.type === 'run.state').map(e => e.state),
    ['context_build', 'streaming', 'completed'],
  )
  const deltaText = events.filter(e => e.type === 'message.delta').map(e => e.t || '').join('')
  assert.equal(deltaText, '最终回答')
  assert.ok(events.includes('[DONE]'))

  // 落库：assistant 消息（含工具记录）+ run 终态
  const convId = events.find(e => e.type === 'run.created').conversationId
  const conv = getConversation(convId)
  assert.equal(conv.messages.length, 2)
  assert.equal(conv.messages[1].content, '最终回答')
  assert.equal(conv.messages[1].role, 'assistant')
  assert.deepEqual(conv.messages[1].tools, [])
})

test('agent loop：发送时携带工作区会绑定会话，只注入运行卡片不预注入正文', async t => {
  const { buildUpstreamMessages } = await import('./prompt.js')
  const c = createCase({ title: '绑定案例' })
  updateCase(c.id, { her: { persona: '慢热', likes: ['猫'] } })
  addCaseMemory(c.id, {
    title: '工作忙时回复会变慢',
    content: '详细结论：她在高工作压力时期回复间隔明显增加，但主动发起率没有同步下降。',
    type: 'semantic', topic: 'her',
  })
  const m = mockDeps({ streamScript: [{ content: '已读取工作区' }] })
  m.deps.buildUpstreamMessages = buildUpstreamMessages
  const { server, port } = await startServer(m.deps)
  t.after(() => new Promise(r => server.close(r)))
  const events = await postRun(port, { text: '分析', caseId: c.id })
  const convId = events.find(e => e.type === 'run.created').conversationId
  assert.equal(getConversation(convId).caseId, c.id)
  assert.ok(events.some(e => e.type === 'case.context'))
  const system = m.calls[0][0].content
  assert.match(system, /绑定案例/)
  assert.match(system, /read_context/)
  assert.match(system, /记忆索引/)
  assert.match(system, /工作忙时回复会变慢/)
  assert.doesNotMatch(system, /慢热/)
  assert.doesNotMatch(system, /高工作压力时期回复间隔明显增加/)
  assert.doesNotMatch(JSON.stringify(m.calls[0]), /untrusted_relationship_workspace/)
})

test('agent loop：单轮工具调用 → 结果回传 → 最终回答', async t => {
  const m = mockDeps({
    streamScript: [
      { toolCalls: [{ id: 'c1', name: 'mock_tool', arguments: '{"q":"累"}' }] },
      { content: '根据工具结果回答' },
    ],
  })
  const { server, port } = await startServer(m.deps)
  t.after(() => {
    server.closeAllConnections()
    return new Promise(r => server.close(r))
  })
  const events = await postRun(port, { text: '查数据' })

  // 工具被执行且参数正确
  assert.deepEqual(m.executeLog, [{ id: 'mock_tool', input: { q: '累' } }])

  // 第二轮 messages 应含 assistant tool_calls 与 tool 结果
  assert.equal(m.calls.length, 2)
  const second = m.calls[1]
  const assistantMsg = second.find(x => x.role === 'assistant')
  assert.equal(assistantMsg.tool_calls[0].function.name, 'mock_tool')
  const toolMsg = second.find(x => x.role === 'tool')
  // 回传给模型的是 executed.result 纯数据（不带 wrapper 元数据）
  assert.deepEqual(JSON.parse(toolMsg.content), { echo: { q: '累' } })

  // 事件流：tool.completed + 最终回答
  const toolEvt = events.find(e => e.type === 'tool.completed')
  assert.equal(toolEvt.tool, 'mock_tool')
  assert.equal(toolEvt.round, 0)
  assert.equal(toolEvt.bytes > 0, true)
  const deltaText = events.filter(e => e.type === 'message.delta').map(e => e.t || '').join('')
  assert.equal(deltaText, '根据工具结果回答')

  // run 终态 completed；工具记录随消息落库
  const runId = events.find(e => e.type === 'run.created').runId
  assert.equal(getRun(runId).state, 'completed')
  const savedConv = getConversation(events.find(e => e.type === 'run.created').conversationId)
  assert.equal(savedConv.messages[1].tools.length, 1)
  assert.equal(savedConv.messages[1].tools[0].tool, 'mock_tool')
  assert.equal(savedConv.messages[1].tools[0].ok, true)
})

test('agent loop：工具执行失败 → tool.failed → 模型继续回答', async t => {
  const m = mockDeps({
    toolFail: true,
    streamScript: [
      { toolCalls: [{ id: 'c1', name: 'mock_tool', arguments: '{}' }] },
      { content: '工具挂了但我还能答' },
    ],
  })
  const { server, port } = await startServer(m.deps)
  t.after(() => {
    server.closeAllConnections()
    return new Promise(r => server.close(r))
  })
  const events = await postRun(port, { text: '查数据' })

  const failEvt = events.find(e => e.type === 'tool.failed')
  assert.equal(failEvt.tool, 'mock_tool')
  assert.equal(failEvt.error, '工具炸了')
  assert.equal(failEvt.errorCode, 'TOOL_EXECUTION_FAILED')
  assert.equal(failEvt.recovery, 'USE_ALTERNATIVE')
  assert.equal(failEvt.retryable, false)
  assert.equal(failEvt.retryExhausted, false)
  assert.equal(failEvt.attempts, 1)

  // 错误以 tool 消息回传给模型
  const toolMsg = m.calls[1].find(x => x.role === 'tool')
  assert.deepEqual(JSON.parse(toolMsg.content), {
    error: '工具炸了', code: 'TOOL_EXECUTION_FAILED', recovery: 'USE_ALTERNATIVE',
    retryable: false, retryExhausted: false, attempts: 1,
  })

  // run 仍正常完成
  assert.equal(events.at(-1), '[DONE]')
  assert.ok(events.some(e => e.type === 'run.completed'))
})

test('agent loop：临时工具错误自动重试一次，成功后继续回答', async t => {
  const m = mockDeps({
    toolExecute: ({ id, input, attempt }) => {
      if (attempt === 1) {
        const error = new Error('数据库暂时繁忙')
        error.code = 'TEMPORARY_FAILURE'
        error.retryable = true
        throw error
      }
      return { tool: id, riskLevel: 'read', truncated: false, result: { echo: input } }
    },
    streamScript: [
      { toolCalls: [{ id: 'c1', name: 'mock_tool', arguments: '{}' }] },
      { content: '重试成功后回答' },
    ],
  })
  const { server, port } = await startServer(m.deps)
  t.after(() => {
    server.closeAllConnections()
    return new Promise(r => server.close(r))
  })
  const events = await postRun(port, { text: '查数据' })

  assert.equal(m.executeLog.length, 2)
  const retry = events.find(event => event.type === 'tool.retrying')
  assert.equal(retry.errorCode, 'TEMPORARY_FAILURE')
  assert.equal(retry.nextAttempt, 2)
  const completed = events.find(event => event.type === 'tool.completed')
  assert.equal(completed.attempts, 2)
  assert.ok(events.some(event => event.type === 'run.completed'))
})

test('agent loop：不可重试错误只执行一次', async t => {
  const m = mockDeps({
    toolExecute: () => {
      const error = new Error('limit 参数不合法')
      error.code = 'INVALID_ARGUMENT'
      error.retryable = false
      throw error
    },
    streamScript: [
      { toolCalls: [{ id: 'c1', name: 'mock_tool', arguments: '{}' }] },
      { content: '改用已有信息回答' },
    ],
  })
  const { server, port } = await startServer(m.deps)
  t.after(() => new Promise(r => server.close(r)))
  const events = await postRun(port, { text: '查数据' })

  assert.equal(m.executeLog.length, 1)
  assert.equal(events.some(event => event.type === 'tool.retrying'), false)
  const failed = events.find(event => event.type === 'tool.failed')
  assert.equal(failed.errorCode, 'INVALID_ARGUMENT')
  assert.equal(failed.recovery, 'REVISE_INPUT')
  assert.equal(failed.retryExhausted, false)
  assert.equal(failed.attempts, 1)
})

test('agent loop：工具超时后重试一次，再把结构化错误交回模型', async t => {
  const m = mockDeps({
    env: { TOOL_TIMEOUT_MS: 20 },
    toolExecute: ({ extras }) => new Promise((resolve, reject) => {
      extras.signal.addEventListener('abort', () => reject(extras.signal.reason), { once: true })
    }),
    streamScript: [
      { toolCalls: [{ id: 'c1', name: 'mock_tool', arguments: '{}' }] },
      { content: '查询超时，先按已有信息回答' },
    ],
  })
  const { server, port } = await startServer(m.deps)
  t.after(() => {
    server.closeAllConnections()
    return new Promise(r => server.close(r))
  })
  const events = await postRun(port, { text: '查数据' })

  assert.equal(m.executeLog.length, 2)
  const failed = events.find(event => event.type === 'tool.failed')
  assert.equal(failed.errorCode, 'TOOL_TIMEOUT')
  assert.equal(failed.recovery, 'USE_ALTERNATIVE')
  assert.equal(failed.retryable, false)
  assert.equal(failed.retryExhausted, true)
  assert.equal(failed.attempts, 2)
  const toolMsg = m.calls[1].find(message => message.role === 'tool')
  assert.deepEqual(JSON.parse(toolMsg.content), {
    error: '工具执行超过 20ms', code: 'TOOL_TIMEOUT', recovery: 'USE_ALTERNATIVE',
    retryable: false, retryExhausted: true, attempts: 2,
  })
})

test('agent loop：工具执行中取消会中断工具并进入 cancelled', async t => {
  let signalSeen = null
  let markStarted
  const started = new Promise(resolve => { markStarted = resolve })
  const m = mockDeps({
    toolExecute: ({ extras }) => {
      signalSeen = extras.signal
      markStarted()
      return new Promise((resolve, reject) => {
        extras.signal.addEventListener('abort', () => reject(extras.signal.reason), { once: true })
      })
    },
    streamScript: [{ toolCalls: [{ id: 'c1', name: 'mock_tool', arguments: '{}' }] }],
  })
  const { server, port } = await startServer(m.deps)
  t.after(() => {
    server.closeAllConnections()
    return new Promise(r => server.close(r))
  })

  const responsePromise = fetch(`http://127.0.0.1:${port}/api/runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '开始慢查询' }),
  })
  await started
  const runId = runFile().at(-1).id
  const cancelled = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/cancel`, { method: 'POST' }).then(res => res.json())
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.data.cancelling, true)

  const response = await responsePromise
  const body = await response.text()
  assert.equal(signalSeen.aborted, true)
  assert.match(body, /"type":"run.cancelled"/)
  assert.doesNotMatch(body, /"type":"tool.failed"/)
  assert.equal(getRun(runId).state, 'cancelled')
})

test('agent loop：重复查询提前收束，只执行一次工具', async t => {
  const m = mockDeps({
    streamScript: [{ toolCalls: [{ id: 'loop', name: 'mock_tool', arguments: '{}' }] }],
  })
  const { server, port } = await startServer(m.deps)
  t.after(() => new Promise(r => server.close(r)))
  const events = await postRun(port, { text: '无限调用' })

  assert.equal(m.calls.length, 3)
  assert.equal(m.toolsPassed.at(-1).length, 0, '最后一轮必须切除工具列表')
  const limitEvt = events.find(e => e.type === 'run.limit')
  assert.equal(limitEvt.reason, 'repeated_tools')
  assert.equal(events.filter(e => e.type === 'tool.completed').length, 1)

  // run 仍为 completed 终态，且回答基于上下文直接输出，不向用户报错
  const runId = events.find(e => e.type === 'run.created').runId
  assert.equal(getRun(runId).state, 'completed')
  const limitedConv = getConversation(events.find(e => e.type === 'run.created').conversationId)
  assert.equal(limitedConv.messages[1].content, '基于已有全部证据直接给出的最终回答')
  assert.doesNotMatch(limitedConv.messages[1].content, /取证上限/)
})

test('agent loop：用户显式设定 maxToolRounds，达到自定义上限后直接回答', async t => {
  const m = mockDeps({
    streamScript: [1, 2, 3].map(page => ({ toolCalls: [{ id: `page_${page}`, name: 'mock_tool', arguments: JSON.stringify({ page }) }] })),
  })
  const { server, port } = await startServer(m.deps)
  t.after(() => new Promise(r => server.close(r)))
  const events = await postRun(port, { text: '自定义轮数调用', maxToolRounds: 3 })

  // 3 轮工具调用 + 1 轮最终总结调用 = 共 4 次调用
  assert.equal(m.calls.length, 4)
  assert.equal(m.toolsPassed.at(-1).length, 0, '最后一轮必须切除工具列表')
  const limitEvt = events.find(e => e.type === 'run.limit')
  assert.equal(limitEvt.rounds, 3)
  assert.equal(events.filter(e => e.type === 'tool.completed').length, 3)

  const limitedConv = getConversation(events.find(e => e.type === 'run.created').conversationId)
  assert.equal(limitedConv.messages[1].content, '基于已有全部证据直接给出的最终回答')
})

test('agent loop：read_context 结果留在本 Run，下一 Turn 不回灌正文', async t => {
  const { buildUpstreamMessages } = await import('./prompt.js')
  const { createToolRegistry } = await import('./tools.js')
  const c = createCase({ title: '切片工作区' })
  updateCase(c.id, { her: { persona: '慢热', dislikes: ['连续追问'], commStyle: '短句' } })
  const m = mockDeps({
    streamScript: [
      { toolCalls: [{ id: 'c1', name: 'read_context', arguments: JSON.stringify({ paths: ['her'] }) }] },
      { content: '根据切片回答' },
    ],
  })
  m.deps.buildUpstreamMessages = buildUpstreamMessages
  m.deps.toolRegistry = createToolRegistry()
  const { server, port } = await startServer(m.deps)
  t.after(() => new Promise(r => server.close(r)))
  const events = await postRun(port, { text: '她是不是有点冷', caseId: c.id })

  assert.equal(m.calls.length, 2)
  const toolMsg = m.calls[1].find(x => x.role === 'tool')
  assert.match(toolMsg.content, /慢热/)
  assert.match(toolMsg.content, /连续追问/)
  const convId = events.find(e => e.type === 'run.created').conversationId
  assert.deepEqual(getConversation(convId).lastContextReads, ['her'])

  m.deps.streamChat = async ({ messages, onDelta }) => {
    m.calls.push(messages)
    onDelta?.({ content: '跟进' })
    return { finishReason: 'stop', toolCalls: [], content: '跟进', reasoning: '' }
  }
  await postRun(port, { conversationId: convId, text: '那怎么回', caseId: c.id })
  const follow = m.calls.at(-1)
  assert.equal(follow.some(x => x.role === 'tool'), false)
  assert.doesNotMatch(JSON.stringify(follow), /连续追问/)
  assert.match(follow[0].content, /上一轮使用过这些资料入口/)
  assert.match(follow[0].content, /her/)
})

test('agent loop：propose_memory 只在成功 Run 后落为待确认候选', async t => {
  const { buildUpstreamMessages } = await import('./prompt.js')
  const { createToolRegistry } = await import('./tools.js')
  const c = createCase({ title: '候选工作区', sessionIds: ['chat_memory_candidate'] })
  const m = mockDeps({
    streamScript: [
      { toolCalls: [{
        id: 'memory_1', name: 'propose_memory', arguments: JSON.stringify({
          title: '对回复延迟敏感',
          content: '我容易把回复延迟理解成关系降温',
          topic: 'me',
          type: 'semantic',
        }),
      }] },
      { content: '先区分忙碌和关系降温。' },
    ],
  })
  m.deps.buildUpstreamMessages = buildUpstreamMessages
  m.deps.toolRegistry = createToolRegistry()
  const { server, port } = await startServer(m.deps)
  t.after(() => new Promise(r => server.close(r)))

  const events = await postRun(port, { caseId: c.id, text: '她没回我，我很慌' })
  const candidateEvent = events.find(event => event.type === 'memory.candidate')
  assert.equal(candidateEvent.candidate.status, 'pending')
  assert.equal(candidateEvent.candidate.topic, 'me')
  assert.equal(getCase(c.id).memories.length, 0)
  assert.equal(getCase(c.id).memoryCandidates.length, 1)
  const conv = getConversation(events.find(event => event.type === 'run.created').conversationId)
  assert.deepEqual(conv.messages.at(-1).memoryCandidateIds, [candidateEvent.candidate.id])
  assert.match(m.calls[0][0].content, /propose_memory/)
  assert.doesNotMatch(m.calls[0][0].content, /write_memory/)
})

test('agent loop：回答失败时不落候选记忆', async t => {
  const { createToolRegistry } = await import('./tools.js')
  const c = createCase({ title: '失败候选', sessionIds: ['chat_memory_failed'] })
  const m = mockDeps({ streamScript: [{ toolCalls: [] }] })
  let calls = 0
  m.deps.toolRegistry = createToolRegistry()
  m.deps.streamChat = async () => {
    calls += 1
    if (calls === 1) return {
      finishReason: 'tool_calls', content: '', reasoning: '',
      toolCalls: [{ id: 'memory_fail', name: 'propose_memory', arguments: '{"content":"失败 Run 不应保存"}' }],
    }
    throw new Error('上游失败')
  }
  const { server, port } = await startServer(m.deps)
  t.after(() => new Promise(r => server.close(r)))

  const events = await postRun(port, { caseId: c.id, text: '测试失败' })
  assert.ok(events.some(event => event.type === 'run.failed'))
  assert.deepEqual(getCase(c.id).memoryCandidates, [])
})

test('agent loop：模型遭遇退化死循环时及时截断并兜底触发直接回答', async t => {
  let fallbackInvoked = false
  const m = mockDeps({
    streamScript: [
      {
        loopDetected: true,
        reasoning: '思考过程重复内容',
        content: '',
      },
    ],
  })
  const origStream = m.deps.streamChat
  m.deps.streamChat = async (opts) => {
    if (opts.messages?.at(-1)?.content?.includes('直接给出给机主的正式回答')) {
      fallbackInvoked = true
      opts.onDelta?.({ content: '经分析，建议采取以下三项应对策略：1... 2... 3...' })
      return { finishReason: 'stop', content: '经分析，建议采取以下三项应对策略：1... 2... 3...' }
    }
    return origStream(opts)
  }

  const { server, port } = await startServer(m.deps)
  t.after(() => new Promise(r => server.close(r)))
  const events = await postRun(port, { text: '测试循环截断' })

  assert.equal(fallbackInvoked, true)
  assert.ok(events.some(e => e.type === 'run.completed'))
  const runId = events.find(e => e.type === 'run.created').runId
  assert.equal(getRun(runId).state, 'completed')
  const convId = events.find(e => e.type === 'run.created').conversationId
  const conv = getConversation(convId)
  assert.ok(conv.messages[1].content.includes('建议采取以下三项应对策略'))
})
