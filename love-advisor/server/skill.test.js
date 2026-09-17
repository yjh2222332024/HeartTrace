// ── skill.js：渐进披露装配 / 目录 / 按需读文档 ────────
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'love-advisor-skills-test-'))
process.env.LOVE_ADVISOR_SKILLS_DIR = tmpDir

const { createSkillRuntime } = await import('./skill.js')
const { createAdvisorPromptStore, DEFAULT_ADVISOR_SYSTEM_PROMPT } = await import('./advisor-prompts.js')

const A_DIR = path.join(tmpDir, 'advisor-a')
const B_DIR = path.join(tmpDir, 'advisor-b')

function writeFile(rel, body) {
  const p = path.join(tmpDir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}

function makeRuntime() {
  return createSkillRuntime({ skillsDir: tmpDir })
}

beforeEach(() => {
  fs.rmSync(A_DIR, { recursive: true, force: true })
  fs.rmSync(B_DIR, { recursive: true, force: true })
  writeFile('advisor-a/SKILL.md', '---\nname: 军师A\ndescription: 测试军师A\ntype: advisor\n---\n# 军师A 总控\n怎么回她 → 读 communication.md\n')
  writeFile('advisor-a/references/core/boundaries.md', '边界规则：威胁/操控/纠缠必须停止策略。')
  writeFile('advisor-a/references/core/methodology.md', '方法论：先判断关系阶段，再决定训练目标。')
  writeFile('advisor-a/references/signals/signals.md', '信号规则：不回消息=弱信号。')
  writeFile('advisor-a/references/playbooks/advance.md', '推进规则：低压力邀约。')
  writeFile('advisor-a/references/playbooks/communication.md', '沟通规则：先给可发的回复。')
  writeFile('advisor-a/style/voice.md', '军师A 语气：短句连发。')
  writeFile('advisor-a/manifest.json', JSON.stringify({
    id: 'advisor-a', name: '军师A', default: true, entry: 'SKILL.md',
    alwaysLoad: ['references/core/boundaries.md'],
    style: ['style/voice.md'],
    trainingLoad: ['references/core/methodology.md', 'references/playbooks/communication.md'],
    routes: [
      { about: '信号解读、喜不喜欢、不回消息', load: ['references/signals/signals.md'] },
      { about: '推进、表白、约不出来', load: ['references/playbooks/advance.md'] },
      { about: '怎么回复、聊什么、冷场', load: ['references/playbooks/communication.md'] },
    ],
  }))
  writeFile('advisor-b/SKILL.md', '---\nname: 军师B\ndescription: 测试军师B\n---\n# 军师B\n')
  writeFile('advisor-b/references/x.md', '军师B 资料。')
})

test('scanSkills：有 manifest 的按 manifest，无 manifest 的目录名兜底', () => {
  const rt = makeRuntime()
  const list = rt.list()
  assert.equal(list.length, 2)
  const a = list.find(s => s.id === 'advisor-a')
  const b = list.find(s => s.id === 'advisor-b')
  assert.equal(a.name, '军师A')
  assert.equal(a.default, true)
  assert.equal(b.id, 'advisor-b')
  assert.equal(b.name, '军师B')
})

test('默认运行时合并内置和用户军师，重复 ID 以内置版本为准', () => {
  const builtInDir = fs.mkdtempSync(path.join(os.tmpdir(), 'love-advisor-built-in-skills-'))
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'love-advisor-user-skills-'))
  try {
    const writeSkill = (root, id, name) => {
      const dir = path.join(root, id)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n# ${name}\n`)
    }
    writeSkill(builtInDir, 'shared', '内置版本')
    writeSkill(userDir, 'shared', '用户重复版本')
    writeSkill(userDir, 'custom', '用户军师')

    const rt = createSkillRuntime({ builtInSkillsDir: builtInDir, userSkillsDir: userDir })
    const skills = rt.scanSkills()
    assert.deepEqual(skills.map(item => item.id), ['shared', 'custom'])
    assert.equal(skills.find(item => item.id === 'shared').name, '内置版本')
    assert.equal(skills.find(item => item.id === 'custom').name, '用户军师')
  } finally {
    fs.rmSync(builtInDir, { recursive: true, force: true })
    fs.rmSync(userDir, { recursive: true, force: true })
  }
})

test('军师选择：仅显式有效 id 启用，不回退默认军师', () => {
  const rt = makeRuntime()
  const skills = rt.scanSkills()
  const auto = rt.pickAdvisor(skills, [])
  assert.equal(auto, null)
  const picked = rt.pickAdvisor(skills, ['advisor-b'])
  assert.equal(picked.skill.id, 'advisor-b')
  assert.equal(picked.auto, false)
  const miss = rt.pickAdvisor(skills, ['not-exist'])
  assert.equal(miss, null)
  assert.equal(rt.pickAdvisor(skills, 'advisor-a'), null)
})

test('assemble：L0 + 目录，不预注入 SKILL / 边界 / 风格正文', () => {
  const rt = makeRuntime()
  const out = rt.assemble({ selectedIds: ['advisor-a'] })
  assert.ok(out.prompt.includes('安全层'), 'L0 安全层必须注入')
  assert.ok(out.prompt.includes('身份锁定'), 'L0 必须锁定顾问身份，禁止扮演对方')
  assert.equal(out.skillId, 'advisor-a')
  assert.equal(out.auto, false)
  assert.ok(out.prompt.includes('当前军师：军师A'))
  assert.ok(out.prompt.includes('skill_doc_catalog'))
  assert.ok(out.prompt.includes('SKILL.md'))
  assert.ok(out.prompt.includes('references/core/boundaries.md'))
  assert.ok(out.prompt.includes('style/voice.md'))
  assert.ok(out.prompt.includes('references/playbooks/communication.md'))
  assert.ok(!out.prompt.includes('# 军师A 总控'))
  assert.ok(!out.prompt.includes('边界规则'))
  assert.ok(!out.prompt.includes('军师A 语气'))
  assert.ok(!out.prompt.includes('沟通规则：先给可发的回复'))
  assert.ok(!out.prompt.includes('信号规则：不回消息=弱信号'))
  assert.deepEqual(out.loadedDocs, [])
})

test('assemble 显式选择军师：auto=false', () => {
  const rt = makeRuntime()
  const out = rt.assemble({ selectedIds: ['advisor-a'] })
  assert.equal(out.auto, false)
  assert.ok(out.prompt.includes('用户手动选择'))
  const out2 = rt.assemble({ selectedIds: ['not-exist'] })
  assert.equal(out2.skillId, null)
  assert.equal(out2.auto, false)
})

test('未 @ 时不注入技能入口、基础文件、风格或目录', () => {
  const rt = makeRuntime()
  rt.assemble({ selectedIds: ['advisor-a'] })
  const out = rt.assemble()
  assert.equal(out.skillId, null)
  assert.deepEqual(out.loadedDocs, [])
  assert.doesNotMatch(out.prompt, /军师A|边界规则|skill_doc_catalog|短句连发/)
})

test('无 manifest 的军师：只给目录，不注入 SKILL 正文', () => {
  const rt = makeRuntime()
  const out = rt.assemble({ selectedIds: ['advisor-b'] })
  assert.ok(out.prompt.includes('当前军师：军师B'))
  assert.ok(out.prompt.includes('SKILL.md'))
  assert.ok(out.prompt.includes('references/x.md'))
  assert.ok(!out.prompt.includes('# 军师B\n'))
  assert.ok(!out.prompt.includes('军师B 资料。'))
})

test('read_skill_doc：按需读正文；路径逃逸拒绝', () => {
  const rt = makeRuntime()
  const doc = rt.readDocFor('advisor-a', 'references/playbooks/communication.md')
  assert.equal(doc.ok, true)
  assert.ok(doc.content.includes('沟通规则'))
  const escaped = rt.readDocFor('advisor-a', '../../secret.md')
  assert.equal(escaped.ok, false)
  const missing = rt.readDocFor('advisor-a', 'references/nope.md')
  assert.equal(missing.ok, false)
})

test('训练军师资料包冻结总控、边界、风格和训练方法，并受总预算约束', () => {
  const rt = makeRuntime()
  const pack = rt.buildTrainingPackage('advisor-a')
  assert.equal(pack.ok, true)
  assert.equal(pack.advisorId, 'advisor-a')
  assert.match(pack.docsText, /军师A 总控/)
  assert.match(pack.docsText, /边界规则/)
  assert.match(pack.docsText, /短句连发/)
  assert.match(pack.docsText, /先判断关系阶段/)
  assert.match(pack.docsText, /先给可发的回复/)
  assert.ok(pack.loadedDocs.includes('SKILL.md'))
  assert.ok(pack.bytes <= 24 * 1024)
})

test('空 skills 目录：只剩 L0 安全层', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'love-advisor-empty-skills-'))
  const rt = createSkillRuntime({ skillsDir: emptyDir })
  const out = rt.assemble({ selectedIds: [] })
  assert.equal(out.skillId, null)
  assert.ok(out.prompt.includes('安全层'))
  assert.ok(out.prompt.includes('身份锁定'))
})

test('默认军师 system prompt 可覆盖、持久化并恢复默认', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'love-advisor-prompts-test-'))
  const store = createAdvisorPromptStore({ dataDir })
  const rt = createSkillRuntime({ skillsDir: tmpDir, promptStore: store })

  assert.equal(rt.promptConfigFor('default').prompt, DEFAULT_ADVISOR_SYSTEM_PROMPT)
  assert.ok(rt.assemble().prompt.includes(DEFAULT_ADVISOR_SYSTEM_PROMPT))

  rt.setPrompt('default', '这是用户修改后的默认军师提示词。')
  assert.ok(rt.assemble().prompt.includes('这是用户修改后的默认军师提示词。'))
  assert.equal(createAdvisorPromptStore({ dataDir }).get('default', '').customized, true)

  rt.resetPrompt('default')
  const restored = rt.promptConfigFor('default')
  assert.equal(restored.customized, false)
  assert.equal(restored.prompt, DEFAULT_ADVISOR_SYSTEM_PROMPT)
  assert.doesNotMatch(rt.assemble().prompt, /用户修改后的默认军师提示词/)
})

test('自定义军师 system prompt 仅在选中该军师时注入', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'love-advisor-skill-prompts-test-'))
  const store = createAdvisorPromptStore({ dataDir })
  const rt = createSkillRuntime({ skillsDir: tmpDir, promptStore: store })

  rt.setPrompt('advisor-a', '军师 A 的自定义 system prompt。')
  assert.ok(rt.assemble({ selectedIds: ['advisor-a'] }).prompt.includes('军师 A 的自定义 system prompt。'))
  assert.doesNotMatch(rt.assemble({ selectedIds: ['advisor-b'] }).prompt, /军师 A 的自定义 system prompt/)
  assert.doesNotMatch(rt.assemble().prompt, /军师 A 的自定义 system prompt/)
  assert.throws(() => rt.setPrompt('missing-advisor', '无效'), /军师不存在/)
  assert.throws(() => rt.setPrompt('advisor-a', ''), /不能为空/)
})
