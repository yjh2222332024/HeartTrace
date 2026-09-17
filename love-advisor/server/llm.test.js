// ── llm.js 流式解析单元测试（mock 全局 fetch，不出网）────
// 覆盖：SSE 文本流 / SSE 增量 tool_calls（跨 chunk 拼接）/ 非 SSE 整段 JSON 兜底 / 上游错误
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { streamChatCompletion, collapseTurnMessages, detectRepetitionLoop } from './llm.js'

const enc = new TextEncoder()

test('SSE final data without a trailing newline is preserved', async () => {
  globalThis.fetch = async () => mockResp(['data: {"choices":[{"delta":{"content":"tail"},"finish_reason":"stop"}]}'])
  const result = await streamChatCompletion({ baseUrl: 'http://mock', model: 'test', messages: [] })
  assert.equal(result.content, 'tail')
})

// 构造一个可分 chunk 读取的 Response 形状对象
function mockResp(chunks, { status = 200 } = {}) {
  let i = 0
  return {
    ok: status < 400,
    status,
    text: async () => (chunks[0] ?? ''),
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: enc.encode(chunks[i++]) }
            : { done: true },
      }),
    },
  }
}

test('SSE 纯文本流：增量回调 + content 回显 + finishReason', async () => {
  globalThis.fetch = async () => mockResp([
    'data: {"choices":[{"delta":{"reasoning_content":"思考","content":""}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ])
  const deltas = []
  const r = await streamChatCompletion({
    baseUrl: 'http://mock', apiKey: 'k', model: 'm', messages: [],
    onDelta: d => deltas.push(d),
  })
  assert.equal(r.finishReason, 'stop')
  assert.equal(r.content, '你好')
  assert.deepEqual(r.toolCalls, [])
  assert.deepEqual(deltas, [
    { reasoning: '思考', content: '' },
    { reasoning: '', content: '你' },
    { reasoning: '', content: '好' },
  ])
})

test('SSE 增量 tool_calls：跨 chunk 拼接 arguments', async () => {
  globalThis.fetch = async () => mockResp([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search_messages","arguments":"{\\"keyw"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ords\\":[\\"累\\"]}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ])
  const r = await streamChatCompletion({ baseUrl: 'http://mock', apiKey: 'k', model: 'm', messages: [] })
  assert.equal(r.finishReason, 'tool_calls')
  assert.deepEqual(r.toolCalls, [
    { id: 'call_1', name: 'search_messages', arguments: '{"keywords":["累"]}' },
  ])
})

test('SSE 多个 tool_calls 按 index 归并', async () => {
  globalThis.fetch = async () => mockResp([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"a","arguments":"{}"}},{"index":1,"id":"c2","function":{"name":"b","arguments":"{\\"x\\""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":":2}"}}]}}]}\n\n',
    'data: [DONE]\n\n',
  ])
  const r = await streamChatCompletion({ baseUrl: 'http://mock', apiKey: 'k', model: 'm', messages: [] })
  assert.equal(r.toolCalls.length, 2)
  assert.deepEqual(r.toolCalls[1], { id: 'c2', name: 'b', arguments: '{"x":2}' })
})

test('非 SSE 整段 JSON 兜底（上游 tool_calls 静默退化）', async () => {
  const body = JSON.stringify({
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: 'c9', type: 'function',
          function: { name: 'get_chat_stats', arguments: '{"sessionId":"s1","metric":"activity"}' },
        }],
      },
      finish_reason: 'tool_calls',
    }],
  })
  globalThis.fetch = async () => mockResp([body])
  const deltas = []
  const r = await streamChatCompletion({
    baseUrl: 'http://mock', apiKey: 'k', model: 'm', messages: [],
    onDelta: d => deltas.push(d),
  })
  assert.equal(r.finishReason, 'tool_calls')
  assert.deepEqual(r.toolCalls, [{
    id: 'c9', name: 'get_chat_stats', arguments: '{"sessionId":"s1","metric":"activity"}',
  }])
  assert.equal(r.content, '')
  assert.deepEqual(deltas, []) // content 为 null 不触发回调
})

test('非 SSE JSON 带文本：content 回显 + onDelta', async () => {
  const body = JSON.stringify({
    choices: [{ message: { content: '直接回答', tool_calls: [] }, finish_reason: 'stop' }],
  })
  globalThis.fetch = async () => mockResp([body])
  const deltas = []
  const r = await streamChatCompletion({
    baseUrl: 'http://mock', apiKey: 'k', model: 'm', messages: [],
    onDelta: d => deltas.push(d),
  })
  assert.equal(r.content, '直接回答')
  assert.deepEqual(deltas, [{ reasoning: '', content: '直接回答' }])
})

test('上游 4xx/5xx：抛错并带状态码', async () => {
  globalThis.fetch = async () => mockResp(['boom'], { status: 500 })
  await assert.rejects(
    streamChatCompletion({ baseUrl: 'http://mock', apiKey: 'k', model: 'm', messages: [] }),
    /上游 500/,
  )
})

test('SSE 包含 : ping 规范心跳注释与 event: 行不重置 sawSse', async () => {
  globalThis.fetch = async () => mockResp([
    ': ping\n\n',
    'event: message\n',
    'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
    ': ping\n\n',
    'data: [DONE]\n\n',
  ])
  const deltas = []
  const r = await streamChatCompletion({
    baseUrl: 'http://mock', apiKey: 'k', model: 'm', messages: [],
    onDelta: d => deltas.push(d),
  })
  assert.equal(r.content, '你好')
  assert.equal(r.finishReason, 'stop')
})

test('collapseTurnMessages：连续 user 消息合并，保持严格轮转', () => {
  const input = [
    { role: 'system', content: '系统提示' },
    { role: 'user', content: '<untrusted_context>证据' },
    { role: 'user', content: '用户实际问题' },
    { role: 'assistant', content: '模型回答' },
  ]
  const collapsed = collapseTurnMessages(input)
  assert.equal(collapsed.length, 3)
  assert.equal(collapsed[0].role, 'system')
  assert.equal(collapsed[1].role, 'user')
  assert.equal(collapsed[1].content, '<untrusted_context>证据\n\n用户实际问题')
  assert.equal(collapsed[2].role, 'assistant')

  // tool_calls 与 tool 消息不合并
  const withTools = [
    { role: 'assistant', content: null, tool_calls: [{ id: '1' }] },
    { role: 'assistant', content: '继续' },
  ]
  assert.equal(collapseTurnMessages(withTools).length, 2)
})

test('非 SSE 普通 JSON 响应中多个 tool_calls（无 index 属性）分别独立解析', async () => {
  const body = JSON.stringify({
    choices: [{
      message: {
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'search_messages', arguments: '{"q":"a"}' } },
          { id: 'call_2', type: 'function', function: { name: 'get_chat_stats', arguments: '{"q":"b"}' } },
        ],
      },
      finish_reason: 'tool_calls',
    }],
  })
  globalThis.fetch = async () => mockResp([body])
  const r = await streamChatCompletion({ baseUrl: 'http://mock', apiKey: 'k', model: 'm', messages: [] })
  assert.equal(r.finishReason, 'tool_calls')
  assert.equal(r.toolCalls.length, 2)
  assert.equal(r.toolCalls[0].name, 'search_messages')
  assert.equal(r.toolCalls[0].arguments, '{"q":"a"}')
  assert.equal(r.toolCalls[1].name, 'get_chat_stats')
  assert.equal(r.toolCalls[1].arguments, '{"q":"b"}')
})

test('传入用户取消 signal 时，timeoutMs 超时熔断机制依然有效', async () => {
  const userController = new AbortController()
  // 模拟挂起的 fetch：5 秒后才返回，但 signal 会提前超时 abort
  globalThis.fetch = (_url, { signal }) => {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason)
      const timer = setTimeout(() => resolve(mockResp(['{}'])), 5000)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(signal.reason || new Error('Aborted by timeout'))
      }, { once: true })
    })
  }

  // 即使 userController 尚未手动 abort，30ms 超时也必须触发
  await assert.rejects(
    streamChatCompletion({
      baseUrl: 'http://mock', apiKey: 'k', model: 'm', messages: [],
      signal: userController.signal,
      timeoutMs: 30,
    }),
    /abort|timeout/i,
  )
})

test('detectRepetitionLoop：准确识别长短重复循环，正常文本无误报', () => {
  assert.equal(detectRepetitionLoop('正常聊天内容很丰富，没有重复。'), null)

  const patternShort = '重要结论分析。请注意后续话术策略。'
  const loopedShort = '前言思考。' + patternShort.repeat(5)
  const repShort = detectRepetitionLoop(loopedShort)
  assert.ok(repShort)
  assert.equal(repShort.period, patternShort.length)

  const patternLong = '这是一个长段落的重复测试，包含多个不同的字符与标点符号。我们用它来测试长周期的重复检测。'
  const loopedLong = '初始思维链条：' + patternLong.repeat(3)
  const repLong = detectRepetitionLoop(loopedLong)
  assert.ok(repLong)
  assert.equal(repLong.period, patternLong.length)
})

test('streamChatCompletion 携带默认 temperature: 0.6 并在推理死循环时及时截断并标记 loop_detected', async () => {
  let capturedBody = null
  const loopBlock = '好的，现在开始写最终答案。针对私聊语境给出以下策略方案：'
  const loopChunks = []
  for (let i = 0; i < 6; i++) {
    loopChunks.push(`data: {"choices":[{"delta":{"reasoning_content":${JSON.stringify(loopBlock)}}}]}\n\n`)
  }
  loopChunks.push('data: {"choices":[{"delta":{"content":"正常内容被阻止"}}]}\n\n')

  globalThis.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body)
    return mockResp(loopChunks)
  }

  const deltas = []
  const result = await streamChatCompletion({
    baseUrl: 'http://mock', apiKey: 'k', model: 'm', messages: [],
    onDelta: d => deltas.push(d),
  })

  // 验证默认 temperature 为 0.6
  assert.equal(capturedBody.temperature, 0.6)
  // 验证循环被识别截断
  assert.equal(result.loopDetected, true)
  assert.equal(result.finishReason, 'loop_detected')
  // 验证截断后 reasoning 剔除了多余重复部分，且未输出后续被污染内容
  assert.ok(result.reasoning.includes(loopBlock))
  assert.doesNotMatch(result.content, /正常内容被阻止/)
})
