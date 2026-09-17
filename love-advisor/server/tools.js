// ── Tool Registry：模型可调用的本地工具（第三步预注册） ──
// 8 个工具基于 clb 白名单命令薄封装（schemas 参考 clb manifest），
// handler 全部只读；sensitive 级返回原文片段，结果统一截断 ≤8KB。
// 权限审批与 agent loop 接线在后续小步完成，本模块只负责定义/校验/执行。
import { clb, extractJson } from './qce.js'
import { validateSessionId } from './chatlab.js'
import { assertPrivateChat, isGroupChat } from './chatgate.js'
import { CONTEXT_TOOL_DEFS, toolResultCacheKey } from './context.js'
import { TOOL_ERROR_CODES, toolError } from './tool-errors.js'

const MAX_RESULT_BYTES = 8 * 1024
const CHAT_CACHE_TOOLS = new Set(['search_messages', 'browse_messages', 'get_message_context'])
const CHAT_SESSION_TOOLS = new Set([
  'get_session_overview',
  'get_chat_stats',
  'search_messages',
  'browse_messages',
  'get_message_context',
  'list_topics',
  'query_sql',
])

export function isChatSessionTool(id) {
  return CHAT_SESSION_TOOLS.has(id)
}

function scopeChatToolInput(id, input, sessionScope) {
  if (!sessionScope?.enforced) return input
  if (id === 'list_chat_sessions') {
    throw toolError(TOOL_ERROR_CODES.PERMISSION_DENIED, '咨询 Run 不能枚举其他聊天会话')
  }
  if (!CHAT_SESSION_TOOLS.has(id)) return input

  const allowedSessionId = String(sessionScope.sessionId || '').trim()
  if (!allowedSessionId) throw toolError(TOOL_ERROR_CODES.PRECONDITION_FAILED, '当前 Run 未绑定私聊，不能调用聊天工具')
  validateSessionId(allowedSessionId)

  const requestedSessionId = String(input?.sessionId || '').trim()
  if (requestedSessionId && requestedSessionId !== allowedSessionId) {
    throw toolError(TOOL_ERROR_CODES.PERMISSION_DENIED, '聊天工具只能访问当前工作区绑定的私聊')
  }
  return { ...input, sessionId: allowedSessionId }
}

async function clbJson(args, options = {}) {
  const j = extractJson(await clb(args, options))
  if (!j.ok) {
    throw toolError(TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED, j.error?.message || `clb ${args.join(' ')} 失败`)
  }
  return j.meta ? { ...j.data, meta: j.meta } : j.data
}

// ── 参数校验辅助 ────────────────────────────────────────
function needString(input, key, label = key) {
  const v = input?.[key]
  if (typeof v !== 'string' || !v.trim()) {
    throw toolError(TOOL_ERROR_CODES.INVALID_ARGUMENT, `缺少参数 ${label}`)
  }
  return v.trim()
}

function optInt(input, key, { min, max, def }) {
  const v = input?.[key]
  if (v === undefined || v === null || v === '') return def
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw toolError(TOOL_ERROR_CODES.INVALID_ARGUMENT, `参数 ${key} 需为 ${min}~${max} 的整数`)
  }
  return n
}

function optEnum(input, key, values, def) {
  const v = input?.[key]
  if (v === undefined || v === null || v === '') return def
  if (!values.includes(v)) {
    throw toolError(TOOL_ERROR_CODES.INVALID_ARGUMENT, `参数 ${key} 只能是 ${values.join('/')}`)
  }
  return v
}

// 相对时间窗：'7d' / '24h' / '2w'
function optWindow(input, key = 'last', def = '30d') {
  const v = input?.[key]
  if (v === undefined || v === null || v === '') return def
  if (!/^\d{1,4}(h|d|w)$/.test(v)) {
    throw toolError(TOOL_ERROR_CODES.INVALID_ARGUMENT, `参数 ${key} 需形如 <N>h|d|w，如 7d`)
  }
  return v
}

function session(input) {
  try {
    return validateSessionId(needString(input, 'sessionId', 'sessionId'))
  } catch (error) {
    if (error?.code) throw error
    throw toolError(TOOL_ERROR_CODES.INVALID_ARGUMENT, error.message, { cause: error })
  }
}

// ── 结果截断：超 8KB 时从数组尾部裁剪 ───────────────────
export function truncateResult(data, maxBytes = MAX_RESULT_BYTES) {
  const raw = JSON.stringify(data) ?? 'null'
  if (Buffer.byteLength(raw) <= maxBytes) return { result: data, truncated: false }
  const clone = structuredClone(data)
  for (const key of ['items', 'rows', 'messages', 'hits']) {
    if (!Array.isArray(clone?.[key])) continue
    while (clone[key].length > 1 && Buffer.byteLength(JSON.stringify(clone)) > maxBytes) {
      clone[key].length = Math.floor(clone[key].length / 2)
    }
    clone[key + '_total'] = data[key].length
  }
  if (Buffer.byteLength(JSON.stringify(clone) ?? 'null', 'utf8') <= maxBytes) {
    return { result: clone, truncated: true }
  }

  // A tool may return one oversized scalar instead of an array. Return a
  // bounded, valid object rather than leaking an unbounded result downstream.
  const marker = '...(truncated)'
  let preview = Buffer.from(raw, 'utf8').subarray(0, Math.max(0, maxBytes - 128)).toString('utf8')
  let bounded = { truncated: true, preview: `${preview}${marker}` }
  while (Buffer.byteLength(JSON.stringify(bounded), 'utf8') > maxBytes && preview.length > 0) {
    preview = preview.slice(0, Math.floor(preview.length * 0.8))
    bounded = { truncated: true, preview: `${preview}${marker}` }
  }
  return { result: bounded, truncated: true }
}

function stripSqlLiteralsAndComments(sql) {
  let out = ''
  let quote = ''
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    const n = sql[i + 1]
    if (quote) {
      if (c === quote && n === quote) { out += '  '; i++; continue }
      if (c === quote) quote = ''
      out += ' '
      continue
    }
    if ((c === '-' && n === '-') || (c === '/' && n === '*')) {
      const end = c === '-' ? '\n' : '*/'
      out += '  '
      i++
      while (i + 1 < sql.length && (end === '\n' ? sql[i] !== '\n' : `${sql[i]}${sql[i + 1]}` !== end)) {
        out += ' '
        i++
      }
      if (end === '*/' && i + 1 < sql.length) { out += '  '; i++ }
      continue
    }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      quote = c === '[' ? ']' : c
      out += ' '
      continue
    }
    out += c
  }
  return out
}

function assertReadOnlySql(query) {
  const normalized = stripSqlLiteralsAndComments(query)
  if (!/^(select|with)\b/i.test(normalized.trim())) {
    throw toolError(TOOL_ERROR_CODES.INVALID_ARGUMENT, '只允许 SELECT/WITH 查询')
  }
  if (/\b(insert|update|delete|drop|alter|create|attach|detach|reindex|vacuum|pragma|replace)\b/i.test(normalized)) {
    throw toolError(TOOL_ERROR_CODES.INVALID_ARGUMENT, '只允许只读 SELECT/WITH 查询')
  }
}

// ── 时间参数拼装（--last 与 since/until 互斥，last 优先）──
function timeArgs(input) {
  const last = optWindow(input)
  if (input?.since || input?.until) {
    if (input.last) throw toolError(TOOL_ERROR_CODES.INVALID_ARGUMENT, 'last 与 since/until 不能同时使用')
    const args = []
    if (input.since) args.push('--since', String(input.since))
    if (input.until) args.push('--until', String(input.until))
    return args
  }
  return ['--last', last]
}

// ── 工具定义 ───────────────────────────────────────────
export const TOOL_DEFS = [
  {
    id: 'list_chat_sessions',
    description: '列出本地已导入的聊天会话（id/名称/平台/消息数）。开始分析前先用它发现可用的 sessionId。',
    riskLevel: 'read',
    inputSchema: { type: 'object', properties: {} },
    async handler(_input, { signal } = {}) {
      const data = await clbJson(['sessions', 'list', '--format', 'json'], { signal })
      return { items: (data.items || []).filter(s => !isGroupChat(s)) }
    },
  },
  {
    id: 'get_session_overview',
    description: '会话总览：消息总量、时间范围、活跃成员排名。用于快速了解一个会话的基本盘。',
    riskLevel: 'read',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: '会话 id' } },
      required: ['sessionId'],
    },
    async handler(input, { signal } = {}) {
      const sid = session(input)
      const sessions = await clbJson(['sessions', 'list', '--format', 'json'], { signal })
      const current = (sessions.items || []).find(x => x.id === sid)
      if (current) assertPrivateChat(current)
      const [overview, members] = await Promise.all([
        clbJson(['stats', 'overview', '--session', sid, '--format', 'json'], { signal }),
        clbJson(['members', 'list', '--session', sid, '--limit', '10', '--format', 'json'], { signal }),
      ])
      return { overview, topMembers: members.items || [] }
    },
  },
  {
    id: 'get_chat_stats',
    description: '会话统计。metric=activity 成员活跃排名；time 消息时段分布(by=hour|weekday|day|month)；keywords 高频词；response 回复速度中位数。支持 last 相对窗口（如 7d）。',
    riskLevel: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 id' },
        metric: { type: 'string', enum: ['activity', 'time', 'keywords', 'response'] },
        last: { type: 'string', description: '相对窗口，如 7d/24h/2w，默认 30d' },
        by: { type: 'string', enum: ['hour', 'weekday', 'day', 'month'], description: '仅 metric=time' },
        top: { type: 'integer', minimum: 1, maximum: 100, description: 'Top N，默认 10' },
      },
      required: ['sessionId', 'metric'],
    },
    async handler(input, { signal } = {}) {
      const sid = session(input)
      const metric = optEnum(input, 'metric', ['activity', 'time', 'keywords', 'response'])
      const args = ['stats', metric, '--session', sid, '--format', 'json']
      if (metric !== 'overview') args.push(...timeArgs(input))
      if (input.by) args.push('--by', optEnum(input, 'by', ['hour', 'weekday', 'day', 'month']))
      const top = optInt(input, 'top', { min: 1, max: 100, def: 10 })
      if (metric === 'activity' || metric === 'keywords' || metric === 'response') args.push('--top', top)
      return clbJson(args, { signal })
    },
  },
  {
    id: 'search_messages',
    description: '按关键词搜索聊天原文（含脱敏后的消息内容）。可加 context=前后条数还原语境。适合查「她提过几次约会」这类问题。',
    riskLevel: 'sensitive',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        keywords: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8, description: '关键词列表' },
        match: { type: 'string', enum: ['any', 'all'], description: 'any=任一命中(默认) all=全部命中' },
        last: { type: 'string', description: '相对窗口，如 7d' },
        since: { type: 'string', description: '开始日期 YYYY-MM-DD（与 last 二选一）' },
        until: { type: 'string', description: '结束日期 YYYY-MM-DD' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '返回条数，默认 20' },
        context: { type: 'integer', minimum: 0, maximum: 10, description: '每条命中前后各取几条' },
        sort: { type: 'string', enum: ['asc', 'desc'], description: 'asc 可查谁先说的' },
      },
      required: ['sessionId', 'keywords'],
    },
    async handler(input, { signal } = {}) {
      const sid = session(input)
      const kws = input.keywords
      if (!Array.isArray(kws) || !kws.length || kws.some(k => typeof k !== 'string' || !k.trim())) {
        throw toolError(TOOL_ERROR_CODES.INVALID_ARGUMENT, 'keywords 必须是非空字符串数组')
      }
      const args = ['messages', 'search',
        '--session', sid,
        '--match', optEnum(input, 'match', ['any', 'all'], 'any'),
        '--sort', optEnum(input, 'sort', ['asc', 'desc'], 'desc'),
        '--limit', optInt(input, 'limit', { min: 1, max: 50, def: 20 }),
        '--context', optInt(input, 'context', { min: 0, max: 10, def: 0 }),
        '--format', 'json',
        ...timeArgs(input),
        '--',
        ...kws.map(k => k.trim())]
      return clbJson(args, { signal })
    },
  },
  {
    id: 'browse_messages',
    description: '按时间窗浏览聊天记录（分页）。noContent=true 时只返回 id/发送者/时间不返回内容，用于先摸清分布再精准取原文。',
    riskLevel: 'sensitive',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        last: { type: 'string', description: '相对窗口，默认 7d' },
        since: { type: 'string' }, until: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: '每页条数，默认 50' },
        noContent: { type: 'boolean', description: '只看结构不看内容，默认 false' },
        cursor: { type: 'string', description: '上一次返回的 meta.nextCursor' },
      },
      required: ['sessionId'],
    },
    async handler(input, { signal } = {}) {
      const sid = session(input)
      const args = ['messages', 'list', '--session', sid,
        '--limit', optInt(input, 'limit', { min: 1, max: 200, def: 50 }),
        '--format', 'json',
        ...timeArgs(input)]
      if (input.cursor) args.push('--cursor', String(input.cursor))
      if (input.noContent) args.push('--no-content')
      return clbJson(args, { signal })
    },
  },
  {
    id: 'get_message_context',
    description: '按消息 id 展开前后文（配合 search_messages / browse_messages 返回的 #id 使用），还原一段对话的完整语境。',
    riskLevel: 'sensitive',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        ids: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 5, description: '消息 id 列表' },
        window: { type: 'integer', minimum: 1, maximum: 50, description: '前后各取几条，默认 10' },
      },
      required: ['sessionId', 'ids'],
    },
    async handler(input, { signal } = {}) {
      const sid = session(input)
      const ids = input.ids
      if (!Array.isArray(ids) || !ids.length || ids.some(n => !Number.isInteger(n))) {
        throw toolError(TOOL_ERROR_CODES.INVALID_ARGUMENT, 'ids 必须是整数数组')
      }
      const args = ['messages', 'context', '--id', ids.join(','),
        '--session', sid,
        '--window', optInt(input, 'window', { min: 1, max: 50, def: 10 }),
        '--format', 'json']
      return clbJson(args, { signal })
    },
  },
  {
    id: 'list_topics',
    description: '列出 AI 生成的对话段落摘要（已脱敏），快速了解「这段时间聊了什么话题」。需要段内原文时再用 browse_messages 取。',
    riskLevel: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        last: { type: 'string', description: '相对窗口' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '默认 20' },
        query: { type: 'string', description: '按摘要关键词过滤' },
      },
      required: ['sessionId'],
    },
    async handler(input, { signal } = {}) {
      const sid = session(input)
      const args = ['topics', 'list', '--session', sid,
        '--limit', optInt(input, 'limit', { min: 1, max: 100, def: 20 }),
        '--format', 'json']
      if (input.query) args.push('--query', String(input.query))
      if (input.last) args.push('--last', optWindow(input))
      return clbJson(args, { signal })
    },
  },
  {
    id: 'query_sql',
    description: '只读 SQL 兜底（SELECT/WITH，自动脱敏，禁止访问原始 content 列）。前面 7 个工具都覆盖不了的复杂统计用它。先用 query_sql 配 schema 提示自查表结构。',
    riskLevel: 'sensitive',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        query: { type: 'string', description: 'SELECT/WITH 语句' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: '最大行数，默认 100' },
      },
      required: ['sessionId', 'query'],
    },
    async handler(input, { signal } = {}) {
      const sid = session(input)
      const q = needString(input, 'query').replace(/;\s*$/, '')
      assertReadOnlySql(q)
      if (q.includes(';')) throw toolError(TOOL_ERROR_CODES.INVALID_ARGUMENT, '只允许单条语句')
      return clbJson(['sql', q, '--session', sid,
        '--limit', optInt(input, 'limit', { min: 1, max: 1000, def: 100 }),
        '--format', 'json'], { signal })
    },
  },
]

function contextTools() {
  return CONTEXT_TOOL_DEFS.map(def => ({
    ...def,
    async handler() {
      throw toolError(TOOL_ERROR_CODES.PERMISSION_DENIED, `${def.id} 只能在咨询 Run 内调用`)
    },
  }))
}

function skillTools(skillRuntime) {
  if (!skillRuntime) return []
  return [
    {
      id: 'read_skill_doc',
      description: '读取当前军师的一份主题文档（references/ 下的手册）。先对照 SKILL.md 路由表选 1～2 个最相关路径再读。未读过的文件不在上下文中，禁止装读过。',
      riskLevel: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对军师目录的文档路径，如 references/playbooks/communication.md' },
          skillId: { type: 'string', description: '军师 id；省略则读默认军师' },
        },
        required: ['path'],
      },
      async handler(input) {
        const rel = needString(input, 'path')
        let skillId = typeof input.skillId === 'string' ? input.skillId.trim() : ''
        if (!skillId) {
          const listed = skillRuntime.list()
          skillId = listed.find(s => s.default)?.id || listed[0]?.id || ''
        }
        if (!skillId) throw toolError(TOOL_ERROR_CODES.TOOL_UNAVAILABLE, '没有可用的军师')
        const doc = skillRuntime.readDocFor(skillId, rel)
        if (!doc.ok) throw toolError(TOOL_ERROR_CODES.INVALID_ARGUMENT, doc.error)
        return { path: doc.path, truncated: doc.truncated, content: doc.content }
      },
    },
  ]
}

export function createToolRegistry({ skillRuntime } = {}) {
  const defs = [...TOOL_DEFS, ...contextTools(), ...skillTools(skillRuntime)]
  const byId = new Map(defs.map(t => [t.id, t]))

  return {
    // OpenAI tools 参数 + /api/tools 数据源
    list() {
      return defs.map(({ id, description, riskLevel, inputSchema }) => ({
        type: 'function',
        function: { name: id, description, parameters: inputSchema, riskLevel },
      }))
    },

    async execute(id, input = {}, extras = {}) {
      const scopedInput = scopeChatToolInput(id, input, extras.sessionScope)
      if ((id === 'read_context' || id === 'propose_memory') && extras.contextSession) {
        const result = await extras.contextSession.execute(id, scopedInput)
        return { tool: id, riskLevel: byId.get(id)?.riskLevel || 'read', truncated: !!result.truncated, result }
      }
      const tool = byId.get(id)
      if (!tool) throw toolError(TOOL_ERROR_CODES.UNKNOWN_TOOL, `未知工具: ${id}`)
      if (CHAT_CACHE_TOOLS.has(id) && extras.contextSession) {
        const cacheKey = extras.contextSession.toolCacheKey?.(id, scopedInput) || toolResultCacheKey(id, scopedInput)
        const hit = extras.contextSession.lookupTool?.(cacheKey)
        if (hit) return { tool: id, riskLevel: tool.riskLevel, truncated: false, result: hit }
        const data = await tool.handler(scopedInput, { signal: extras.signal })
        const { result, truncated } = truncateResult(data, MAX_RESULT_BYTES)
        extras.contextSession.rememberTool?.(cacheKey, result)
        return { tool: id, riskLevel: tool.riskLevel, truncated, result }
      }
      const data = await tool.handler(scopedInput, { signal: extras.signal })
      const cap = id === 'read_skill_doc' ? 48 * 1024 : MAX_RESULT_BYTES
      const { result, truncated } = truncateResult(data, cap)
      return { tool: id, riskLevel: tool.riskLevel, truncated, result }
    },
  }
}
