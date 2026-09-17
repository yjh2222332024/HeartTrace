import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { getPicPath, registerQqMediaRoutes, _usePicDirsForTest } from './qqmedia.js'

const HASH_ORI = 'a'.repeat(32)
const HASH_THUMB = 'b'.repeat(32)
const HASH_MISS = 'c'.repeat(32)

test('qqmedia: 哈希解析 Ori 优先 / Thumb 兜底 / 未命中 / 非法哈希', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqpic-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, '2026-08', 'Ori'), { recursive: true })
  fs.mkdirSync(path.join(root, '2026-08', 'Thumb'), { recursive: true })
  fs.writeFileSync(path.join(root, '2026-08', 'Ori', `${HASH_ORI}.jpg`), Buffer.from('ori-bytes'))
  // 故意给 HASH_ORI 也放一个 Thumb，验证 Ori 优先
  fs.writeFileSync(path.join(root, '2026-08', 'Thumb', `${HASH_ORI}.jpg`), Buffer.from('thumb-bytes'))
  // 只有 Thumb 的哈希
  fs.writeFileSync(path.join(root, '2026-08', 'Thumb', `${HASH_THUMB}.png`), Buffer.from('thumb-bytes'))
  _usePicDirsForTest([root])

  const ori = getPicPath(HASH_ORI)
  assert.ok(ori, 'Ori 命中')
  assert.ok(ori.file.endsWith(path.join('Ori', `${HASH_ORI}.jpg`)), `应选 Ori 原图: ${ori.file}`)
  assert.equal(ori.mime, 'image/jpeg')

  const thumb = getPicPath(HASH_THUMB.toUpperCase()) // 大写也应归一化命中
  assert.ok(thumb, 'Thumb 兜底命中')
  assert.ok(thumb.file.includes(path.join('Thumb', `${HASH_THUMB}.png`)))
  assert.equal(thumb.mime, 'image/png')

  assert.equal(getPicPath(HASH_MISS), null, '未命中返回 null')
  assert.equal(getPicPath('../etc/passwd'), null, '路径穿越被拒绝')
  assert.equal(getPicPath('zz'), null, '非法哈希被拒绝')
  assert.equal(getPicPath(''), null, '空哈希被拒绝')
})

test('qqmedia: 0 字节 Ori 不命中，回退 Thumb', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqpic-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const hash = 'd'.repeat(32)
  fs.mkdirSync(path.join(root, '2026-07', 'Ori'), { recursive: true })
  fs.mkdirSync(path.join(root, '2026-07', 'Thumb'), { recursive: true })
  fs.writeFileSync(path.join(root, '2026-07', 'Ori', `${hash}.jpg`), '') // 空文件
  fs.writeFileSync(path.join(root, '2026-07', 'Thumb', `${hash}.jpg`), Buffer.from('t'))
  _usePicDirsForTest([root])

  const hit = getPicPath(hash)
  assert.ok(hit, 'Thumb 兜底')
  assert.ok(hit.file.includes(path.join('Thumb', `${hash}.jpg`)))
})

test('qqmedia: GET /api/qq/pic/:hash 返回图片二进制 / 404', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqpic-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, '2026-08', 'Ori'), { recursive: true })
  fs.writeFileSync(path.join(root, '2026-08', 'Ori', `${HASH_ORI}.jpg`), Buffer.from('real-jpg'))
  _usePicDirsForTest([root])

  const app = express()
  registerQqMediaRoutes(app)
  const server = app.listen(0, '127.0.0.1')
  t.after(() => server.close())
  await new Promise(r => server.on('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`

  const ok = await fetch(`${base}/api/qq/pic/${HASH_ORI}`)
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('content-type'), 'image/jpeg')
  assert.equal(Buffer.from(await ok.arrayBuffer()).toString(), 'real-jpg')

  const miss = await fetch(`${base}/api/qq/pic/${HASH_MISS}`)
  assert.equal(miss.status, 404)

  const silentMiss = await fetch(`${base}/api/qq/pic/${HASH_MISS}?fallback=1`)
  assert.equal(silentMiss.status, 204, '浏览器图片展示允许无报错降级')

  const bad = await fetch(`${base}/api/qq/pic/..%2f..%2fetc`)
  assert.equal(bad.status, 404, '路径穿越返回 404')
})
