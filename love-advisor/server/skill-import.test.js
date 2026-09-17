import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { createSkillImportRuntime, inspectSkillPackage, installSkillPackage } from './skill-import.js'
import { registerSkillImportRoutes } from './skill-import-routes.js'

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// 测试专用的最小 ZIP（stored entries，不依赖外部打包工具）。
function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, text] of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const data = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8')
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0, 6)
    header.writeUInt16LE(0, 8)
    header.writeUInt32LE(crc32(data), 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(nameBuf.length, 26)
    const local = Buffer.concat([header, nameBuf, data])
    locals.push(local)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(crc32(data), 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, nameBuf]))
    offset += local.length
  }
  const centralData = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralData.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralData, end])
}

function validPackage(root = 'coach-a', id = root) {
  const manifest = {
    id,
    name: '测试军师',
    description: '用来验证本地 ZIP 导入。',
    entry: 'SKILL.md',
    alwaysLoad: ['references/core/boundaries.md'],
    routes: [{ about: '沟通', load: ['references/playbooks/communication.md'] }],
  }
  return makeZip([
    [`${root}/manifest.json`, JSON.stringify(manifest)],
    [`${root}/SKILL.md`, '# 测试军师\n\n先读边界，再按路由读取资料。'],
    [`${root}/references/core/boundaries.md`, '# 边界\n\n尊重与安全优先。'],
    [`${root}/references/playbooks/communication.md`, '# 沟通\n\n先复述，再表达。'],
    [`${root}/scripts/prepare.py`, 'print("这段脚本仅随包保存")'],
  ])
}

test('Skill ZIP：检查通过后原子安装；脚本作为静态文件保留', async () => {
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-skill-import-'))
  try {
    const inspected = await inspectSkillPackage(validPackage(), 'coach-a.zip')
    assert.equal(inspected.summary.id, 'coach-a')
    assert.equal(inspected.summary.scriptCount, 1)
    assert.deepEqual(inspected.summary.scriptPaths, ['scripts/prepare.py'])

    const installed = installSkillPackage(inspected, { skillsDir })
    assert.equal(installed.id, 'coach-a')
    assert.equal(fs.readFileSync(path.join(skillsDir, 'coach-a', 'scripts', 'prepare.py'), 'utf8'), 'print("这段脚本仅随包保存")')
    assert.throws(() => installSkillPackage(inspected, { skillsDir }), /已存在/)
  } finally {
    fs.rmSync(skillsDir, { recursive: true, force: true })
  }
})

test('Skill ZIP：用户包不能覆盖内置军师 ID', async () => {
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-user-skills-'))
  const builtInSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-built-in-skills-'))
  try {
    fs.mkdirSync(path.join(builtInSkillsDir, 'coach-a'))
    fs.writeFileSync(path.join(builtInSkillsDir, 'coach-a', 'SKILL.md'), '# 内置军师')
    const inspected = await inspectSkillPackage(validPackage(), 'coach-a.zip')
    assert.throws(
      () => installSkillPackage(inspected, { skillsDir, builtInSkillsDir }),
      /内置军师，不能覆盖/,
    )
    assert.equal(fs.existsSync(path.join(skillsDir, 'coach-a')), false)
  } finally {
    fs.rmSync(skillsDir, { recursive: true, force: true })
    fs.rmSync(builtInSkillsDir, { recursive: true, force: true })
  }
})

test('Skill ZIP：拒绝根目录与 manifest.id 不一致、路径逃逸和缺失的路由文件', async () => {
  await assert.rejects(inspectSkillPackage(validPackage('different-root', 'coach-a'), 'package.zip'), /根目录名称/)

  const traversal = makeZip([
    ['coach-a/manifest.json', JSON.stringify({ id: 'coach-a', name: '测试军师' })],
    ['coach-a/SKILL.md', '# 测试军师\n\n这是军师的总控入口文档，按需路由到对应资料。'],
    ['coach-a/../escape.md', 'bad'],
  ])
  await assert.rejects(inspectSkillPackage(traversal, 'package.zip'), /路径不安全|ZIP 解析失败/)

  const missingReference = makeZip([
    ['coach-a/manifest.json', JSON.stringify({ id: 'coach-a', name: '测试军师', alwaysLoad: ['references/missing.md'] })],
    ['coach-a/SKILL.md', '# 测试军师\n\n这是军师的总控入口文档，按需路由到对应资料。'],
  ])
  await assert.rejects(inspectSkillPackage(missingReference, 'package.zip'), /不存在的文件/)

  const looseScript = makeZip([
    ['coach-a/manifest.json', JSON.stringify({ id: 'coach-a', name: '测试军师' })],
    ['coach-a/SKILL.md', '# 测试军师\n\n这是入口文档。'],
    ['coach-a/unsafe.js', 'console.log("never run")'],
  ])
  await assert.rejects(inspectSkillPackage(looseScript, 'package.zip'), /scripts/)
})

test('Skill ZIP：检查结果只在内存短暂保留，安装一次后立即失效', async () => {
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-skill-pending-'))
  try {
    const runtime = createSkillImportRuntime({ skillsDir, ttlMs: 100 })
    const preview = await runtime.inspect(validPackage(), 'coach-a.zip')
    const installed = runtime.install(preview.token)
    assert.equal(installed.id, 'coach-a')
    assert.throws(() => runtime.install(preview.token), /已过期/)
  } finally {
    fs.rmSync(skillsDir, { recursive: true, force: true })
  }
})

test('Skill ZIP API：multipart 检查后确认安装', async t => {
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-skill-api-'))
  const app = express()
  registerSkillImportRoutes(app, { skillsDir })
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => {
    fs.rmSync(skillsDir, { recursive: true, force: true })
    return new Promise(resolve => server.close(resolve))
  })

  const base = `http://127.0.0.1:${server.address().port}`
  const form = new FormData()
  form.append('file', new Blob([validPackage()], { type: 'application/zip' }), 'coach-a.zip')
  const inspected = await fetch(`${base}/api/advisor-imports/inspect`, { method: 'POST', body: form })
  assert.equal(inspected.status, 200)
  const preview = (await inspected.json()).data
  assert.equal(preview.id, 'coach-a')

  const installed = await fetch(`${base}/api/advisor-imports/${preview.token}/install`, { method: 'POST' })
  assert.equal(installed.status, 200)
  assert.ok(fs.existsSync(path.join(skillsDir, 'coach-a', 'SKILL.md')))
})
