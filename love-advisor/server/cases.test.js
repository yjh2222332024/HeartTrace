// ── cases：案例 CRUD / 记忆 / 会话绑定 / Run 上下文注入 ──
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import express from 'express'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'love-advisor-cases-test-'))
process.env.LOVE_ADVISOR_DATA_DIR = tmpDir

const {
  createCase, getCase, updateCase, deleteCase, addCaseMemory, deleteCaseMemory, listCases,
  addCaseMemoryCandidates, updateCaseMemoryCandidate, acceptCaseMemoryCandidate, rejectCaseMemoryCandidate,
  createConversation, updateConversation, getConversation, createTrainingSession, listTrainingSessions,
  upsertImportJob, listImportJobs, _writeJsonForTest,
} = await import('./store.js')

const { buildCaseBlock } = await import('./runs.js')
const { confirmWorkspaceProfile } = await import('./profile.js')
const { registerCaseRoutes } = await import('./cases.js')

beforeEach(() => {
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { force: true })
})

function startCaseServer() {
  const app = express()
  app.use(express.json())
  registerCaseRoutes(app)
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

test('案例创建 → 更新 → 查询 → 列表倒序', () => {
  const a = createCase({ title: '和某某的暧昧期' })
  assert.match(a.id, /^case_/)
  assert.equal(a.stage, '初识')
  assert.equal(a.riskLevel, 'normal')
  assert.deepEqual(a.sessionIds, [])

  const b = createCase({ title: '另一个案例' })
  const updated = updateCase(a.id, { title: '暧昧期 · 复盘', stage: '暧昧', riskLevel: 'high' })
  assert.equal(updated.stage, '暧昧')
  assert.equal(updated.riskLevel, 'high')

  const items = listCases()
  assert.equal(items[0].id, a.id) // a 更新时间更晚，排前面
  assert.ok(items.some(x => x.id === b.id))
})

test('案例枚举校验：stage / riskLevel 非法值拒绝', () => {
  const c = createCase({})
  assert.throws(() => updateCase(c.id, { stage: '已婚' }), /stage/)
  assert.throws(() => updateCase(c.id, { riskLevel: 'extreme' }), /riskLevel/)
  assert.throws(() => updateCase(c.id, { sessionIds: 'not-array' }), /数组/)
})

test('案例更新与创建失败时不留下部分写入', () => {
  const c = createCase({ title: '原标题' })
  assert.throws(() => updateCase(c.id, { title: '不应保存', stage: '非法阶段' }), /stage/)
  assert.equal(getCase(c.id).title, '原标题')

  assert.throws(
    () => createCase({ title: '不应创建', sessionIds: ['s1', 's2'] }),
    /只能绑定 1 个/
  )
  assert.equal(listCases().some(item => item.title === '不应创建'), false)
})

test('绑定 ChatLab 会话：一对一 + 去重占用', () => {
  const c = createCase({})
  const updated = updateCase(c.id, { sessionIds: ['qq_1', 'qq_1'] })
  assert.deepEqual(updated.sessionIds, ['qq_1'])
  assert.throws(() => updateCase(c.id, { sessionIds: ['qq_1', 'qq_2'] }), /只能绑定 1 个/)
  const c2 = createCase({ title: '第二个' })
  assert.throws(() => updateCase(c2.id, { sessionIds: ['qq_1'] }), /已绑定工作区/)
})

test('记忆：添加（带 runId 溯源）/ 删除 / 上限 / 内容截断', () => {
  const c = createCase({})
  const m1 = addCaseMemory(c.id, { content: '她明确说过不喜欢忽冷忽热', runId: 'run_x' })
  assert.match(m1.id, /^mem_/)
  assert.equal(m1.runId, 'run_x')

  const long = addCaseMemory(c.id, { content: '长'.repeat(3000) })
  assert.equal(long.content.length, 2000) // 截断到 2000
  assert.throws(() => addCaseMemory(c.id, { content: '  ' }), /不能为空/)

  assert.ok(deleteCaseMemory(c.id, m1.id))
  assert.equal(deleteCaseMemory(c.id, m1.id), false)
  assert.equal(getCase(c.id).memories.length, 1)

  // 上限 100
  for (let i = 0; i < 99; i++) addCaseMemory(c.id, { content: `记忆${i}` })
  assert.throws(() => addCaseMemory(c.id, { content: '超限' }), /最多保留/)
})

test('候选记忆：确认前不进入正式记忆，支持去重、编辑、确认和忽略', () => {
  const c = createCase({ title: '候选测试', sessionIds: ['chat_candidate'] })
  const created = addCaseMemoryCandidates(c.id, [{
    title: '忙碌时回复变慢',
    content: '她工作忙时回复通常会变慢',
    topic: 'her',
    type: 'semantic',
    kind: 'conclusion',
    refs: ['her', 'evidence.recent'],
    sourceMessageIds: [3, 8],
    confidence: 0.82,
  }], { runId: 'run_candidate' })

  assert.equal(created.length, 1)
  assert.match(created[0].id, /^cand_/)
  assert.equal(created[0].status, 'pending')
  assert.equal(created[0].runId, 'run_candidate')
  assert.equal(getCase(c.id).memories.length, 0)

  const duplicate = addCaseMemoryCandidates(c.id, [{
    content: '她工作忙时，回复通常会变慢。', topic: 'her',
  }], { runId: 'run_duplicate' })
  assert.deepEqual(duplicate, [])

  const edited = updateCaseMemoryCandidate(c.id, created[0].id, {
    title: '工作节奏影响回复',
    content: '她在工作繁忙时回复节奏通常会下降',
  })
  assert.equal(edited.title, '工作节奏影响回复')

  const accepted = acceptCaseMemoryCandidate(c.id, created[0].id)
  assert.equal(accepted.candidate.status, 'accepted')
  assert.equal(accepted.memory.content, edited.content)
  assert.equal(accepted.memory.status, 'active')
  assert.equal(accepted.candidate.acceptedMemoryId, accepted.memory.id)
  assert.equal(getCase(c.id).memories.length, 1)

  const acceptedAgain = acceptCaseMemoryCandidate(c.id, created[0].id)
  assert.equal(acceptedAgain.memory.id, accepted.memory.id)
  assert.equal(getCase(c.id).memories.length, 1)

  const [ignored] = addCaseMemoryCandidates(c.id, [{ content: '我容易连续追问', topic: 'me' }], { runId: 'run_ignore' })
  assert.equal(rejectCaseMemoryCandidate(c.id, ignored.id).status, 'rejected')
  assert.equal(rejectCaseMemoryCandidate(c.id, ignored.id).status, 'rejected')
  assert.throws(() => acceptCaseMemoryCandidate(c.id, ignored.id), /已忽略/)
})

test('候选记忆 API：查询、编辑、确认、忽略均绑定工作区', async t => {
  const c = createCase({ title: '候选 API' })
  const other = createCase({ title: '其他工作区' })
  const [candidate, ignored] = addCaseMemoryCandidates(c.id, [
    { content: '她习惯提前约时间', topic: 'her' },
    { content: '我容易连续追问', topic: 'me' },
  ], { runId: 'run_api' })
  const { server, port } = await startCaseServer()
  t.after(() => new Promise(resolve => server.close(resolve)))

  const listed = await fetch(`http://127.0.0.1:${port}/api/cases/${c.id}/memory-candidates`).then(res => res.json())
  assert.equal(listed.data.items.length, 2)

  const edited = await fetch(`http://127.0.0.1:${port}/api/cases/${c.id}/memory-candidates/${candidate.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '提前安排', content: '她更喜欢提前确定见面时间' }),
  }).then(res => res.json())
  assert.equal(edited.data.title, '提前安排')

  const accepted = await fetch(`http://127.0.0.1:${port}/api/cases/${c.id}/memory-candidates/${candidate.id}/accept`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }).then(res => res.json())
  assert.equal(accepted.data.candidate.status, 'accepted')
  const acceptedAgain = await fetch(`http://127.0.0.1:${port}/api/cases/${c.id}/memory-candidates/${candidate.id}/accept`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }).then(res => res.json())
  assert.equal(acceptedAgain.data.memory.id, accepted.data.memory.id)

  const rejected = await fetch(`http://127.0.0.1:${port}/api/cases/${c.id}/memory-candidates/${ignored.id}/reject`, {
    method: 'POST',
  }).then(res => res.json())
  assert.equal(rejected.data.status, 'rejected')

  const crossCase = await fetch(`http://127.0.0.1:${port}/api/cases/${other.id}/memory-candidates/${candidate.id}/accept`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
  assert.equal(crossCase.status, 404)
})

test('会话绑定案例：创建时携带 + PATCH 换绑 + 删案例自动解绑', () => {
  const c = createCase({ title: 'A 案' })
  const conv = createConversation({ title: '聊天', caseId: c.id })
  assert.equal(getConversation(conv.id).caseId, c.id)

  const c2 = createCase({ title: 'B 案' })
  updateConversation(conv.id, { caseId: c2.id })
  assert.equal(getConversation(conv.id).caseId, c2.id)

  updateConversation(conv.id, { caseId: '' })
  assert.equal(getConversation(conv.id).caseId, '')

  // 绑定后再删案例 → 自动解绑
  updateConversation(conv.id, { caseId: c2.id })
  deleteCase(c2.id)
  assert.equal(getConversation(conv.id).caseId, '')
})

test('案例删除后查询为 null', () => {
  const c = createCase({})
  assert.ok(deleteCase(c.id))
  assert.equal(getCase(c.id), null)
  assert.equal(deleteCase(c.id), false)
})

test('删除工作区会清理训练和导入任务，但保留并解绑普通会话', () => {
  const workspace = createCase({ title: '待删除工作区' })
  const conversation = createConversation({ title: '保留的咨询', caseId: workspace.id })
  const training = createTrainingSession({
    caseId: workspace.id,
    scenario: { title: '测试场景', premise: '验证级联删除' },
    snapshot: { profile: { name: '测试对象' } },
  })
  const importJob = upsertImportJob({
    id: 'import_cascade_test',
    caseId: workspace.id,
    state: 'completed',
    createdAt: new Date().toISOString(),
  })

  assert.ok(deleteCase(workspace.id))
  assert.equal(getConversation(conversation.id)?.caseId, '')
  assert.equal(listTrainingSessions().some(item => item.id === training.id), false)
  assert.equal(listImportJobs().some(item => item.id === importJob.id), false)
})

test('工作区档案：her/me/relationship 整体替换 + 校验 + 旧数据补齐', () => {
  const c = createCase({})
  // 旧数据兼容：新结构自动补齐默认值
  assert.deepEqual(c.her.traits, [])
  assert.equal(c.baseline.updatedAt, null)

  updateCase(c.id, {
    her: { persona: '慢热理性', traits: ['内向', '理性'], likes: ['猫', '悬疑片'], dislikes: ['忽冷忽热'], commStyle: '喜欢用省略号', replyStyle: '短句，偶尔单独发省略号' },
    me: { goal: '三个月内确定关系', pitfalls: ['过度热情'] },
    relationship: {
      keyEvents: [{ date: '2026-08-01', event: '第一次一起吃饭' }, null, { event: '' }],
      openLoops: ['约了周末看展还没定时间'],
      boundaries: ['不查岗'],
    },
  })
  const got = getCase(c.id)
  assert.equal(got.her.persona, '慢热理性')
  assert.deepEqual(got.her.likes, ['猫', '悬疑片'])
  assert.equal(got.her.replyStyle, '短句，偶尔单独发省略号')
  assert.equal(got.me.goal, '三个月内确定关系')
  assert.equal(got.relationship.keyEvents.length, 1) // null / 空 event 被过滤
  assert.equal(got.relationship.keyEvents[0].event, '第一次一起吃饭')
  assert.equal(got.baseline.updatedAt, null) // baseline 不可经 API 修改

  assert.throws(() => updateCase(c.id, { her: 'not-object' }), /her 必须是对象/)
  assert.throws(() => updateCase(c.id, { her: { traits: 'x' } }), /字符串数组/)
  assert.throws(() => updateCase(c.id, { relationship: { keyEvents: 'x' } }), /keyEvents 必须是数组/)
})

test('记忆 type 校验', () => {
  const c = createCase({})
  const m = addCaseMemory(c.id, {
    content: '结论', type: 'risk', topic: 'risk', kind: 'conclusion',
    title: '风险结论', refs: ['relationship', 'evidence.recent'],
  })
  assert.equal(m.type, 'risk')
  assert.equal(m.topic, 'risk')
  assert.equal(m.status, 'active')
  assert.equal(m.title, '风险结论')
  assert.deepEqual(m.refs, ['relationship', 'evidence.recent'])
  const defaults = addCaseMemory(c.id, { content: '默认' })
  assert.equal(defaults.type, 'semantic')
  assert.equal(defaults.topic, 'relationship')
  assert.equal(defaults.kind, 'conclusion')
  assert.equal(defaults.status, 'active')
  assert.throws(() => addCaseMemory(c.id, { content: 'x', type: 'hack' }), /type 只能是/)
  assert.throws(() => addCaseMemory(c.id, { content: 'x', topic: 'unknown' }), /topic 只能是/)
  assert.throws(() => addCaseMemory(c.id, { content: 'x', refs: ['unknown'] }), /refs/)
})

test('buildCaseBlock：五块结构按内容出现，空块不输出', () => {
  const c = createCase({ title: '工作区A' })
  updateCase(c.id, {
    her: { persona: '慢热', likes: ['猫'] },
    me: { goal: '确定关系', pitfalls: ['过度热情'] },
    relationship: { keyEvents: [{ date: '2026-08-01', event: '首约' }], openLoops: ['看展'] },
  })
  addCaseMemory(c.id, { content: '她提到喜欢悬疑片', type: 'semantic' })
  const block = buildCaseBlock(getCase(c.id))

  assert.ok(block.includes('# 关系工作区'))
  assert.ok(block.includes('## 她是谁'))
  assert.ok(block.includes('兴趣偏好：猫'))
  assert.ok(block.includes('## 我是谁'))
  assert.ok(block.includes('我常犯的错'))
  assert.ok(block.includes('## 关系现状'))
  assert.ok(block.includes('[2026-08-01] 首约'))
  assert.ok(block.includes('未完结事项：看展'))
  assert.ok(block.includes('## 相关记忆'))
  assert.ok(block.includes('/semantic]'))
  assert.ok(!block.includes('## 信号基线')) // baseline 未产出则不输出
})

test('buildCaseBlock：风险标记提示 + 超限截断', () => {
  const c = createCase({ title: '风险工作区' })
  updateCase(c.id, { riskLevel: 'safety' })
  const block = buildCaseBlock(getCase(c.id))
  assert.ok(block.includes('安全层规则优先级进一步提高'))

  // 超限：塞 100 条 1000 字记忆 + 大摘要 → 12KB 截断
  const big = { ...getCase(c.id), summary: '长'.repeat(20000), memories: [] }
  assert.ok(Buffer.byteLength(buildCaseBlock(big)) <= 12 * 1024 + 100)
})

test('writeJson：独立 tmp 文件与 Windows EPERM 锁竞争回退 copyFileSync 且清理 tmp', () => {
  const target = path.join(tmpDir, 'test_atomic.json')
  _writeJsonForTest(target, { a: 1 })
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { a: 1 })

  // 模拟 renameSync 抛出 EPERM（Windows 杀软瞬时锁）
  const origRename = fs.renameSync
  try {
    let renameCalled = false
    fs.renameSync = (src, dest) => {
      renameCalled = true
      const err = new Error('operation not permitted')
      err.code = 'EPERM'
      throw err
    }

    _writeJsonForTest(target, { a: 2, status: 'fallback_ok' })
    assert.equal(renameCalled, true)
    // 验证 copyFileSync 兜底成功写入
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { a: 2, status: 'fallback_ok' })

    // 验证没有残留任何 .tmp 文件
    const remainingTmp = fs.readdirSync(tmpDir).filter(f => f.endsWith('.tmp'))
    assert.equal(remainingTmp.length, 0, '所有临时文件必须被清理')
  } finally {
    fs.renameSync = origRename
  }
})

test('confirmWorkspaceProfile：字段级安全合并，绝不被草稿空数组清空人工维护的雷区与边界', () => {
  const c = createCase({ title: '工作区保全测试' })
  // 用户此前已在工作区手动维护了核心雷区与边界承诺
  updateCase(c.id, {
    her: { persona: '温柔', dislikes: ['严禁查岗', '反感冷暴力'], callHistory: ['2026-01-01 通话'] },
    relationship: { boundaries: ['互不看手机', '有矛盾当天解决'] },
    profileStatus: {
      status: 'draft',
      ownerName: '我',
      peerName: '她',
      ownerConfirmed: false,
      draft: {
        stage: '暧昧',
        summary: 'AI 生成的关系摘要',
        her: { persona: '外冷内热', traits: ['独立'], likes: ['阅读'], dislikes: [] }, // AI 草稿 dislikes 为空
        relationship: { keyEvents: [{ date: '2026-02-01', event: '一起自驾' }], boundaries: [] }, // AI 草稿 boundaries 为空
      },
    },
  })

  // 确认草稿（未在 patch 中传递 dislikes 和 boundaries）
  const updated = confirmWorkspaceProfile(c.id, { applyDraft: true })
  assert.equal(updated.profileStatus.status, 'confirmed')
  assert.equal(updated.profileStatus.ownerConfirmed, true)
  assert.equal(updated.her.persona, '外冷内热') // AI 新抽取的字段生效
  assert.deepEqual(updated.her.likes, ['阅读'])
  // 核心验证：用户之前保存的人工维护数据被完整保留，未被覆盖为 []
  assert.deepEqual(updated.her.dislikes, ['严禁查岗', '反感冷暴力'])
  assert.deepEqual(updated.her.callHistory, ['2026-01-01 通话'])
  assert.deepEqual(updated.relationship.boundaries, ['互不看手机', '有矛盾当天解决'])
  assert.equal(updated.relationship.keyEvents[0].event, '一起自驾')
})
