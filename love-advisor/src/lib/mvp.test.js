import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ref } from 'vue'
import { conversationsApi } from '../api.js'
import { useChatRun } from '../composables/useChatRun.js'
import { useConversations } from '../composables/useConversations.js'

test('归档接口返回解析后的业务结果，包括失败信息', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: false, error: '归档失败' }, { status: 400 }))
  assert.deepEqual(await conversationsApi.patch('conv_test', { caseId: 'case_test' }), {
    ok: false, error: '归档失败',
  })
})

test('前端重新生成只发送替换目标，不重复插入用户消息', async t => {
  const conversation = { id: 'conv_test', title: '已有对话', messages: [
    { id: 'user_test', role: 'user', content: '原问题' },
    { id: 'answer_test', role: 'assistant', content: '旧回答' },
  ] }
  let request
  let refreshed = false
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    request = JSON.parse(init.body)
    return new Response('data: {"type":"run.completed"}\n\n')
  })
  const chat = useChatRun({
    generating: ref(false), currentConv: () => conversation,
    newConversation: async () => {}, refreshConversation: async () => { refreshed = true },
    selectedChat: ref(null), selectedSessionId: ref(''), currentCaseId: ref(''), showToast: () => {},
  })
  await chat.onSend('原问题', [], { regenerateMessageId: 'answer_test' })
  assert.equal(request.regenerateMessageId, 'answer_test')
  assert.equal(conversation.messages.filter(message => message.role === 'user').length, 1)
  assert.equal(conversation.messages[1].content, '旧回答')
  assert.equal(refreshed, true)
})

test('删除当前会话后切换到摘要会话时会先加载正文', async t => {
  const full = {
    conv_a: { id: 'conv_a', title: 'A', caseId: 'case_a', messages: [{ role: 'user', content: 'A 正文' }] },
    conv_b: { id: 'conv_b', title: 'B', caseId: 'case_b', messages: [{ role: 'user', content: 'B 正文' }] },
  }
  const gets = []
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (url === '/api/conversations') {
      return Response.json({ ok: true, data: { items: [
        { id: 'conv_a', title: 'A', caseId: 'case_a', messageCount: 1 },
        { id: 'conv_b', title: 'B', caseId: 'case_b', messageCount: 1 },
      ] } })
    }
    if (String(url).startsWith('/api/conversations/') && (!init.method || init.method === 'GET')) {
      const id = String(url).split('/').at(-1)
      gets.push(id)
      return Response.json({ ok: true, data: full[id] })
    }
    if (init.method === 'DELETE') return Response.json({ ok: true })
    throw new Error(`unexpected request: ${url}`)
  })

  const currentId = ref('conv_a')
  const currentCaseId = ref('case_a')
  const state = useConversations({
    saved: {}, currentId, currentCaseId,
    persist: () => {}, showToast: () => {}, generating: ref(false),
    syncSessionFromCase: () => {}, activeView: ref('chat'), selectedChat: ref(null),
  })
  await state.loadConversations()
  await state.deleteConversation('conv_a')

  assert.equal(currentId.value, 'conv_b')
  assert.equal(currentCaseId.value, 'case_b')
  assert.deepEqual(state.currentConv().messages, full.conv_b.messages)
  assert.deepEqual(gets, ['conv_a', 'conv_b'])
})

test('创建会话失败时不生成不可持久化的 local 会话', async t => {
  const notices = []
  t.mock.method(globalThis, 'fetch', async (_url, init = {}) => {
    assert.equal(init.method, 'POST')
    return Response.json({ ok: false, error: '存储不可用' }, { status: 503 })
  })
  const state = useConversations({
    saved: {}, currentId: ref(null), currentCaseId: ref('case_a'),
    persist: () => assert.fail('创建失败不应写入本地会话状态'), showToast: message => notices.push(message), generating: ref(false),
    syncSessionFromCase: () => {}, activeView: ref('chat'), selectedChat: ref(null),
  })

  assert.equal(await state.newConversation(), null)
  assert.deepEqual(state.conversations.value, [])
  assert.match(notices.at(-1), /无法创建新对话/)
})

test('删除会话仅在服务端确认后更新界面', async t => {
  const notices = []
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (url === '/api/conversations') return Response.json({ ok: true, data: { items: [{ id: 'conv_a', title: 'A', caseId: '', messageCount: 0 }] } })
    if (url === '/api/conversations/conv_a' && !init.method) return Response.json({ ok: true, data: { id: 'conv_a', title: 'A', caseId: '', messages: [] } })
    if (url === '/api/conversations/conv_a' && init.method === 'DELETE') return Response.json({ ok: false, error: '服务端拒绝删除' }, { status: 500 })
    throw new Error(`unexpected request: ${url}`)
  })
  const currentId = ref('conv_a')
  const state = useConversations({
    saved: {}, currentId, currentCaseId: ref(''), persist: () => {}, showToast: message => notices.push(message), generating: ref(false),
    syncSessionFromCase: () => {}, activeView: ref('chat'), selectedChat: ref(null),
  })
  await state.loadConversations()

  assert.equal(await state.deleteConversation('conv_a'), false)
  assert.equal(state.conversations.value[0].id, 'conv_a')
  assert.equal(currentId.value, 'conv_a')
  assert.match(notices.at(-1), /服务端拒绝删除/)
})

test('首次发送在创建会话期间锁定，避免并发创建和生成', async t => {
  const generating = ref(false)
  let conversation = null
  let releaseCreation
  const creation = new Promise(resolve => { releaseCreation = resolve })
  let creates = 0
  let runs = 0
  t.mock.method(globalThis, 'fetch', async () => {
    runs += 1
    return new Response('data: {"type":"run.completed"}\n\n')
  })
  const chat = useChatRun({
    generating,
    currentConv: () => conversation,
    newConversation: async () => {
      creates += 1
      await creation
      conversation = { id: 'conv_new', title: '已有对话', messages: [] }
      return conversation
    },
    refreshConversation: async () => {}, selectedChat: ref(null), selectedSessionId: ref(''), currentCaseId: ref(''), showToast: () => {},
  })

  const first = chat.onSend('第一条', [])
  const second = chat.onSend('第二条', [])
  assert.equal(generating.value, true)
  releaseCreation()
  await Promise.all([first, second])

  assert.equal(creates, 1)
  assert.equal(runs, 1)
  assert.deepEqual(conversation.messages.map(message => message.content), ['第一条', ''])
})

test('运行接口失败时保留原始错误并写入助手占位消息', async t => {
  const notices = []
  const conversation = { id: 'conv_test', title: '已有对话', messages: [] }
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: false, error: '模型服务暂不可用' }, { status: 503 }))
  const chat = useChatRun({
    generating: ref(false), currentConv: () => conversation,
    newConversation: async () => {}, refreshConversation: async () => {},
    selectedChat: ref(null), selectedSessionId: ref(''), currentCaseId: ref(''), showToast: message => notices.push(message),
  })

  await chat.onSend('帮我分析一下', [])

  assert.equal(conversation.messages[1].content, '\n\n(连接失败：模型服务暂不可用)')
  assert.equal(notices.at(-1), '模型服务暂不可用')
})
