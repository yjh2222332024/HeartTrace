import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  migrateLegacyData,
  resolveUserDataDir,
  resolveUserSkillsDir,
} from './runtime-paths.js'

test('用户数据目录遵循 Windows、macOS 和 Linux 平台约定', () => {
  assert.equal(
    resolveUserDataDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, homeDir: 'C:\\Users\\me' }),
    'C:\\Users\\me\\AppData\\Local\\LoveAdvisor',
  )
  assert.equal(
    resolveUserDataDir({ platform: 'darwin', env: {}, homeDir: '/Users/me' }),
    '/Users/me/Library/Application Support/LoveAdvisor',
  )
  assert.equal(
    resolveUserDataDir({ platform: 'linux', env: { XDG_DATA_HOME: '/data/me' }, homeDir: '/home/me' }),
    '/data/me/love-advisor',
  )
  assert.equal(
    resolveUserDataDir({ platform: 'linux', env: {}, homeDir: '/home/me' }),
    '/home/me/.local/share/love-advisor',
  )
})

test('数据和军师目录支持环境变量覆盖', () => {
  assert.equal(
    resolveUserDataDir({ platform: 'linux', env: { LOVE_ADVISOR_DATA_DIR: '/custom/data' }, homeDir: '/home/me' }),
    '/custom/data',
  )
  assert.equal(
    resolveUserSkillsDir({ platform: 'linux', env: { LOVE_ADVISOR_SKILLS_DIR: '/custom/skills' }, homeDir: '/home/me' }),
    '/custom/skills',
  )
})

test('旧数据迁移只复制缺失文件，不覆盖也不删除旧文件', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'love-advisor-migration-'))
  const legacyDataDir = path.join(root, 'legacy')
  const dataDir = path.join(root, 'current')
  try {
    fs.mkdirSync(legacyDataDir, { recursive: true })
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(legacyDataDir, 'cases.json'), '[{"old":true}]')
    fs.writeFileSync(path.join(legacyDataDir, 'settings.json'), '{"source":"legacy"}')
    fs.writeFileSync(path.join(dataDir, 'settings.json'), '{"source":"current"}')

    const result = migrateLegacyData({ legacyDataDir, dataDir })
    assert.deepEqual(result.copied, ['cases.json'])
    assert.deepEqual(result.skipped, ['settings.json'])
    assert.equal(fs.readFileSync(path.join(dataDir, 'cases.json'), 'utf8'), '[{"old":true}]')
    assert.equal(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'), '{"source":"current"}')
    assert.equal(fs.readFileSync(path.join(legacyDataDir, 'cases.json'), 'utf8'), '[{"old":true}]')

    const second = migrateLegacyData({ legacyDataDir, dataDir })
    assert.deepEqual(second.copied, [])
    assert.deepEqual(second.skipped.sort(), ['cases.json', 'settings.json'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
