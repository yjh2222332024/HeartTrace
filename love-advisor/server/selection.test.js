import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSelectedMessages, validateSelection, selectionCacheKey, compactSelection, citedMessageIds } from './selection.js'

test('selection cache key 由 session + 排序后的 id 组成，compact 不含正文', () => {
  const ctx = {
    sessionId: 'chat_1',
    sessionName: 'Peer',
    messages: [
      { id: 3, content: 'secret later' },
      { id: 1, content: 'secret first' },
    ],
  }
  assert.deepEqual(citedMessageIds(ctx), [1, 3])
  assert.equal(selectionCacheKey(ctx), 'cite:chat_1:1,3')
  assert.equal(selectionCacheKey({ sessionId: 'chat_1', messageIds: [3, 1, 1] }), 'cite:chat_1:1,3')
  const compact = compactSelection(ctx)
  assert.equal(compact.cached, true)
  assert.equal(compact.key, 'cite:chat_1:1,3')
  assert.deepEqual(compact.messageIds, [1, 3])
  assert.equal(compact.count, 2)
  assert.equal(compact.content, undefined)
  assert.equal(compact.messages, undefined)
})

test('selection validates workspace, IDs and count', () => {
  assert.throws(() => validateSelection({ sessionId: 'other', messageIds: [1] }, 'chat'))
  for (const messageIds of [[], [0], ['1'], Array(51).fill(1)]) {
    assert.throws(() => validateSelection({ sessionId: 'chat', messageIds }, 'chat'))
  }
  assert.deepEqual(validateSelection({ sessionId: 'chat', messageIds: [1, 1, 2] }, 'chat'), [1, 2])
})

test('selection retrieves full anchors only, orders them and rejects missing records', async () => {
  const deps = {
    loadSession: async () => ({ id: 'chat', name: 'Test peer' }),
    query: async args => {
      assert.ok(args.includes('--full'))
      return JSON.stringify({ ok: true, data: { items: [
        { id: 2, time: '2026-09-10 12:01', senderName: 'Peer', content: 'x'.repeat(800) },
        { id: 1, time: '2026-09-10 12:00', senderName: 'Me', content: 'Question' },
        { id: 3, time: '2026-09-10 12:02', content: 'Unselected' },
      ] } })
    },
  }
  const result = await loadSelectedMessages({ sessionId: 'chat', messageIds: [2, 1] }, deps)
  assert.deepEqual(result.messages.map(m => m.id), [1, 2])
  assert.equal(result.messages[1].content.length, 800)
  await assert.rejects(loadSelectedMessages({ sessionId: 'chat', messageIds: [4] }, deps), /失效/)
})
