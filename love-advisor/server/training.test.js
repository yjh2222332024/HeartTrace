import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'love-advisor-training-test-'))
process.env.LOVE_ADVISOR_DATA_DIR = dataDir

const {
  createCase,
  createTrainingSession,
  getTrainingSession,
  appendTrainingMessages,
  createTrainingInitiativeBudget,
  scheduleTrainingInitiative,
  cancelTrainingInitiative,
  deliverDueTrainingInitiative,
  pauseTrainingSession,
  resumeTrainingSession,
  updateTrainingSession,
} = await import('./store.js')
const { buildPeerContext, buildTrainingSnapshot, parsePeerTurn, parseScenarios, randomInitiativeDeliverySeconds } = await import('./training.js')
const { registerTrainingRoutes } = await import('./training.js')

test('训练会话独立绑定工作区，且只接受训练角色消息', () => {
  const workspace = createCase({ title: '训练对象', sessionIds: ['session_training_1'] })
  const session = createTrainingSession({
    caseId: workspace.id,
    advisorId: 'default',
    scenario: { title: '自然续聊', opening: '对方刚结束加班。', goal: '自然延续话题' },
    snapshot: { caseTitle: workspace.title },
  })

  assert.equal(session.caseId, workspace.id)
  assert.equal(session.messages.length, 0)
  assert.equal(session.simulatedMinutes, 0)

  const updated = appendTrainingMessages(session.id, [
    { role: 'me', content: '辛苦啦，今天还顺利吗？' },
    { role: 'peer', content: '还行，刚到家', afterSeconds: 3, simulatedMinutes: 18 },
  ])
  assert.equal(updated.messages.length, 2)
  assert.equal(updated.simulatedMinutes, 18)
  assert.equal(getTrainingSession(session.id).messages[1].role, 'peer')

  assert.throws(
    () => appendTrainingMessages(session.id, [{ role: 'assistant', content: '不应进入训练记录' }]),
    /训练消息角色无效/,
  )

  const reviewed = updateTrainingSession(session.id, { state: 'reviewed', review: { summary: '表达自然' } })
  assert.equal(reviewed.state, 'reviewed')
  assert.equal(reviewed.review.summary, '表达自然')
})

test('训练会话拒绝不存在的工作区', () => {
  assert.throws(
    () => createTrainingSession({ caseId: 'case_does_not_exist', scenario: { title: 'x' } }),
    /工作区不存在/,
  )
})

test('训练场主动消息：额度随机、暂停冻结、到点只投递一次', () => {
  assert.equal(createTrainingInitiativeBudget(() => 0), 2)
  assert.equal(createTrainingInitiativeBudget(() => 0.079), 2)
  assert.equal(createTrainingInitiativeBudget(() => 0.08), 1)
  assert.equal(createTrainingInitiativeBudget(() => 0.279), 1)
  assert.equal(createTrainingInitiativeBudget(() => 0.28), 0)

  const workspace = createCase({ title: '主动消息训练', sessionIds: ['session_training_initiative'] })
  const session = createTrainingSession({
    caseId: workspace.id,
    initiativeBudget: 2,
    scenario: { title: '自然续聊', opening: '刚下班。' },
    snapshot: { caseTitle: workspace.title },
  })
  const startedAt = Date.parse('2026-09-16T12:00:00.000Z')
  const pending = scheduleTrainingInitiative(session.id, {
    deliverySeconds: 7,
    simulatedMinutes: 24,
    topicSource: '未完话题',
    reason: '主动换题',
    messages: [{ content: '对了，周末那部电影你后来去看了吗？' }, { content: '我刚刷到预告' }],
  }, { now: startedAt })
  assert.equal(pending.pendingInitiative.deliverySeconds, 7)
  assert.equal(pending.pendingInitiative.messages.length, 2)
  assert.equal(pending.initiativeUsed, 1)
  assert.equal(deliverDueTrainingInitiative(session.id, { now: startedAt + 6999 }).messages.length, 0)

  const paused = pauseTrainingSession(session.id, { now: startedAt + 2000 })
  assert.equal(paused.state, 'paused')
  assert.equal(paused.pendingInitiative.remainingMs, 5000)
  assert.equal(deliverDueTrainingInitiative(session.id, { now: startedAt + 60_000 }).messages.length, 0)
  const resumed = resumeTrainingSession(session.id, { now: startedAt + 60_000 })
  assert.equal(resumed.state, 'active')
  assert.equal(deliverDueTrainingInitiative(session.id, { now: startedAt + 64_999 }).messages.length, 0)
  const delivered = deliverDueTrainingInitiative(session.id, { now: startedAt + 65_000 })
  assert.equal(delivered.messages.length, 2)
  assert.equal(delivered.messages[0].role, 'peer')
  assert.equal(deliverDueTrainingInitiative(session.id, { now: startedAt + 66_000 }).messages.length, 0)

  scheduleTrainingInitiative(session.id, {
    deliverySeconds: 3,
    simulatedMinutes: 30,
    messages: [{ content: '这条会被取消' }],
  }, { now: startedAt })
  const cancelled = cancelTrainingInitiative(session.id)
  assert.equal(cancelled.pendingInitiative, null)
  assert.equal(cancelled.initiativeUsed, 1)
})

test('训练快照保留工作区历史结构，对方回合被严格裁剪', () => {
  const snapshot = buildTrainingSnapshot({
    id: 'case_training_snapshot', title: '小林', stage: '暧昧', riskLevel: 'normal', sessionIds: ['session_1'],
    profileStatus: { ownerName: '我', peerName: '小林', status: 'confirmed' },
    her: { persona: '慢热', traits: ['谨慎'], likes: ['电影'], dislikes: ['催促'], commStyle: '短句', replyStyle: '短句，偶尔拆成两条，不用句号' },
    me: { goal: '自然邀约', style: '直白', pitfalls: ['追问'] },
    summary: '已经认识三个月。',
    relationship: { keyEvents: [{ date: '2026-08-01', event: '第一次见面' }], openLoops: ['周末电影'], boundaries: ['不喜欢逼问'] },
    memories: [{ status: 'active', topic: 'events', content: '八月一起看过展览', createdAt: '2026-08-02' }],
  })
  assert.equal(snapshot.her.persona, '慢热')
  assert.equal(snapshot.relationship.keyEvents[0].event, '第一次见面')
  assert.equal(snapshot.memories[0].content, '八月一起看过展览')
  assert.equal(snapshot.her.replyStyle, '短句，偶尔拆成两条，不用句号')

  const scenarios = parseScenarios(JSON.stringify({ scenarios: [
    { title: '周末邀约', premise: '最近互动稳定', goal: '自然提出见面', opening: '对方说这周终于不加班了', difficulty: '适中' },
  ] }))
  assert.equal(scenarios[0].title, '周末邀约')

  const turn = parsePeerTurn(JSON.stringify({
    delayMinutes: 999,
    messages: [
      { content: '好呀', afterSeconds: 2 },
      { content: '不过周六可能不行', afterSeconds: 99 },
      { content: '周日可以看看', afterSeconds: 4 },
      { content: '这条应被裁剪', afterSeconds: 4 },
    ],
    privateState: { warmth: 'warm', engagement: 'high' },
  }), 12)
  assert.equal(turn.delayMinutes, 240)
  assert.equal(turn.messages.length, 3)
  assert.equal(turn.messages[1].afterSeconds, 45)
  assert.equal(turn.messages[0].simulatedMinutes, 252)
  assert.equal(turn.privateState.warmth, 'high')
  assert.equal(turn.privateState.engagement, 'high')
  assert.equal(turn.privateState.boundaryPressure, 'low')

  const initiativeTurn = parsePeerTurn(JSON.stringify({
    delayMinutes: 12,
    messages: [{ content: '刚忙完' }],
    initiative: {
      delayMinutes: 30,
      topicSource: '未完话题',
      reason: '主动换题',
      messages: [{ content: '对了，那家店你收藏了吗？' }, { content: '我刚好想起来' }, { content: '这条应被裁剪' }],
    },
  }), 20)
  assert.equal(initiativeTurn.messages.length, 1)
  assert.equal(initiativeTurn.initiative.messages.length, 2)
  assert.equal(initiativeTurn.initiative.simulatedMinutes, 62)
  assert.equal(randomInitiativeDeliverySeconds(() => 0), 3)
  assert.equal(randomInitiativeDeliverySeconds(() => 0.999), 12)

  const peerContext = buildPeerContext({ ...snapshot, recentEvidence: { recent14d: '不应注入对方模型'.repeat(3000) } })
  assert.ok(Buffer.byteLength(peerContext, 'utf8') <= 8 * 1024)
  assert.doesNotMatch(peerContext, /不应注入对方模型/)
  assert.match(peerContext, /不使用句号|不.?用句号/)
})

test('训练路由让军师出题，但对方模拟器不会读取军师点评', async t => {
  const workspace = createCase({ title: '训练路由', sessionIds: ['session_training_route'] })
  const calls = []
  const app = express()
  app.use(express.json())
  let clock = Date.parse('2026-09-16T13:00:00.000Z')
  let trainingDocs = '冻结的方法论：先判断，再给训练建议。'
  registerTrainingRoutes(app, {
    getEnv: () => ({ BASE_URL: 'https://model.example/v1', API_KEY: 'secret', BASE_MODEL: 'test' }),
    buildEvidencePack: async () => null,
    skillRuntime: {
      promptConfigFor: () => ({ ok: true, prompt: '你是冷静的训练军师' }),
      buildTrainingPackage: () => ({
        ok: true, version: 1, advisorId: 'default', name: '测试军师', prompt: '你是冷静的训练军师',
        loadedDocs: ['SKILL.md', 'references/core/methodology.md'], docsText: trainingDocs,
      }),
    },
    random: () => 0.1,
    now: () => clock,
    streamChat: async ({ messages, timeoutMs }) => {
      calls.push({ messages, timeoutMs })
      const system = messages[0]?.content || ''
      if (system.includes('生成恰好 3')) return { content: JSON.stringify({ scenarios: [{ title: '自然续聊', premise: '最近互动稳定', goal: '自然延续', opening: '对方刚下班', difficulty: '适中' }] }) }
      if (system.includes('对方模拟器')) {
        const isReply = messages.some(message => message.content === '请作为对方自然回应上一条【我】的消息。')
        return { content: JSON.stringify({
          delayMinutes: 12,
          messages: [{ content: '刚到家呀', afterSeconds: 2 }],
          initiative: isReply ? {
            delayMinutes: 20,
            topicSource: '未完话题',
            reason: '主动换题',
            messages: [{ content: '对了，周末电影你想看哪个？' }],
          } : null,
          privateState: { warmth: 'neutral' },
        }) }
      }
      if (system.includes('结束复盘')) return { content: JSON.stringify({ title: '本局复盘', body: '节奏自然', suggestions: ['下次练习邀约'] }) }
      return { content: JSON.stringify({ title: '暂停点评', body: '先接住对方情绪', suggestions: ['少一点追问'] }) }
    },
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = async (pathname, body = {}) => {
    const response = await fetch(base + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return response.json()
  }

  const scenes = await post('/api/training/scenarios', { caseId: workspace.id, advisorId: 'default' })
  assert.equal(scenes.ok, true)
  assert.match(calls[0].messages[0].content, /冻结的方法论/)
  const created = await post('/api/training/sessions', { caseId: workspace.id, advisorId: 'default', scenario: scenes.data.scenarios[0] })
  assert.equal(created.ok, true)
  assert.equal(created.data.messages[0].role, 'peer')
  assert.equal(created.data.openingMessages[0].content, '刚到家呀')
  assert.match(created.data.advisorPackage.docsText, /冻结的方法论/)
  trainingDocs = '修改后的方法论，不应进入已经开始的训练。'
  const id = created.data.id
  const sessionList = await fetch(`${base}/api/training/sessions`).then(response => response.json())
  assert.equal(sessionList.ok, true)
  assert.equal(sessionList.data.items[0].id, id)
  assert.equal(sessionList.data.items[0].messageCount, 1)
  assert.equal(Object.hasOwn(sessionList.data.items[0], 'messages'), false)
  assert.equal(Object.hasOwn(sessionList.data.items[0], 'snapshot'), false)
  const firstTurn = await post(`/api/training/sessions/${id}/turn`, { content: '今天怎么样？' })
  assert.equal(firstTurn.ok, true)
  assert.equal(firstTurn.data.messages[0].role, 'peer')
  assert.equal(firstTurn.data.session.pendingInitiative.messages.length, 1)
  assert.equal(firstTurn.data.session.pendingInitiative.deliverySeconds, 4)
  clock += 4000
  const delivered = await post(`/api/training/sessions/${id}/deliver-initiative`)
  assert.equal(delivered.ok, true)
  assert.equal(delivered.data.messages[0].content, '对了，周末电影你想看哪个？')
  const deliveredAgain = await post(`/api/training/sessions/${id}/deliver-initiative`)
  assert.equal(deliveredAgain.data.messages.length, 0)
  const pause = await post(`/api/training/sessions/${id}/coach`, { mode: 'pause' })
  assert.equal(pause.ok, true)
  assert.equal(pause.data.session.state, 'paused')
  const latestCoachCall = [...calls].reverse().find(call => call.messages[0]?.content?.includes('模拟聊天训练场的军师'))
  assert.match(latestCoachCall.messages[0].content, /冻结的方法论/)
  assert.doesNotMatch(latestCoachCall.messages[0].content, /修改后的方法论/)
  const resumed = await post(`/api/training/sessions/${id}/resume`)
  assert.equal(resumed.ok, true)
  assert.equal(resumed.data.session.state, 'active')
  const secondTurn = await post(`/api/training/sessions/${id}/turn`, { content: '听起来挺累的' })
  assert.equal(secondTurn.ok, true)
  const latestSimulatorCall = [...calls].reverse().find(call => call.messages[0]?.content?.includes('对方模拟器'))
  assert.equal(latestSimulatorCall.timeoutMs, 20_000)
  assert.doesNotMatch(JSON.stringify(latestSimulatorCall.messages), /军师点评|先接住对方情绪/)
  assert.doesNotMatch(JSON.stringify(latestSimulatorCall.messages), /冻结的方法论/)
  assert.match(latestSimulatorCall.messages[0].content, /聊天口吻优先级最高/)
})

test('训练路由：用户抢先发言会撤销待发主动消息', async t => {
  const workspace = createCase({ title: '抢先发言训练', sessionIds: ['session_training_cancel'] })
  const app = express()
  app.use(express.json())
  let replyCount = 0
  registerTrainingRoutes(app, {
    getEnv: () => ({ BASE_URL: 'https://model.example/v1', API_KEY: 'secret', BASE_MODEL: 'test' }),
    buildEvidencePack: async () => null,
    skillRuntime: { promptConfigFor: () => ({ ok: true, prompt: '训练军师' }) },
    random: () => 0.1,
    streamChat: async ({ messages }) => {
      const system = messages[0]?.content || ''
      if (system.includes('对方模拟器')) {
        const isReply = messages.some(message => message.content === '请作为对方自然回应上一条【我】的消息。')
        if (isReply) replyCount += 1
        return {
          content: JSON.stringify({
            delayMinutes: 4,
            messages: [{ content: '我在呀' }],
            initiative: replyCount === 1
              ? { delayMinutes: 15, topicSource: '兴趣', reason: '主动换题', messages: [{ content: '突然想起那部电影' }] }
              : null,
          }),
        }
      }
      return { content: JSON.stringify({ title: '提示', body: '先接住情绪' }) }
    },
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = async (pathname, body = {}) => {
    const response = await fetch(base + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return response.json()
  }

  const created = await post('/api/training/sessions', {
    caseId: workspace.id,
    scenario: { title: '续聊', opening: '今天好忙' },
  })
  const first = await post(`/api/training/sessions/${created.data.id}/turn`, { content: '那你先忙' })
  assert.ok(first.data.session.pendingInitiative)
  assert.equal(first.data.session.initiativeUsed, 1)

  const second = await post(`/api/training/sessions/${created.data.id}/turn`, { content: '我刚想起一件事' })
  assert.equal(second.ok, true)
  assert.equal(second.data.session.pendingInitiative, null)
  assert.equal(second.data.session.initiativeUsed, 0)
})
