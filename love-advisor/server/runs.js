// ── Run Runtime：一次 AI 响应 = 一个 Run ─────────────────
// 状态机：created → context_build → streaming → completed | failed | cancelled
// SSE 事件流：run.created / run.state / message.delta / run.completed / run.failed / run.cancelled
import { streamChatCompletion } from './llm.js'
import { isChatSessionTool, truncateResult } from './tools.js'
import { validateSelection } from './selection.js'
import {
  createRun, getRun, updateRun, appendRunEvent, appendMessage, isRunActive,
  listConversations, listConversationSummaries, getConversation, createConversation, updateConversation,
  deleteConversation, importConversations, getCase, addCaseMemoryCandidates,
} from './store.js'
import { createContextSession, buildMemoryIndex, buildRuntimeCard, MAX_CONTEXT_BYTES } from './context.js'
import { TOOL_ERROR_CODES, normalizeToolError, toolError } from './tool-errors.js'

// 活跃 Run 的 AbortController 注册表（取消用）
const controllers = new Map()

function sseWrite(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
  if (typeof res.flush === 'function') res.flush()
}

function setState(res, run, state) {
  updateRun(run.id, {
    state,
    ...(state === 'context_build' && !run.startedAt ? { startedAt: new Date().toISOString() } : {}),
  })
  appendRunEvent(run.id, { type: 'run.state', state })
  if (!res.writableEnded) sseWrite(res, { type: 'run.state', runId: run.id, state })
}

// ── 工作区常驻块（L3a）：会话绑定工作区时注入 ───────────
// 五块结构：她 / 我 / 关系现状 / 信号基线 / 记忆流，总量限制防撑爆上下文
export function buildCaseBlock(c) {
  const RISK_LABELS = { normal: '普通', high: '高风险', safety: '安全优先' }
  const list = (arr, fmt = s => s) => (arr?.length ? arr.map(fmt).join('、') : '')
  const lines = [
    '# 关系工作区（长期上下文，跨会话持续有效）',
    `工作区：${c.title}`,
    `关系阶段：${c.stage}；风险等级：${RISK_LABELS[c.riskLevel] || c.riskLevel}`,
    c.riskLevel !== 'normal' ? '注意：该工作区已标记风险，安全层规则优先级进一步提高。' : '',

    c.her && (c.her.persona || c.her.traits.length || c.her.likes.length || c.her.dislikes.length || c.her.commStyle) ? [
      '## 她是谁',
      c.her.persona ? `人格概括：${c.her.persona}` : '',
      list(c.her.traits) ? `特质：${list(c.her.traits)}` : '',
      list(c.her.likes) ? `兴趣偏好：${list(c.her.likes)}` : '',
      list(c.her.dislikes) ? `雷区忌讳（严禁触犯）：${list(c.her.dislikes)}` : '',
      c.her.commStyle ? `沟通风格：${c.her.commStyle}` : '',
    ].filter(Boolean).join('\n') : '',

    c.me && (c.me.goal || c.me.style || c.me.pitfalls.length) ? [
      '## 我是谁',
      c.me.goal ? `我的目标：${c.me.goal}` : '',
      c.me.style ? `表达习惯：${c.me.style}` : '',
      list(c.me.pitfalls) ? `我常犯的错（要提醒我规避）：${list(c.me.pitfalls)}` : '',
    ].filter(Boolean).join('\n') : '',

    c.summary || c.relationship?.keyEvents?.length || c.relationship?.openLoops?.length || c.relationship?.boundaries?.length ? [
      '## 关系现状',
      c.summary ? `背景摘要：\n${c.summary}` : '',
      c.relationship?.keyEvents?.length ? `关键事件：\n${c.relationship.keyEvents.slice(-10).map(e => `- [${e.date || '未标注'}] ${e.event}`).join('\n')}` : '',
      c.relationship?.openLoops?.length ? `未完结事项：${c.relationship.openLoops.join('；')}` : '',
      c.relationship?.boundaries?.length ? `已确认的边界与承诺：${c.relationship.boundaries.join('；')}` : '',
    ].filter(Boolean).join('\n') : '',

    c.profileStatus?.ownerName || c.profileStatus?.peerName ? [
      '## 身份',
      c.profileStatus.ownerName ? `我（机主）：${c.profileStatus.ownerName}${c.profileStatus.ownerConfirmed ? '（已确认）' : '（待确认）'}` : '',
      c.profileStatus.peerName ? `对方：${c.profileStatus.peerName}` : '',
      c.profileStatus.status === 'draft' ? '档案仍是待确认草稿，解释性描述不要当成已核实事实。' : '',
    ].filter(Boolean).join('\n') : '',
    c.baseline?.updatedAt ? [
      '## 信号基线（工具自动统计）',
      `回复延迟中位数 ${c.baseline.replyLatencyP50 ?? '未知'}；主动发起比 ${(typeof c.baseline.initiationRatio === 'number' && Number.isFinite(c.baseline.initiationRatio)) ? `${Math.round(c.baseline.initiationRatio * 100)}%` : '未知'}；消息频率 ${c.baseline.msgFrequency ?? '未知'}`,
    ].join('\n') : '',

    c.memories.length ? [
      '## 相关记忆（旧→新）',
      ...c.memories.map(m => `- [${m.createdAt.slice(0, 10)}${m.type ? '/' + m.type : ''}] ${m.content}`),
    ].join('\n') : '',
  ].filter(Boolean)

  const block = lines.join('\n')
  // 按字节截断（中文一字 3 字节，不能用字符串 slice）
  const buf = Buffer.from(block, 'utf8')
  return buf.byteLength > 12 * 1024
    ? buf.subarray(0, 12 * 1024).toString('utf8') + '\n…（工作区上下文超限已截断）'
    : block
}

// ── 路由注册 ─────────────────────────────────────────────
// deps 注入：assembleSkills / buildEvidencePack / buildUpstreamMessages / getEnv
//            toolRegistry（模型可调用工具）/ streamChat（可注入 mock 做测试）
const MAX_TOOL_ROUNDS = 12
const TOOL_RESULT_CAP = 8 * 1024
const DEFAULT_TOOL_TIMEOUT_MS = 30_000
// Leave a small envelope margin for the tool message itself so the payload
// sent to the model stays below the context runtime's 32KB budget end-to-end.
const READ_CONTEXT_PAYLOAD_CAP = MAX_CONTEXT_BYTES - 1024

function capToolPayload(value, maxBytes = TOOL_RESULT_CAP) {
  const raw = JSON.stringify(value) ?? 'null'
  if (Buffer.byteLength(raw, 'utf8') <= maxBytes) return raw

  // Keep the tool message valid JSON even when a mock/custom tool ignores its cap.
  const marker = '...(truncated)'
  let preview = Buffer.from(raw, 'utf8').subarray(0, Math.max(0, maxBytes - 128)).toString('utf8')
  let result = JSON.stringify({ truncated: true, preview: `${preview}${marker}` })
  while (Buffer.byteLength(result, 'utf8') > maxBytes && preview.length > 0) {
    preview = preview.slice(0, Math.floor(preview.length * 0.8))
    result = JSON.stringify({ truncated: true, preview: `${preview}${marker}` })
  }
  return result
}

function resolveToolTimeoutMs(env) {
  const configured = Number(env?.TOOL_TIMEOUT_MS || DEFAULT_TOOL_TIMEOUT_MS)
  if (!Number.isFinite(configured)) return DEFAULT_TOOL_TIMEOUT_MS
  return Math.max(10, Math.min(120_000, Math.floor(configured)))
}

async function executeToolAttempt(toolRegistry, id, input, extras, { runSignal, timeoutMs }) {
  if (runSignal.aborted) throw toolError(TOOL_ERROR_CODES.TOOL_CANCELLED, '工具执行已取消')

  const attemptController = new AbortController()
  const cancelForRun = () => attemptController.abort(
    toolError(TOOL_ERROR_CODES.TOOL_CANCELLED, '工具执行已取消'),
  )
  runSignal.addEventListener('abort', cancelForRun, { once: true })
  const timer = setTimeout(() => attemptController.abort(
    toolError(TOOL_ERROR_CODES.TOOL_TIMEOUT, `工具执行超过 ${timeoutMs}ms`, { retryable: true }),
  ), timeoutMs)

  const aborted = new Promise((_, reject) => {
    attemptController.signal.addEventListener(
      'abort',
      () => reject(attemptController.signal.reason || toolError(TOOL_ERROR_CODES.TOOL_CANCELLED, '工具执行已取消')),
      { once: true },
    )
  })

  try {
    return await Promise.race([
      toolRegistry.execute(id, input, { ...extras, signal: attemptController.signal }),
      aborted,
    ])
  } finally {
    clearTimeout(timer)
    runSignal.removeEventListener('abort', cancelForRun)
  }
}

async function executeToolWithPolicy(toolRegistry, id, input, extras, {
  runSignal, timeoutMs, onRetry,
}) {
  for (let attempts = 1; attempts <= 2; attempts++) {
    try {
      const value = await executeToolAttempt(toolRegistry, id, input, extras, { runSignal, timeoutMs })
      return { value, attempts }
    } catch (error) {
      const normalized = normalizeToolError(error, { cancelled: runSignal.aborted })
      normalized.attempts = attempts
      if (normalized.code === TOOL_ERROR_CODES.TOOL_CANCELLED) throw normalized
      if (!normalized.retryable || attempts === 2) throw normalized
      onRetry?.(normalized, attempts + 1)
    }
  }
  throw toolError(TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED, '工具执行失败')
}

export function registerRunRoutes(app, deps) {
  // 执行一个 Run（SSE 已建好）：上下文构建 → agent loop（工具调用 + 流式生成）→ 落库 → 终态
  async function executeRun(res, run, { skillPrompt, env, maxToolRounds, skillName = '', regenerateMessageId }) {
    const conv = getConversation(run.conversationId)
    if (!conv) throw new Error('会话不存在')

    const controller = new AbortController()
    controllers.set(run.id, controller)
    const deltas = { reasoning: '', content: '' }
    const toolCalls = [] // 工具调用记录（随 assistant 消息落库，前端时间线展示）

    // 工具事件：SSE + run 记录双写
    const emitToolEvent = (evt) => {
      appendRunEvent(run.id, evt)
      if (!res.writableEnded) sseWrite(res, evt)
    }

    try {
      // 1. 上下文构建：运行卡片 + 按需工具。工作区/证据正文不再预注入。
      setState(res, run, 'context_build')
      const boundCase = conv.caseId ? getCase(conv.caseId) : null
      const evidenceSessionId = boundCase?.sessionIds?.[0] || run.evidenceSessionId
      if (boundCase) {
        emitToolEvent({ type: 'case.context', runId: run.id, caseId: boundCase.id, caseTitle: boundCase.title, memories: boundCase.memories.length })
      }
      const contextSession = createContextSession({
        caseId: boundCase?.id || '',
        sessionId: evidenceSessionId || '',
        runId: run.id,
        getCase,
        loadEvidencePack: deps.buildEvidencePack,
      })
      const inputMessages = regenerateMessageId ? conv.messages.slice(0, -1) : conv.messages
      const currentSelection = inputMessages.at(-1)?.selectionContext
      if (currentSelection) contextSession.rememberCite(currentSelection)
      const selectionCount = currentSelection?.messages?.length || 0
      const runtimeCard = buildRuntimeCard({
        caseId: boundCase?.id || '',
        caseTitle: boundCase?.title || '',
        stage: boundCase?.stage || '',
        riskLevel: boundCase?.riskLevel || '',
        sessionId: evidenceSessionId || '',
        skillId: run.skillId || '',
        skillName: skillName || '',
        selectionCount,
        lastReads: conv.lastContextReads || [],
        lastCites: conv.lastCitedChats || [],
        memoryIndex: buildMemoryIndex(boundCase),
      })
      const upstreamMessages = deps.buildUpstreamMessages({
        skillPrompt, messages: inputMessages, runtimeCard,
      })

      // 工具使用规范：背景资料按需读，禁止编造
      const toolDefs = (deps.toolRegistry?.list() || []).filter(t => {
        const name = t.function?.name
        if (name === 'read_skill_doc') return !!run.skillId
        if (name === 'propose_memory') return !!boundCase
        if (name === 'list_chat_sessions') return false
        if (isChatSessionTool(name)) return !!evidenceSessionId
        return true
      })
      if (toolDefs.length && upstreamMessages[0]?.role === 'system') {
        upstreamMessages[0].content +=
          '\n\n# 本地工具\n背景资料（工作区/证据）没有预注入，用 read_context 按切片读取。同一 Run 内已读结果会保留；下一轮用户对话不会带回工具正文。' +
          (run.skillId ? '\n手册：主题文档没有预注入。按目录用 read_skill_doc 读取 1～2 个最相关文件后再给可执行步骤；未读取的文件不在上下文中。' : '') +
          '\n聊天：只能查询当前绑定私聊；可按需使用统计、关键词搜原文、按时间浏览、展开上下文、话题摘要和只读 SQL。' +
          '\n规则：引用具体数据必须有证据，已附在当前用户消息里的点选原文可以直接引用；仅在缺少必要事实时调用工具。禁止重复执行相同查询；引用数据时注明时间范围；每次回答控制在用户问题的必要范围内。' +
          '\n工具失败：严格按错误结果的 recovery 行动。REVISE_INPUT 表示结合错误信息和参数定义修正后再调用；USE_ALTERNATIVE 表示不要重复原调用，改用其他工具或已有信息回答；ASK_USER 表示停止工具链并请用户补齐前置条件；STOP 表示停止调用工具。retryExhausted=true 时禁止重复原调用。' +
          '\n记忆：只有稳定偏好、明确边界、重要事件、重复规律，或用户明确要求记住的信息，才用 propose_memory 提出候选；临时情绪、回复话术、普通建议、聊天原文、无证据猜测和已有记忆不要提。候选必须由用户确认后才生效，每轮最多 2 条。' +
          '\n回答要求：以顾问身份对机主说话，自然结合查证到的事实与结论；禁止用对方口吻第一人称续写私聊。所有回复策略与【建议发送】话术均面向机主。无需向用户提及工具名称、函数调用或内部检索过程。'
      }

      // 2. Agent loop：模型可自主调用本地工具（≤ maxRounds 轮）
      setState(res, run, 'streaming')
      const maxRounds = Math.max(1, Math.min(30, Number(maxToolRounds || env?.MAX_TOOL_ROUNDS || 12)))
      const toolTimeoutMs = resolveToolTimeoutMs(env)
      let round = 0
      const seenCalls = new Set()
      let repeatedRound = false
      let toolsStopped = false
      for (; round < maxRounds; round++) {
        if (round && deltas.reasoning) {
          deltas.reasoning += '\n\n'
          if (!res.writableEnded) sseWrite(res, { type: 'message.delta', runId: run.id, r: '\n\n' })
        }
        const result = await deps.streamChat({
          baseUrl: env.BASE_URL,
          apiKey: env.API_KEY,
          model: env.BASE_MODEL,
          messages: upstreamMessages,
          tools: toolDefs,
          signal: controller.signal,
          onDelta({ reasoning, content }) {
            if (reasoning) deltas.reasoning += reasoning
            if (content) deltas.content += content
            if (res.writableEnded) return
            sseWrite(res, {
              type: 'message.delta', runId: run.id,
              ...(reasoning ? { r: reasoning } : {}), ...(content ? { t: content } : {}),
            })
          },
        })

        if (result.loopDetected) {
          if (result.reasoning) deltas.reasoning = result.reasoning
          break
        }

        if (!result.toolCalls?.length) break // 无工具调用 = 最终回答已流式输出

        const keys = result.toolCalls.map(tc => `${tc.name}:${tc.arguments || '{}'}`)
        if (keys.every(key => seenCalls.has(key))) {
          repeatedRound = true
          break
        }
        keys.forEach(key => seenCalls.add(key))
        // 回填 assistant tool_calls 消息，再逐个执行工具
        upstreamMessages.push({
          role: 'assistant',
          content: result.content || null,
          tool_calls: result.toolCalls.map(t => ({
            id: t.id || `call_${round}_${t.name}`,
            type: 'function',
            function: { name: t.name, arguments: t.arguments || '{}' },
          })),
        })

        for (const tc of result.toolCalls) {
          if (toolsStopped) {
            upstreamMessages.push({
              role: 'tool', tool_call_id: tc.id || `call_${round}_${tc.name}`,
              content: JSON.stringify({ code: 'TOOL_CANCELLED', recovery: 'STOP', error: '前序工具要求停止，未执行此调用' }),
            })
            continue
          }
          let argsSummary = ''
          let attempts = 1
          let outcome
          try {
            let args
            try {
              args = JSON.parse(tc.arguments || '{}')
            } catch (error) {
              throw toolError(TOOL_ERROR_CODES.INVALID_ARGUMENT, '工具参数不是有效 JSON', { cause: error })
            }
            if (tc.name === 'read_skill_doc') {
              if (!run.skillId) throw toolError(TOOL_ERROR_CODES.PERMISSION_DENIED, '本次消息未 @ 选择军师，不能读取技能文档')
              if (args.skillId && args.skillId !== run.skillId) {
                throw toolError(TOOL_ERROR_CODES.PERMISSION_DENIED, '只能读取本次 @ 选择的军师文档')
              }
              args.skillId = run.skillId
            }
            argsSummary = JSON.stringify(args).slice(0, 120)
            const execution = await executeToolWithPolicy(deps.toolRegistry, tc.name, args, {
              contextSession, sessionScope: { enforced: true, sessionId: evidenceSessionId || '' },
            }, {
              runSignal: controller.signal,
              timeoutMs: toolTimeoutMs,
              onRetry(error, nextAttempt) {
                emitToolEvent({
                  type: 'tool.retrying', runId: run.id, tool: tc.name, args: argsSummary, round,
                  error: error.message, errorCode: error.code, retryable: true, nextAttempt,
                })
              },
            })
            const executed = execution.value
            attempts = execution.attempts
            const payload = capToolPayload(
              executed.result,
              tc.name === 'read_skill_doc' ? 48 * 1024 : (tc.name === 'read_context' ? READ_CONTEXT_PAYLOAD_CAP : TOOL_RESULT_CAP),
            )
            // 前端内嵌可视化用：结果按 4KB 截断随事件下发
            let summary
            if (tc.name === 'read_skill_doc' && executed.result) {
              summary = {
                path: executed.result.path || args.path || '',
                truncated: !!executed.truncated,
                content: String(executed.result.content || '').slice(0, 3000),
              }
            } else {
              summary = truncateResult(executed.result, 4 * 1024).result
            }
            outcome = {
              ok: true,
              truncated: executed.truncated,
              bytes: Buffer.byteLength(payload),
              summary,
              attempts,
            }
            upstreamMessages.push({
              role: 'tool',
              tool_call_id: tc.id || `call_${round}_${tc.name}`,
              content: payload,
            })
          } catch (error) {
            const normalized = normalizeToolError(error, { cancelled: controller.signal.aborted })
            if (normalized.code === TOOL_ERROR_CODES.TOOL_CANCELLED) throw normalized
            attempts = normalized.attempts || attempts
            const retryExhausted = normalized.retryable && attempts >= 2
            outcome = {
              ok: false,
              error: normalized.message,
              errorCode: normalized.code,
              recovery: normalized.recovery,
              retryable: normalized.retryable && !retryExhausted,
              retryExhausted,
              attempts,
            }
            if (['STOP', 'ASK_USER'].includes(normalized.recovery)) toolsStopped = true
            upstreamMessages.push({
              role: 'tool',
              tool_call_id: tc.id || `call_${round}_${tc.name}`,
              content: JSON.stringify({
                error: normalized.message,
                code: normalized.code,
                recovery: normalized.recovery,
                retryable: normalized.retryable && !retryExhausted,
                retryExhausted,
                attempts,
              }),
            })
          }
          emitToolEvent({
            type: outcome.ok ? 'tool.completed' : 'tool.failed',
            runId: run.id, tool: tc.name, args: argsSummary, round, attempts: outcome.attempts,
            ...(outcome.ok
              ? { truncated: !!outcome.truncated, bytes: outcome.bytes, summary: outcome.summary }
              : {
                  error: outcome.error, errorCode: outcome.errorCode, recovery: outcome.recovery,
                  retryable: outcome.retryable, retryExhausted: outcome.retryExhausted,
                }),
          })
          toolCalls.push({
            tool: tc.name, ok: outcome.ok, args: argsSummary, round, attempts: outcome.attempts,
            ...(outcome.ok
              ? { bytes: outcome.bytes, truncated: !!outcome.truncated, summary: outcome.summary }
              : {
                  error: outcome.error, errorCode: outcome.errorCode, recovery: outcome.recovery,
                  retryable: outcome.retryable, retryExhausted: outcome.retryExhausted,
                }),
          })
        }
        if (toolsStopped) break
      }

      // 如果模型一直调用工具达到 maxRounds 上限（最后一轮为 tool 返回）
      // 最后一轮直接不带工具发起调用，结合已有全部 context 与证据直接输出正文
      if ((toolsStopped || repeatedRound || round >= maxRounds) && upstreamMessages[upstreamMessages.length - 1]?.role === 'tool') {
        emitToolEvent({ type: 'run.limit', runId: run.id, rounds: round, reason: toolsStopped ? 'recovery_stop' : (repeatedRound ? 'repeated_tools' : 'round_limit') })
        await deps.streamChat({
          baseUrl: env.BASE_URL,
          apiKey: env.API_KEY,
          model: env.BASE_MODEL,
          messages: upstreamMessages,
          tools: [], // 彻底切断工具，强制模型基于已有上下文直接生成最终回答
          signal: controller.signal,
          onDelta({ reasoning, content }) {
            if (reasoning) deltas.reasoning += reasoning
            if (content) deltas.content += content
            if (res.writableEnded) return
            sseWrite(res, {
              type: 'message.delta', runId: run.id,
              ...(reasoning ? { r: reasoning } : {}), ...(content ? { t: content } : {}),
            })
          },
        })
      }

      // 如果本轮遭遇循环截断或未输出正文（但已积累了推理思考内容）：
      // 快速请求模型依据已有思考直接输出正式回答，避免用户界面卡死或空白
      if (!deltas.content.trim() && deltas.reasoning.trim() && !controller.signal.aborted) {
        try {
          const directMessages = [
            ...upstreamMessages,
            {
              role: 'user',
              content: '请根据上述已有的分析思考，直接给出给机主的正式回答与建议发送话术（无需再次展开推理）。',
            },
          ]
          await deps.streamChat({
            baseUrl: env.BASE_URL,
            apiKey: env.API_KEY,
            model: env.BASE_MODEL,
            messages: directMessages,
            tools: [],
            signal: controller.signal,
            onDelta({ content }) {
              if (content) {
                deltas.content += content
                if (!res.writableEnded) {
                  sseWrite(res, { type: 'message.delta', runId: run.id, t: content })
                }
              }
            },
          })
        } catch {}
      }

      // 3. 落库：助手消息 + 终态。下一 Turn 只留 path 提示，不回灌 tool 正文。
      const citeKeys = contextSession.usedCites()
      updateConversation(conv.id, {
        lastContextReads: contextSession.usedPaths(),
        ...(citeKeys.length ? { lastCitedChats: citeKeys } : {}),
      })
      let memoryCandidates = []
      if (boundCase) {
        try {
          memoryCandidates = addCaseMemoryCandidates(
            boundCase.id,
            contextSession.memoryProposals(),
            { runId: run.id },
          ) || []
        } catch (e) {
          emitToolEvent({ type: 'memory.candidate.failed', runId: run.id, error: e.message })
        }
      }
      const message = appendMessage(conv.id, {
        role: 'assistant', content: deltas.content, reasoning: deltas.reasoning, runId: run.id, tools: toolCalls,
        memoryCandidateIds: memoryCandidates.map(candidate => candidate.id),
      }, { replaceMessageId: regenerateMessageId })
      updateRun(run.id, { messageId: message.id, finishedAt: new Date().toISOString() })
      for (const candidate of memoryCandidates) {
        emitToolEvent({ type: 'memory.candidate', runId: run.id, messageId: message.id, candidate })
      }
      setState(res, run, 'completed')
      if (!res.writableEnded) {
        sseWrite(res, { type: 'run.completed', runId: run.id, messageId: message.id })
        res.write('data: [DONE]\n\n')
        res.end()
      }
    } catch (e) {
      const aborted = controller.signal.aborted || e.name === 'AbortError'
      if (aborted) {
        // 取消：保留已生成的部分内容
        if (!regenerateMessageId && (deltas.content || deltas.reasoning)) {
          const message = appendMessage(conv.id, {
            role: 'assistant',
            content: deltas.content + (deltas.content ? '\n\n（已取消）' : '（已取消）'),
            reasoning: deltas.reasoning,
            runId: run.id,
            tools: toolCalls,
          })
          updateRun(run.id, { messageId: message.id })
        }
        updateRun(run.id, { finishedAt: new Date().toISOString() })
        setState(res, run, 'cancelled')
        if (!res.writableEnded) {
          sseWrite(res, { type: 'run.cancelled', runId: run.id })
          res.write('data: [DONE]\n\n')
          res.end()
        }
      } else {
        updateRun(run.id, { error: e.message, finishedAt: new Date().toISOString() })
        setState(res, run, 'failed')
        if (!res.writableEnded) {
          sseWrite(res, { type: 'run.failed', runId: run.id, error: e.message })
          res.write('data: [DONE]\n\n')
          res.end()
        }
      }
    } finally {
      controllers.delete(run.id)
    }
  }

  // 发起 Run：响应本身就是 SSE 事件流
  app.post('/api/runs', async (req, res) => {
    try {
      let { conversationId, text = '', skills = [], sessionId = '', title, caseId, selection, maxToolRounds, MAX_TOOL_ROUNDS, regenerateMessageId } = req.body || {}
      const userMax = maxToolRounds ?? MAX_TOOL_ROUNDS

      if (caseId) {
        try {
          if (!getCase(caseId)) return res.status(404).json({ ok: false, error: '工作区不存在' })
        } catch {
          return res.status(400).json({ ok: false, error: '工作区 ID 无效' })
        }
      }

      // 会话：传 id 用现有；没传则新建（标题取首句前 18 字）
      let conv = conversationId ? getConversation(conversationId) : null
      if (conversationId && !conv) return res.status(404).json({ ok: false, error: '会话不存在' })
      if ([...controllers.keys()].some(id => getRun(id)?.conversationId === conversationId)) {
        return res.status(409).json({ ok: false, error: '当前对话正在生成回答' })
      }
      if (regenerateMessageId) {
        const answer = conv?.messages.at(-1)
        if (!answer || answer.id !== regenerateMessageId || answer.role !== 'assistant' || conv.messages.at(-2)?.role !== 'user') {
          return res.status(409).json({ ok: false, error: '只能重新生成当前对话的最后一条回答' })
        }
        const previousRun = answer.runId ? getRun(answer.runId) : null
        skills = previousRun?.selectedSkillIds || []
        sessionId = previousRun?.evidenceSessionId || ''
        caseId = conv.caseId
        selection = undefined
      }
      const effectiveCaseId = caseId !== undefined ? caseId : conv?.caseId
      const boundCase = effectiveCaseId ? getCase(effectiveCaseId) : null
      const boundSession = boundCase?.sessionIds?.[0]
      const targetSession = boundSession || sessionId || selection?.sessionId || ''
      if (boundSession && sessionId && boundSession !== sessionId) {
        return res.status(400).json({ ok: false, error: '聊天记录与工作区不一致，请切换工作区后重试' })
      }
      let selectionContext
      if (selection) {
        try {
          const sessionForSelection = boundSession || selection.sessionId
          if (!sessionForSelection) throw new Error('请先选择有效聊天记录')
          if (boundSession && selection.sessionId !== boundSession) {
            throw new Error('所选聊天记录与当前工作区不一致')
          }
          validateSelection(selection, sessionForSelection)
          selectionContext = await deps.loadSelectedMessages(selection)
        } catch (e) {
          return res.status(400).json({ ok: false, error: e.message })
        }
      }
      if (!conv) conv = createConversation({ title: title || String(text).slice(0, 18) || '新对话', caseId: caseId || '' })
      if (caseId !== undefined && conv.caseId !== caseId) {
        conv = updateConversation(conv.id, { caseId: caseId || '' }) || conv
      }

      // 用户消息先落库（即使客户端断开也不丢）
      if (!regenerateMessageId) appendMessage(conv.id, { role: 'user', content: String(text), selectionContext })

      // Skill 装配（军师路由 + 文档路由），供 executeRun 注入与事件播报
      const assembly = deps.assembleSkills(skills)

      const run = createRun({
        conversationId: conv.id,
        selectedSkillIds: skills,
        skillId: assembly.skillId,
        evidenceSessionId: targetSession,
      })

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
      if (res.socket) res.socket.setNoDelay(true)
      res.flushHeaders()
      sseWrite(res, { type: 'run.created', runId: run.id, conversationId: conv.id })
      if (assembly.skillId) {
        const evt = {
          type: 'skill.loaded', runId: run.id,
          skillId: assembly.skillId, skillName: assembly.skillName,
          auto: assembly.auto, docs: assembly.loadedDocs.map(d => d.path),
        }
        appendRunEvent(run.id, evt)
        if (!res.writableEnded) sseWrite(res, evt)
      }

      // 客户端断开 → 视为取消，防止僵尸流
      // 注意：req 的 'close' 在请求体读完即触发；res 的 'close' 才对应连接关闭
      res.on('close', () => {
        if (!res.writableEnded && isRunActive(getRun(run.id))) controllers.get(run.id)?.abort()
      })

      await executeRun(res, run, { skillPrompt: assembly.prompt, env: deps.getEnv(), maxToolRounds: userMax, skillName: assembly.skillName, regenerateMessageId })
    } catch (e) {
      if (!res.headersSent) return res.status(500).json({ ok: false, error: e.message })
      if (!res.writableEnded) {
        sseWrite(res, { type: 'run.failed', error: e.message })
        res.write('data: [DONE]\n\n')
        res.end()
      }
    }
  })

  // 查询 Run（状态 + 事件）
  app.get('/api/runs/:id', (req, res) => {
    const run = getRun(req.params.id)
    if (!run) return res.status(404).json({ ok: false, error: 'Run 不存在' })
    res.json({ ok: true, data: run })
  })

  // 取消 Run
  app.post('/api/runs/:id/cancel', (req, res) => {
    const run = getRun(req.params.id)
    if (!run) return res.status(404).json({ ok: false, error: 'Run 不存在' })
    if (!isRunActive(run)) return res.json({ ok: true, data: { state: run.state, alreadyFinished: true } })
    controllers.get(run.id)?.abort()
    res.json({ ok: true, data: { state: run.state, cancelling: true } })
  })

  // ── Conversations CRUD（服务端为会话事实源）────────────
  app.get('/api/conversations', (_req, res) => {
    res.json({ ok: true, data: { items: listConversationSummaries() } })
  })

  app.post('/api/conversations', (req, res) => {
    const { title, caseId } = req.body || {}
    res.json({ ok: true, data: createConversation({ title, caseId }) })
  })

  // 前端 localStorage 一次性迁移
  app.post('/api/conversations/migrate', (req, res) => {
    const { conversations = [] } = req.body || {}
    const imported = importConversations(conversations)
    res.json({ ok: true, data: { imported: imported.length } })
  })

  app.get('/api/conversations/:id', (req, res) => {
    const conv = getConversation(req.params.id)
    if (!conv) return res.status(404).json({ ok: false, error: '会话不存在' })
    res.json({ ok: true, data: conv })
  })

  app.patch('/api/conversations/:id', (req, res) => {
    const conv = updateConversation(req.params.id, req.body || {})
    if (!conv) return res.status(404).json({ ok: false, error: '会话不存在' })
    res.json({ ok: true, data: conv })
  })

  app.delete('/api/conversations/:id', (req, res) => {
    const deleted = deleteConversation(req.params.id)
    if (!deleted) return res.status(404).json({ ok: false, error: '会话不存在' })
    res.json({ ok: true, data: { deleted: true } })
  })
}
