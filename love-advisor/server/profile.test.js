import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickLatency, pickFrequency } from './profile.js'

test('pickLatency 读 clb medianSeconds，并优先机主', () => {
  const response = {
    items: [
      { name: 'Eudeamonia', medianSeconds: 26, avgSeconds: 185 },
      { name: '没钥匙的锁', medianSeconds: 21, avgSeconds: 178 },
    ],
  }
  assert.equal(pickLatency(response, '没钥匙的锁'), 21)
  assert.equal(pickLatency(response, 'Eudeamonia'), 26)
  assert.equal(pickLatency(response), 26)
})

test('pickFrequency 读 firstMessage/lastMessage/totalMessages', () => {
  const overview = {
    totalMessages: 9958,
    firstMessage: '2025-11-14T19:36:58+08:00',
    lastMessage: '2026-09-05T14:42:54+08:00',
  }
  const text = pickFrequency(overview)
  assert.match(text, /9958 条/)
  assert.match(text, /条\/天/)
})
