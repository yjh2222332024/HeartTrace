// ── 上游 LLM 调用（OpenAI 兼容 /chat/completions，SSE 解析）──
// 供 /api/chat（旧路径）与 /api/runs（Run Runtime，agent loop）共用
// 注意：.env 加载保留在 index.js（需在 qce.js 使用前写入 process.env）
//
// 已知上游行为：文本回复走标准 SSE 增量；返回 tool_calls 时会静默退化为
// 单个完整 JSON（无 data: 前缀）。因此解析器必须同时兼容两种格式。

// 合并连续同角色的文本消息（某些 upstream 网关强制要求严格 user/assistant 交替轮转）
export function collapseTurnMessages(messages) {
  if (!Array.isArray(messages)) return []
  const out = []
  for (const m of messages) {
    if (!m) continue
    const last = out[out.length - 1]
    if (
      last &&
      last.role === m.role &&
      m.role !== 'tool' &&
      !m.tool_calls?.length &&
      !last.tool_calls?.length &&
      !m.tool_call_id &&
      !last.tool_call_id
    ) {
      last.content = [last.content, m.content].filter(Boolean).join('\n\n')
    } else {
      out.push({ ...m })
    }
  }
  return out
}

// 检测文本尾部是否存在退化重复循环（周期 L ≥ minLen，重复次数导致总匹配字符 ≥ target）
export function detectRepetitionLoop(str, minLen = 15, maxLen = 3000) {
  if (!str || str.length < minLen * 2) return null
  const end = str.length - 1
  const maxL = Math.min(maxLen, Math.floor(str.length / 2))
  for (let len = minLen; len <= maxL; len++) {
    if (str[end] !== str[end - len]) continue
    let match = 1
    for (let i = 1; i < str.length - len; i++) {
      if (str[end - i] === str[end - i - len]) {
        match++
      } else {
        break
      }
    }
    const target = len >= 100 ? Math.floor(len * 1.5) : (len >= 30 ? Math.floor(len * 1.8) : Math.max(50, Math.floor(len * 2.5)))
    if (match >= target) {
      return { period: len, matchChars: match }
    }
  }
  return null
}

// 流式请求上游模型；文本增量回调 onDelta({ reasoning, content })
// 返回 { finishReason, toolCalls, content, reasoning, loopDetected }
export async function streamChatCompletion({
  baseUrl, apiKey, model, messages, tools, signal, timeoutMs = 300000, onDelta = () => {},
  temperature,
}) {
  if (!baseUrl || !model) throw new Error('LLM 服务未配置 BASE_URL 或 BASE_MODEL')
  const envTemp = process.env.TEMPERATURE !== undefined ? Number(process.env.TEMPERATURE) : undefined
  const effectiveTemp = Number.isFinite(envTemp) ? envTemp : (Number.isFinite(temperature) ? temperature : 0.6)
  const body = {
    model,
    messages: collapseTurnMessages(messages),
    stream: true,
    temperature: effectiveTemp,
  }
  if (Array.isArray(tools) && tools.length) body.tools = tools

  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

  const upstream = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: effectiveSignal,
  })

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '')
    throw new Error(`上游 ${upstream.status}: ${errText.slice(0, 200)}`)
  }

  const contentType = upstream.headers?.get?.('content-type') || ''
  let sawSse = contentType.includes('text/event-stream')

  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let raw = ''          // 累积原始响应（用于非 SSE 整段 JSON 兜底）
  const toolAcc = new Map() // index -> { id, name, arguments }
  let finishReason = null
  let contentEcho = ''
  let accumulatedReasoning = ''
  let accumulatedContent = ''
  let repetitionDetected = false

  const handleChoice = (choice) => {
    if (!choice || repetitionDetected) return
    if (choice.finish_reason) finishReason = choice.finish_reason
    const msg = choice.message
    if (msg) {
      // 非 SSE 整段 JSON：一次性取全文 + tool_calls
      if (msg.content) {
        contentEcho += msg.content
        accumulatedContent += msg.content
        onDelta({ reasoning: msg.reasoning_content || '', content: msg.content })
      }
      if (Array.isArray(msg.tool_calls)) {
        msg.tool_calls.forEach((tc, i) => {
          const idx = tc.index ?? i
          const cur = toolAcc.get(idx) || { id: '', name: '', arguments: '' }
          cur.id = tc.id || cur.id
          cur.name = tc.function?.name || cur.name
          cur.arguments += tc.function?.arguments || ''
          toolAcc.set(idx, cur)
        })
      }
    }
    const delta = choice.delta
    if (delta) {
      const reasoning = delta.reasoning_content || delta.reasoning || delta.thinking || ''
      const content = delta.content || ''
      if (reasoning || content) {
        if (reasoning) {
          accumulatedReasoning += reasoning
          const loop = detectRepetitionLoop(accumulatedReasoning)
          if (loop) {
            repetitionDetected = true
            finishReason = 'loop_detected'
            accumulatedReasoning = accumulatedReasoning.slice(0, accumulatedReasoning.length - loop.matchChars)
            return
          }
        }
        if (content) {
          contentEcho += content
          accumulatedContent += content
          const loop = detectRepetitionLoop(accumulatedContent)
          if (loop) {
            repetitionDetected = true
            finishReason = 'loop_detected'
            contentEcho = accumulatedContent.slice(0, accumulatedContent.length - loop.matchChars)
            return
          }
        }
        onDelta({ reasoning, content })
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0
          const cur = toolAcc.get(idx) || { id: '', name: '', arguments: '' }
          cur.id = tc.id || cur.id
          cur.name = tc.function?.name || cur.name
          cur.arguments += tc.function?.arguments || ''
          toolAcc.set(idx, cur)
        }
      }
    }
  }

  while (true) {
    if (repetitionDetected) {
      try { await reader.cancel('Repetition loop detected') } catch {}
      break
    }
    const { done, value } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value, { stream: true })
    raw += chunk
    buf += chunk
    const lines = buf.split('\n')
    buf = lines.pop() // 半行留待下轮
    for (const line of lines) {
      if (repetitionDetected) break
      const l = line.trim()
      if (!l) continue
      if (l.startsWith(':')) continue // SSE 规范注释/保活心跳行（: keep-alive / : ping）
      if (!l.startsWith('data:')) continue // 其它 SSE 字段（event:、id: 等）不重置 sawSse
      sawSse = true
      const payload = l.slice(5).trim()
      if (payload === '[DONE]') continue
      try {
        handleChoice(JSON.parse(payload).choices?.[0])
      } catch { /* 非 JSON 行忽略 */ }
    }
  }

  const tail = (buf + decoder.decode()).trim()
  if (!repetitionDetected && tail.startsWith('data:')) {
    const payload = tail.slice(5).trim()
    if (payload !== '[DONE]') {
      try { handleChoice(JSON.parse(payload).choices?.[0]) } catch { /* Ignore invalid trailing data. */ }
    }
    sawSse = true
  }

  // 非 SSE 兜底：响应是单个完整 JSON（上游 tool_calls 静默退化时）
  if (!sawSse && !repetitionDetected) {
    try {
      const parsed = JSON.parse(raw)
      handleChoice(parsed.choices?.[0])
      if (!finishReason) finishReason = parsed.choices?.[0]?.finish_reason || 'stop'
    } catch { /* 忽略解析失败 */ }
  }

  return {
    finishReason: finishReason || 'stop',
    toolCalls: [...toolAcc.values()].filter(t => t.name),
    content: contentEcho,
    reasoning: accumulatedReasoning,
    loopDetected: repetitionDetected,
  }
}
