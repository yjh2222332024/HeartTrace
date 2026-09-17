import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  STYLE_PRESETS,
  clusterAndGradeRules,
  compileSkillDraft,
  writeSkillToDisk,
  createBuilderRuntime,
} from './builder.js'

test('clusterAndGradeRules 能够根据出现频次与跨阶段精确划分三级定级', () => {
  const mockCases = [
    {
      has_valid_case: true,
      bvid: 'BV1case1',
      case: { relationship_stage: '初识' },
      candidate_rules: [
        {
          rule_name: '不紧不慢回复',
          statement: '如果对方回复间隔长，在初识阶段更支持同步拉长间隔',
          if_conditions: ['对方回复慢'],
          then_inference: '同步降速',
          suggested_actions: ['拉长回复时间'],
          citations: ['BV1case1:10'],
        },
        {
          rule_name: '冷笑话破冰',
          statement: '如果初识冷场，发冷笑话破冰',
          suggested_actions: ['发一个冷笑话'],
          citations: ['BV1case1:25'],
        },
      ],
      danger_flags: ['对方言语侮辱'],
    },
    {
      has_valid_case: true,
      bvid: 'BV1case2',
      case: { relationship_stage: '暧昧' },
      candidate_rules: [
        {
          rule_name: '不紧不慢回复',
          statement: '如果对方回复间隔长，在暧昧期也应同步降速',
          then_inference: '同步降速',
          suggested_actions: ['不连续追问'],
          citations: ['BV1case2:40'],
        },
        {
          rule_name: '周末邀约测试',
          statement: '在暧昧期如果对方连续2天互动良好，可邀约周末见面',
          suggested_actions: ['提出具体时间邀约'],
          citations: ['BV1case2:80'],
        },
      ],
    },
    {
      has_valid_case: true,
      bvid: 'BV1case3',
      case: { relationship_stage: '交往' },
      candidate_rules: [
        {
          rule_name: '不紧不慢回复',
          statement: '在交往初期若遇冷淡，亦保持原有节奏',
          then_inference: '同步降速',
          suggested_actions: ['做好自己的事'],
          citations: ['BV1case3:15'],
        },
      ],
    },
  ]

  const summary = clusterAndGradeRules(mockCases)

  // 1. 不紧不慢回复 在 3 个案例中跨阶段复现 -> 验证规则
  const slowReply = summary.verifiedRules.find(r => r.ruleName === '不紧不慢回复')
  assert.ok(slowReply, '应当存在「不紧不慢回复」验证规则')
  assert.equal(slowReply.level, '验证规则')
  assert.equal(slowReply.caseCount, 3)
  assert.equal(slowReply.crossStageCount, 3)
  assert.equal(slowReply.generality, '较强可迁移')

  // 2. 冷笑话破冰 与 周末邀约测试 仅在 1 个案例中出现 -> 案例启发式（单篇观点）
  const iceBreaker = summary.caseHeuristics.find(r => r.ruleName === '冷笑话破冰')
  assert.ok(iceBreaker, '冷笑话破冰应属于案例启发式')
  assert.equal(iceBreaker.level, '案例启发式')
  assert.equal(iceBreaker.caseCount, 1)

  // 3. 危险信号收集
  assert.ok(summary.dangerFlags.includes('对方言语侮辱'))
})

test('clusterAndGradeRules 不会因两个阶段的两条案例就升级为验证规则', () => {
  const summary = clusterAndGradeRules([
    {
      has_valid_case: true,
      bvid: 'BV1case11',
      case: { relationship_stage: '初识' },
      key_signals: [{ category: 'rejection_cue' }],
      candidate_rules: [{
        rule_name: '第一次命名',
        statement: '如果明确拒绝，更支持停止推进',
        if_conditions: ['明确拒绝'],
        then_inference: '停止推进',
        citations: ['BV1case11:10'],
      }],
    },
    {
      has_valid_case: true,
      bvid: 'BV1case22',
      case: { relationship_stage: '暧昧' },
      key_signals: [{ category: 'rejection_cue' }],
      candidate_rules: [{
        rule_name: '另一种命名',
        statement: '如果明确拒绝，更支持停止推进',
        if_conditions: ['明确拒绝'],
        then_inference: '停止推进',
        citations: ['BV1case22:18'],
      }],
    },
  ])
  assert.equal(summary.verifiedRules.length, 0)
  assert.equal(summary.candidateRules.length, 1)
  assert.equal(summary.candidateRules[0].crossStageCount, 2)
})

test('compileSkillDraft 编译出符合规范的 Skill 文件树及解耦风格', () => {
  const rulesSummary = {
    verifiedRules: [
      {
        ruleName: '止损信号识别',
        level: '验证规则',
        statement: '如果明确拒绝且不给备选时间，支持止损',
        suggestedActions: ['礼貌结束对话', '不再主动发起'],
        stages: ['初识', '追求'],
        citations: ['BV1xxx:10'],
      },
    ],
    candidateRules: [],
    caseHeuristics: [
      {
        ruleName: '水族馆邀约',
        level: '案例启发式',
        statement: '如果首次约会不知去哪，去水族馆更容易打破沉闷',
        suggestedActions: ['提议水族馆'],
        citations: ['BV2yyy:45'],
      },
    ],
    dangerFlags: ['经济试探'],
  }

  const draft = compileSkillDraft({
    id: 'test-advisor',
    name: '测试军师',
    rulesSummary,
    styleType: 'gentle',
    sources: [{ title: '测试视频', bvid: 'BV1xxx' }],
  })

  assert.equal(draft.advisorId, 'test-advisor')
  assert.equal(draft.manifest.name, '测试军师')
  assert.ok(draft.files['manifest.json'])
  assert.ok(draft.files['SKILL.md'])
  assert.ok(draft.files['references/core/boundaries.md'])
  assert.ok(draft.files['references/signals/signal-recognition.md'])
  assert.ok(draft.files['references/cases/casebook.md'])
  assert.ok(draft.files['style/style.md'])

  // 验证风格与方法论解耦
  assert.ok(draft.files['style/style.md'].includes(STYLE_PRESETS.gentle.prompt))
  // 验证启发式规则有明确警示
  assert.ok(draft.files['references/cases/casebook.md'].includes('未写入此军师'))
  assert.doesNotMatch(draft.files['references/cases/casebook.md'], /水族馆邀约/)
  assert.doesNotMatch(draft.files['references/signals/signal-recognition.md'], /水族馆邀约/)
  assert.doesNotMatch(draft.files['references/playbooks/communication.md'], /不紧不慢/)
})

test('writeSkillToDisk 能够将草稿写入磁盘并拦截路径逃逸', () => {
  const tmpSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'))
  try {
    const draft = {
      advisorId: 'my-custom-advisor',
      files: {
        'manifest.json': '{"id":"my-custom-advisor"}',
        'SKILL.md': '# Hello Advisor',
        'references/core/boundaries.md': '# Boundaries',
      },
    }

    const res = writeSkillToDisk(draft, { skillsDir: tmpSkillsDir })
    assert.equal(res.ok, true)
    assert.ok(fs.existsSync(path.join(tmpSkillsDir, 'my-custom-advisor', 'manifest.json')))
    assert.ok(fs.existsSync(path.join(tmpSkillsDir, 'my-custom-advisor', 'references', 'core', 'boundaries.md')))
    assert.throws(() => writeSkillToDisk(draft, { skillsDir: tmpSkillsDir }), /已存在/)

    // 路径逃逸测试
    const evilDraft = {
      advisorId: '../evil-advisor',
      files: { 'SKILL.md': '# Evil' },
    }
    assert.throws(() => writeSkillToDisk(evilDraft, { skillsDir: tmpSkillsDir }), /非法军师 ID/)
  } finally {
    fs.rmSync(tmpSkillsDir, { recursive: true, force: true })
  }
})

test('createBuilderRuntime 完整执行管道模拟测试', async () => {
  const tmpSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-runtime-test-'))
  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-runtime-test-'))
  process.env.LOVE_ADVISOR_DATA_DIR = tmpDataDir

  try {
    const mockChat = async () => ({
      content: JSON.stringify({
        has_valid_case: true,
        case: {
          relationship_stage: '初识',
          core_problem: '对方不主动聊天',
          facts: ['加了好友一周', '聊过两次'],
        },
        candidate_rules: [
          {
            rule_name: '被动降温测试',
            statement: '如果初识阶段对方从不主动发起，更支持其兴趣度低',
            if_conditions: ['发起率为0'],
            then_inference: '兴趣度低',
            suggested_actions: ['停止单向发起'],
            evidence: [{ citation: 'L1', quote: '加了好友对方不主动发消息' }],
          },
        ],
        danger_flags: [],
      }),
    })

    const runtime = createBuilderRuntime({
      skillsDir: tmpSkillsDir,
      getEnv: () => ({ BASE_URL: 'https://mock.llm.com', BASE_MODEL: 'mock-model', API_KEY: 'test' }),
      streamChat: mockChat,
    })

    const job = await runtime.startJob({
      name: '自动化测试军师',
      id: 'auto-advisor',
      sources: [
        {
          type: 'text',
          title: '测试字幕',
          content: '[00:01] L1 用户：加了好友对方不主动发消息\n[00:05] L2 军师：如果从来不主动，就不要天天找他',
        },
      ],
      styleType: 'direct',
    })

    assert.equal(job.advisorName, '自动化测试军师')
    assert.ok(job.id.startsWith('bjob_'))

    // 等待异步任务完成
    let finishedJob = null
    for (let i = 0; i < 30; i++) {
      finishedJob = runtime.getJob(job.id)
      if (finishedJob.state === 'draft_ready' || finishedJob.state === 'failed') break
      await new Promise(r => setTimeout(r, 50))
    }

    assert.equal(finishedJob.state, 'draft_ready')
    assert.ok(finishedJob.draft)
    assert.equal(finishedJob.rulesSummary.caseHeuristics.length, 1)

    // 测试更新草稿
    runtime.updateDraft(job.id, { name: '改名后的军师' })
    const updated = runtime.getJob(job.id)
    assert.equal(updated.advisorName, '改名后的军师')
    assert.equal(updated.draft.manifest.name, '改名后的军师')

    runtime.updateDraft(job.id, {
      rulesSummary: { verifiedRules: [], candidateRules: [], caseHeuristics: [], dangerFlags: [] },
    })
    const reviewed = runtime.getJob(job.id)
    assert.doesNotMatch(reviewed.draft.files['references/signals/signal-recognition.md'], /被动降温测试/)

    // 测试发布到磁盘
    const pub = runtime.publishSkill(job.id)
    assert.equal(pub.ok, true)
    assert.ok(fs.existsSync(path.join(tmpSkillsDir, 'auto-advisor', 'manifest.json')))
    assert.ok(fs.existsSync(path.join(tmpSkillsDir, 'auto-advisor', 'SKILL.md')))
  } finally {
    fs.rmSync(tmpSkillsDir, { recursive: true, force: true })
    fs.rmSync(tmpDataDir, { recursive: true, force: true })
  }
})

test('构建会拒绝与原字幕不一致的模型规则，避免生成空壳军师', async () => {
  const tmpSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-grounding-test-'))
  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-grounding-test-'))
  process.env.LOVE_ADVISOR_DATA_DIR = tmpDataDir

  try {
    const runtime = createBuilderRuntime({
      skillsDir: tmpSkillsDir,
      getEnv: () => ({ BASE_URL: 'https://mock.llm.com', BASE_MODEL: 'mock-model', API_KEY: 'test' }),
      streamChat: async () => ({
        content: JSON.stringify({
          has_valid_case: true,
          case: { relationship_stage: '初识', core_problem: '聊天频率' },
          candidate_rules: [{
            rule_name: '伪造的车载规则',
            statement: '如果驾驶员喊热，就打开座椅通风',
            then_inference: '调节座舱温度',
            evidence: [{ citation: 'L1', quote: '打开座椅通风' }],
          }],
        }),
      }),
    })

    const job = await runtime.startJob({
      name: '证据校验测试',
      id: 'grounding-test',
      sources: [{ type: 'text', title: '聊天字幕', content: '[00:01] L1 对方：这周末要不要一起吃饭' }],
    })

    let finishedJob = null
    for (let i = 0; i < 30; i++) {
      finishedJob = runtime.getJob(job.id)
      if (finishedJob.state === 'draft_ready' || finishedJob.state === 'failed') break
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    assert.equal(finishedJob.state, 'failed')
    assert.match(finishedJob.error, /未提取出有效的方法论案例/)
    assert.equal(finishedJob.draft, null)
  } finally {
    fs.rmSync(tmpSkillsDir, { recursive: true, force: true })
    fs.rmSync(tmpDataDir, { recursive: true, force: true })
  }
})

test('构建任务不会把临时 B 站登录态写入任务记录', async () => {
  const runtime = createBuilderRuntime({
    getEnv: () => ({}),
    streamChat: async () => ({ content: '{}' }),
  })
  const secret = 'SESSDATA=temporary_session_token_123'
  const job = await runtime.startJob({
    name: '临时登录态测试',
    sources: [{
      type: 'text',
      title: '本地字幕',
      content: '[00:01] L1 这是一条本地字幕',
      cookie: secret,
    }],
    bilibiliCookie: secret,
  })

  assert.doesNotMatch(JSON.stringify(job), /temporary_session_token_123/)
  assert.equal(Object.hasOwn(job.sources[0], 'cookie'), false)

  await new Promise(resolve => setTimeout(resolve, 25))
  assert.doesNotMatch(JSON.stringify(runtime.getJob(job.id)), /temporary_session_token_123/)
})
