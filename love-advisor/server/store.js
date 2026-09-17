// ── 本地 JSON 存储：conversations / messages / runs / cases ──
// 单用户本地应用，JSON 文件 + 同步原子写足够；SQLite 留给更大规模时再迁
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveUserDataDir } from './runtime-paths.js'

// 测试可通过 LOVE_ADVISOR_DATA_DIR 覆盖数据目录
const DATA_DIR = resolveUserDataDir()

const CONV_FILE = path.join(DATA_DIR, 'conversations.json')
const RUN_FILE = path.join(DATA_DIR, 'runs.json')
const CASE_FILE = path.join(DATA_DIR, 'cases.json')
const TRAINING_FILE = path.join(DATA_DIR, 'training-sessions.json')

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const RUN_EVENTS_CAP = 200
const CASE_STAGES = ['陌生', '初识', '暧昧', '交往', '冲突/分手']
const CASE_RISKS = ['normal', 'high', 'safety']
const CASE_MEMORIES_CAP = 100
const CASE_MEMORY_CANDIDATES_CAP = 50
const CASE_PENDING_CANDIDATES_CAP = 20
const CASE_SESSIONS_CAP = 1

// ── 内存缓存 + 原子落盘（write tmp → rename）────────────
let convs = null
let runs = null
let cases = null
let trainingSessions = null

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, data) {
  ensureDir()
  const tmp = `${file}.${process.pid}.${randomUUID().replaceAll('-', '').slice(0, 8)}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    try {
      fs.renameSync(tmp, file)
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EBUSY') {
        // Windows 独有：目标文件被杀软/索引器短暂占用导致原子 rename 失败时，
        // 回退为 copyFileSync 写入，消除 Atomics.wait 对 Node 主线程事件循环的同步阻塞
        fs.copyFileSync(tmp, file)
      } else {
        throw e
      }
    }
  } finally {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略清理错误 */ }
  }
}

function loadConvs() {
  if (convs === null) convs = readJson(CONV_FILE, [])
  return convs
}

function loadRuns() {
  if (runs === null) runs = readJson(RUN_FILE, [])
  return runs
}

function loadCases() {
  if (cases === null) cases = readJson(CASE_FILE, [])
  return cases
}

function loadTrainingSessions() {
  if (trainingSessions === null) trainingSessions = readJson(TRAINING_FILE, [])
  return trainingSessions
}

function saveConvs() {
  writeJson(CONV_FILE, convs || [])
}

function saveRuns() {
  writeJson(RUN_FILE, runs || [])
}

function saveCases() {
  writeJson(CASE_FILE, cases || [])
}

function saveTrainingSessions() {
  writeJson(TRAINING_FILE, trainingSessions || [])
}

function assertId(id) {
  const value = String(id || '')
  if (!ID_RE.test(value)) throw new Error('ID 格式无效')
  return value
}

// ── Conversations ────────────────────────────────────────
export function listConversations() {
  return [...loadConvs()].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
}

// 会话列表只承担导航职责；正文在用户打开对应会话时再读取。
// 这样不会让历史消息随每次应用启动全部跨进程传输、解析并转成响应式数据。
export function listConversationSummaries() {
  return listConversations().map(conversation => ({
    id: conversation.id,
    title: conversation.title,
    caseId: conversation.caseId || '',
    messageCount: Array.isArray(conversation.messages) ? conversation.messages.length : 0,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  }))
}

export function getConversation(id) {
  return loadConvs().find(c => c.id === assertId(id)) || null
}

export function createConversation({ id, title = '新对话', caseId = '' } = {}) {
  const now = new Date().toISOString()
  const conv = {
    id: id && ID_RE.test(String(id)) ? String(id) : `conv_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    title: String(title).slice(0, 60) || '新对话',
    caseId: caseId ? assertId(caseId) : '',
    lastContextReads: [],
    lastCitedChats: [],
    messages: [],
    createdAt: now,
    updatedAt: now,
  }
  loadConvs().push(conv)
  saveConvs()
  return conv
}

export function updateConversation(id, patch = {}) {
  const conv = getConversation(id)
  if (!conv) return null
  let caseChanged = false
  if (patch.title !== undefined) conv.title = String(patch.title).slice(0, 60) || conv.title
  if (patch.caseId !== undefined) {
    const nextCaseId = patch.caseId ? assertId(patch.caseId) : ''
    caseChanged = conv.caseId !== nextCaseId
    conv.caseId = nextCaseId
  }
  if (patch.lastContextReads !== undefined) {
    conv.lastContextReads = Array.isArray(patch.lastContextReads)
      ? [...new Set(patch.lastContextReads.map(s => String(s).slice(0, 80)).filter(Boolean))].slice(0, 20)
      : []
  }
  if (patch.lastCitedChats !== undefined) {
    conv.lastCitedChats = Array.isArray(patch.lastCitedChats)
      ? [...new Set(patch.lastCitedChats.map(s => String(s).slice(0, 400)).filter(Boolean))].slice(0, 20)
      : []
  }
  // Context hints belong to the workspace/session that produced them.
  // Never carry stale hints across a conversation workspace switch, even if
  // a caller includes old hint fields in the same patch.
  if (caseChanged) {
    conv.lastContextReads = []
    conv.lastCitedChats = []
  }
  conv.updatedAt = new Date().toISOString()
  saveConvs()
  return conv
}

export function deleteConversation(id) {
  const list = loadConvs()
  const idx = list.findIndex(c => c.id === assertId(id))
  if (idx < 0) return false
  list.splice(idx, 1)
  saveConvs()
  return true
}

export function appendMessage(convId, msg = {}, { replaceMessageId } = {}) {
  const conv = getConversation(convId)
  if (!conv) throw new Error('会话不存在')
  const message = {
    id: `msg_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    role: msg.role === 'assistant' ? 'assistant' : 'user',
    content: typeof msg.content === 'string' ? msg.content : '',
    reasoning: typeof msg.reasoning === 'string' ? msg.reasoning : '',
    runId: msg.runId || null,
    tools: Array.isArray(msg.tools) ? msg.tools.slice(0, 20) : [],
    memoryCandidateIds: Array.isArray(msg.memoryCandidateIds)
      ? [...new Set(msg.memoryCandidateIds.map(String).filter(Boolean))].slice(0, 2)
      : [],
    ...(msg.selectionContext ? { selectionContext: msg.selectionContext } : {}),
    createdAt: new Date().toISOString(),
  }
  if (replaceMessageId) {
    if (conv.messages.at(-1)?.id !== replaceMessageId || conv.messages.at(-1)?.role !== 'assistant') {
      throw new Error('回答已变化，请刷新后重新生成')
    }
    conv.messages.splice(-1, 1, message)
  } else conv.messages.push(message)
  conv.updatedAt = message.createdAt
  saveConvs()
  return message
}

// 前端 localStorage 一次性迁移：批量导入（保留可用的旧 id）
export function importConversations(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list.slice(0, 200)) {
    if (!item || typeof item !== 'object') continue
    const conv = createConversation({ id: item.id, title: item.title })
    for (const m of (Array.isArray(item.messages) ? item.messages : []).slice(0, 500)) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue
      conv.messages.push({
        id: `msg_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        role: m.role,
        content: typeof m.content === 'string' ? m.content : '',
        reasoning: typeof m.reasoning === 'string' ? m.reasoning : '',
        runId: null,
        createdAt: new Date().toISOString(),
      })
    }
    conv.updatedAt = new Date().toISOString()
    out.push(conv)
  }
  if (out.length) saveConvs()
  return out
}

// ── Runs ─────────────────────────────────────────────────
export function createRun({ conversationId, selectedSkillIds = [], evidenceSessionId = '', skillId = '' } = {}) {
  const now = new Date().toISOString()
  const run = {
    id: `run_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    conversationId: String(conversationId || ''),
    state: 'created',
    mode: 'ask',
    selectedSkillIds: Array.isArray(selectedSkillIds) ? selectedSkillIds.map(String) : [],
    skillId: String(skillId || ''),
    evidenceSessionId: String(evidenceSessionId || ''),
    error: null,
    messageId: null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    events: [],
  }
  loadRuns().push(run)
  saveRuns()
  return run
}

export function getRun(id) {
  return loadRuns().find(r => r.id === assertId(id)) || null
}

export function updateRun(id, patch = {}) {
  const run = getRun(id)
  if (!run) return null
  const allowed = ['state', 'mode', 'error', 'messageId', 'startedAt', 'finishedAt']
  for (const key of allowed) {
    if (patch[key] !== undefined) run[key] = patch[key]
  }
  saveRuns()
  return run
}

export function appendRunEvent(id, event) {
  const run = getRun(id)
  if (!run) return null
  run.events.push({ ts: new Date().toISOString(), ...event })
  if (run.events.length > RUN_EVENTS_CAP) run.events.splice(0, run.events.length - RUN_EVENTS_CAP)
  saveRuns()
  return run
}

export function isRunActive(run) {
  return ['created', 'context_build', 'streaming'].includes(run?.state)
}

// ── Training Sessions：独立于普通咨询会话的模拟聊天记录 ────────
// 训练内容是虚构陪练，绝不进入 conversations / memories。
const TRAINING_MESSAGE_ROLES = new Set(['me', 'peer', 'coach'])
const TRAINING_STATES = new Set(['active', 'paused', 'reviewed', 'ended'])
const TRAINING_MESSAGES_CAP = 400
const TRAINING_SNAPSHOT_CAP = 48 * 1024
const TRAINING_ADVISOR_PACKAGE_CAP = 32 * 1024
const TRAINING_INITIATIVE_MESSAGE_CAP = 2
const TRAINING_INITIATIVE_MIN_SECONDS = 3
const TRAINING_INITIATIVE_MAX_SECONDS = 12

function capTrainingText(value, cap = 3000) {
  return String(value || '').trim().slice(0, cap)
}

function sanitizeTrainingScenario(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('训练场景必须是对象')
  const title = capTrainingText(value.title, 80)
  if (!title) throw new Error('训练场景缺少标题')
  return {
    id: capTrainingText(value.id, 80),
    title,
    premise: capTrainingText(value.premise, 800),
    goal: capTrainingText(value.goal, 300),
    opening: capTrainingText(value.opening, 800),
    difficulty: ['轻松', '适中', '挑战'].includes(value.difficulty) ? value.difficulty : '适中',
  }
}

function sanitizeTrainingSnapshot(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('训练快照必须是对象')
  const raw = JSON.stringify(value)
  if (Buffer.byteLength(raw, 'utf8') > TRAINING_SNAPSHOT_CAP) {
    throw new Error('训练快照超过 48KB 上限')
  }
  return structuredClone(value)
}

function sanitizeTrainingAdvisorPackage(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('训练军师资料包必须是对象')
  const raw = JSON.stringify(value)
  if (Buffer.byteLength(raw, 'utf8') > TRAINING_ADVISOR_PACKAGE_CAP) {
    throw new Error('训练军师资料包超过 32KB 上限')
  }
  return structuredClone(value)
}

function sanitizeTrainingMessage(value = {}) {
  const role = String(value.role || '')
  if (!TRAINING_MESSAGE_ROLES.has(role)) throw new Error('训练消息角色无效')
  const content = capTrainingText(value.content)
  if (!content) throw new Error('训练消息不能为空')
  const simulatedMinutes = Number(value.simulatedMinutes)
  const afterSeconds = Number(value.afterSeconds)
  return {
    id: `tmsg_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    role,
    content,
    simulatedMinutes: Number.isFinite(simulatedMinutes) ? Math.max(0, Math.min(1000000, Math.floor(simulatedMinutes))) : undefined,
    afterSeconds: Number.isFinite(afterSeconds) ? Math.max(0, Math.min(120, Math.floor(afterSeconds))) : 0,
    createdAt: new Date().toISOString(),
  }
}

function normalizedInitiativeBudget(value) {
  const budget = Math.floor(Number(value))
  return Number.isFinite(budget) ? Math.max(0, Math.min(2, budget)) : 0
}

// 大多数训练不会额外冒消息；偶尔一次、极少数两次，频率由服务端而非模型控制。
export function createTrainingInitiativeBudget(random = Math.random) {
  const roll = Number(random())
  if (!Number.isFinite(roll)) return 0
  if (roll < 0.08) return 2
  if (roll < 0.28) return 1
  return 0
}

function trainingTimestamp(value, fallback = Date.now()) {
  const timestamp = value instanceof Date ? value.getTime() : Number(value)
  return Number.isFinite(timestamp) ? timestamp : fallback
}

function sanitizePendingInitiative(value = {}, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('待发主动消息必须是对象')
  const messages = (Array.isArray(value.messages) ? value.messages : [])
    .slice(0, TRAINING_INITIATIVE_MESSAGE_CAP)
    .map((message, index) => ({
      content: capTrainingText(message?.content),
      afterSeconds: Math.max(0, Math.min(12, Math.floor(Number(message?.afterSeconds) || (index ? 2 : 0)))),
    }))
    .filter(message => message.content)
  if (!messages.length) throw new Error('待发主动消息不能为空')
  const deliverySeconds = Math.max(
    TRAINING_INITIATIVE_MIN_SECONDS,
    Math.min(TRAINING_INITIATIVE_MAX_SECONDS, Math.floor(Number(value.deliverySeconds) || TRAINING_INITIATIVE_MIN_SECONDS)),
  )
  const simulatedMinutes = Math.max(0, Math.min(1000000, Math.floor(Number(value.simulatedMinutes) || 0)))
  return {
    id: `initiative_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    messages,
    deliverySeconds,
    simulatedMinutes,
    topicSource: capTrainingText(value.topicSource, 80),
    reason: capTrainingText(value.reason, 120),
    dueAt: new Date(now + deliverySeconds * 1000).toISOString(),
    createdAt: new Date(now).toISOString(),
  }
}

function appendSanitizedTrainingMessages(session, input) {
  const messages = input.slice(0, 4).map(sanitizeTrainingMessage)
  for (const message of messages) {
    if (message.simulatedMinutes !== undefined) {
      session.simulatedMinutes = Math.max(session.simulatedMinutes, message.simulatedMinutes)
    }
    message.simulatedMinutes ??= session.simulatedMinutes
    session.messages.push(message)
  }
  if (session.messages.length > TRAINING_MESSAGES_CAP) {
    session.messages.splice(0, session.messages.length - TRAINING_MESSAGES_CAP)
  }
  return messages
}

export function createTrainingSession({ caseId, advisorId = 'default', scenario, snapshot, advisorPackage, initiativeBudget } = {}) {
  const workspace = getCase(caseId)
  if (!workspace) throw new Error('工作区不存在')
  const now = new Date().toISOString()
  const session = {
    id: `training_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    caseId: workspace.id,
    advisorId: capTrainingText(advisorId, 80) || 'default',
    scenario: sanitizeTrainingScenario(scenario),
    snapshot: sanitizeTrainingSnapshot(snapshot),
    advisorPackage: sanitizeTrainingAdvisorPackage(advisorPackage),
    state: 'active',
    simulatedMinutes: 0,
    messages: [],
    initiativeBudget: initiativeBudget === undefined ? createTrainingInitiativeBudget() : normalizedInitiativeBudget(initiativeBudget),
    initiativeUsed: 0,
    pendingInitiative: null,
    privateState: {},
    review: null,
    createdAt: now,
    updatedAt: now,
  }
  loadTrainingSessions().push(session)
  saveTrainingSessions()
  return session
}

export function getTrainingSession(id) {
  return loadTrainingSessions().find(session => session.id === assertId(id)) || null
}

export function listTrainingSessions(caseId = '') {
  const target = caseId ? assertId(caseId) : ''
  return loadTrainingSessions()
    .filter(session => !target || session.caseId === target)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
}

export function appendTrainingMessages(id, input = []) {
  const session = getTrainingSession(id)
  if (!session) throw new Error('训练会话不存在')
  const isPausedCoachNote = session.state === 'paused' && Array.isArray(input) && input.every(message => message?.role === 'coach')
  if (session.state !== 'active' && !isPausedCoachNote) throw new Error('训练未处于进行状态，不能继续发送消息')
  if (!Array.isArray(input) || !input.length) throw new Error('缺少训练消息')
  appendSanitizedTrainingMessages(session, input)
  session.updatedAt = new Date().toISOString()
  saveTrainingSessions()
  return session
}

export function scheduleTrainingInitiative(id, initiative, { now = Date.now() } = {}) {
  const session = getTrainingSession(id)
  if (!session) throw new Error('训练会话不存在')
  if (session.state !== 'active') throw new Error('训练未处于进行状态，不能安排主动消息')
  if (session.pendingInitiative) throw new Error('已有待发主动消息')
  const budget = normalizedInitiativeBudget(session.initiativeBudget)
  const used = normalizedInitiativeBudget(session.initiativeUsed)
  if (used >= budget) throw new Error('主动消息额度已用完')
  session.pendingInitiative = sanitizePendingInitiative(initiative, trainingTimestamp(now))
  session.initiativeBudget = budget
  session.initiativeUsed = used + 1
  session.updatedAt = new Date().toISOString()
  saveTrainingSessions()
  return session
}

export function cancelTrainingInitiative(id) {
  const session = getTrainingSession(id)
  if (!session) throw new Error('训练会话不存在')
  if (!session.pendingInitiative) return session
  session.pendingInitiative = null
  // 只有真正投递的消息才算一次主动发起；用户提前改写了上下文则把额度归还。
  session.initiativeUsed = Math.max(0, normalizedInitiativeBudget(session.initiativeUsed) - 1)
  session.updatedAt = new Date().toISOString()
  saveTrainingSessions()
  return session
}

export function deliverDueTrainingInitiative(id, { now = Date.now() } = {}) {
  const session = getTrainingSession(id)
  if (!session) throw new Error('训练会话不存在')
  const pending = session.pendingInitiative
  const timestamp = trainingTimestamp(now)
  if (session.state !== 'active' || !pending || !pending.dueAt || timestamp < Date.parse(pending.dueAt)) {
    return { session, messages: [] }
  }
  session.pendingInitiative = null
  const messages = appendSanitizedTrainingMessages(session, pending.messages.map(message => ({
    role: 'peer',
    content: message.content,
    afterSeconds: message.afterSeconds,
    simulatedMinutes: pending.simulatedMinutes,
  })))
  session.updatedAt = new Date().toISOString()
  saveTrainingSessions()
  return { session, messages }
}

export function pauseTrainingSession(id, { now = Date.now() } = {}) {
  const session = getTrainingSession(id)
  if (!session) throw new Error('训练会话不存在')
  if (session.state === 'paused') return session
  if (session.state !== 'active') throw new Error('训练未处于进行状态，无法暂停')
  const timestamp = trainingTimestamp(now)
  if (session.pendingInitiative?.dueAt) {
    session.pendingInitiative.remainingMs = Math.max(0, Date.parse(session.pendingInitiative.dueAt) - timestamp)
    delete session.pendingInitiative.dueAt
  }
  session.state = 'paused'
  session.updatedAt = new Date().toISOString()
  saveTrainingSessions()
  return session
}

export function resumeTrainingSession(id, { now = Date.now() } = {}) {
  const session = getTrainingSession(id)
  if (!session) throw new Error('训练会话不存在')
  if (session.state === 'active') return session
  if (session.state !== 'paused') throw new Error('训练未处于暂停状态，无法继续')
  const timestamp = trainingTimestamp(now)
  if (session.pendingInitiative) {
    const remainingMs = Math.max(0, Number(session.pendingInitiative.remainingMs) || 0)
    session.pendingInitiative.dueAt = new Date(timestamp + remainingMs).toISOString()
    delete session.pendingInitiative.remainingMs
  }
  session.state = 'active'
  session.updatedAt = new Date().toISOString()
  saveTrainingSessions()
  return session
}

export function updateTrainingSession(id, patch = {}) {
  const session = getTrainingSession(id)
  if (!session) return null
  if (patch.state !== undefined) {
    if (!TRAINING_STATES.has(patch.state)) throw new Error('训练状态无效')
    session.state = patch.state
  }
  if (patch.review !== undefined) {
    if (!patch.review || typeof patch.review !== 'object' || Array.isArray(patch.review)) throw new Error('训练复盘必须是对象')
    session.review = structuredClone(patch.review)
  }
  if (patch.privateState !== undefined) {
    if (!patch.privateState || typeof patch.privateState !== 'object' || Array.isArray(patch.privateState)) {
      throw new Error('训练私有状态必须是对象')
    }
    session.privateState = structuredClone(patch.privateState)
  }
  session.updatedAt = new Date().toISOString()
  saveTrainingSessions()
  return session
}

// ── Cases：关系工作区 + 长期记忆 ─────────────────────────
// Workspace 锚定一个私聊：她的人格档案 + 我的档案 + 关系叙事 + 信号基线 + 记忆流
// 档案是蒸馏后的结论，记忆是跨 Turn 短结论；两者都通过 read_context 按需加载
const MEM_TYPES = ['episodic', 'semantic', 'risk', 'preference']
const MEM_TOPICS = ['her', 'me', 'relationship', 'risk', 'events', 'general']
const MEM_KINDS = ['fact', 'conclusion']
const MEM_STATUSES = ['active', 'superseded', 'invalid', 'archived']
const MEM_REFS = new Set([
  'meta', 'her', 'me', 'relationship', 'baseline', 'memories',
  'evidence.stats', 'evidence.recent', 'evidence.windows', 'evidence.keywords',
])

function defaultMemoryTopic(type) {
  if (type === 'episodic') return 'events'
  if (type === 'risk') return 'risk'
  if (type === 'preference') return 'her'
  return 'relationship'
}

function memoryTitle(content) {
  const text = String(content || '').replace(/\s+/g, ' ').trim()
  return text.length > 60 ? `${text.slice(0, 59)}…` : text
}

function normalizeStoredMemory(memory) {
  if (!memory || typeof memory !== 'object') return memory
  const type = MEM_TYPES.includes(memory.type) ? memory.type : 'semantic'
  const content = String(memory.content || '')
  return {
    ...memory,
    type,
    topic: MEM_TOPICS.includes(memory.topic) ? memory.topic : defaultMemoryTopic(type),
    kind: MEM_KINDS.includes(memory.kind) ? memory.kind : (type === 'episodic' ? 'fact' : 'conclusion'),
    title: String(memory.title || memoryTitle(content)).slice(0, 80),
    refs: Array.isArray(memory.refs) ? [...new Set(memory.refs.filter(ref => MEM_REFS.has(ref)))].slice(0, 8) : [],
    status: MEM_STATUSES.includes(memory.status) ? memory.status : 'active',
    updatedAt: memory.updatedAt || memory.createdAt || null,
    supersededBy: memory.supersededBy ? String(memory.supersededBy).slice(0, 64) : null,
  }
}

function normalizedMemoryText(content) {
  return String(content || '').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function normalizeSourceMessageIds(value) {
  return Array.isArray(value)
    ? [...new Set(value.map(n => Number(n)).filter(n => Number.isInteger(n) && n > 0))].slice(0, 20)
    : []
}

function sanitizeMemoryCore(input = {}, { contentCap = 2000, rejectOverCap = false } = {}) {
  const type = MEM_TYPES.includes(input.type) ? input.type : 'semantic'
  const topic = input.topic || defaultMemoryTopic(type)
  const kind = input.kind || (type === 'episodic' ? 'fact' : 'conclusion')
  if (!MEM_TOPICS.includes(topic)) throw new Error(`topic 只能是 ${MEM_TOPICS.join('/')}`)
  if (!MEM_KINDS.includes(kind)) throw new Error(`kind 只能是 ${MEM_KINDS.join('/')}`)
  if (!Array.isArray(input.refs || [])) throw new Error('refs 必须是数组')
  if ((input.refs || []).some(ref => !MEM_REFS.has(ref))) throw new Error('refs 含未知 context path')
  const content = String(input.content || '').trim()
  if (!content) throw new Error('记忆内容不能为空')
  if (rejectOverCap && content.length > contentCap) throw new Error(`记忆最多 ${contentCap} 字`)
  const confidence = input.confidence === null || input.confidence === undefined || input.confidence === ''
    ? null
    : Number(input.confidence)
  return {
    type,
    topic,
    kind,
    title: (String(input.title || '').trim() || memoryTitle(content)).slice(0, 80),
    content: content.slice(0, contentCap),
    refs: [...new Set(input.refs || [])].slice(0, 8),
    sourceMessageIds: normalizeSourceMessageIds(input.sourceMessageIds),
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : null,
  }
}

function normalizeStoredCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return candidate
  const type = MEM_TYPES.includes(candidate.type) ? candidate.type : 'semantic'
  const content = String(candidate.content || '')
  const status = ['pending', 'accepted', 'rejected'].includes(candidate.status) ? candidate.status : 'pending'
  return {
    ...candidate,
    type,
    topic: MEM_TOPICS.includes(candidate.topic) ? candidate.topic : defaultMemoryTopic(type),
    kind: MEM_KINDS.includes(candidate.kind) ? candidate.kind : (type === 'episodic' ? 'fact' : 'conclusion'),
    title: String(candidate.title || memoryTitle(content)).slice(0, 80),
    content: content.slice(0, 500),
    refs: Array.isArray(candidate.refs) ? [...new Set(candidate.refs.filter(ref => MEM_REFS.has(ref)))].slice(0, 8) : [],
    sourceMessageIds: normalizeSourceMessageIds(candidate.sourceMessageIds),
    status,
    acceptedMemoryId: candidate.acceptedMemoryId ? String(candidate.acceptedMemoryId).slice(0, 64) : null,
    updatedAt: candidate.updatedAt || candidate.createdAt || null,
    decidedAt: candidate.decidedAt || null,
  }
}

function pickStr(v, cap) {
  return typeof v === 'string' ? v.slice(0, cap) : undefined
}

function pickStrArr(v, cap, itemLen) {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) throw new Error('标签字段必须是字符串数组')
  return v
    .map(s => String(s).trim().slice(0, itemLen))
    .filter(Boolean)
    .slice(0, cap)
}

function defaultHer() {
  return { persona: '', traits: [], likes: [], dislikes: [], commStyle: '', replyStyle: '', callHistory: [] }
}

function defaultMe() {
  return { goal: '', style: '', pitfalls: [] }
}

function defaultRelationship() {
  return { keyEvents: [], openLoops: [], boundaries: [] }
}

function defaultBaseline() {
  return { replyLatencyP50: null, initiationRatio: null, msgFrequency: null, updatedAt: null }
}

function defaultProfileStatus() {
  return {
    status: 'empty',
    ownerName: '',
    peerName: '',
    ownerConfirmed: false,
    generatedAt: null,
    warnings: [],
    draft: null,
  }
}

// 整体替换式更新（UI 每次提交完整子对象），逐字段清洗 + 上限
function sanitizeHer(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('her 必须是对象')
  return {
    persona: pickStr(v.persona, 1000) ?? '',
    traits: pickStrArr(v.traits, 20, 30) ?? [],
    likes: pickStrArr(v.likes, 30, 60) ?? [],
    dislikes: pickStrArr(v.dislikes, 30, 60) ?? [],
    commStyle: pickStr(v.commStyle, 500) ?? '',
    replyStyle: pickStr(v.replyStyle, 700) ?? '',
    callHistory: pickStrArr(v.callHistory, 20, 60) ?? [],
  }
}

function sanitizeMe(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('me 必须是对象')
  return {
    goal: pickStr(v.goal, 500) ?? '',
    style: pickStr(v.style, 500) ?? '',
    pitfalls: pickStrArr(v.pitfalls, 20, 60) ?? [],
  }
}

function sanitizeProfileStatus(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('profileStatus 必须是对象')
  const status = ['empty', 'draft', 'confirmed'].includes(v.status) ? v.status : 'empty'
  return {
    status,
    ownerName: String(v.ownerName || '').slice(0, 80),
    peerName: String(v.peerName || '').slice(0, 80),
    ownerConfirmed: !!v.ownerConfirmed,
    generatedAt: v.generatedAt ? String(v.generatedAt).slice(0, 40) : null,
    warnings: Array.isArray(v.warnings) ? v.warnings.map(s => String(s).slice(0, 200)).slice(0, 12) : [],
    draft: v.draft && typeof v.draft === 'object' ? v.draft : null,
  }
}

export function updateCaseBaseline(id, baseline = {}) {
  const item = getCase(id)
  if (!item) return null
  item.baseline = {
    replyLatencyP50: baseline.replyLatencyP50 ?? item.baseline.replyLatencyP50,
    initiationRatio: baseline.initiationRatio ?? item.baseline.initiationRatio,
    msgFrequency: baseline.msgFrequency ?? item.baseline.msgFrequency,
    updatedAt: new Date().toISOString(),
  }
  touchCase(item)
  saveCases()
  return item
}

function sanitizeRelationship(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('relationship 必须是对象')
  let keyEvents = []
  if (v.keyEvents !== undefined) {
    if (!Array.isArray(v.keyEvents)) throw new Error('keyEvents 必须是数组')
    keyEvents = v.keyEvents
      .filter(e => e && typeof e === 'object')
      .map(e => ({ date: String(e.date || '').slice(0, 20), event: String(e.event || '').slice(0, 200) }))
      .filter(e => e.event)
      .slice(0, 50)
  }
  return {
    keyEvents,
    openLoops: pickStrArr(v.openLoops, 50, 200) ?? [],
    boundaries: pickStrArr(v.boundaries, 50, 200) ?? [],
  }
}

export function listCases() {
  return loadCases().map(normalizeCaseRecord).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
}

function normalizeCaseRecord(item) {
  if (!item) return item
  // 旧数据兼容：补齐工作区档案结构（内存填充，下次保存时落盘）
  if (!item.her) item.her = defaultHer()
  if (!item.me) item.me = defaultMe()
  if (!item.relationship) item.relationship = defaultRelationship()
  if (!item.baseline) item.baseline = defaultBaseline()
  if (!item.profileStatus) item.profileStatus = defaultProfileStatus()
  item.memories = Array.isArray(item.memories) ? item.memories.map(normalizeStoredMemory) : []
  item.memoryCandidates = Array.isArray(item.memoryCandidates)
    ? item.memoryCandidates.map(normalizeStoredCandidate).filter(Boolean)
    : []
  if (Array.isArray(item.sessionIds) && item.sessionIds.length > CASE_SESSIONS_CAP) {
    item.sessionIds = item.sessionIds.slice(0, CASE_SESSIONS_CAP)
  }
  return item
}

export function getCase(id) {
  return normalizeCaseRecord(loadCases().find(c => c.id === assertId(id)) || null)
}

function touchCase(c) {
  c.updatedAt = new Date().toISOString()
}

function normalizeSessionIds(value, { exceptCaseId } = {}) {
  if (!Array.isArray(value)) throw new Error('sessionIds 必须是数组')
  const ids = [...new Set(value.map(s => String(s).slice(0, 200)).filter(Boolean))]
  if (ids.length > CASE_SESSIONS_CAP) throw new Error('工作区只能绑定 1 个一对一私聊')
  if (ids[0]) assertSessionFree(ids[0], exceptCaseId)
  return ids
}

function assertSessionFree(sessionId, exceptCaseId) {
  const taken = loadCases().find(c => c.sessionIds?.includes(sessionId) && c.id !== exceptCaseId)
  if (taken) throw new Error(`该私聊已绑定工作区「${taken.title}」`)
}

export function findCaseBySessionId(sessionId) {
  const id = String(sessionId || '')
  if (!id) return null
  return loadCases().find(c => c.sessionIds?.includes(id)) || null
}

export function createCase({ title = '新工作区', sessionIds = [] } = {}) {
  const normalizedSessionIds = normalizeSessionIds(sessionIds)
  const now = new Date().toISOString()
  const item = {
    id: `case_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    title: String(title).slice(0, 60) || '新工作区',
    stage: '初识',
    riskLevel: 'normal',
    summary: '',
    her: defaultHer(),
    me: defaultMe(),
    relationship: defaultRelationship(),
    baseline: defaultBaseline(),
    profileStatus: defaultProfileStatus(),
    sessionIds: normalizedSessionIds,
    memories: [],
    memoryCandidates: [],
    createdAt: now,
    updatedAt: now,
  }
  loadCases().push(item)
  saveCases()
  return item
}

export function updateCase(id, patch = {}) {
  const item = getCase(id)
  if (!item) return null
  // Validate the complete patch on a copy so rejected requests never leave
  // a partially updated object in memory or on disk.
  const next = structuredClone(item)
  if (patch.title !== undefined) next.title = String(patch.title).slice(0, 60) || next.title
  if (patch.stage !== undefined) {
    if (!CASE_STAGES.includes(patch.stage)) throw new Error(`stage 只能是 ${CASE_STAGES.join('/')}`)
    next.stage = patch.stage
  }
  if (patch.riskLevel !== undefined) {
    if (!CASE_RISKS.includes(patch.riskLevel)) throw new Error(`riskLevel 只能是 ${CASE_RISKS.join('/')}`)
    next.riskLevel = patch.riskLevel
  }
  if (patch.summary !== undefined) next.summary = String(patch.summary).slice(0, 4000)
  if (patch.sessionIds !== undefined) {
    next.sessionIds = normalizeSessionIds(patch.sessionIds, { exceptCaseId: item.id })
  }
  // 工作区档案：整体替换式更新（baseline 只由工具产出回写，API 不开放）
  if (patch.her !== undefined) next.her = sanitizeHer(patch.her)
  if (patch.me !== undefined) next.me = sanitizeMe(patch.me)
  if (patch.relationship !== undefined) next.relationship = sanitizeRelationship(patch.relationship)
  if (patch.profileStatus !== undefined) next.profileStatus = sanitizeProfileStatus(patch.profileStatus)
  touchCase(next)
  Object.assign(item, next)
  saveCases()
  return item
}

export function deleteCase(id) {
  const list = loadCases()
  const caseId = assertId(id)
  const idx = list.findIndex(c => c.id === caseId)
  if (idx < 0) return false
  list.splice(idx, 1)
  saveCases()

  // 普通咨询会话保留，只解除工作区绑定。
  for (const conv of loadConvs()) {
    if (conv.caseId === caseId) conv.caseId = ''
  }
  saveConvs()

  // 训练记录和导入分析只属于该工作区，删除工作区时同步清理。
  const sessions = loadTrainingSessions()
  const remainingSessions = sessions.filter(session => session.caseId !== caseId)
  if (remainingSessions.length !== sessions.length) {
    trainingSessions = remainingSessions
    saveTrainingSessions()
  }
  const jobs = loadImports()
  const remainingJobs = jobs.filter(job => job.caseId !== caseId)
  if (remainingJobs.length !== jobs.length) {
    imports = remainingJobs
    writeJson(IMPORT_FILE, imports)
  }
  return true
}

export function addCaseMemory(id, {
  content, runId = null, type = 'semantic', topic, kind, title = '', refs = [],
  status = 'active', sourceMessageIds = [], confidence = null,
} = {}) {
  const item = getCase(id)
  if (!item) return null
  if (!MEM_TYPES.includes(type)) throw new Error(`type 只能是 ${MEM_TYPES.join('/')}`)
  if (!MEM_STATUSES.includes(status)) throw new Error(`status 只能是 ${MEM_STATUSES.join('/')}`)
  if (item.memories.length >= CASE_MEMORIES_CAP) throw new Error(`最多保留 ${CASE_MEMORIES_CAP} 条记忆`)
  const now = new Date().toISOString()
  const memory = {
    id: `mem_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    ...sanitizeMemoryCore({ content, type, topic, kind, title, refs, sourceMessageIds, confidence }),
    status,
    supersededBy: null,
    runId: runId ? String(runId) : null,
    createdAt: now,
    updatedAt: now,
  }
  item.memories.push(memory)
  touchCase(item)
  saveCases()
  return memory
}

function findMemoryCandidate(item, candidateId) {
  return item.memoryCandidates.find(candidate => candidate.id === assertId(candidateId)) || null
}

function hasMemoryDuplicate(item, content, { exceptCandidateId = '' } = {}) {
  const key = normalizedMemoryText(content)
  if (!key) return false
  return item.memories.some(memory => normalizedMemoryText(memory.content) === key)
    || item.memoryCandidates.some(candidate => candidate.id !== exceptCandidateId
      && candidate.status === 'pending' && normalizedMemoryText(candidate.content) === key)
}

export function addCaseMemoryCandidates(id, proposals = [], { runId = '' } = {}) {
  const item = getCase(id)
  if (!item) return null
  if (!Array.isArray(proposals)) throw new Error('候选记忆必须是数组')
  if (proposals.length > 2) throw new Error('每个 Run 最多提出 2 条候选记忆')
  const added = []
  for (const proposal of proposals) {
    const core = sanitizeMemoryCore(proposal, { contentCap: 500, rejectOverCap: true })
    if (hasMemoryDuplicate(item, core.content)) continue
    const pendingCount = item.memoryCandidates.filter(candidate => candidate.status === 'pending').length
    if (pendingCount >= CASE_PENDING_CANDIDATES_CAP) throw new Error(`最多保留 ${CASE_PENDING_CANDIDATES_CAP} 条待确认记忆`)
    if (item.memoryCandidates.length >= CASE_MEMORY_CANDIDATES_CAP) {
      const decidedIndex = item.memoryCandidates.findIndex(candidate => candidate.status !== 'pending')
      if (decidedIndex < 0) throw new Error('候选记忆已满，请先处理待确认项')
      item.memoryCandidates.splice(decidedIndex, 1)
    }
    const now = new Date().toISOString()
    const candidate = {
      id: `cand_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      ...core,
      runId: runId ? String(runId) : (proposal.runId ? String(proposal.runId) : null),
      status: 'pending',
      acceptedMemoryId: null,
      createdAt: now,
      updatedAt: now,
      decidedAt: null,
    }
    item.memoryCandidates.push(candidate)
    added.push(candidate)
  }
  if (added.length) {
    touchCase(item)
    saveCases()
  }
  return added
}

export function updateCaseMemoryCandidate(id, candidateId, patch = {}) {
  const item = getCase(id)
  if (!item) return null
  const candidate = findMemoryCandidate(item, candidateId)
  if (!candidate) return null
  if (candidate.status !== 'pending') throw new Error('只能修改待确认记忆')
  const core = sanitizeMemoryCore({ ...candidate, ...patch }, { contentCap: 500, rejectOverCap: true })
  if (hasMemoryDuplicate(item, core.content, { exceptCandidateId: candidate.id })) throw new Error('已有相同记忆')
  Object.assign(candidate, core, { updatedAt: new Date().toISOString() })
  touchCase(item)
  saveCases()
  return candidate
}

export function acceptCaseMemoryCandidate(id, candidateId, patch = {}) {
  const item = getCase(id)
  if (!item) return null
  const candidate = findMemoryCandidate(item, candidateId)
  if (!candidate) return null
  if (candidate.status === 'rejected') throw new Error('该候选已忽略')
  if (candidate.status === 'accepted') {
    return { candidate, memory: item.memories.find(memory => memory.id === candidate.acceptedMemoryId) || null }
  }

  const core = sanitizeMemoryCore({ ...candidate, ...patch }, { contentCap: 500, rejectOverCap: true })
  const existing = item.memories.find(memory => normalizedMemoryText(memory.content) === normalizedMemoryText(core.content))
  let memory = existing
  if (!memory) {
    if (item.memories.length >= CASE_MEMORIES_CAP) throw new Error(`最多保留 ${CASE_MEMORIES_CAP} 条记忆`)
    const now = new Date().toISOString()
    memory = {
      id: `mem_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      ...core,
      status: 'active',
      supersededBy: null,
      runId: candidate.runId || null,
      createdAt: now,
      updatedAt: now,
    }
    item.memories.push(memory)
  }
  const decidedAt = new Date().toISOString()
  Object.assign(candidate, core, {
    status: 'accepted',
    acceptedMemoryId: memory.id,
    updatedAt: decidedAt,
    decidedAt,
  })
  touchCase(item)
  saveCases()
  return { candidate, memory }
}

export function rejectCaseMemoryCandidate(id, candidateId) {
  const item = getCase(id)
  if (!item) return null
  const candidate = findMemoryCandidate(item, candidateId)
  if (!candidate) return null
  if (candidate.status === 'accepted') throw new Error('该候选已记住')
  if (candidate.status === 'rejected') return candidate
  const decidedAt = new Date().toISOString()
  Object.assign(candidate, { status: 'rejected', updatedAt: decidedAt, decidedAt })
  touchCase(item)
  saveCases()
  return candidate
}

export function deleteCaseMemory(id, memoryId) {
  const item = getCase(id)
  if (!item) return false
  const idx = item.memories.findIndex(m => m.id === assertId(memoryId))
  if (idx < 0) return false
  item.memories.splice(idx, 1)
  touchCase(item)
  saveCases()
  return true
}

// 清掉某次导入分析写入的记忆（runId 以 tagPrefix 开头），重新分析前调用
export function removeCaseMemoriesByRunTag(id, tagPrefix) {
  const item = getCase(id)
  if (!item) return null
  const before = item.memories.length
  item.memories = item.memories.filter(m => !String(m.runId || '').startsWith(tagPrefix))
  if (item.memories.length !== before) {
    touchCase(item)
    saveCases()
  }
  return item
}

// ── Import Jobs（工作区导入分析：后台 Job + 断点 checkpoint）──
const IMPORT_FILE = path.join(DATA_DIR, 'imports.json')
let imports = null

function loadImports() {
  if (imports === null) imports = readJson(IMPORT_FILE, [])
  return imports
}

export function listImportJobs() {
  return [...loadImports()].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
}

export function getImportJob(id) {
  return loadImports().find(j => j.id === assertId(id)) || null
}

export function upsertImportJob(job) {
  const list = loadImports()
  job.updatedAt = new Date().toISOString()
  const idx = list.findIndex(j => j.id === job.id)
  if (idx >= 0) list[idx] = job
  else list.push(job)
  if (list.length > 50) list.splice(0, list.length - 50)
  writeJson(IMPORT_FILE, list)
  return job
}

export function latestImportJobByCase(caseId, { excludeId } = {}) {
  return loadImports()
    .filter(j => j.caseId === caseId && j.id !== excludeId)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0] || null
}

export function findRunningImportJob(caseId) {
  return loadImports().find(j => j.caseId === caseId && ['queued', 'analyzing'].includes(j.state)) || null
}

// ── Builder Jobs（军师构建工作流：后台 Job + 草稿缓存）─────────
const BUILDER_JOB_FILE = path.join(DATA_DIR, 'builder_jobs.json')
let builderJobs = null

function loadBuilderJobs() {
  if (builderJobs === null) builderJobs = readJson(BUILDER_JOB_FILE, [])
  return builderJobs
}

export function listBuilderJobs() {
  return [...loadBuilderJobs()].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
}

export function getBuilderJob(id) {
  return loadBuilderJobs().find(j => j.id === assertId(id)) || null
}

export function upsertBuilderJob(job) {
  const list = loadBuilderJobs()
  job.updatedAt = new Date().toISOString()
  const idx = list.findIndex(j => j.id === job.id)
  if (idx >= 0) list[idx] = job
  else list.push(job)
  if (list.length > 50) list.splice(0, list.length - 50)
  writeJson(BUILDER_JOB_FILE, list)
  return job
}

export function deleteBuilderJob(id) {
  const list = loadBuilderJobs()
  const idx = list.findIndex(j => j.id === assertId(id))
  if (idx < 0) return false
  list.splice(idx, 1)
  writeJson(BUILDER_JOB_FILE, list)
  return true
}

export { writeJson as _writeJsonForTest }
