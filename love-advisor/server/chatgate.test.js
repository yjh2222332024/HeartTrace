import assert from 'node:assert/strict'
import test from 'node:test'
import { isGroupChat, assertPrivateChat } from './chatgate.js'

test('group chats are blocked, private chats pass', () => {
  assert.equal(isGroupChat({ type: 'group' }), true)
  assert.equal(isGroupChat({ chatType: 2 }), true)
  assert.equal(isGroupChat({ memberCount: 8 }), true)
  assert.equal(isGroupChat({ type: 'private', name: '小美' }), false)
  assert.throws(() => assertPrivateChat({ type: 'group', name: '班级群' }), /班级群/)
  assert.equal(assertPrivateChat({ type: 'private' }).type, 'private')
})
