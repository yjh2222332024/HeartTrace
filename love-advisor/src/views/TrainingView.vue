<script setup>
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue'
import TrainingChat from '../components/TrainingChat.vue'
import AiActivity from '../components/AiActivity.vue'
import { trainingApi } from '../api.js'

const props = defineProps({ cases: { type: Array, default: () => [] } })
const emit = defineEmits(['back'])
const toast = inject('toast', () => {})

const step = ref('choose-workspace')
const selectedCaseId = ref('')
const selectedAdvisorId = ref('default')
const advisors = ref([{ id: 'default', name: '默认情感军师', description: '帮助你看清关系事实，并给出可执行的沟通建议。' }])
const scenarios = ref([])
const session = ref(null)
const visibleMessages = ref([])
const loadingScenes = ref(false)
const starting = ref(false)
const sending = ref(false)
const typing = ref(false)
const coachLoading = ref(false)
const coachAction = ref('')
const coachCard = ref(null)
const review = ref(null)
const input = ref('')
const trainingHistory = ref([])
const loadingHistory = ref(false)
const openingHistoryId = ref('')
let initiativeTimer = null
const initiativeClaiming = ref(false)

const trainableCases = computed(() => props.cases.filter(item => item?.id && item.sessionIds?.[0]))
const selectedWorkspace = computed(() => trainableCases.value.find(item => item.id === selectedCaseId.value) || null)
const selectedAdvisor = computed(() => advisors.value.find(item => item.id === selectedAdvisorId.value) || advisors.value[0])
const peerName = computed(() => session.value?.snapshot?.workspace?.peerName || selectedWorkspace.value?.profileStatus?.peerName || selectedWorkspace.value?.title || '对方')
const ownerName = computed(() => session.value?.snapshot?.workspace?.ownerName || selectedWorkspace.value?.profileStatus?.ownerName || '我')
const activeWorkspaceTitle = computed(() => selectedWorkspace.value?.title || session.value?.snapshot?.workspace?.title || '')
const coachActivityLabel = computed(() => ({
  hint: '军师正在看这局…',
  pause: '军师正在整理点评…',
  resume: '正在继续实战…',
  review: '军师正在生成复盘…',
}[coachAction.value] || '军师正在思考…'))
const isPaused = computed(() => session.value?.state === 'paused')
const isReadOnly = computed(() => session.value?.state === 'reviewed' || session.value?.state === 'ended')
const waitingForPeer = computed(() => (
  session.value?.state === 'active'
  && !!session.value?.pendingInitiative
  && !sending.value
  && !typing.value
))
const composerDisabled = computed(() => starting.value || sending.value || typing.value || isReadOnly.value || isPaused.value || coachAction.value === 'pause')

function historyStatus(item) {
  if (item.state === 'reviewed') return '已复盘'
  if (item.state === 'paused') return '已暂停'
  return '训练中'
}

function historyTimestamp(item) {
  const date = new Date(item?.updatedAt || item?.createdAt || '')
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

async function loadTrainingHistory() {
  loadingHistory.value = true
  try {
    const response = await trainingApi.list()
    if (!response?.ok) throw new Error(response?.error || '训练记录加载失败')
    trainingHistory.value = response.data?.items || []
  } catch (error) {
    toast(error.message || '训练记录加载失败')
  } finally {
    loadingHistory.value = false
  }
}

async function openTrainingHistory(item) {
  if (!item?.id || openingHistoryId.value) return
  openingHistoryId.value = item.id
  clearInitiativeTimer()
  try {
    const response = await trainingApi.get(item.id)
    if (!response?.ok) throw new Error(response?.error || '训练记录读取失败')
    const saved = response.data
    selectedCaseId.value = saved.caseId || ''
    selectedAdvisorId.value = saved.advisorId || 'default'
    session.value = saved
    visibleMessages.value = saved.messages || []
    review.value = saved.state === 'reviewed' ? saved.review : null
    const latestCoach = [...(saved.messages || [])].reverse().find(message => message?.role === 'coach')
    coachCard.value = review.value || (latestCoach ? { title: saved.state === 'paused' ? '暂停点评' : '军师提示', body: latestCoach.content } : null)
    input.value = ''
    step.value = 'chat'
    schedulePendingInitiative()
  } catch (error) {
    toast(error.message || '训练记录读取失败')
  } finally {
    openingHistoryId.value = ''
  }
}

function clearInitiativeTimer() {
  if (initiativeTimer !== null) window.clearTimeout(initiativeTimer)
  initiativeTimer = null
}

function pendingDelayMs() {
  const dueAt = Date.parse(session.value?.pendingInitiative?.dueAt || '')
  return Number.isFinite(dueAt) ? Math.max(0, dueAt - Date.now()) : null
}

function schedulePendingInitiative() {
  clearInitiativeTimer()
  if (!session.value || isPaused.value || review.value || initiativeClaiming.value) return
  const delay = pendingDelayMs()
  if (delay === null) return
  initiativeTimer = window.setTimeout(() => { deliverPendingInitiative() }, delay)
}

async function deliverPendingInitiative() {
  clearInitiativeTimer()
  if (!session.value || isPaused.value || review.value || sending.value || initiativeClaiming.value) return
  const sessionId = session.value.id
  initiativeClaiming.value = true
  try {
    const response = await trainingApi.deliverInitiative(sessionId)
    if (!response?.ok) return
    if (!session.value || session.value.id !== sessionId) return
    session.value = response.data.session
    const messages = response.data.messages || []
    if (!messages.length) return
    // 长等待期间不伪造输入状态；真正投递前才给一个很短的“正在输入”。
    typing.value = true
    await wait(420)
    for (const message of messages) {
      await wait(Math.min(120 + (message.afterSeconds || 0) * 75, 760))
      visibleMessages.value.push(message)
    }
  } catch {
    // 领取失败通常是刷新、结束或用户抢先发言；下次状态同步即可恢复。
  } finally {
    typing.value = false
    initiativeClaiming.value = false
    schedulePendingInitiative()
    void loadTrainingHistory()
  }
}

function resetTraining() {
  clearInitiativeTimer()
  step.value = 'choose-workspace'
  selectedCaseId.value = ''
  scenarios.value = []
  session.value = null
  visibleMessages.value = []
  coachCard.value = null
  review.value = null
  input.value = ''
  coachAction.value = ''
  void loadTrainingHistory()
}

function chooseWorkspace(workspace) {
  selectedCaseId.value = workspace.id
  scenarios.value = []
  coachCard.value = null
  step.value = 'choose-advisor'
}

async function generateScenarios() {
  if (!selectedWorkspace.value || loadingScenes.value) return
  loadingScenes.value = true
  coachCard.value = null
  try {
    const response = await trainingApi.scenarios({ caseId: selectedWorkspace.value.id, advisorId: selectedAdvisorId.value })
    if (!response?.ok) throw new Error(response?.error || '场景生成失败')
    scenarios.value = response.data.scenarios || []
    if (!scenarios.value.length) throw new Error('没有生成可用场景，请重试')
    step.value = 'choose-scenario'
  } catch (error) {
    toast(error.message || '场景生成失败')
  } finally {
    loadingScenes.value = false
  }
}

async function beginScenario(scenario) {
  if (starting.value || !selectedWorkspace.value) return
  starting.value = true
  try {
    const response = await trainingApi.create({
      caseId: selectedWorkspace.value.id,
      advisorId: selectedAdvisorId.value,
      scenario,
    })
    if (!response?.ok) throw new Error(response?.error || '训练创建失败')
    session.value = response.data
    visibleMessages.value = []
    coachCard.value = null
    review.value = null
    step.value = 'chat'
    typing.value = true
    await wait(520)
    for (const message of response.data.openingMessages || response.data.messages || []) {
      await wait(Math.min(150 + (message.afterSeconds || 0) * 70, 900))
      visibleMessages.value.push(message)
    }
    schedulePendingInitiative()
    void loadTrainingHistory()
  } catch (error) {
    toast(error.message || '训练创建失败')
  } finally {
    typing.value = false
    starting.value = false
  }
}

function wait(ms) {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

async function sendMessage() {
  const content = input.value.trim()
  if (!content || composerDisabled.value || !session.value) return
  input.value = ''
  sending.value = true
  clearInitiativeTimer()
  const optimistic = {
    id: `local_${Date.now()}`,
    role: 'me',
    content,
    simulatedMinutes: session.value.simulatedMinutes || 0,
  }
  visibleMessages.value.push(optimistic)
  // 模型仍在请求时也立即呈现输入状态，避免几十秒空白看上去像界面卡住。
  typing.value = true
  try {
    const response = await trainingApi.turn(session.value.id, { content })
    if (!response?.ok) throw new Error(response?.error || '对方暂时没有回应')
    session.value = response.data.session
    await wait(Math.min(700 + (response.data.delayMinutes || 0) * 12, 2200))
    for (const message of response.data.messages || []) {
      await wait(Math.min(180 + (message.afterSeconds || 0) * 75, 1300))
      visibleMessages.value.push(message)
    }
  } catch (error) {
    toast(error.message || '发送失败')
  } finally {
    typing.value = false
    sending.value = false
    schedulePendingInitiative()
    void loadTrainingHistory()
  }
}

async function askCoach(mode) {
  if (!session.value || coachLoading.value) return
  coachAction.value = mode
  coachLoading.value = true
  if (mode === 'pause') clearInitiativeTimer()
  try {
    const response = await trainingApi.coach(session.value.id, { mode })
    if (!response?.ok) throw new Error(response?.error || '军师暂时无法点评')
    coachCard.value = response.data.coach
    session.value = response.data.session || session.value
  } catch (error) {
    if (mode === 'pause' && session.value) {
      const latest = await trainingApi.get(session.value.id).catch(() => null)
      if (latest?.ok) session.value = latest.data
    }
    toast(error.message || '军师暂时无法点评')
  } finally {
    coachLoading.value = false
    coachAction.value = ''
    schedulePendingInitiative()
    void loadTrainingHistory()
  }
}

async function resumeTraining() {
  if (!session.value || coachLoading.value || !isPaused.value) return
  coachAction.value = 'resume'
  coachLoading.value = true
  try {
    const response = await trainingApi.resume(session.value.id)
    if (!response?.ok) throw new Error(response?.error || '暂时无法继续训练')
    session.value = response.data.session
    coachCard.value = null
  } catch (error) {
    toast(error.message || '暂时无法继续训练')
  } finally {
    coachLoading.value = false
    coachAction.value = ''
    schedulePendingInitiative()
    void loadTrainingHistory()
  }
}

async function finishTraining() {
  if (!session.value || coachLoading.value) return
  clearInitiativeTimer()
  coachAction.value = 'review'
  coachLoading.value = true
  try {
    const response = await trainingApi.review(session.value.id)
    if (!response?.ok) throw new Error(response?.error || '复盘生成失败')
    session.value = response.data.session
    review.value = response.data.review
    coachCard.value = response.data.review
  } catch (error) {
    toast(error.message || '复盘生成失败')
  } finally {
    coachLoading.value = false
    coachAction.value = ''
    schedulePendingInitiative()
    void loadTrainingHistory()
  }
}

onMounted(async () => {
  void loadTrainingHistory()
  try {
    const response = await fetch('/api/skills').then(result => result.json())
    if (!response?.ok) return
    const custom = (response.data?.items || []).map(item => ({ id: item.id, name: item.name, description: item.description || '自定义训练军师' }))
    advisors.value = [advisors.value[0], ...custom.filter(item => item.id !== 'default')]
  } catch { /* 默认军师仍可用 */ }
})

onBeforeUnmount(clearInitiativeTimer)
</script>

<template>
  <section class="training-view">
    <header class="training-topbar">
      <button class="training-back" type="button" @click="step === 'chat' ? resetTraining() : emit('back')">←</button>
      <div class="training-title">
        <span>模拟训练</span>
        <small v-if="activeWorkspaceTitle">{{ activeWorkspaceTitle }}</small>
      </div>
      <div class="training-top-status" :class="{ live: step === 'chat' && !review && !isPaused }">
        {{ review ? '已复盘' : isPaused ? '已暂停' : waitingForPeer ? '等待对方回应' : step === 'chat' ? '训练中' : '陪练模式' }}
      </div>
    </header>

    <Transition name="app-view" mode="out-in">
    <main v-if="step !== 'chat'" key="training-setup" class="training-setup">
      <div class="training-setup-copy">
        <span class="eyebrow">ROLEPLAY LAB</span>
        <h1>{{ step === 'choose-workspace' ? '先选一段关系，开始练习' : '把这一局练得更像真的' }}</h1>
        <p>只用这段档案，不影响真实聊天。</p>
      </div>

      <Transition name="wizard-step" mode="out-in">
      <div v-if="step === 'choose-workspace'" key="choose-workspace" class="workspace-picker">
        <section v-if="loadingHistory || trainingHistory.length" class="training-history" aria-label="最近训练">
          <div class="training-history-heading"><strong>最近训练</strong><span v-if="trainingHistory.length">{{ trainingHistory.length }} 局</span></div>
          <div v-if="loadingHistory" class="training-history-loading"><AiActivity label="正在读取训练记录…" size="sm" /></div>
          <div v-else class="training-history-list">
            <button v-for="item in trainingHistory" :key="item.id" class="training-history-item" type="button" :disabled="!!openingHistoryId" @click="openTrainingHistory(item)">
              <span class="training-history-avatar">{{ (item.workspace?.peerName || item.workspace?.title || '?').slice(0, 1) }}</span>
              <span class="training-history-copy"><strong>{{ item.workspace?.title || '已删除的工作区' }}</strong><small>{{ item.scenario?.title || '未命名场景' }} · {{ item.messageCount || 0 }} 条消息</small></span>
              <span class="training-history-meta"><em :class="item.state">{{ historyStatus(item) }}</em><small>{{ historyTimestamp(item) }}</small></span>
            </button>
          </div>
        </section>
        <div class="training-workspace-list">
          <button v-for="workspace in trainableCases" :key="workspace.id" class="training-workspace-card" type="button" @click="chooseWorkspace(workspace)">
            <span class="workspace-avatar">{{ (workspace.profileStatus?.peerName || workspace.title || '?').slice(0, 1) }}</span>
            <span class="workspace-copy"><strong>{{ workspace.title }}</strong><small>{{ workspace.stage || '私聊档案' }}</small></span>
            <span class="workspace-arrow">→</span>
          </button>
          <div v-if="!trainableCases.length" class="training-empty">
            <strong>还没有可训练的私聊档案</strong>
            <span>先导入一份一对一聊天记录并创建私聊档案，再回来开始练习。</span>
          </div>
        </div>
      </div>

      <div v-else-if="step === 'choose-advisor'" key="choose-advisor" class="advisor-picker">
        <button class="setup-back" type="button" @click="step = 'choose-workspace'">← 重选工作区</button>
        <div class="chosen-workspace"><span>{{ (selectedWorkspace?.profileStatus?.peerName || selectedWorkspace?.title || '?').slice(0, 1) }}</span><div><strong>{{ selectedWorkspace?.title }}</strong><small>由军师根据这份档案动态出题</small></div></div>
        <h2>这局由谁来带练？</h2>
        <div class="advisor-options">
          <button v-for="advisor in advisors" :key="advisor.id" type="button" class="advisor-option" :class="{ selected: advisor.id === selectedAdvisorId }" @click="selectedAdvisorId = advisor.id">
            <span class="advisor-option-mark">@</span><span><strong>{{ advisor.name }}</strong><small>{{ advisor.description }}</small></span><b v-if="advisor.id === selectedAdvisorId">✓</b>
          </button>
        </div>
        <button class="training-primary" type="button" :disabled="loadingScenes" @click="generateScenarios">
          <AiActivity v-if="loadingScenes" label="军师正在根据档案出题…" size="sm" tone="inverse" />
          <span v-else>生成这一局的场景</span>
        </button>
      </div>

      <div v-else key="choose-scenario" class="scenario-picker">
        <button class="setup-back" type="button" @click="step = 'choose-advisor'">← 更换军师</button>
        <div class="scenario-heading"><span>本局军师：{{ selectedAdvisor?.name }}</span><h2>挑一局开始练</h2></div>
        <div class="scenario-grid">
          <button v-for="scenario in scenarios" :key="scenario.id" type="button" class="scenario-card" :disabled="starting" @click="beginScenario(scenario)">
            <span class="scenario-difficulty">{{ scenario.difficulty }}</span><strong>{{ scenario.title }}</strong><p>{{ scenario.premise }}</p><span class="scenario-start" aria-hidden="true">→</span>
          </button>
        </div>
        <div v-if="starting" class="scenario-starting-overlay">
          <AiActivity label="对方正在准备开场…" size="hero" />
        </div>
        <button class="regenerate-scenes" type="button" :disabled="loadingScenes" @click="generateScenarios">
          <AiActivity v-if="loadingScenes" label="军师正在重新出题…" size="sm" />
          <span v-else>换一批场景</span>
        </button>
      </div>
      </Transition>
    </main>

    <main v-else key="training-live" class="training-live">
      <TrainingChat :session="session" :messages="visibleMessages" :peer-name="peerName" :owner-name="ownerName" :typing="typing" />
      <aside class="training-coach-panel">
        <div class="coach-panel-heading"><span>本局目标</span><strong>{{ session.scenario.goal || '自然推进这段对话' }}</strong></div>
        <Transition name="content-reveal" mode="out-in">
          <div v-if="coachLoading" key="coach-loading" class="coach-loading"><AiActivity :label="coachActivityLabel" size="sm" /></div>
          <div v-else-if="coachCard" key="coach-card" class="coach-card" :class="{ review: !!review }"><span>{{ coachCard.title }}</span><p>{{ coachCard.body }}</p><ul v-if="coachCard.suggestions?.length"><li v-for="suggestion in coachCard.suggestions" :key="suggestion">{{ suggestion }}</li></ul></div>
          <div v-else key="coach-idle" class="coach-idle">需要时再问军师。</div>
        </Transition>
        <div class="coach-actions"><button type="button" :disabled="coachLoading || sending || isReadOnly || isPaused" @click="askCoach('hint')">给个提示</button><button type="button" :disabled="coachLoading || sending || isReadOnly" @click="isPaused ? resumeTraining() : askCoach('pause')">{{ isPaused ? '继续实战' : '暂停点评' }}</button><button class="finish-training" type="button" :disabled="coachLoading || sending || isReadOnly || isPaused || !visibleMessages.length" @click="finishTraining">结束复盘</button></div>
      </aside>
      <form class="training-composer" @submit.prevent="sendMessage">
        <textarea v-model="input" :disabled="composerDisabled" maxlength="1200" rows="1" placeholder="输入你想说的话…" @keydown.enter.exact.prevent="sendMessage"></textarea>
        <button type="submit" :disabled="!input.trim() || composerDisabled" aria-label="发送训练消息">➤</button>
      </form>
    </main>
    </Transition>
  </section>
</template>

<style scoped>
.training-view { width: 100%; height: 100%; min-height: 0; display: flex; flex-direction: column; color: #2d2828; background: #fbfaf9; }
.training-topbar { height: 56px; flex: 0 0 56px; display: flex; align-items: center; gap: 12px; padding: 0 22px; border-bottom: 1px solid #eee7e6; background: rgba(255,255,255,.92); }
.training-back { width: 32px; height: 32px; border: 0; border-radius: 9px; color: #5c5454; background: transparent; cursor: pointer; font-size: 22px; line-height: 1; }.training-back:hover { background: #f5f0f0; }
.training-title { display: flex; align-items: baseline; gap: 8px; min-width: 0; }.training-title span { color: #332d2e; font-size: 15px; font-weight: 720; }.training-title small { overflow: hidden; color: #9b9090; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.training-top-status { margin-left: auto; padding: 4px 9px; border-radius: 999px; color: #9a717a; background: #faf0f2; font-size: 11px; font-weight: 650; }.training-top-status.live { color: #488358; background: #ecf7ee; }
.training-setup { flex: 1; overflow-y: auto; padding: clamp(32px, 6vw, 72px) 24px 48px; }.training-setup-copy, .workspace-picker, .advisor-picker, .scenario-picker { width: min(840px, 100%); margin: 0 auto; }.training-setup-copy { text-align: center; }.eyebrow { color: #a05269; font-size: 11px; font-weight: 750; letter-spacing: .16em; }.training-setup h1 { margin: 10px 0 9px; font-family: var(--font-serif); font-size: clamp(30px, 4vw, 44px); line-height: 1.1; font-weight: 600; }.training-setup-copy p { max-width: 570px; margin: 0 auto; color: #817779; font-size: 14px; line-height: 1.7; }
.workspace-picker { display: grid; gap: 26px; margin-top: 36px; }.training-workspace-list { display: grid; gap: 12px; }.training-workspace-card { width: 100%; display: flex; align-items: center; gap: 14px; padding: 16px 18px; border: 1px solid #eae1e2; border-radius: 15px; color: inherit; background: #fff; box-shadow: 0 5px 20px rgba(57,34,39,.035); text-align: left; cursor: pointer; transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease; }.training-workspace-card:hover { transform: translateY(-2px); border-color: #cf8ea1; box-shadow: 0 12px 28px rgba(113,48,67,.1); }.workspace-avatar, .chosen-workspace > span { width: 43px; height: 43px; flex: 0 0 43px; display: grid; place-items: center; border-radius: 13px; color: #fff; background: linear-gradient(145deg,#c06981,#862f4b); font-size: 18px; font-weight: 700; }.workspace-copy { min-width: 0; display: grid; gap: 3px; }.workspace-copy strong { font-size: 15px; }.workspace-copy small { overflow: hidden; color: #887d7e; font-size: 12.5px; line-height: 1.45; text-overflow: ellipsis; white-space: nowrap; }.workspace-arrow { margin-left: auto; color: #b77a8b; font-size: 20px; }.training-empty { display: grid; gap: 6px; padding: 34px; border: 1px dashed #dfd1d3; border-radius: 15px; color: #8d8183; text-align: center; }.training-empty strong { color: #625759; }
.training-history { min-width: 0; padding-bottom: 20px; border-bottom: 1px solid #eee5e6; }.training-history-heading { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }.training-history-heading strong { color: #594c4e; font-size: 13px; font-weight: 720; }.training-history-heading span { color: #a09093; font-size: 11px; }.training-history-loading { display: flex; align-items: center; min-height: 52px; padding: 0 12px; border: 1px solid #eee5e6; border-radius: 10px; background: #fff; }.training-history-list { display: grid; gap: 5px; max-height: 264px; overflow-y: auto; padding-right: 3px; }.training-history-item { width: 100%; min-width: 0; display: flex; align-items: center; gap: 10px; padding: 10px 11px; border: 1px solid transparent; border-radius: 10px; color: #473c3e; background: transparent; text-align: left; cursor: pointer; transition: background .15s ease, border-color .15s ease; }.training-history-item:hover:not(:disabled) { border-color: #ead9dd; background: #fff8f9; }.training-history-item:disabled { cursor: wait; opacity: .58; }.training-history-avatar { width: 31px; height: 31px; flex: 0 0 31px; display: grid; place-items: center; border-radius: 9px; color: #a1435e; background: #f7e7eb; font-size: 13px; font-weight: 760; }.training-history-copy { min-width: 0; display: grid; gap: 2px; }.training-history-copy strong, .training-history-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.training-history-copy strong { font-size: 13px; font-weight: 680; }.training-history-copy small { color: #8e8183; font-size: 11.5px; }.training-history-meta { margin-left: auto; display: grid; justify-items: end; gap: 3px; flex: 0 0 auto; }.training-history-meta em { padding: 2px 6px; border-radius: 999px; color: #9c5266; background: #fbebef; font-size: 10px; font-style: normal; font-weight: 700; }.training-history-meta em.active { color: #4c7e56; background: #edf7ee; }.training-history-meta em.paused { color: #8b6e45; background: #fbf3e6; }.training-history-meta small { color: #a5989a; font-size: 10px; }
.advisor-picker, .scenario-picker { margin-top: 28px; }.scenario-picker { position: relative; }.setup-back, .regenerate-scenes { border: 0; color: #8b5060; background: transparent; cursor: pointer; font-size: 13px; }.chosen-workspace { display: flex; align-items: center; gap: 10px; margin: 18px 0 25px; padding: 12px; border: 1px solid #f0e4e6; border-radius: 13px; background: #fff8f9; }.chosen-workspace > span { width: 33px; height: 33px; flex-basis: 33px; border-radius: 10px; font-size: 14px; }.chosen-workspace div { display: grid; gap: 1px; }.chosen-workspace strong { font-size: 13px; }.chosen-workspace small { color: #967d82; font-size: 11.5px; }.advisor-picker h2, .scenario-heading h2 { margin: 0 0 16px; font-family: var(--font-serif); font-size: 27px; font-weight: 600; }.advisor-options { display: grid; gap: 9px; }.advisor-option { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 12px; border: 1px solid #e9e1e2; border-radius: 12px; background: #fff; color: inherit; text-align: left; cursor: pointer; }.advisor-option.selected { border-color: #bd6f84; background: #fff7f8; box-shadow: inset 3px 0 #9e425c; }.advisor-option-mark { width: 31px; height: 31px; display: grid; place-items: center; border-radius: 9px; color: #913752; background: #f7e8ec; font-weight: 800; }.advisor-option span:nth-child(2) { min-width: 0; display: grid; gap: 2px; }.advisor-option strong { font-size: 13px; }.advisor-option small { overflow: hidden; color: #8d8182; font-size: 11.5px; text-overflow: ellipsis; white-space: nowrap; }.advisor-option b { margin-left: auto; color: #9a3b57; }.training-primary { width: 100%; height: 45px; margin-top: 16px; border: 0; border-radius: 11px; color: #fff; background: linear-gradient(135deg,#8b2643,#6b172f); box-shadow: 0 8px 18px rgba(117,36,63,.18); cursor: pointer; font-weight: 650; }.training-primary:disabled { opacity: .58; cursor: wait; }
.scenario-heading { text-align: center; }.scenario-heading > span { color: #a05269; font-size: 12px; }.scenario-grid { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 13px; }.scenario-card { position: relative; min-height: 190px; display: flex; flex-direction: column; align-items: flex-start; padding: 18px; overflow: hidden; border: 1px solid #e8dfe0; border-radius: 15px; color: #3e3638; background: #fff; text-align: left; cursor: pointer; transition: transform .17s ease, border-color .17s ease, box-shadow .17s ease; }.scenario-card:hover:not(:disabled) { transform: translateY(-3px); border-color: #bd7488; box-shadow: 0 13px 26px rgba(103,43,61,.11); }.scenario-card:disabled { opacity: .6; cursor: wait; }.scenario-difficulty { padding: 3px 7px; border-radius: 999px; color: #a14c63; background: #fff0f3; font-size: 11px; }.scenario-card strong { margin-top: 14px; font-family: var(--font-serif); font-size: 23px; font-weight: 600; }.scenario-card p { margin: 9px 0 0; color: #706567; font-size: 14px; line-height: 1.55; }.scenario-start { margin-top: auto; align-self: flex-end; color: #913953; font-size: 22px; font-weight: 700; }.scenario-starting-overlay { position: absolute; inset: -8px; z-index: 2; display: grid; place-items: center; border-radius: 16px; background: rgba(251,250,249,.82); backdrop-filter: blur(3px); }.scenario-starting-overlay .ai-activity { padding: 11px 15px; border: 1px solid #ead9de; border-radius: 999px; background: rgba(255,255,255,.94); box-shadow: 0 8px 24px rgba(112,47,65,.1); }.scenario-starting-overlay :deep(.ai-activity--hero) { padding: 18px 27px; border-color: rgba(203,139,158,.38); box-shadow: 0 14px 34px rgba(117,50,70,.13); }.regenerate-scenes { display: block; margin: 19px auto 0; text-decoration: underline; text-underline-offset: 3px; }
.training-live { position: relative; flex: 1; min-height: 0; display: flex; overflow: hidden; background: #ededed; }.training-coach-panel { width: min(285px, 28%); flex: 0 0 min(285px, 28%); display: flex; flex-direction: column; gap: 13px; padding: 16px; border-left: 1px solid #e4dcdc; background: rgba(255,255,255,.96); overflow-y: auto; }.coach-panel-heading { display: grid; gap: 5px; padding-bottom: 12px; border-bottom: 1px solid #eee8e8; }.coach-panel-heading span { color: #a26274; font-size: 12px; font-weight: 700; }.coach-panel-heading strong { font-size: 15px; line-height: 1.5; }.coach-idle { color: #8d8182; font-size: 14px; line-height: 1.7; }.coach-loading { display: grid; min-height: 98px; place-items: center start; padding: 14px; border: 1px solid #efd6dc; border-radius: 12px; background: #fff7f8; }.coach-card { padding: 14px; border: 1px solid #efd6dc; border-radius: 12px; background: #fff7f8; }.coach-card.review { border-color: #d4e6d6; background: #f3faf3; }.coach-card > span { color: #964159; font-size: 12px; font-weight: 750; }.coach-card.review > span { color: #4a8055; }.coach-card p { margin: 7px 0; color: #584c4e; font-size: 14px; line-height: 1.7; white-space: pre-wrap; }.coach-card ul { margin: 8px 0 0; padding-left: 17px; color: #6f6063; font-size: 13px; line-height: 1.6; }.coach-actions { margin-top: auto; display: grid; gap: 7px; }.coach-actions button { height: 38px; border: 1px solid #e6dadd; border-radius: 8px; color: #7c4858; background: #fff; cursor: pointer; font-size: 13px; font-weight: 650; }.coach-actions .finish-training { color: #477c52; border-color: #cce0ce; background: #f4fbf4; }.coach-actions button:disabled { opacity: .5; cursor: not-allowed; }.training-composer { position: absolute; right: min(285px, 28%); bottom: 0; left: 0; display: flex; align-items: flex-end; gap: 10px; padding: 12px clamp(14px,3vw,34px) 15px; background: linear-gradient(to top,rgba(237,237,237,.98) 70%,rgba(237,237,237,0)); }.training-composer textarea { min-width: 0; flex: 1; min-height: 48px; max-height: 120px; padding: 11px 13px; resize: none; border: 1px solid #d7d7d7; border-radius: 7px; outline: none; background: #fff; color: #222; font-size: 16px; line-height: 1.55; }.training-composer textarea:focus { border-color: #8db57f; }.training-composer button { width: 48px; height: 48px; flex: 0 0 48px; border: 0; border-radius: 7px; color: #fff; background: #07c160; cursor: pointer; font-size: 21px; }.training-composer button:disabled { background: #b3dcbc; cursor: not-allowed; }
@media (max-width: 880px) { .training-live { flex-direction: column; }.training-coach-panel { width: 100%; flex: 0 0 auto; order: 2; display: grid; grid-template-columns: 1fr auto; align-items: start; gap: 10px; max-height: 36%; border-top: 1px solid #e4dcdc; border-left: 0; }.coach-panel-heading { border: 0; padding: 0; }.coach-actions { margin: 0; display: flex; flex-wrap: wrap; justify-content: flex-end; }.coach-actions button { padding: 0 9px; }.coach-idle, .coach-card { grid-column: 1 / -1; }.training-composer { right: 0; bottom: min(36%, 220px); }.training-chat-scroll { padding-bottom: 70px; } }
@media (max-width: 640px) { .training-topbar { padding-inline: 11px; }.training-title small { display: none; }.training-setup { padding-inline: 14px; }.scenario-grid { grid-template-columns: 1fr; }.scenario-card { min-height: 190px; }.training-coach-panel { max-height: 43%; }.training-composer { bottom: min(43%, 260px); padding-inline: 12px; }.coach-actions { justify-content: flex-start; }.coach-actions button { flex: 1; }.training-setup h1 { font-size: 32px; } }
</style>
