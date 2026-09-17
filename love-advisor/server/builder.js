// ── 军师构建工作流（Advisor Builder Runtime）──────────────
// 管线：
// 1. 素材清洗：B 站抓取 / 文本解析 → 标准化行号与分片
// 2. 分段提取：LLM 抽取（prop.md 规范 + N1-N6 噪声清洗）
// 3. 跨篇归纳：规则聚类 + 三级定级（验证规则 / 候选规则 / 案例启发式）
// 4. 风格装配：解耦表达风格与方法论内核
// 5. 草稿生成：编译为完整的 Skill 目录树（manifest / SKILL.md / references / style）
// 6. 审核与落盘：支持人审修改，一键原子写入 skills/ 目录

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  fetchSubtitle,
  parseAnySubtitleInput,
  chunkSubtitles,
  extractBvId,
  getBilibiliGuestCookie,
  mergeBilibiliCookies,
  normalizeBilibiliSessionCookie,
  fingerprintSubtitle,
} from './bilibili.js'
import { streamChatCompletion } from './llm.js'
import {
  getBuilderJob,
  upsertBuilderJob,
  listBuilderJobs,
} from './store.js'
import { BUNDLED_SKILLS_DIR, resolveUserSkillsDir } from './runtime-paths.js'

const DEFAULT_SKILLS_DIR = resolveUserSkillsDir()
const MAX_BUILDER_SOURCES = 8
const MAX_TEXT_SOURCE_CHARS = 160 * 1024
const MAX_BUILDER_CHUNKS = 40

function normalizeRulePart(value) {
  return String(value || '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase()
    .slice(0, 120)
}

function isCitationInChunk(citation, chunk) {
  const raw = String(citation || '').trim()
  const match = raw.match(/^(?:(BV[A-Za-z0-9]{10}):)?L?(\d+)(?:\s*[-–]\s*L?(\d+))?$/i)
  if (!match) return false
  const [, citedBvid, fromRaw, toRaw] = match
  if (citedBvid && String(chunk.bvid || '').toLowerCase() !== citedBvid.toLowerCase()) return false
  const from = Number(fromRaw)
  const to = Number(toRaw || fromRaw)
  return Number.isInteger(from) && Number.isInteger(to)
    && from >= chunk.fromLine && to >= from && to <= chunk.toLine
}

function asStringList(value, limit = 12) {
  if (!Array.isArray(value)) return []
  return value
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .slice(0, limit)
}

function citedLines(citation, chunk) {
  const match = String(citation || '').trim().match(/^(?:(BV[A-Za-z0-9]{10}):)?L?(\d+)(?:\s*[-–]\s*L?(\d+))?$/i)
  if (!match || !isCitationInChunk(citation, chunk)) return []
  const from = Number(match[2])
  const to = Number(match[3] || match[2])
  return (chunk.items || []).filter(item => item.line >= from && item.line <= to)
}

function normalizeEvidenceText(value) {
  return String(value || '').replace(/\s+/g, '').trim()
}

function isGroundedEvidence(evidence, chunk) {
  if (!evidence || typeof evidence !== 'object') return false
  const quote = normalizeEvidenceText(evidence.quote)
  if (quote.length < 3 || quote.length > 120) return false
  return citedLines(evidence.citation, chunk)
    .some(item => normalizeEvidenceText(item.content).includes(quote))
}

function sanitizeExtraction(parsed, chunk) {
  if (!parsed || typeof parsed !== 'object') return null
  const candidateRules = (Array.isArray(parsed.candidate_rules) ? parsed.candidate_rules : [])
    .map(rule => {
      if (!rule || typeof rule !== 'object' || !String(rule.statement || '').trim()) return null
      const evidence = (Array.isArray(rule.evidence) ? rule.evidence : [])
        .filter(item => isGroundedEvidence(item, chunk))
        .slice(0, 4)
      if (!evidence.length) return null
      return {
        ...rule,
        if_conditions: asStringList(rule.if_conditions, 6),
        suggested_actions: asStringList(rule.suggested_actions, 6),
        exceptions: asStringList(rule.exceptions, 5),
        risks: asStringList(rule.risks, 5),
        citations: [...new Set(evidence.map(item => String(item.citation).trim()))],
        evidence,
      }
    })
    .filter(Boolean)
  return {
    ...parsed,
    // 一条候选规则都没有通过逐字证据校验，不能被视作可用于构建的案例。
    has_valid_case: parsed.has_valid_case !== false && candidateRules.length > 0,
    candidate_rules: candidateRules,
    key_signals: Array.isArray(parsed.key_signals) ? parsed.key_signals : [],
    danger_flags: Array.isArray(parsed.danger_flags) ? parsed.danger_flags : [],
  }
}

export const STYLE_PRESETS = {
  direct: {
    key: 'direct',
    name: '直接犀利',
    desc: '短句连发，先破后立，不和稀泥，直击本质',
    prompt: '短句连发、先破后立（损完必给步骤）、反问逼站位、金句收尾、黑话点缀（建模/打法/上头/止损）。遇到安全红线或法律危机时，脱离风格切换为平实清晰的现实支持。',
  },
  gentle: {
    key: 'gentle',
    name: '温和陪伴',
    desc: '共情理解，循序渐进，语气温厚，情绪托底',
    prompt: '温和包容、善于倾听、先接纳情绪再剖析行为。用探询式口吻提出建议，步骤温和循序渐进，多鼓励少指责。安全第一。',
  },
  analytical: {
    key: 'analytical',
    name: '理性极简',
    desc: '条理严密，数据与步骤先行，极度冷静',
    prompt: '结构化编号清单输出。先给信号识别与事实证据，再给明确步骤和判断，不带主观情绪词汇，条理清晰，言简意赅。',
  },
  humorous: {
    key: 'humorous',
    name: '幽默风趣',
    desc: '适度自嘲与网梗，化解焦虑与沉重',
    prompt: '风趣生动、适当运用形象比喻和网络幽默化解焦虑，但结论清晰可行，绝不含糊其辞。危急时刻严肃正经。',
  },
  custom: {
    key: 'custom',
    name: '自定义风格',
    desc: '根据用户自定义的描述设定表达口吻',
    prompt: '',
  },
}

function extractJsonObject(text) {
  const raw = String(text || '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('LLM 输出不是有效的 JSON 对象')
  return JSON.parse(raw.slice(start, end + 1))
}

// ── 提示词：单分片方法论抽取（继承 prop.md 与 归纳规范.md）──
const EXTRACTION_SYSTEM_PROMPT = `你是一名专业的情感与人际互动专家方法论提取器。
你的任务不是总结剧情，更不是模仿说话风格或口头禅。
你的核心任务是：从给定的带时间戳和行号的字幕文本中，还原其中包含的客观事实、专家判断结构与策略规则。

重要原则（严格遵守）：
1. 绝对禁止模板套用：每条规则必须依据当前素材中的真实内容，严禁输出与素材无关的通用空话。
2. 强制过滤以下六种非方法论噪声：
   - N1 反串/玩梗（极端化、逗乐、弹幕起哄的言论，与基本理性冲突的一律不采纳）
   - N2 跑题闲聊（借题发挥的无关发挥，不计入因果判断）
   - N3 刻板印象调侃（对地域/专业/性别的整体化调侃）
   - N4 外貌打分/建模评价
   - N5 弹幕互动与观众斗嘴
   - N6 有害/矛盾建议（与人身安全、防骚扰红线冲突的建议严禁采纳）
3. 方法论与表达风格彻底解耦：不要提取任何情绪化措辞或个人口癖，只提取「在何种条件下，更支持何种判断/行动」。
4. 证据链回溯：所有事实与规则必须标注来源于本素材的具体行号或引用（格式如 "BV...:行号" 或 "L12"）。
5. 必须记录规则的适用阶段（陌生/初识/暧昧/交往/冲突/分手）及潜在失效条件或反例。

请直接输出符合以下 JSON 契约的内容（不要输出任何外部多余文字）：
{
  "has_valid_case": true,
  "case": {
    "relationship_stage": "陌生/初识/暧昧/交往/冲突/分手",
    "core_problem": "求助者的核心困扰或判断目标",
    "facts": ["客观事实1", "客观事实2"]
  },
  "key_signals": [
    {
      "signal": "观察到的信号",
      "category": "rejection_cue/interest_cue/boundary_violation/communication_breakdown/other",
      "citation": "素材引用或行号"
    }
  ],
  "candidate_rules": [
    {
      "rule_name": "规则名称（简练概括）",
      "statement": "如果 [条件/信号]，在 [背景约束] 下，更支持 [推断]，而不是 [其他解释]",
      "if_conditions": ["条件1"],
      "then_inference": "推断结论",
      "suggested_actions": ["具体可执行动作步骤"],
      "exceptions": ["失效条件或例外"],
      "risks": ["潜在风险"],
      "evidence": [{"citation": "L12", "quote": "从原字幕逐字摘录的连续短句，3-120字"}]
    }
  ],
  "danger_flags": ["若素材中出现暴力、跟踪、骚扰、极端精神操控等危险信号，在此记录"]
}`

// ── 规则聚类与三级定级 ──────────────────────────────────
export function clusterAndGradeRules(extractedCases = []) {
  const verifiedRules = []
  const candidateRules = []
  const caseHeuristics = []
  const allDangerFlags = new Set()

  const clusters = new Map() // key -> { name, items, cases: Set, stages: Set, citations: Set }

  for (const c of extractedCases) {
    if (!c || !c.has_valid_case) continue
    const stage = c.case?.relationship_stage || '未标注'
    const caseBvid = c.bvid || 'case_' + randomUUID().slice(0, 6)
    const signalCategories = [...new Set((c.key_signals || [])
      .map(signal => String(signal?.category || '').trim())
      .filter(Boolean))]

    for (const df of c.danger_flags || []) {
      if (df && typeof df === 'string') allDangerFlags.add(df)
    }

    for (const rule of c.candidate_rules || []) {
      if (!rule || !rule.statement) continue
      // 按「信号类别 + 推断」归并，不把模型生成的相似标题当作复现证据。
      const inference = normalizeRulePart(rule.then_inference || rule.rule_name)
      if (!inference) continue
      const normKey = `${signalCategories.sort().join(',')}|${inference}`

      if (!clusters.has(normKey)) {
        clusters.set(normKey, {
          key: normKey,
          ruleName: rule.rule_name || '未命名规则',
          statement: rule.statement,
          ifConditions: asStringList(rule.if_conditions, 6),
          thenInference: rule.then_inference || '',
          suggestedActions: asStringList(rule.suggested_actions, 6),
          exceptions: asStringList(rule.exceptions, 5),
          risks: asStringList(rule.risks, 5),
          cases: new Set([caseBvid]),
          stages: new Set([stage]),
          citations: new Set(rule.citations || []),
        })
      } else {
        const entry = clusters.get(normKey)
        entry.cases.add(caseBvid)
        entry.stages.add(stage)
        for (const act of asStringList(rule.suggested_actions, 6)) entry.suggestedActions.push(act)
        for (const exp of asStringList(rule.exceptions, 5)) entry.exceptions.push(exp)
        for (const risk of asStringList(rule.risks, 5)) entry.risks.push(risk)
        for (const cit of rule.citations || []) entry.citations.add(cit)
      }
    }
  }

  // 聚类评估与定级
  for (const entry of clusters.values()) {
    const caseCount = entry.cases.size
    const stageCount = entry.stages.size
    const dedupedActions = [...new Set(entry.suggestedActions.map(s => String(s).trim()))].filter(Boolean).slice(0, 5)
    const dedupedExceptions = [...new Set(entry.exceptions.map(s => String(s).trim()))].filter(Boolean).slice(0, 4)

    const card = {
      ruleName: entry.ruleName,
      statement: entry.statement,
      thenInference: entry.thenInference,
      suggestedActions: dedupedActions,
      exceptions: dedupedExceptions,
      risks: [...new Set(entry.risks)],
      caseCount,
      crossStageCount: stageCount,
      stages: [...entry.stages],
      citations: [...entry.citations].slice(0, 8),
      generality: stageCount >= 2 ? '较强可迁移' : '特定场景',
    }

    if (caseCount >= 3) {
      card.level = '验证规则'
      card.levelDesc = '经多个独立案例验证的成熟规则，置信度高'
      verifiedRules.push(card)
    } else if (caseCount === 2) {
      card.level = '候选规则'
      card.levelDesc = '经 2 个案例复现，具较高参考价值'
      candidateRules.push(card)
    } else {
      card.level = '案例启发式'
      card.levelDesc = '源自单个案例的探索性启发式推断，需结合具体情境慎用'
      caseHeuristics.push(card)
    }
  }

  return {
    verifiedRules,
    candidateRules,
    caseHeuristics,
    dangerFlags: [...allDangerFlags],
    totalCases: extractedCases.length,
  }
}

// ── 编译生成完整 Skill 目录结构（Draft Compiler）────────────
export function compileSkillDraft({
  id,
  name,
  description = '',
  rulesSummary,
  styleType = 'direct',
  customStyleText = '',
  sources = [],
}) {
  const advisorId = String(id || '').trim().replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase() || `advisor-${randomUUID().slice(0, 8)}`
  const advisorName = String(name || '').trim() || '定制军师'
  const styleConfig = STYLE_PRESETS[styleType] || STYLE_PRESETS.direct
  const effectiveStylePrompt = styleType === 'custom' && customStyleText
    ? customStyleText.trim()
    : styleConfig.prompt

  const { verifiedRules = [], candidateRules = [], caseHeuristics = [], dangerFlags = [] } = rulesSummary || {}
  // 单案例只保留在构建任务的审阅记录，不进入最终可路由的咨询知识库。
  const allRules = [...verifiedRules, ...candidateRules]

  // 生成 manifest.json
  const manifest = {
    id: advisorId,
    name: advisorName,
    description: description || `基于 ${sources.length || 1} 个素材源与 ${allRules.length} 条提炼规则生成的定制恋爱军师。`,
    default: false,
    entry: 'SKILL.md',
    alwaysLoad: ['references/core/boundaries.md'],
    style: ['style/style.md'],
    routes: [
      { about: '信号识别：喜不喜欢、什么意思、回复延迟、态度判断', load: ['references/signals/signal-recognition.md'] },
      { about: '推进策略：如何推进、约会时机、表白节点', load: ['references/playbooks/advancement.md'] },
      { about: '沟通话术：怎么回消息、聊什么话题、化解冷场', load: ['references/playbooks/communication.md'] },
      { about: '止损与边界：要不要撤退、何时止损、关系边界', load: ['references/playbooks/stop-loss.md'] },
      { about: '方法论总则与判断框架', load: ['references/core/methodology.md'] },
      { about: '案例溯源与启发式规则库', load: ['references/cases/casebook.md'] },
    ],
    presentation: {
      summary: description || `基于客观音视频素材提取的结构化决策军师，内含 ${verifiedRules.length} 条验证规则及 ${caseHeuristics.length} 条启发式规则。`,
      strengths: ['信号识别与误读纠偏', '客观证据链回溯', '步骤化推进与止损策略'],
      limitations: ['不代替用户做决定', '单案例启发式规则需结合具体场景'],
      style: `${styleConfig.name}：${styleConfig.desc}`,
      source: sources.map(s => s.title || s.bvid || '素材输入').join('、').slice(0, 150),
    },
  }

  // 生成 SKILL.md
  const skillMd = `---
name: ${advisorName}
description: |
  ${manifest.description}
  核心能力：信号识别、边界研判、推进打法、止损决策。
type: advisor
---

# ${advisorName} · 总控制器

## 一、核心定位与身份
你是恋爱顾问/军师，对机主说话。
- 必须基于客观事实和结构化规则给出决策建议。
- 严格将「成熟验证规则」与「单案例启发式规则」区分呈现。
- 安全底线优先于爱情：严禁任何PUA、纠缠骚扰或突破底线的策略。

## 二、执行流程与路由

按用户问题的意图，使用工具 \`read_skill_doc\` 按需调阅对应文档：

| 场景意图 | 需读取的主题文件 |
|---|---|
| 信号解读、喜不喜欢、冷淡、回复态度 | \`references/signals/signal-recognition.md\` |
| 怎么追、推进节奏、约会与升级时机 | \`references/playbooks/advancement.md\` |
| 聊天回复、怎么回、聊什么、冷场 | \`references/playbooks/communication.md\` |
| 该不该继续、要不要止损、放弃 | \`references/playbooks/stop-loss.md\` |
| 方法论总原则 / 核心判断框架 | \`references/core/methodology.md\` |
| 案例溯源与待验证启发式规则 | \`references/cases/casebook.md\` |
| 安全底线与边界检查（已常驻，无需调阅） | \`references/core/boundaries.md\` |

## 三、输出规范
1. 【信号识别】：指出对方关键言行与信号类别。
2. 【规则匹配】：指明引用的规则及定级（如「验证规则」或「案例启发式」）。
3. 【行动建议】：编号清单，步骤清晰，动作具体。
4. 【风险/失效提示】：指出该建议可能失效的边界条件。
`

  // 生成 boundaries.md
  const boundariesMd = `# 安全边界与伦理底线（常驻不可逾越层）

任何情况下，如果用户或对方涉及以下信号，策略分析必须立即让位于现实安全支持：

1. **身体与人身安全威胁**：暴力倾向、跟踪、蹲守、违背意愿的身体接触。
2. **骚扰与纠缠**：明确拒绝后仍不断轰炸、威胁发布隐私。
3. **极端情绪操控**：以自残/自毁威胁、断绝人际孤立、金钱欺诈。

## 提取素材中标记的特定风险点
${dangerFlags.length ? dangerFlags.map(df => `- ⚠️ ${df}`).join('\n') : '- 暂无特异性高危信号标记，执行标准伦理基准。'}

**原则：安全与身心健康永远优先于关系推进。明确拒绝即终点，不可教唆突破他人明确表达的边界。**
`

  // 生成 methodology.md
  const methodologyMd = `# 方法论总原则与判断框架

1. **统计先行，拒绝脑补**：
   - 关注回复间隔中位数、主动发起比例等客观行为，而非单条措辞的过度脑补。
2. **规则定级分层认知**：
    - **验证规则**：至少经过 3 个独立案例复现，具备较高指导意义；跨阶段复现只说明更可能可迁移，不替代案例数量。
   - **候选规则**：在两个案例中复现，需要结合环境背景判断。
   - **案例启发式**：仅在单个特定案例中出现，绝不可视为普遍真理，仅供提供视角。
3. **如果-条件-推断三元组**：
   - 所有推断必须建立在「在条件 C 下更支持 Y 而非 Z」的逻辑树上。
`

  // 生成 signal-recognition.md
  const signalMd = `# 关键信号识别指南

本军师从素材库中提取出的关键互动信号及其语义：

${allRules.filter(r => r.ruleName).map(r => `### 【${r.level}】${r.ruleName}
- **核心判定**：${r.statement}
- **推断结论**：${r.thenInference || '详见具体建议'}
- **适用阶段**：${r.stages?.join('、') || '全周期'}
- **注意事项**：${r.exceptions?.join('；') || '暂无特定例外'}
`).join('\n') || '暂无提炼出的专用信号，遵循通用信号原则。'}
`

  // 生成 advancement.md
  const advancementMd = `# 推进与表白战术手册

${allRules.filter(r => (r.suggestedActions || []).length).map(r => `## ${r.ruleName}（${r.level}）
- **触发判断**：${r.statement}
- **推荐行动**：
${r.suggestedActions.map((a, i) => `  ${i + 1}. ${a}`).join('\n')}
- **风险提示**：${r.risks?.join('；') || '按节奏试探，遇阻即退'}
`).join('\n') || '当前素材未提炼出带具体行动步骤的可验证推进策略。'}
`

  // 生成 communication.md
  const communicationMd = `# 聊天与日常沟通策略

${allRules.length ? allRules.map(r => `## ${r.ruleName}（${r.level}）
- **触发判断**：${r.statement}
- **推荐行动**：${r.suggestedActions?.join('；') || '素材未提供具体行动步骤'}
- **例外**：${r.exceptions?.join('；') || '需结合具体互动背景判断'}
`).join('\n') : '当前素材未提炼出可验证的沟通策略；不要把通用经验伪装成该军师的专属方法论。'}
`

  // 生成 stop-loss.md
  const stopLossMd = `# 止损与退出策略

${allRules.length ? allRules.map(r => `## ${r.ruleName}（${r.level}）
- **触发判断**：${r.statement}
- **推荐行动**：${r.suggestedActions?.join('；') || '素材未提供具体行动步骤'}
- **风险提示**：${r.risks?.join('；') || '避免把单方叙述直接当作结论'}
`).join('\n') : '当前素材未提炼出可验证的止损策略；仅执行常驻安全边界。'}
`

  // 生成 casebook.md
  const casebookMd = `# 案例溯源与启发式规则备忘录

本军师的所有规则均可追溯至以下证据与提炼案例：

## 1. 验证规则库（高置信度）
${verifiedRules.length ? verifiedRules.map(r => `### ${r.ruleName}
- **推断**：${r.statement}
- **来源引用**：${r.citations?.join('、') || '多案例复现'}
`).join('\n') : '暂无三级验证规则（素材量较少，主要为候选或启发式规则）。'}

## 2. 候选规则库（待验证）
${candidateRules.length ? candidateRules.map(r => `### ${r.ruleName}
- **推断**：${r.statement}
- **复现案例**：${r.caseCount} 篇
- **来源引用**：${r.citations?.join('、') || '双案例复现'}
`).join('\n') : '暂无。'}

  ## 3. 单案例观察

  共 ${caseHeuristics.length} 条单案例观察已留在构建任务的审阅记录中，未写入此军师，也不会用于咨询建议。
`

  // 生成 style.md
  const styleMd = `# 表达风格指南

## 一、基本基调与口吻
${effectiveStylePrompt}

## 二、表达铁律
1. **就事论事，言之有物**：严禁空洞灌汤，必须给出具体可操作的执行步骤。
2. **责任配比不和稀泥**：客观分析机主与对方的行为配比，指出机主自身盲点。
3. **脱离风格机制**：一旦识别到触犯人身安全、法律边界、暴力威胁等高危场景，**立刻停止一切调侃与人设**，切换为中立严肃的求助指引。
`

  const files = {
    'manifest.json': JSON.stringify(manifest, null, 2),
    'SKILL.md': skillMd,
    'references/core/boundaries.md': boundariesMd,
    'references/core/methodology.md': methodologyMd,
    'references/signals/signal-recognition.md': signalMd,
    'references/playbooks/advancement.md': advancementMd,
    'references/playbooks/communication.md': communicationMd,
    'references/playbooks/stop-loss.md': stopLossMd,
    'references/cases/casebook.md': casebookMd,
    'style/style.md': styleMd,
  }

  return {
    advisorId,
    manifest,
    rulesSummary,
    files,
  }
}

// ── 磁盘原子写入 ────────────────────────────────────────
export function writeSkillToDisk(draft, {
  skillsDir = DEFAULT_SKILLS_DIR,
  builtInSkillsDir = BUNDLED_SKILLS_DIR,
} = {}) {
  if (!draft || !draft.advisorId || !draft.files) {
    throw new Error('无效的 Skill 草稿对象')
  }

  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(draft.advisorId)) {
    throw new Error('非法军师 ID：仅允许小写字母、数字、连字符和下划线')
  }

  const targetDir = path.resolve(skillsDir, draft.advisorId)
  // 路径逃逸防护
  const root = path.resolve(skillsDir) + path.sep
  if (!targetDir.startsWith(root)) {
    throw new Error('非法军师 ID：目录路径逃逸')
  }
  const builtInTarget = path.resolve(builtInSkillsDir, draft.advisorId)
  if (fs.existsSync(builtInTarget) && builtInTarget !== targetDir) {
    throw new Error(`军师 ID「${draft.advisorId}」属于内置军师，不能覆盖`)
  }
  if (fs.existsSync(targetDir)) {
    throw new Error(`军师 ID「${draft.advisorId}」已存在；请更换一个新 ID，现有军师不会被覆盖`)
  }

  // 先校验所有路径，避免错误草稿留下半个目录。
  const entries = Object.entries(draft.files)
  if (!entries.length) throw new Error('军师草稿没有可写入的文件')
  for (const [relPath, content] of entries) {
    if (typeof content !== 'string') throw new Error(`文件内容必须是文本: ${relPath}`)
    const fullPath = path.resolve(targetDir, relPath)
    if (!fullPath.startsWith(targetDir + path.sep) && fullPath !== targetDir) {
      throw new Error(`文件路径逃逸: ${relPath}`)
    }
  }

  const tempDir = path.join(path.resolve(skillsDir), `.${draft.advisorId}.tmp-${randomUUID()}`)
  try {
    fs.mkdirSync(tempDir, { recursive: false })
    for (const [relPath, content] of entries) {
      const fullPath = path.resolve(tempDir, relPath)
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, content, 'utf8')
    }
    // 同一文件系统内的 rename 是整体切换；目标已提前保证不存在。
    fs.renameSync(tempDir, targetDir)
  } catch (error) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch {}
    throw error
  }

  return { ok: true, dir: targetDir, id: draft.advisorId }
}

// ── 构建工作流运行时（Builder Runtime）───────────────────
export function createBuilderRuntime({
  skillsDir = DEFAULT_SKILLS_DIR,
  builtInSkillsDir = BUNDLED_SKILLS_DIR,
  getEnv = () => ({}),
  streamChat = streamChatCompletion,
  customFetch = fetch,
} = {}) {
  // 任务控制器 Map（用于取消进行中的任务）
  const activeControllers = new Map()
  // 登录态只在当前 Node 进程与当前构建任务的生命周期内保存。
  // task、日志和草稿均不携带此 Map 中的内容。
  const temporaryBilibiliCookies = new Map()

  function stripSourceSecrets(source) {
    const { bilibiliCookie, cookie, session, ...safe } = source || {}
    return safe
  }

  function updateJob(jobId, patch) {
    const job = getBuilderJob(jobId)
    if (!job) return null
    Object.assign(job, patch)
    return upsertBuilderJob(job)
  }

  function appendLog(jobId, message) {
    const job = getBuilderJob(jobId)
    if (!job) return
    const line = `[${new Date().toLocaleTimeString()}] ${message}`
    job.logs.push(line)
    if (job.logs.length > 200) job.logs.shift()
    upsertBuilderJob(job)
  }

  /**
   * 启动军师构建工作流
   */
  async function startJob({
    name,
    id,
    sources = [], // [ { type: 'bilibili'|'text', value: 'BV...', title?: '' } ]
    styleType = 'direct',
    customStyleText = '',
    bilibiliCookie = '',
  }) {
    if (!name || !String(name).trim()) throw new Error('必须提供军师名称')
    if (!sources || !sources.length) throw new Error('至少需要提供一个素材来源')
    if (sources.length > MAX_BUILDER_SOURCES) throw new Error(`单次最多添加 ${MAX_BUILDER_SOURCES} 个素材源`)
    for (const source of sources) {
      const content = String(source?.content || '')
      if (content.length > MAX_TEXT_SOURCE_CHARS) {
        throw new Error(`单个手工文本素材不能超过 ${Math.round(MAX_TEXT_SOURCE_CHARS / 1024)}KB`)
      }
    }

    const jobId = `bjob_${randomUUID().replaceAll('-', '').slice(0, 16)}`
    const advisorId = String(id || '').trim().replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase() || `adv_${randomUUID().replaceAll('-', '').slice(0, 8)}`
    const temporaryBilibiliCookie = normalizeBilibiliSessionCookie(bilibiliCookie)

    const job = {
      id: jobId,
      advisorId,
      advisorName: String(name).trim(),
      styleType,
      customStyleText,
      sources: sources.map(stripSourceSecrets),
      state: 'queued',
      progress: {
        step: 0,
        totalSteps: 4,
        stage: 'queued',
        percent: 0,
        message: '任务已加入队列',
      },
      logs: [`[${new Date().toLocaleTimeString()}] 构建任务已创建`],
      extractedCases: [],
      rulesSummary: null,
      draft: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    upsertBuilderJob(job)

    const controller = new AbortController()
    activeControllers.set(jobId, controller)
    if (temporaryBilibiliCookie) temporaryBilibiliCookies.set(jobId, temporaryBilibiliCookie)

    // 异步执行完整流水线
    runPipeline(jobId, controller.signal).catch(e => {
      console.error(`[AdvisorBuilder] 任务 ${jobId} 执行失败:`, e)
    }).finally(() => {
      activeControllers.delete(jobId)
      temporaryBilibiliCookies.delete(jobId)
    })

    return job
  }

  async function runPipeline(jobId, signal) {
    try {
      const job = getBuilderJob(jobId)
      if (!job) return

      // ── Step 1: 素材抓取与格式化 ───────────────────────
      updateJob(jobId, {
        state: 'fetching',
        progress: { step: 1, totalSteps: 4, stage: 'fetching', percent: 15, message: '正在抓取并清洗素材字幕…' },
      })
      appendLog(jobId, '开始处理素材源，准备抓取/解析字幕…')

      const hasBili = job.sources.some(s => s.type === 'bilibili' || extractBvId(s.value))
      const guestCookie = hasBili ? await getBilibiliGuestCookie(customFetch).catch(() => '') : ''
      const bilibiliCookie = mergeBilibiliCookies(temporaryBilibiliCookies.get(jobId), guestCookie)
      const processedSources = []
      const allChunks = []

      for (let i = 0; i < job.sources.length; i++) {
        if (signal.aborted) throw new Error('任务已被取消')
        const src = job.sources[i]
        appendLog(jobId, `处理第 ${i + 1}/${job.sources.length} 个素材源: ${src.title || src.value}`)

        let bvid = extractBvId(src.value)
        let subtitleItems = []
        let title = src.title || ''

        if (src.type === 'bilibili' || bvid) {
          bvid = bvid || src.value
          try {
            const fetched = await fetchSubtitle(bvid, { cookie: bilibiliCookie, customFetch })
            title = title || fetched.videoInfo.title
            subtitleItems = fetched.items
            if (src.subtitleFingerprint && src.subtitleFingerprint !== fingerprintSubtitle(subtitleItems)) {
              throw new Error(`视频「${title}」的字幕内容已变化，请返回素材页重新确认后再构建。`)
            }
            appendLog(jobId, `成功拉取 B 站字幕「${title}」，共 ${subtitleItems.length} 行`)
          } catch (err) {
            appendLog(jobId, `⚠️ B 站视频 ${bvid} 拉取失败: ${err.message}`)
            // 如果用户同时提供了备用文本，降级走备用文本
            if (src.content) {
              appendLog(jobId, `使用附带的备用字幕文本解析`)
              subtitleItems = parseAnySubtitleInput(src.content, bvid)
            } else {
              throw err
            }
          }
        } else {
          // 直接上传或粘贴的文本/JSON
          subtitleItems = parseAnySubtitleInput(src.content || src.value, `text_${i + 1}`)
          title = title || `文本素材_${i + 1}`
          appendLog(jobId, `完成解析文本素材「${title}」，共 ${subtitleItems.length} 行`)
        }

        if (!subtitleItems.length) {
          throw new Error(`素材「${title}」未能提取出任何有效字幕文本`)
        }

        processedSources.push({ title, bvid, itemCount: subtitleItems.length })
        const chunks = chunkSubtitles(subtitleItems, { maxChars: 7000, overlapLines: 2 })
        for (const ch of chunks) {
          allChunks.push({ ...ch, videoTitle: title })
        }
        if (allChunks.length > MAX_BUILDER_CHUNKS) {
          throw new Error(`素材过长，最多允许 ${MAX_BUILDER_CHUNKS} 个分析分片；请减少视频或先筛选字幕片段`)
        }
      }

      appendLog(jobId, `所有素材切片完成，共生成 ${allChunks.length} 个 LLM 待提取分片`)

      // ── Step 2: 分段 LLM 方法论抽取 ───────────────────
      updateJob(jobId, {
        state: 'extracting',
        progress: { step: 2, totalSteps: 4, stage: 'extracting', percent: 40, message: `正在使用模型抽取方法论（0/${allChunks.length}）` },
      })

      const env = getEnv()
      if (!env.BASE_URL || !env.BASE_MODEL) {
        throw new Error('未配置 LLM 服务，请先在右上角「设置」中填入 API Key 与模型信息')
      }

      const extractedCases = []

      for (let i = 0; i < allChunks.length; i++) {
        if (signal.aborted) throw new Error('任务已被取消')
        const ch = allChunks[i]
        const percent = 40 + Math.round(((i + 1) / allChunks.length) * 35)

        updateJob(jobId, {
          progress: {
            step: 2,
            totalSteps: 4,
            stage: 'extracting',
            percent,
            message: `正在提取方法论（${i + 1}/${allChunks.length}）：${ch.videoTitle}`,
          },
        })
        appendLog(jobId, `正在抽取分片 ${i + 1}/${allChunks.length}（行 L${ch.fromLine}-L${ch.toLine}）…`)

        const userPrompt = `素材标题：《${ch.videoTitle}》
视频标识：${ch.bvid || '无'}
分片范围：第 ${ch.fromLine} 行 至 第 ${ch.toLine} 行

--- 原始字幕证据（按行标号）---
${ch.text}
--- 结束 ---

请提取上述内容中的案例事实、信号识别、专家判断及候选规则，并按要求输出 JSON。`

        try {
          const res = await streamChat({
            baseUrl: env.BASE_URL,
            apiKey: env.API_KEY,
            model: env.BASE_MODEL,
            messages: [
              { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
              { role: 'user', content: userPrompt },
            ],
            signal,
            temperature: 0.2, // 低温抽取，保真性优先
          })

          const parsedJson = sanitizeExtraction(extractJsonObject(res.content), ch)
          if (parsedJson && parsedJson.has_valid_case !== false) {
            extractedCases.push({
              ...parsedJson,
              bvid: ch.bvid,
              videoTitle: ch.videoTitle,
              chunkIndex: ch.chunkIndex,
            })
            appendLog(jobId, `分片 ${i + 1} 抽取成功，发现 ${parsedJson.candidate_rules?.length || 0} 条候选规则`)
          } else {
            appendLog(jobId, `分片 ${i + 1} 无有效案例结构，已跳过`)
          }
        } catch (llmErr) {
          appendLog(jobId, `⚠️ 分片 ${i + 1} 抽取异常: ${llmErr.message}，继续后续分片`)
        }
      }

      if (!extractedCases.length) {
        throw new Error('所有分片均未提取出有效的方法论案例，请检查素材内容是否包含足够的情感分析对话。')
      }

      // ── Step 3: 跨篇归纳聚类与三级定级 ─────────────────
      updateJob(jobId, {
        state: 'inducing',
        progress: { step: 3, totalSteps: 4, stage: 'inducing', percent: 80, message: '正在对候选规则进行跨案例验证与聚类定级…' },
      })
      appendLog(jobId, '开始对所有抽取的规则进行聚类合并与三级定级…')

      const rulesSummary = clusterAndGradeRules(extractedCases)
      appendLog(jobId, `规则聚类定级完成：验证规则 ${rulesSummary.verifiedRules.length} 条、候选规则 ${rulesSummary.candidateRules.length} 条、案例启发式 ${rulesSummary.caseHeuristics.length} 条`)

      // ── Step 4: 编译生成 Skill 草稿 ───────────────────
      updateJob(jobId, {
        progress: { step: 4, totalSteps: 4, stage: 'compiling', percent: 95, message: '正在生成军师完整知识库草稿…' },
      })
      appendLog(jobId, '正在装配独立风格与编译 Markdown 文件树…')

      const draft = compileSkillDraft({
        id: job.advisorId,
        name: job.advisorName,
        rulesSummary,
        styleType: job.styleType,
        customStyleText: job.customStyleText,
        sources: processedSources,
      })

      updateJob(jobId, {
        state: 'draft_ready',
        extractedCases,
        rulesSummary,
        draft,
        progress: { step: 4, totalSteps: 4, stage: 'draft_ready', percent: 100, message: '军师草稿已生成，等待审阅' },
      })
      appendLog(jobId, '✅ 军师构建完成！草稿已就绪，可供用户审阅、修改或一键发布。')
    } catch (e) {
      if (signal.aborted) {
        updateJob(jobId, {
          state: 'cancelled',
          progress: { step: 0, totalSteps: 4, stage: 'cancelled', percent: 0, message: '任务已取消' },
        })
        appendLog(jobId, '⏹️ 任务已被用户手动取消')
      } else {
        updateJob(jobId, {
          state: 'failed',
          error: e.message,
          progress: { step: 0, totalSteps: 4, stage: 'failed', percent: 0, message: `构建失败: ${e.message}` },
        })
        appendLog(jobId, `❌ 构建失败: ${e.message}`)
      }
    }
  }

  function getJob(jobId) {
    return getBuilderJob(jobId)
  }

  function cancelJob(jobId) {
    const controller = activeControllers.get(jobId)
    if (controller) {
      controller.abort()
      activeControllers.delete(jobId)
      return true
    }
    const job = getBuilderJob(jobId)
    if (job && ['queued', 'fetching', 'extracting', 'inducing'].includes(job.state)) {
      updateJob(jobId, { state: 'cancelled' })
      return true
    }
    return false
  }

  function updateDraft(jobId, draftPatch) {
    const job = getBuilderJob(jobId)
    if (!job) throw new Error('任务不存在')
    if (job.state !== 'draft_ready' && job.state !== 'published') {
      throw new Error('草稿尚未生成，无法修改')
    }

    if (draftPatch.name) {
      job.advisorName = String(draftPatch.name).trim()
    }
    if (draftPatch.rulesSummary) {
      job.rulesSummary = draftPatch.rulesSummary
      job.draft = compileSkillDraft({
        id: job.advisorId,
        name: job.advisorName,
        description: String(draftPatch.description || job.draft?.manifest?.description || ''),
        rulesSummary: job.rulesSummary,
        styleType: job.styleType,
        customStyleText: job.customStyleText,
        sources: job.sources,
      })
    } else if (job.draft?.manifest) {
      job.draft.manifest.name = job.advisorName
      if (draftPatch.description) job.draft.manifest.description = String(draftPatch.description).trim()
    }
    if (draftPatch.files && typeof draftPatch.files === 'object') {
      const patches = Object.entries(draftPatch.files)
      for (const [filePath, content] of patches) {
        if (!(filePath in job.draft.files) || typeof content !== 'string') {
          throw new Error('草稿文件修改无效')
        }
      }
      job.draft.files = { ...job.draft.files, ...draftPatch.files }
    }

    return upsertBuilderJob(job)
  }

  function publishSkill(jobId) {
    const job = getBuilderJob(jobId)
    if (!job || !job.draft) throw new Error('任务草稿不存在')
    if (job.state !== 'draft_ready') throw new Error('只有待审阅的草稿可以发布')

    const res = writeSkillToDisk(job.draft, { skillsDir, builtInSkillsDir })
    updateJob(jobId, { state: 'published' })
    appendLog(jobId, `🎉 军师已正式发布写入至 ${res.dir}，运行时已就绪！`)
    return { ok: true, id: job.draft.advisorId, dir: res.dir }
  }

  return {
    startJob,
    getJob,
    listJobs: listBuilderJobs,
    cancelJob,
    updateDraft,
    publishSkill,
  }
}
