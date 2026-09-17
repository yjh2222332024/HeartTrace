<script setup>
import { ref, computed, nextTick, onBeforeUnmount } from 'vue'
import AiActivity from './AiActivity.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'published'])

// 步骤：1. input (素材) -> 2. config (军师与风格) -> 3. running (任务中) -> 4. review (审阅草稿) -> 5. success (完成)
const currentStep = ref(1)

// 步骤 1：素材管理
const sourceType = ref('bilibili') // 'bilibili' | 'text'
const inputBv = ref('')
const inputTextTitle = ref('')
const inputTextContent = ref('')
const sources = ref([]) // [ { type, value, title, lineCount, content } ]
const detecting = ref(false)
const detectError = ref('')
const loginRequiredSource = ref(null)
const temporaryBilibiliCookie = ref('')
const showBilibiliCookieHelp = ref(false)
const cookieHelpCloseRef = ref(null)
const expandedSourcePreview = ref(null)

// 步骤 2：基本信息与风格
const advisorName = ref('')
const advisorId = ref('')
const styleType = ref('direct')
const customStyleText = ref('')
const stylePresets = [
  { key: 'direct', name: '直接犀利', desc: '短句连发，先破后立，直击本质，不和稀泥' },
  { key: 'gentle', name: '温和陪伴', desc: '共情理解，循序渐进，语气温厚，情绪托底' },
  { key: 'analytical', name: '理性极简', desc: '条理严密，数据与步骤先行，极度冷静' },
  { key: 'humorous', name: '幽默风趣', desc: '适度调侃网梗，化解沉重，形象生动' },
  { key: 'custom', name: '自定义风格', desc: '自行输入特定的口吻、人设与口癖' },
]

// 步骤 3：任务执行
const activeJobId = ref(null)
const jobState = ref('queued')
const progressPercent = ref(0)
const progressMessage = ref('正在准备构建任务…')
const logs = ref([])
let pollTimer = null

// 步骤 4：草稿审阅
const draftData = ref(null)
const rulesSummary = ref(null)
const activeTab = ref('rules') // 'rules' | 'files'
const selectedFile = ref('SKILL.md')
const dirtyFiles = ref({})
const publishing = ref(false)
const publishError = ref('')

// 添加素材
async function addSource() {
  detectError.value = ''
  if (sourceType.value === 'bilibili') {
    const val = inputBv.value.trim()
    if (!val) return
    await probeBilibiliSource(val)
  } else {
    const content = inputTextContent.value.trim()
    if (!content) {
      detectError.value = '请输入或粘贴字幕/案例内容'
      return
    }
    detecting.value = true
    try {
      const title = inputTextTitle.value.trim() || `本地素材_${sources.value.length + 1}`
      const res = await fetch('/api/builder/parse-source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, type: 'text' }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || '解析失败')

      const sourceIndex = sources.value.length
      sources.value.push({
        type: 'text',
        value: title,
        title,
        content,
        lineCount: data.data.lineCount,
        previewLines: data.data.previewLines || [],
        subtitleFingerprint: data.data.subtitleFingerprint || '',
        hasSubtitle: true,
      })
      expandedSourcePreview.value = sourceIndex
      inputTextTitle.value = ''
      inputTextContent.value = ''
    } catch (e) {
      detectError.value = e.message
    } finally {
      detecting.value = false
    }
  }
}

function addBilibiliSource(data, fallbackValue) {
  const sourceIndex = sources.value.length
  sources.value.push({
    type: 'bilibili',
    value: data.bvid || fallbackValue,
    title: data.title || `B 站视频 ${fallbackValue}`,
    ownerName: data.ownerName,
    lineCount: data.lineCount,
    previewLines: data.previewLines || [],
    subtitleFingerprint: data.subtitleFingerprint || '',
    hasSubtitle: true,
    subtitleAccess: data.subtitleAccess || 'public',
  })
  expandedSourcePreview.value = sourceIndex
  inputBv.value = ''
  loginRequiredSource.value = null
  if (!advisorName.value && data.ownerName) {
    advisorName.value = `恋爱军师 · ${data.ownerName}`
  }
}

async function probeBilibiliSource(source, bilibiliCookie = '') {
  detecting.value = true
  detectError.value = ''
  try {
    const res = await fetch('/api/builder/parse-source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, type: 'bilibili', ...(bilibiliCookie ? { bilibiliCookie } : {}) }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || '探测失败')
    if (data.data.hasSubtitle) {
      addBilibiliSource(data.data, source)
      return true
    }
    if (data.data.requiresLogin) {
      loginRequiredSource.value = {
        value: data.data.bvid || source,
        title: data.data.title || `B 站视频 ${source}`,
        ownerName: data.data.ownerName || '',
      }
      return false
    }
    throw new Error(data.data.warning || '该视频没有可下载的字幕，请改为粘贴字幕文本')
  } catch (e) {
    detectError.value = e.message || '探测失败'
    return false
  } finally {
    detecting.value = false
  }
}

async function retryWithBilibiliLogin() {
  if (!loginRequiredSource.value) return
  if (!temporaryBilibiliCookie.value.trim()) {
    detectError.value = '请先输入 B 站 Cookie 中的 SESSDATA'
    return
  }
  await probeBilibiliSource(loginRequiredSource.value.value, temporaryBilibiliCookie.value.trim())
}

function switchToSubtitlePaste() {
  if (loginRequiredSource.value?.title) inputTextTitle.value = loginRequiredSource.value.title
  loginRequiredSource.value = null
  temporaryBilibiliCookie.value = ''
  detectError.value = ''
  sourceType.value = 'text'
}

function dismissLoginRequired() {
  loginRequiredSource.value = null
  temporaryBilibiliCookie.value = ''
  detectError.value = ''
}

async function openBilibiliCookieHelp() {
  showBilibiliCookieHelp.value = true
  await nextTick()
  cookieHelpCloseRef.value?.focus()
}

function closeBilibiliCookieHelp() {
  showBilibiliCookieHelp.value = false
}

function clearTemporaryBilibiliAccess() {
  temporaryBilibiliCookie.value = ''
  showBilibiliCookieHelp.value = false
}

function removeSource(idx) {
  sources.value.splice(idx, 1)
  if (expandedSourcePreview.value === idx) expandedSourcePreview.value = null
}

// 自动生成 Slug
function generateIdFromName() {
  if (!advisorId.value && advisorName.value) {
    const slug = advisorName.value
      .replace(/恋爱军师[·\s]*/g, '')
      .replace(/[\s\p{P}\p{S}]+/gu, '-')
      .toLowerCase()
      .slice(0, 20)
    advisorId.value = slug ? `advisor-${slug}` : `advisor-${Date.now().toString().slice(-6)}`
  }
}

// 启动构建工作流
async function startWorkflow() {
  detectError.value = ''
  currentStep.value = 3
  progressPercent.value = 5
  progressMessage.value = '正在向服务端提交任务…'
  logs.value = ['[系统] 正在发起军师知识库提取与归纳任务…']

  try {
    const bilibiliCookie = temporaryBilibiliCookie.value.trim()
    const res = await fetch('/api/builder/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: advisorName.value.trim() || '定制恋爱军师',
        id: advisorId.value.trim() || undefined,
        sources: sources.value,
        styleType: styleType.value,
        customStyleText: customStyleText.value,
        ...(bilibiliCookie ? { bilibiliCookie } : {}),
      }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || '任务发起失败')

    activeJobId.value = data.data.id
    temporaryBilibiliCookie.value = ''
    pollJob()
  } catch (e) {
    progressMessage.value = `启动错误: ${e.message}`
    jobState.value = 'failed'
  }
}

// 轮询任务状态
function pollJob() {
  stopPolling()
  pollTimer = setInterval(async () => {
    if (!activeJobId.value) return
    try {
      const res = await fetch(`/api/builder/tasks/${activeJobId.value}`)
      const data = await res.json()
      if (!res.ok || !data.ok) return

      const job = data.data
      jobState.value = job.state
      progressPercent.value = job.progress?.percent || 0
      progressMessage.value = job.progress?.message || ''
      logs.value = job.logs || []

      if (job.state === 'draft_ready') {
        stopPolling()
        draftData.value = job.draft
        rulesSummary.value = job.rulesSummary
        currentStep.value = 4
      } else if (job.state === 'failed' || job.state === 'cancelled') {
        stopPolling()
      }
    } catch { /* 容忍网络抖动 */ }
  }, 1200)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

// 取消任务
async function cancelTask() {
  if (!activeJobId.value) return
  await fetch(`/api/builder/tasks/${activeJobId.value}/cancel`, { method: 'POST' })
  stopPolling()
  jobState.value = 'cancelled'
  progressMessage.value = '任务已由用户手动取消'
}

// 移除某条规则
function removeRule(listName, index) {
  if (rulesSummary.value && rulesSummary.value[listName]) {
    rulesSummary.value[listName].splice(index, 1)
  }
}

function updateFile(fileName, content) {
  if (!draftData.value?.files || !fileName) return
  draftData.value.files[fileName] = content
  dirtyFiles.value[fileName] = content
}

async function saveReview() {
  const res = await fetch(`/api/builder/tasks/${activeJobId.value}/draft`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rulesSummary: rulesSummary.value,
      files: dirtyFiles.value,
    }),
  })
  const data = await res.json()
  if (!res.ok || !data.ok) throw new Error(data.error || '保存审阅修改失败')
  draftData.value = data.data.draft
  rulesSummary.value = data.data.rulesSummary
  dirtyFiles.value = {}
}

// 发布到 Skill 目录
async function publishSkill() {
  publishing.value = true
  publishError.value = ''
  try {
    await saveReview()
    const res = await fetch(`/api/builder/tasks/${activeJobId.value}/publish`, {
      method: 'POST',
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || '发布失败')

    advisorId.value = data.data.id
    currentStep.value = 5
    emit('published', data.data)
  } catch (e) {
    publishError.value = e.message
  } finally {
    publishing.value = false
  }
}

function handleClose() {
  stopPolling()
  clearTemporaryBilibiliAccess()
  emit('close')
}

onBeforeUnmount(() => {
  stopPolling()
  clearTemporaryBilibiliAccess()
})
</script>

<template>
  <Transition name="modal-reveal">
  <div v-if="open" class="builder-overlay" @click.self="handleClose">
    <div class="builder-modal">
      <!-- 头部 -->
      <header class="modal-header">
        <div>
          <h2>🪄 军师生产工作流（Advisor Builder）</h2>
          <p class="subtitle">从视频链接或字幕素材，全自动提取去噪、跨案例归纳并生成专属军师</p>
        </div>
        <button class="close-btn" @click="handleClose">✕</button>
      </header>

      <!-- 步骤指示条 -->
      <div class="stepper">
        <div :class="['step-item', { active: currentStep === 1, done: currentStep > 1 }]">
          <span class="step-num">1</span>
          <span class="step-label">素材准备</span>
        </div>
        <div class="step-divider"></div>
        <div :class="['step-item', { active: currentStep === 2, done: currentStep > 2 }]">
          <span class="step-num">2</span>
          <span class="step-label">军师设定</span>
        </div>
        <div class="step-divider"></div>
        <div :class="['step-item', { active: currentStep === 3, done: currentStep > 3 }]">
          <span class="step-num">3</span>
          <span class="step-label">提取归纳</span>
        </div>
        <div class="step-divider"></div>
        <div :class="['step-item', { active: currentStep === 4, done: currentStep > 4 }]">
          <span class="step-num">4</span>
          <span class="step-label">审阅草稿</span>
        </div>
        <div class="step-divider"></div>
        <div :class="['step-item', { active: currentStep === 5, done: currentStep >= 5 }]">
          <span class="step-num">5</span>
          <span class="step-label">完成发布</span>
        </div>
      </div>

      <!-- 步骤内容容器 -->
      <main class="modal-body">
        <Transition name="wizard-step" mode="out-in">
        <!-- ── 步骤 1：素材输入 ── -->
        <div v-if="currentStep === 1" key="sources" class="step-panel">
          <div class="source-tabs">
            <button :class="{ active: sourceType === 'bilibili' }" @click="sourceType = 'bilibili'">
              📺 B 站视频 / 切片链接
            </button>
            <button :class="{ active: sourceType === 'text' }" @click="sourceType = 'text'">
              📝 文本 / 本地字幕粘贴
            </button>
          </div>

          <!-- B 站链接输入 -->
          <div v-if="sourceType === 'bilibili'" class="input-group">
            <label>输入 B 站视频链接或 BV 号（如 BV1qb17BxEQZ）：</label>
            <div class="input-inline">
              <input
                v-model="inputBv"
                type="text"
                placeholder="https://www.bilibili.com/video/BV... 或 BV..."
                :disabled="detecting"
                @keyup.enter="addSource"
              />
              <button :disabled="detecting || !inputBv.trim()" class="primary-btn" @click="addSource">
                {{ detecting ? '正在抓取字幕…' : '+ 添加视频' }}
              </button>
            </div>
            <span class="tip-text">系统会自动通过访客凭证轮换获取该切片的官方或 AI 生成字幕并排版编号。</span>

            <Transition name="subtitle-access">
              <section v-if="loginRequiredSource" class="subtitle-access-card" aria-live="polite">
                <div class="subtitle-access-heading">
                  <span>需要登录</span>
                  <strong>{{ loginRequiredSource.title }}</strong>
                </div>
                <p>这条字幕只向已登录的 B 站账号开放。请选择继续方式。</p>
                <div class="subtitle-access-label-row">
                  <label for="bilibili-session-cookie">临时 B 站 SESSDATA</label>
                  <button type="button" class="session-help-btn" aria-haspopup="dialog" @click="openBilibiliCookieHelp">怎么找到？</button>
                </div>
                <div class="subtitle-access-actions">
                  <input
                    id="bilibili-session-cookie"
                    v-model="temporaryBilibiliCookie"
                    type="password"
                    autocomplete="off"
                    spellcheck="false"
                    placeholder="SESSDATA=..."
                    :disabled="detecting"
                    @keyup.enter="retryWithBilibiliLogin"
                  />
                  <button type="button" class="primary-btn" :disabled="detecting || !temporaryBilibiliCookie.trim()" @click="retryWithBilibiliLogin">
                    {{ detecting ? '验证登录态…' : '使用登录态读取' }}
                  </button>
                </div>
                <small>仅用于本次构建向 B 站读取字幕，不写入本地设置、构建记录或日志。</small>
                <div class="subtitle-access-footer">
                  <button type="button" class="link-btn" @click="switchToSubtitlePaste">改为粘贴字幕</button>
                  <button type="button" class="link-btn muted" @click="dismissLoginRequired">暂不添加</button>
                </div>
              </section>
            </Transition>
          </div>

          <!-- 文本粘贴输入 -->
          <div v-else class="input-group">
            <div class="field-row">
              <label>素材标题（可选）：</label>
              <input v-model="inputTextTitle" type="text" placeholder="例如：某切片第3案例" />
            </div>
            <label>粘贴字幕或案例对话文本（支持 SRT、JSON 或带时间戳/纯文本）：</label>
            <textarea
              v-model="inputTextContent"
              rows="6"
              placeholder="可直接粘贴字幕内容，例如：&#10;[01:15] 投稿者：我和他认识三个月了...&#10;[01:20] 专家：这种明显不是喜欢，是..."
            ></textarea>
            <button :disabled="detecting || !inputTextContent.trim()" class="primary-btn self-end" @click="addSource">
              {{ detecting ? '正在解析…' : '+ 添加该素材' }}
            </button>
          </div>

          <div v-if="detectError" class="error-banner">⚠️ {{ detectError }}</div>

          <!-- 已添加素材列表 -->
          <div class="added-sources">
            <h4>已添加的素材源（{{ sources.length }}）</h4>
            <p v-if="!sources.length" class="empty-hint">尚未添加任何素材。至少需要添加 1 个视频或文本段落。</p>
            <div v-else class="source-list">
              <div v-for="(src, idx) in sources" :key="idx" class="source-card">
                <div class="source-info">
                  <span class="source-tag">{{ src.type === 'bilibili' ? 'B站' : '文本' }}</span>
                  <div class="source-details">
                    <strong>{{ src.title }}</strong>
                    <span class="source-sub">
                      {{ src.value }} · 约 {{ src.lineCount || 0 }} 行字幕
                      <span v-if="src.subtitleAccess === 'login'" class="access-badge">临时登录态</span>
                      <span v-if="src.warning" class="warn-badge">（{{ src.warning }}）</span>
                    </span>
                    <button
                      v-if="src.previewLines?.length"
                      type="button"
                      class="source-preview-toggle"
                      :aria-expanded="expandedSourcePreview === idx"
                      @click="expandedSourcePreview = expandedSourcePreview === idx ? null : idx"
                    >
                      {{ expandedSourcePreview === idx ? '收起字幕片段' : '查看字幕片段' }}
                    </button>
                    <div v-if="expandedSourcePreview === idx" class="source-preview" role="status">
                      <b>已抓到的前 {{ src.previewLines.length }} 行，请先核对内容。</b>
                      <span v-for="(line, lineIndex) in src.previewLines" :key="lineIndex">{{ line }}</span>
                    </div>
                  </div>
                </div>
                <button class="remove-btn" title="删除" @click="removeSource(idx)">✕</button>
              </div>
            </div>
          </div>
        </div>

        <!-- ── 步骤 2：军师设定与风格选择 ── -->
        <div v-else-if="currentStep === 2" key="configuration" class="step-panel">
          <div class="form-grid">
            <div class="form-field">
              <label>军师名称 <span class="req">*</span></label>
              <input
                v-model="advisorName"
                type="text"
                placeholder="例如：恋爱军师 · 谟老师"
                @blur="generateIdFromName"
              />
            </div>
            <div class="form-field">
              <label>英文唯一标识（用于创建目录与 @ 唤醒）</label>
              <input v-model="advisorId" type="text" placeholder="例如：moxi-advisor" />
            </div>
          </div>

          <div class="style-section">
            <label>表达风格定制（与核心方法论彻底解耦）：</label>
            <p class="section-desc">方法论是纯粹客观的判断逻辑，表达风格决定军师以何种口吻向你建议：</p>
            <div class="style-grid">
              <div
                v-for="preset in stylePresets"
                :key="preset.key"
                :class="['style-card', { selected: styleType === preset.key }]"
                @click="styleType = preset.key"
              >
                <div class="style-header">
                  <strong>{{ preset.name }}</strong>
                  <span class="radio-dot"></span>
                </div>
                <p>{{ preset.desc }}</p>
              </div>
            </div>

            <div v-if="styleType === 'custom'" class="custom-style-box">
              <label>输入自定义表达口吻与人设规则：</label>
              <textarea
                v-model="customStyleText"
                rows="3"
                placeholder="例如：使用幽默调侃的语气，多用反问句，结论务必分三步走..."
              ></textarea>
            </div>
          </div>
        </div>

        <!-- ── 步骤 3：任务执行中 ── -->
        <div v-else-if="currentStep === 3" key="running" class="step-panel running-panel">
          <div class="progress-box">
            <div class="progress-bar-bg">
              <div class="progress-bar-fill" :class="{ 'progress-bar-fill--active': jobState !== 'failed' }" :style="{ width: progressPercent + '%' }"></div>
            </div>
            <div class="progress-info">
              <AiActivity v-if="jobState !== 'failed'" :label="progressMessage || '军师正在归纳素材…'" size="sm" />
              <span v-else>{{ progressMessage || '构建失败' }}</span>
              <strong>{{ progressPercent }}%</strong>
            </div>
          </div>

          <div class="console-box">
            <div class="console-header">实时工作流执行日志</div>
            <div class="console-logs">
              <div v-for="(line, idx) in logs" :key="idx" class="console-line">{{ line }}</div>
            </div>
          </div>

          <div v-if="jobState === 'failed'" class="error-box">
            ❌ 构建失败：请检查右上角「设置」中模型 API 配置是否正确，或返回调整素材。
          </div>
        </div>

        <!-- ── 步骤 4：草稿审阅与修改 ── -->
        <div v-else-if="currentStep === 4" key="review" class="step-panel review-panel">
          <div class="review-header">
            <div>
              <h3>{{ draftData?.manifest?.name }}</h3>
              <p>{{ draftData?.manifest?.description }}</p>
            </div>
            <div class="tab-buttons">
              <button :class="{ active: activeTab === 'rules' }" @click="activeTab = 'rules'">提炼规则清单</button>
              <button :class="{ active: activeTab === 'files' }" @click="activeTab = 'files'">文件树预览</button>
            </div>
          </div>

          <!-- 规则清单视图 -->
          <div v-if="activeTab === 'rules'" class="rules-view">
            <!-- 验证规则 -->
            <div v-if="rulesSummary?.verifiedRules?.length" class="rule-group">
              <h4 class="group-title text-emerald-700">⭐ 验证规则（跨案例复现的高置信度成熟规则）</h4>
              <div v-for="(rule, idx) in rulesSummary.verifiedRules" :key="'v_' + idx" class="rule-card verified">
                <div class="rule-top">
                  <span class="badge verified">验证规则 ({{ rule.caseCount }}案例)</span>
                  <span class="rule-name">{{ rule.ruleName }}</span>
                  <button class="rule-del" @click="removeRule('verifiedRules', idx)">删除</button>
                </div>
                <p class="rule-stmt"><strong>判定：</strong>{{ rule.statement }}</p>
                <div v-if="rule.suggestedActions?.length" class="rule-acts">
                  <strong>行动步骤：</strong>
                  <ul><li v-for="(act, aIdx) in rule.suggestedActions" :key="aIdx">{{ act }}</li></ul>
                </div>
              </div>
            </div>

            <!-- 候选规则 -->
            <div v-if="rulesSummary?.candidateRules?.length" class="rule-group">
              <h4 class="group-title text-blue-700">💡 候选规则（在两个案例中复现）</h4>
              <div v-for="(rule, idx) in rulesSummary.candidateRules" :key="'c_' + idx" class="rule-card candidate">
                <div class="rule-top">
                  <span class="badge candidate">候选规则</span>
                  <span class="rule-name">{{ rule.ruleName }}</span>
                  <button class="rule-del" @click="removeRule('candidateRules', idx)">删除</button>
                </div>
                <p class="rule-stmt">{{ rule.statement }}</p>
              </div>
            </div>

            <!-- 案例启发式 -->
            <div v-if="rulesSummary?.caseHeuristics?.length" class="rule-group">
              <h4 class="group-title text-amber-700">🔍 案例启发式（单案例提取，需结合情境慎用）</h4>
              <div v-for="(rule, idx) in rulesSummary.caseHeuristics" :key="'h_' + idx" class="rule-card heuristic">
                <div class="rule-top">
                  <span class="badge heuristic">单案例启发式</span>
                  <span class="rule-name">{{ rule.ruleName }}</span>
                  <button class="rule-del" @click="removeRule('caseHeuristics', idx)">删除</button>
                </div>
                <p class="rule-stmt">{{ rule.statement }}</p>
                <span class="tip-sub">⚠️ 该推断仅在单案例出现，在最终技能库中已明确注明警示，防止盲目套用。</span>
              </div>
            </div>

            <!-- 危险信号 -->
            <div v-if="rulesSummary?.dangerFlags?.length" class="danger-box">
              <h4>🛡️ 提取素材中识别的安全红线（将作为常驻边界拦截）：</h4>
              <ul><li v-for="(df, dfIdx) in rulesSummary.dangerFlags" :key="dfIdx">{{ df }}</li></ul>
            </div>
          </div>

          <!-- 文件树预览 -->
          <div v-else class="files-view">
            <div class="file-sidebar">
              <button
                v-for="fileName in Object.keys(draftData?.files || {})"
                :key="fileName"
                :class="['file-item', { selected: selectedFile === fileName }]"
                @click="selectedFile = fileName"
              >
                {{ fileName }}
              </button>
            </div>
            <div class="file-preview">
              <textarea
                v-if="draftData?.files?.[selectedFile]"
                :value="draftData.files[selectedFile]"
                @input="updateFile(selectedFile, $event.target.value)"
                class="code-editor"
              ></textarea>
            </div>
          </div>

          <div v-if="publishError" class="error-banner">⚠️ {{ publishError }}</div>
        </div>

        <!-- ── 步骤 5：完成发布 ── -->
        <div v-else key="success" class="step-panel success-panel">
          <div class="success-icon">🎉</div>
          <h3>军师已成功发布并入库！</h3>
          <p>
            新军师「<strong>{{ advisorName }}</strong>」已安全写入本地 <code>skills/{{ advisorId }}</code> 目录，
            运行时已热重载生效。你现在可以在聊天框中输入 <code>@{{ advisorName }}</code> 直接开启咨询决策！
          </p>
        </div>
        </Transition>
      </main>

      <!-- 底部控制栏 -->
      <footer class="modal-footer">
        <button v-if="currentStep > 1 && currentStep < 3" class="secondary-btn" @click="currentStep--">上一步</button>

        <div class="spacer"></div>

        <button v-if="currentStep === 1" :disabled="!sources.length" class="primary-btn" @click="currentStep = 2">
          下一步：设定军师与风格 →
        </button>

        <button v-if="currentStep === 2" :disabled="!advisorName.trim()" class="primary-btn" @click="startWorkflow">
          ⚡ 开始提取与归纳
        </button>

        <button v-if="currentStep === 3 && jobState !== 'failed'" class="danger-btn" @click="cancelTask">
          取消任务
        </button>
        <button v-if="currentStep === 3 && jobState === 'failed'" class="secondary-btn" @click="currentStep = 2">
          返回修改设定
        </button>

        <button v-if="currentStep === 4" :disabled="publishing" class="primary-btn" @click="publishSkill">
          {{ publishing ? '正在落盘写入…' : '✅ 确认并发布军师' }}
        </button>

        <button v-if="currentStep === 5" class="primary-btn" @click="handleClose">
          完成并返回军师管理
        </button>
      </footer>
    </div>
  </div>
  </Transition>

  <Transition name="cookie-help">
    <div
      v-if="showBilibiliCookieHelp"
      class="cookie-help-mask"
      role="presentation"
      @click.self="closeBilibiliCookieHelp"
      @keydown.esc="closeBilibiliCookieHelp"
    >
      <section class="cookie-help-dialog" role="dialog" aria-modal="true" aria-labelledby="cookie-help-title">
        <header>
          <div>
            <span>临时登录态说明</span>
            <h3 id="cookie-help-title">如何找到 B 站 SESSDATA</h3>
          </div>
          <button ref="cookieHelpCloseRef" type="button" class="cookie-help-close" aria-label="关闭说明" @click="closeBilibiliCookieHelp">✕</button>
        </header>

        <p class="cookie-help-intro">请在你自己的电脑、已登录 B 站的 Chrome 或 Edge 中操作。复制 <strong>SESSDATA</strong> 的值即可，不需要整段 Cookie。</p>

        <div class="cookie-help-steps">
          <article>
            <b>1</b>
            <div><strong>打开开发者工具</strong><small>在 B 站网页按 <kbd>F12</kbd>，或按 <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>I</kbd>。</small></div>
          </article>
          <article>
            <b>2</b>
            <div><strong>进入 Cookie 列表</strong><small>选择“应用 / Application” → “存储 / Storage” → “Cookies” → <code>https://www.bilibili.com</code>。</small></div>
          </article>
          <article>
            <b>3</b>
            <div><strong>复制 SESSDATA 的 Value</strong><small>搜索 <code>SESSDATA</code>，只复制该行 <em>Value</em> 一列的内容，粘贴回这里。</small></div>
          </article>
        </div>

        <div class="cookie-help-map" role="img" aria-label="开发者工具定位示意：应用，Cookies，www.bilibili.com，SESSDATA，Value">
          <span>应用</span><i>›</i><span>Cookies</span><i>›</i><span>www.bilibili.com</span><i>›</i><strong>SESSDATA <small>Value</small></strong>
        </div>

        <aside class="cookie-help-safety">
          <strong>这是登录凭证，等同于密码的一部分。</strong>
          <span>不要发送给他人、粘贴到聊天或保存到笔记。系统仅在本次页面与当前构建任务中临时使用；任务结束、取消、关闭构建窗口或服务重启后即清除。</span>
        </aside>

        <footer><button type="button" class="primary-btn" @click="closeBilibiliCookieHelp">知道了，返回填写</button></footer>
      </section>
    </div>
  </Transition>
</template>

<style scoped>
.builder-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.6);
  backdrop-filter: blur(4px);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.builder-modal {
  background: white;
  width: min(920px, 95vw);
  max-height: 90vh;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
  overflow: hidden;
}
.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 24px;
  border-bottom: 1px solid #e5e7eb;
}
.modal-header h2 { font-size: 18px; font-weight: 650; margin: 0 0 4px; color: #1f2937; }
.subtitle { font-size: 13px; color: #6b7280; margin: 0; }
.close-btn { border: none; background: none; font-size: 18px; color: #9ca3af; cursor: pointer; padding: 4px 8px; border-radius: 4px; }
.close-btn:hover { background: #f3f4f6; color: #374151; }

.stepper {
  display: flex;
  align-items: center;
  padding: 12px 24px;
  background: #f9fafb;
  border-bottom: 1px solid #e5e7eb;
}
.step-item { display: flex; align-items: center; gap: 6px; font-size: 13px; color: #9ca3af; font-weight: 500; }
.step-item.active { color: #85344f; font-weight: 650; }
.step-item.done { color: #059669; }
.step-num { width: 20px; height: 20px; border-radius: 50%; background: #e5e7eb; color: #4b5563; display: flex; align-items: center; justify-content: center; font-size: 11px; }
.step-item.active .step-num { background: #85344f; color: white; }
.step-item.done .step-num { background: #059669; color: white; }
.step-divider { flex: 1; height: 1px; background: #e5e7eb; margin: 0 10px; }

.modal-body { flex: 1; overflow-y: auto; padding: 24px; }
.step-panel { display: flex; flex-direction: column; gap: 20px; }

.source-tabs { display: flex; gap: 8px; border-bottom: 1px solid #e5e7eb; padding-bottom: 12px; }
.source-tabs button { padding: 8px 16px; border-radius: 6px; border: 1px solid #d1d5db; background: white; font-size: 14px; cursor: pointer; }
.source-tabs button.active { background: #f3e7ed; border-color: #ddc8d1; color: #85344f; font-weight: 600; }

.input-group { display: flex; flex-direction: column; gap: 8px; }
.input-group label { font-size: 13px; font-weight: 600; color: #374151; }
.input-inline { display: flex; gap: 8px; }
.input-inline input, .field-row input, .form-field input, textarea {
  flex: 1; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; outline: none;
}
.input-inline input:focus, textarea:focus, .form-field input:focus { border-color: #85344f; }
.tip-text { font-size: 12px; color: #6b7280; }
.subtitle-access-card { display: grid; gap: 8px; margin-top: 8px; padding: 13px; border: 1px solid #edc6d2; border-left: 3px solid #9d405b; border-radius: 8px; background: #fff8fa; }
.subtitle-access-heading { display: flex; align-items: baseline; gap: 8px; min-width: 0; }.subtitle-access-heading span { flex: 0 0 auto; padding: 2px 6px; border-radius: 4px; color: #8b2643; background: #f8dfe7; font-size: 11px; font-weight: 700; }.subtitle-access-heading strong { overflow: hidden; color: #4b2431; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }.subtitle-access-card p, .subtitle-access-card small { margin: 0; color: #6d5360; font-size: 12px; line-height: 1.55; }.subtitle-access-label-row { display: flex; align-items: center; gap: 7px; }.subtitle-access-card label { color: #4b2431; font-size: 12px; font-weight: 650; }.session-help-btn { padding: 0; border: 0; color: #85344f; background: transparent; font-size: 11.5px; font-weight: 700; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }.session-help-btn:hover { color: #5f1f33; }.session-help-btn:focus-visible, .link-btn:focus-visible, .cookie-help-close:focus-visible { outline: 2px solid #a84b68; outline-offset: 3px; }.subtitle-access-actions { display: flex; gap: 8px; }.subtitle-access-actions input { min-width: 0; flex: 1; padding: 9px 10px; border: 1px solid #d8b8c3; border-radius: 6px; background: #fff; font-size: 13px; outline: none; }.subtitle-access-actions input:focus { border-color: #85344f; box-shadow: 0 0 0 3px rgba(133,52,79,.1); }.subtitle-access-actions .primary-btn { flex: 0 0 auto; white-space: nowrap; }.subtitle-access-footer { display: flex; gap: 12px; }.link-btn { padding: 0; border: 0; color: #85344f; background: transparent; font-size: 12px; font-weight: 650; cursor: pointer; }.link-btn:hover { text-decoration: underline; text-underline-offset: 3px; }.link-btn.muted { color: #7c6b71; }.subtitle-access-enter-active, .subtitle-access-leave-active { transition: opacity .18s ease, transform .18s ease; }.subtitle-access-enter-from, .subtitle-access-leave-to { opacity: 0; transform: translateY(-5px); }

.added-sources h4 { font-size: 14px; font-weight: 650; margin: 0 0 8px; color: #374151; }
.empty-hint { font-size: 13px; color: #9ca3af; padding: 16px; background: #f9fafb; border-radius: 6px; text-align: center; }
.source-list { display: flex; flex-direction: column; gap: 8px; }
.source-card { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 10px 14px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; }
.source-info { display: flex; min-width: 0; align-items: flex-start; gap: 10px; }
.source-tag { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: #e0e7ff; color: #3730a3; font-weight: 600; }
.source-details { min-width: 0; }.source-details strong { font-size: 14px; color: #1f2937; display: block; }.source-sub { font-size: 12px; color: #6b7280; }
.source-preview-toggle { display: block; margin-top: 5px; padding: 0; border: 0; color: #85344f; background: transparent; font-size: 12px; font-weight: 650; cursor: pointer; }.source-preview-toggle:hover { text-decoration: underline; text-underline-offset: 3px; }.source-preview-toggle:focus-visible { outline: 2px solid #a84b68; outline-offset: 3px; border-radius: 2px; }.source-preview { display: grid; gap: 3px; max-width: 650px; margin-top: 7px; padding: 8px 9px; border-left: 2px solid #c48b9f; background: #fff; color: #66555b; font-size: 12px; line-height: 1.5; }.source-preview b { margin-bottom: 2px; color: #754356; font-size: 11.5px; }.source-preview span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.warn-badge { color: #d97706; }
.access-badge { margin-left: 6px; padding: 1px 5px; border-radius: 4px; color: #7e3449; background: #f7e0e7; font-size: 10.5px; font-weight: 650; }
.remove-btn { background: none; border: none; color: #9ca3af; cursor: pointer; font-size: 14px; }
.remove-btn:hover { color: #dc2626; }

.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.form-field { display: flex; flex-direction: column; gap: 6px; }
.form-field label { font-size: 13px; font-weight: 600; color: #374151; }
.req { color: #dc2626; }
.section-desc { font-size: 12px; color: #6b7280; margin: 4px 0 12px; }

.style-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
.style-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; cursor: pointer; transition: all 0.15s ease; }
.style-card:hover { border-color: #ddc8d1; background: #fffbfd; }
.style-card.selected { border-color: #85344f; background: #fdf2f7; }
.style-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.style-header strong { font-size: 14px; color: #1f2937; }
.style-card.selected .style-header strong { color: #85344f; }
.style-card p { font-size: 12px; color: #6b7280; margin: 0; line-height: 1.4; }
.radio-dot { width: 14px; height: 14px; border-radius: 50%; border: 2px solid #d1d5db; }
.style-card.selected .radio-dot { border-color: #85344f; background: #85344f; }
.custom-style-box { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }

.running-panel { align-items: center; text-align: center; }
.progress-box { width: 100%; max-width: 600px; display: flex; flex-direction: column; gap: 8px; }
.progress-bar-bg { height: 10px; border-radius: 5px; background: #e5e7eb; overflow: hidden; }
.progress-bar-fill { position: relative; height: 100%; overflow: hidden; background: linear-gradient(90deg, #9d405b, #85344f 48%, #9d405b); transition: width 0.3s ease; }
.progress-bar-fill--active::after { position: absolute; inset: 0; content: ''; background: linear-gradient(100deg, transparent 18%, rgba(255,255,255,.45) 50%, transparent 82%); transform: translateX(-110%); animation: builder-progress-shimmer 1.35s ease-in-out infinite; }
@keyframes builder-progress-shimmer { to { transform: translateX(110%); } }
.progress-info { display: flex; justify-content: space-between; font-size: 13px; color: #4b5563; }
.console-box { width: 100%; max-width: 600px; border: 1px solid #e5e7eb; border-radius: 6px; background: #1e293b; color: #e2e8f0; font-family: monospace; font-size: 12px; text-align: left; overflow: hidden; }
.console-header { padding: 6px 12px; background: #0f172a; border-bottom: 1px solid #334155; font-size: 11px; color: #94a3b8; }
.console-logs { height: 180px; overflow-y: auto; padding: 8px 12px; display: flex; flex-direction: column; gap: 4px; }
.console-line { word-break: break-all; }
@media (prefers-reduced-motion: reduce) { .progress-bar-fill--active::after { animation: none; } }

.review-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e5e7eb; padding-bottom: 12px; }
.review-header h3 { font-size: 16px; font-weight: 650; margin: 0 0 4px; color: #1f2937; }
.review-header p { font-size: 13px; color: #6b7280; margin: 0; }
.tab-buttons { display: flex; gap: 6px; }
.tab-buttons button { padding: 6px 12px; border: 1px solid #d1d5db; background: white; border-radius: 6px; font-size: 13px; cursor: pointer; }
.tab-buttons button.active { background: #f3e7ed; border-color: #ddc8d1; color: #85344f; font-weight: 600; }

.rules-view { display: flex; flex-direction: column; gap: 16px; max-height: 420px; overflow-y: auto; padding-right: 4px; }
.rule-group { display: flex; flex-direction: column; gap: 8px; }
.group-title { font-size: 13px; font-weight: 650; margin: 0; }
.rule-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; background: white; }
.rule-card.verified { border-left: 4px solid #10b981; }
.rule-card.candidate { border-left: 4px solid #3b82f6; }
.rule-card.heuristic { border-left: 4px solid #f59e0b; }
.rule-top { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.badge { font-size: 11px; padding: 2px 6px; border-radius: 4px; font-weight: 600; }
.badge.verified { background: #d1fae5; color: #065f46; }
.badge.candidate { background: #dbeafe; color: #1e40af; }
.badge.heuristic { background: #fef3c7; color: #92400e; }
.rule-name { font-size: 14px; font-weight: 600; color: #1f2937; flex: 1; }
.rule-del { background: none; border: none; color: #9ca3af; font-size: 12px; cursor: pointer; }
.rule-del:hover { color: #dc2626; }
.rule-stmt { font-size: 13px; color: #374151; margin: 0 0 6px; }
.rule-acts { font-size: 12px; color: #4b5563; }
.rule-acts ul { margin: 4px 0 0 16px; padding: 0; }
.tip-sub { font-size: 11px; color: #b45309; }
.danger-box { background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 12px; font-size: 13px; color: #991b1b; }
.danger-box h4 { margin: 0 0 6px; font-size: 13px; }
.danger-box ul { margin: 0 0 0 16px; padding: 0; }

.files-view { display: flex; height: 380px; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
.file-sidebar { width: 220px; background: #f9fafb; border-right: 1px solid #e5e7eb; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 2px; }
.file-item { border: none; background: none; text-align: left; padding: 6px 10px; border-radius: 4px; font-size: 12px; color: #4b5563; cursor: pointer; font-family: monospace; }
.file-item.selected { background: #85344f; color: white; }
.file-preview { flex: 1; background: white; }
.code-editor { width: 100%; height: 100%; border: none; padding: 12px; font-family: monospace; font-size: 12px; line-height: 1.5; resize: none; outline: none; }

.success-panel { align-items: center; text-align: center; padding: 32px 16px; }
.success-icon { font-size: 48px; margin-bottom: 12px; }
.success-panel h3 { font-size: 20px; font-weight: 650; color: #1f2937; margin: 0 0 8px; }
.success-panel p { max-width: 520px; font-size: 14px; color: #4b5563; line-height: 1.6; margin: 0; }
.success-panel code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-weight: 600; color: #85344f; }

.error-banner { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; padding: 8px 12px; border-radius: 6px; font-size: 13px; }
.error-box { color: #dc2626; font-size: 13px; margin-top: 10px; }

.modal-footer {
  display: flex;
  align-items: center;
  padding: 16px 24px;
  border-top: 1px solid #e5e7eb;
  background: #f9fafb;
}
.spacer { flex: 1; }
.primary-btn { border: none; border-radius: 6px; padding: 8px 16px; background: #85344f; color: white; font-size: 14px; font-weight: 600; cursor: pointer; }
.primary-btn:hover:not(:disabled) { background: #6b283e; }
.primary-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.secondary-btn { border: 1px solid #d1d5db; border-radius: 6px; padding: 8px 16px; background: white; color: #374151; font-size: 14px; font-weight: 500; cursor: pointer; }
.secondary-btn:hover { background: #f3f4f6; }
.danger-btn { border: 1px solid #fca5a5; border-radius: 6px; padding: 8px 16px; background: #fee2e2; color: #b91c1c; font-size: 14px; font-weight: 600; cursor: pointer; }
.danger-btn:hover { background: #fecaca; }
.self-end { align-self: flex-end; }

.cookie-help-mask { position: fixed; inset: 0; z-index: 140; display: grid; place-items: center; padding: 20px; background: rgba(38, 20, 29, .48); backdrop-filter: blur(5px); }
.cookie-help-dialog { width: min(650px, 100%); max-height: min(720px, calc(100vh - 40px)); overflow-y: auto; padding: 24px; border: 1px solid #decbd3; border-radius: 12px; background: #fffdfd; box-shadow: 0 28px 70px rgba(45, 18, 31, .25); }
.cookie-help-dialog header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }.cookie-help-dialog header span { color: #9d405b; font-size: 11px; font-weight: 750; letter-spacing: .06em; }.cookie-help-dialog h3 { margin: 4px 0 0; color: #35262b; font-family: var(--font-serif); font-size: 27px; font-weight: 650; }.cookie-help-close { display: grid; width: 31px; height: 31px; place-items: center; border: 1px solid #ead9de; border-radius: 50%; color: #7a6269; background: #fff; cursor: pointer; }.cookie-help-close:hover { color: #7d2642; border-color: #cb9eae; background: #fff6f8; }
.cookie-help-intro { margin: 18px 0 16px; color: #57464c; font-size: 14px; line-height: 1.7; }.cookie-help-intro strong { color: #7f2d47; }.cookie-help-steps { display: grid; gap: 10px; }.cookie-help-steps article { display: grid; grid-template-columns: 31px minmax(0, 1fr); gap: 11px; align-items: start; padding: 11px 12px; border: 1px solid #eee3e6; border-radius: 8px; background: #fff; }.cookie-help-steps b { display: grid; width: 27px; height: 27px; place-items: center; border-radius: 50%; color: #fff; background: #8b2643; font-size: 12px; }.cookie-help-steps strong { display: block; color: #3e3035; font-size: 13px; }.cookie-help-steps small { display: block; margin-top: 3px; color: #79666c; font-size: 12.5px; line-height: 1.55; }.cookie-help-dialog kbd, .cookie-help-dialog code { display: inline-block; padding: 1px 4px; border: 1px solid #e5d8dc; border-radius: 4px; color: #704052; background: #faf6f7; font: 11.5px ui-monospace, SFMono-Regular, Consolas, monospace; }.cookie-help-steps em { color: #8b2643; font-style: normal; font-weight: 700; }
.cookie-help-map { display: flex; align-items: center; gap: 7px; margin-top: 15px; padding: 11px 12px; overflow-x: auto; border: 1px dashed #d9b9c4; border-radius: 8px; color: #7c5f6a; background: linear-gradient(105deg, #fff8fa, #fdfcfc); font-size: 11.5px; white-space: nowrap; }.cookie-help-map span { padding: 4px 6px; border: 1px solid #eadfe2; border-radius: 5px; background: #fff; }.cookie-help-map i { color: #b27c8e; font-size: 17px; font-style: normal; }.cookie-help-map strong { padding: 5px 8px; border: 1px solid #d89aaf; border-radius: 5px; color: #7c2440; background: #fff0f4; }.cookie-help-map strong small { margin-left: 4px; color: #a15f76; font-size: 10.5px; font-weight: 600; }
.cookie-help-safety { display: grid; gap: 3px; margin-top: 15px; padding: 11px 13px; border-left: 3px solid #c78144; border-radius: 6px; background: #fff8ed; }.cookie-help-safety strong { color: #7a4a1d; font-size: 12.5px; }.cookie-help-safety span { color: #745b47; font-size: 12px; line-height: 1.55; }.cookie-help-dialog footer { display: flex; justify-content: flex-end; margin-top: 18px; }.cookie-help-enter-active, .cookie-help-leave-active { transition: opacity .18s ease; }.cookie-help-enter-active .cookie-help-dialog, .cookie-help-leave-active .cookie-help-dialog { transition: opacity .18s ease, transform .18s ease; }.cookie-help-enter-from, .cookie-help-leave-to { opacity: 0; }.cookie-help-enter-from .cookie-help-dialog, .cookie-help-leave-to .cookie-help-dialog { opacity: 0; transform: translateY(8px) scale(.98); }

@media (max-width: 620px) { .subtitle-access-actions { flex-direction: column; }.subtitle-access-actions .primary-btn { width: 100%; }.cookie-help-dialog { padding: 19px; }.cookie-help-dialog h3 { font-size: 23px; }.cookie-help-map { margin-inline: -2px; }.cookie-help-safety { margin-top: 12px; } }
</style>
