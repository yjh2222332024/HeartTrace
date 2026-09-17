<script setup>
// ── 关系工作区档案：她 / 我 / 关系 / 记忆 分页签 ──────────
// 档案是"蒸馏后的结论"（常驻注入每次分析），记忆是"原始证据"（可溯源 runId）
import { ref, reactive, computed, watch, inject, onUnmounted } from 'vue'
import MemoryCandidateCard from './MemoryCandidateCard.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import AiActivity from './AiActivity.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  caseId: { type: String, default: '__new__' },   // '__new__' = 创建模式
  sessions: { type: Array, default: () => [] },   // 可绑定的 ChatLab 会话
  initialSession: { type: Object, default: null }, // 预选私聊会话
})
const emit = defineEmits(['close', 'changed', 'deleted', 'import'])
const toast = inject('toast', () => {})

const STAGES = ['陌生', '初识', '暧昧', '交往', '冲突/分手']
const RISKS = [
  { value: 'normal', label: '普通' },
  { value: 'high', label: '高风险' },
  { value: 'safety', label: '安全优先' },
]
const MEM_TYPE_LABELS = { episodic: '事件', semantic: '结论', risk: '风险', preference: '偏好' }

const TABS = [
  { id: 'her', label: '她' },
  { id: 'me', label: '我' },
  { id: 'relationship', label: '关系' },
  { id: 'memory', label: '记忆' },
]

const isNew = () => props.caseId === '__new__'
const id = ref('')
const tab = ref('her')
const form = reactive({
      title: '', stage: '初识', riskLevel: 'normal', summary: '', sessionIds: [], profileStatus: null,
      her: { persona: '', traits: '', likes: '', dislikes: '', commStyle: '', replyStyle: '', callHistory: '' },
  me: { goal: '', style: '', pitfalls: '' },
  relationship: { keyEvents: [], openLoops: '', boundaries: '' },
})
const newEvent = reactive({ date: '', event: '' })
const memories = ref([])
const memoryCandidates = ref([])
const memoryView = ref('pending')
const newMemory = ref('')
const saving = ref(false)
const job = ref(null)
let pollTimer = null

// 数组 <-> 逗号分隔字符串（表单交互用字符串，提交时转数组）
function arrToStr(a) { return (a || []).join('，') }
function strToArr(s) { return String(s || '').split(/[，,、\n]/).map(x => x.trim()).filter(Boolean) }

async function load(keepJob = false) {
  if (isNew()) {
    id.value = ''
    stopPolling()
    job.value = null
    const initS = props.initialSession
    Object.assign(form, {
      title: initS ? `和${initS.name}` : '',
      stage: '初识',
      riskLevel: 'normal',
      summary: '',
      sessionIds: initS ? [initS.id] : [],
      profileStatus: null,
      her: { persona: '', traits: '', likes: '', dislikes: '', commStyle: '', replyStyle: '', callHistory: '' },
      me: { goal: '', style: '', pitfalls: '' },
      relationship: { keyEvents: [], openLoops: '', boundaries: '' },
    })
    memories.value = []
    memoryCandidates.value = []
    memoryView.value = 'pending'
    tab.value = 'her'
    return
  }
  try {
    const j = await fetch(`/api/cases/${props.caseId}`).then(r => r.json())
    if (!j.ok) return toast('工作区加载失败')
    const d = j.data
    id.value = d.id
    Object.assign(form, {
      title: d.title, stage: d.stage, riskLevel: d.riskLevel, summary: d.summary,
      sessionIds: d.sessionIds?.slice(0, 1) || [],
      profileStatus: d.profileStatus || null,
      her: {
        persona: d.her.persona, traits: arrToStr(d.her.traits), likes: arrToStr(d.her.likes),
        dislikes: arrToStr(d.her.dislikes), commStyle: d.her.commStyle, replyStyle: d.her.replyStyle || '', callHistory: arrToStr(d.her.callHistory),
      },
      me: { goal: d.me.goal, style: d.me.style, pitfalls: arrToStr(d.me.pitfalls) },
      relationship: {
        keyEvents: [...d.relationship.keyEvents],
        openLoops: arrToStr(d.relationship.openLoops), boundaries: arrToStr(d.relationship.boundaries),
      },
    })
    memories.value = d.memories
    memoryCandidates.value = d.memoryCandidates || []
    ownerPick.value = d.profileStatus?.ownerName || ''
    if (!keepJob) {
      job.value = null
      pollJob() // 若有正在跑/失败的分析任务，接上进度
    }
  } catch { toast('后端未启动') }
}

const profile = computed(() => ({
  status: 'empty',
  ownerName: '',
  peerName: '',
  warnings: [],
  draft: null,
  ...(typeof form.profileStatus === 'object' ? form.profileStatus : {}),
}))
const pendingMemoryCandidates = computed(() => memoryCandidates.value.filter(candidate => candidate.status === 'pending'))

watch(() => [props.open, props.caseId], ([o]) => { if (o) load(); else stopPolling() }, { immediate: true })

const privateSessions = computed(() => (props.sessions || []).filter(s => s.type !== 'group' && s.type !== 'groups'))
const confirming = ref(false)
const showDeleteConfirm = ref(false)
const deleting = ref(false)
const ownerPick = ref('')

function bindSession(sid) {
  form.sessionIds = sid ? [sid] : []
}

// ── 导入分析进度：创建/重试后轮询 /api/imports，完成后刷新出草稿确认卡 ──
const JOB_ACTIVE = ['queued', 'analyzing']
const PHASE_LABELS = {
  prepare: '读取会话 · 识别机主',
  map: '逐段抽取聊天事实',
  reduce: '归并关系画像',
  persist: '写入工作区',
  done: '完成',
}

const jobActive = computed(() => !!job.value && JOB_ACTIVE.includes(job.value.state))
const progressPct = computed(() => {
  const j = job.value
  if (!j) return 0
  if (j.state === 'done') return 100
  if (j.phase === 'map') return 8 + 57 * (j.mapDone || 0) / Math.max(1, j.mapTotal || 1)
  if (j.phase === 'reduce') return 65 + 30 * (j.reduceDone || 0) / Math.max(1, j.reduceTotal || 1)
  if (j.phase === 'persist') return 96
  return 6
})
const jobDetail = computed(() => {
  const j = job.value
  if (!j) return ''
  if (j.since) return `聊天跨度 ${String(j.since).slice(0, 10)} ~ ${String(j.until).slice(0, 10)} · 片段 ${j.mapDone || 0}/${j.mapTotal || 0} · 归并 ${j.reduceDone || 0}/${j.reduceTotal || 0}`
  return `片段 ${j.mapDone || 0}/${j.mapTotal || 0} · 归并 ${j.reduceDone || 0}/${j.reduceTotal || 0}`
})

function ensurePolling() {
  if (!pollTimer) pollTimer = setInterval(pollJob, 1500)
}
function stopPolling() {
  clearInterval(pollTimer)
  pollTimer = null
}
async function pollJob() {
  if (isNew() || !id.value) return
  try {
    const j = await fetch(`/api/imports?caseId=${id.value}`).then(r => r.json())
    if (!j.ok) return
    job.value = j.data
    if (j.data && JOB_ACTIVE.includes(j.data.state)) ensurePolling()
    else {
      stopPolling()
      if (j.data?.state === 'done') await load(true) // 拉出待确认草稿卡（不再回查 job，避免循环）
    }
  } catch { /* 后端未启动时静默 */ }
}
function trackJob(j) {
  job.value = j || null
  if (j && JOB_ACTIVE.includes(j.state)) ensurePolling()
}
async function startAnalysis(force) {
  if (isNew() || !id.value) return
  try {
    const j = await fetch('/api/imports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseId: id.value, force }),
    }).then(r => r.json())
    if (!j.ok) return toast(j.error || '发起失败')
    trackJob(j.data?.job)
  } catch { toast('后端未启动') }
}
function reanalyze() { return startAnalysis(true) }
function retryAnalysis() { return startAnalysis(false) }
async function cancelJob() {
  if (!job.value) return
  try { await fetch(`/api/imports/${job.value.id}/cancel`, { method: 'POST' }) } catch { /* 静默 */ }
}
onUnmounted(stopPolling)

async function confirmDraft(applyDraft) {
  if (isNew() || !id.value) return toast('先保存工作区')
  confirming.value = true
  try {
    const j = await fetch(`/api/cases/${id.value}/confirm-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        applyDraft,
        ownerName: ownerPick.value || undefined,
        peerName: profile.value.peerName || undefined,
      }),
    }).then(r => r.json())
    if (!j.ok) return toast(j.error || '确认失败')
    emit('changed', j.data.id)
    await load()
    toast(applyDraft ? '已确认并写入档案' : '已确认身份，草稿未写入')
  } catch { toast('后端未启动') } finally { confirming.value = false }
}

function addEvent() {
  const event = newEvent.event.trim()
  if (!event) return
  form.relationship.keyEvents.push({ date: newEvent.date.trim(), event })
  newEvent.date = ''
  newEvent.event = ''
}

function removeEvent(i) { form.relationship.keyEvents.splice(i, 1) }

function buildBody() {
  return JSON.stringify({
    title: form.title || '新工作区', stage: form.stage, riskLevel: form.riskLevel,
    summary: form.summary, sessionIds: form.sessionIds,
    her: {
      persona: form.her.persona, traits: strToArr(form.her.traits), likes: strToArr(form.her.likes),
      dislikes: strToArr(form.her.dislikes), commStyle: form.her.commStyle, replyStyle: form.her.replyStyle, callHistory: strToArr(form.her.callHistory),
    },
    me: { goal: form.me.goal, style: form.me.style, pitfalls: strToArr(form.me.pitfalls) },
    relationship: {
      keyEvents: form.relationship.keyEvents,
      openLoops: strToArr(form.relationship.openLoops), boundaries: strToArr(form.relationship.boundaries),
    },
  })
}

async function save() {
  if (saving.value) return
  if (isNew() && !form.sessionIds[0]) return toast('创建工作区必须绑定一个一对一私聊')
  saving.value = true
  try {
    const res = isNew()
      ? await fetch('/api/cases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: buildBody() })
      : await fetch(`/api/cases/${id.value}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: buildBody() })
    const j = await res.json()
    if (!j.ok) return toast(j.error || '保存失败')
    if (isNew()) {
      id.value = j.data.id
      trackJob(j.job) // 创建即自动分析，接上进度轮询
      if (j.job?.state === 'error') toast('自动分析启动失败，可稍后重试')
    }
    toast('工作区已保存')
    emit('changed', j.data.id)
  } catch { toast('后端未启动') } finally { saving.value = false }
}

async function addMemory() {
  const content = newMemory.value.trim()
  if (!content) return
  if (isNew()) { toast('先保存工作区再添加记忆'); return }
  try {
    const j = await fetch(`/api/cases/${id.value}/memories`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, type: 'semantic' }),
    }).then(r => r.json())
    if (!j.ok) return toast(j.error || '添加失败')
    memories.value.push(j.data)
    newMemory.value = ''
  } catch { toast('后端未启动') }
}

async function delMemory(mid) {
  try {
    const j = await fetch(`/api/cases/${id.value}/memories/${mid}`, { method: 'DELETE' }).then(r => r.json())
    if (j.ok) memories.value = memories.value.filter(m => m.id !== mid)
  } catch { /* 静默 */ }
}

function onMemoryCandidateChanged({ candidate, memory }) {
  const index = memoryCandidates.value.findIndex(item => item.id === candidate.id)
  if (index >= 0) memoryCandidates.value[index] = candidate
  if (memory && !memories.value.some(item => item.id === memory.id)) memories.value.push(memory)
  emit('changed', id.value)
}

async function removeCase() {
  if (deleting.value) return
  deleting.value = true
  try {
    const j = await fetch(`/api/cases/${id.value}`, { method: 'DELETE' }).then(r => r.json())
    if (!j.ok) throw new Error(j.error || '删除失败')
    showDeleteConfirm.value = false
    toast('私聊档案已删除')
    emit('deleted')
    emit('close')
  } catch (e) {
    toast(e.message || '删除失败')
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <Transition name="modal-reveal">
  <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center">
    <div class="absolute inset-0 bg-black/25 backdrop-blur-[2px]" @click="$emit('close')"></div>
    <div class="relative w-[600px] max-w-[94vw] max-h-[88vh] flex flex-col rounded-3xl bg-white shadow-float-lg border border-sakura-100 p-6 animate-bubble-in">
      <div class="flex items-center justify-between mb-1">
        <h2 class="text-lg font-semibold text-gray-800">{{ isNew() ? '新建关系工作区' : '工作区档案' }}</h2>
        <button class="text-gray-300 hover:text-gray-500 text-xl leading-none" @click="$emit('close')">✕</button>
      </div>

      <!-- 概况：名称 / 阶段 / 风险 -->
      <div v-if="isNew()" class="mb-3 border-b border-sakura-100 pb-3">
        <button class="rounded-lg bg-sakura-500 text-white px-4 py-2 text-sm" @click="emit('import')">导入私聊并创建工作区</button>
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] gap-2 mb-3">
        <input v-model="form.title" placeholder="工作区名称，如：和某某的暧昧期"
          class="min-w-0 col-span-2 sm:col-span-1 rounded-xl border border-sakura-100 bg-gray-50/60 px-3 py-2 text-sm outline-none focus:border-sakura-300" />
        <select v-model="form.stage" class="rounded-xl border border-sakura-100 bg-gray-50/60 px-2 py-2 text-sm outline-none">
          <option v-for="s in STAGES" :key="s" :value="s">{{ s }}</option>
        </select>
        <select v-model="form.riskLevel" class="rounded-xl border border-sakura-100 bg-gray-50/60 px-2 py-2 text-sm outline-none">
          <option v-for="r in RISKS" :key="r.value" :value="r.value">{{ r.label }}</option>
        </select>
      </div>

      <!-- 绑定会话：一对一（创建必选，创建后立即自动分析全量聊天记录） -->
      <div class="mb-3">
        <label class="text-xs text-gray-500 mb-1 block">
          <span class="text-rose-400 mr-0.5">*</span>绑定的一对一私聊（一个工作区对应一份聊天记录）
        </label>
        <select
          class="w-full rounded-xl border border-sakura-100 bg-gray-50/60 px-3 py-2 text-sm outline-none"
          :value="form.sessionIds[0] || ''"
          @change="bindSession($event.target.value)"
        >
          <option value="" disabled>选择已导入的私聊（必选）</option>
          <option v-for="s in privateSessions" :key="s.id" :value="s.id">{{ s.name || s.id }}</option>
        </select>
        <p v-if="!privateSessions.length" class="text-xs text-stone-400 mt-1">暂无一对一会话，请先导入好友私聊。</p>
        <p v-else-if="isNew()" class="text-xs text-rose-700 mt-1.5 font-medium">保存后军师会自动通读全部聊天记录，生成关系档案草稿。</p>
        <div v-else-if="!jobActive" class="mt-2">
          <button class="ui-btn-pill" @click="reanalyze">
            <svg class="w-3.5 h-3.5 text-rose-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>
            <span>重新分析聊天记录</span>
          </button>
        </div>
      </div>

      <!-- 导入分析进度 -->
      <div v-if="jobActive" class="mb-3 rounded-2xl border border-sakura-100 bg-sakura-50/50 p-3">
        <div class="flex items-center justify-between text-xs">
          <AiActivity :label="`${PHASE_LABELS[job.phase] || '准备中'}…`" size="xs" />
          <button
            class="group inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium text-gray-500 bg-white/90 border border-gray-200/80 hover:border-rose-300 hover:text-rose-600 hover:bg-rose-50/90 active:scale-95 transition-all shadow-xs cursor-pointer"
            title="中止当前分析任务"
            @click="cancelJob"
          >
            <svg class="w-3 h-3 text-gray-400 group-hover:text-rose-500 transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" class="opacity-20 group-hover:opacity-100" />
            </svg>
            <span>取消分析</span>
          </button>
        </div>
        <div class="mt-2 h-1.5 rounded-full bg-white border border-sakura-100 overflow-hidden">
          <div class="h-full bg-sakura-400 transition-all duration-500 workspace-analysis-progress" :style="{ width: progressPct + '%' }"></div>
        </div>
        <p class="mt-1.5 text-[11px] text-gray-400">{{ jobDetail }}</p>
      </div>
      <div v-else-if="job?.state === 'error'" class="mb-3 rounded-2xl border border-rose-100 bg-rose-50/60 p-3">
        <div class="text-xs font-medium text-rose-500 mb-1">聊天记录分析失败</div>
        <p class="text-[11px] text-gray-500 break-all">{{ job.error }}</p>
        <button class="mt-2 rounded-lg px-3 py-1.5 text-xs bg-sakura-500 text-white" @click="retryAnalysis">重试</button>
      </div>
      <div v-else-if="job?.state === 'cancelled'" class="mb-3 rounded-2xl border border-gray-200/80 bg-gray-50/70 p-3 flex items-center justify-between text-xs">
        <div class="flex items-center gap-1.5 text-gray-500">
          <svg class="w-3.5 h-3.5 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
          <span>导入分析已取消</span>
        </div>
        <button class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-sakura-600 bg-white border border-sakura-200 hover:bg-sakura-50 active:scale-95 transition-all shadow-xs cursor-pointer" @click="retryAnalysis">
          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
          </svg>
          <span>重新分析</span>
        </button>
      </div>


      <Transition name="content-reveal">
      <div v-if="profile.status === 'draft'" class="mb-3 rounded-2xl border border-amber-100 bg-amber-50/70 p-3 space-y-2">
        <div class="text-xs font-medium text-amber-700">待确认档案草稿</div>
        <p class="text-[11px] text-amber-600 leading-relaxed">先确认「我是谁」，再决定要不要把草稿写入档案。未确认的解释性描述不会当成已核实事实。</p>
        <div class="flex items-center gap-2 text-xs">
          <span class="text-gray-500">我是</span>
          <select v-model="ownerPick" class="rounded-lg border border-amber-200 bg-white px-2 py-1">
            <option v-if="profile.ownerName" :value="profile.ownerName">{{ profile.ownerName }}</option>
            <option v-if="profile.peerName && profile.peerName !== profile.ownerName" :value="profile.peerName">{{ profile.peerName }}</option>
          </select>
          <span class="text-gray-400">对方 {{ profile.peerName }}</span>
        </div>
        <p v-if="profile.draft?.summary" class="text-xs text-gray-600">{{ profile.draft.summary }}</p>
        <p v-if="profile.warnings?.length" class="text-[11px] text-gray-400">{{ profile.warnings[0] }}</p>
        <div class="flex gap-2 mt-2">
          <button class="ui-seal-btn" :disabled="confirming" @click="confirmDraft(true)">采用草稿</button>
          <button class="ui-btn-pill" :disabled="confirming" @click="confirmDraft(false)">只确认身份</button>
        </div>
      </div>
      </Transition>

      <!-- 分页签 -->
      <div class="flex gap-1 p-1 rounded-2xl bg-gray-50 border border-sakura-50 mb-3 shrink-0">
        <button v-for="t in TABS" :key="t.id" @click="tab = t.id"
          class="flex-1 rounded-xl py-1.5 text-sm transition"
          :class="tab === t.id ? 'bg-white shadow text-sakura-600 font-medium' : 'text-gray-400 hover:text-gray-600'">
          {{ t.label }}
        </button>
      </div>

      <Transition name="content-reveal" mode="out-in">
      <div :key="tab" class="flex-1 overflow-y-auto pr-1 space-y-3">
        <!-- 她 -->
        <template v-if="tab === 'her'">
          <div>
            <label class="text-xs text-gray-500 mb-1 block">人格概括</label>
            <textarea v-model="form.her.persona" rows="2" placeholder="她是什么样的人：慢热、吃软不吃硬、嘴硬心软…"
              class="w-full rounded-xl border border-sakura-100 bg-gray-50/60 px-3 py-2 text-sm outline-none focus:border-sakura-300 resize-none"></textarea>
          </div>
          <div>
            <label class="text-xs text-gray-500 mb-1 block">特质标签（顿号/逗号分隔）</label>
            <input v-model="form.her.traits" placeholder="内向， 理性， 傲娇"
              class="w-full rounded-xl border border-sakura-100 bg-gray-50/60 px-3 py-2 text-sm outline-none focus:border-sakura-300" />
          </div>
          <div>
            <label class="text-xs text-gray-500 mb-1 block">兴趣偏好</label>
            <input v-model="form.her.likes" placeholder="猫， 悬疑片， 火锅"
              class="w-full rounded-xl border border-sakura-100 bg-gray-50/60 px-3 py-2 text-sm outline-none focus:border-sakura-300" />
          </div>
          <div>
            <label class="text-xs text-gray-500 mb-1 block">雷区忌讳（军师会严禁触犯）</label>
            <input v-model="form.her.dislikes" placeholder="忽冷忽热， 查岗式关心， 开身材玩笑"
              class="w-full rounded-xl border border-rose-100 bg-rose-50/30 px-3 py-2 text-sm outline-none focus:border-rose-300" />
          </div>
          <div>
            <label class="text-xs text-gray-500 mb-1 block">沟通风格</label>
            <input v-model="form.her.commStyle" placeholder="爱用省略号、回复偏短但秒回、讨厌语音…"
              class="w-full rounded-xl border border-sakura-100 bg-gray-50/60 px-3 py-2 text-sm outline-none focus:border-sakura-300" />
          </div>
          <div>
            <label class="text-xs text-sakura-600 mb-1 block">训练聊天口吻（对方模拟优先）</label>
            <textarea v-model="form.her.replyStyle" rows="3" placeholder="短句分两三条发；常用“哈哈/啊？”和表情；爱接梗；很少用句号…"
              class="w-full rounded-xl border border-sakura-200 bg-sakura-50/30 px-3 py-2 text-sm outline-none focus:border-sakura-400 resize-none" />
          </div>
          <div>
            <label class="text-xs text-gray-500 mb-1 block">称呼变迁（可从改名历史维护）</label>
            <input v-model="form.her.callHistory" placeholder="宝儿 → 阿玉 → 玉玉"
              class="w-full rounded-xl border border-sakura-100 bg-gray-50/60 px-3 py-2 text-sm outline-none focus:border-sakura-300" />
          </div>
        </template>

        <!-- 我 -->
        <template v-else-if="tab === 'me'">
          <div>
            <label class="text-xs text-gray-500 mb-1 block">我的目标</label>
            <textarea v-model="form.me.goal" rows="2" placeholder="短期：让对话热起来；长期：三个月内确定关系"
              class="w-full rounded-xl border border-sakura-100 bg-gray-50/60 px-3 py-2 text-sm outline-none focus:border-sakura-300 resize-none"></textarea>
          </div>
          <div>
            <label class="text-xs text-gray-500 mb-1 block">表达习惯</label>
            <textarea v-model="form.me.style" rows="2" placeholder="喜欢分享日常、表情包多、有时候啰嗦…"
              class="w-full rounded-xl border border-sakura-100 bg-gray-50/60 px-3 py-2 text-sm outline-none focus:border-sakura-300 resize-none"></textarea>
          </div>
          <div>
            <label class="text-xs text-gray-500 mb-1 block">我常犯的错（军师会主动提醒规避）</label>
            <input v-model="form.me.pitfalls" placeholder="过度热情， 连环追问， 她冷淡就焦虑"
              class="w-full rounded-xl border border-sakura-100 bg-gray-50/60 px-3 py-2 text-sm outline-none focus:border-sakura-300" />
          </div>
        </template>

        <!-- 关系 -->
        <template v-else-if="tab === 'relationship'">
          <div>
            <label class="text-xs text-gray-500 mb-1 block">关系现状 / 背景摘要</label>
            <textarea v-model="form.summary" rows="4" placeholder="怎么认识的、目前到哪一步、最近的状态…"
              class="w-full rounded-xl border border-sakura-100 bg-gray-50/60 px-3 py-2 text-sm outline-none focus:border-sakura-300 resize-none"></textarea>
          </div>
          <div>
            <label class="text-xs text-gray-500 mb-1 block">关键事件时间线</label>
            <div v-if="form.relationship.keyEvents.length" class="space-y-1 mb-2">
              <div v-for="(e, i) in form.relationship.keyEvents" :key="i"
                class="flex items-center gap-2 rounded-xl bg-gray-50 border border-gray-100 px-3 py-1.5 text-sm text-gray-600">
                <span class="text-gray-300 shrink-0">{{ e.date || '未标注' }}</span>
                <span class="flex-1 break-all">{{ e.event }}</span>
                <button class="text-gray-300 hover:text-rose-400" @click="removeEvent(i)">✕</button>
              </div>
            </div>
            <div class="flex gap-2">
              <input v-model="newEvent.date" placeholder="日期" class="w-28 rounded-xl border border-sakura-100 bg-gray-50/60 px-3 py-2 text-sm outline-none" />
              <input v-model="newEvent.event" placeholder="事件：第一次约会 / 大吵一架…" class="flex-1 rounded-xl border border-sakura-100 bg-gray-50/60 px-3 py-2 text-sm outline-none" @keydown.enter="addEvent" />
              <button class="rounded-xl border border-sakura-100 px-3 text-sm text-gray-500 hover:bg-sakura-50" @click="addEvent">添加</button>
            </div>
          </div>
          <div>
            <label class="text-xs text-gray-500 mb-1 block">未完结事项</label>
            <input v-model="form.relationship.openLoops" placeholder="约了周末看展还没定时间， 上一话题她还没回"
              class="w-full rounded-xl border border-sakura-100 bg-gray-50/60 px-3 py-2 text-sm outline-none focus:border-sakura-300" />
          </div>
          <div>
            <label class="text-xs text-gray-500 mb-1 block">已确认的边界与承诺</label>
            <input v-model="form.relationship.boundaries" placeholder="不查岗， 已说明只是朋友阶段"
              class="w-full rounded-xl border border-sakura-100 bg-gray-50/60 px-3 py-2 text-sm outline-none focus:border-sakura-300" />
          </div>
        </template>

        <!-- 记忆 -->
        <template v-else>
          <div class="space-y-3">
            <div class="flex gap-1 p-1 rounded-xl bg-gray-50 border border-sakura-50">
              <button
                type="button"
                class="flex-1 rounded-lg py-1.5 text-xs transition"
                :class="memoryView === 'pending' ? 'bg-white shadow text-sakura-600 font-medium' : 'text-gray-400 hover:text-gray-600'"
                @click="memoryView = 'pending'"
              >
                待确认 {{ pendingMemoryCandidates.length ? `(${pendingMemoryCandidates.length})` : '' }}
              </button>
              <button
                type="button"
                class="flex-1 rounded-lg py-1.5 text-xs transition"
                :class="memoryView === 'saved' ? 'bg-white shadow text-sakura-600 font-medium' : 'text-gray-400 hover:text-gray-600'"
                @click="memoryView = 'saved'"
              >
                已记住 ({{ memories.length }})
              </button>
            </div>

            <template v-if="memoryView === 'pending'">
              <p v-if="isNew()" class="py-8 text-center text-xs text-gray-400">保存工作区后，AI 提出的记忆建议会显示在这里。</p>
              <div v-else-if="pendingMemoryCandidates.length" class="max-h-[310px] overflow-y-auto pr-1">
                <MemoryCandidateCard
                  v-for="candidate in pendingMemoryCandidates"
                  :key="candidate.id"
                  :candidate="candidate"
                  :case-id="id"
                  @changed="onMemoryCandidateChanged"
                />
              </div>
              <div v-else class="py-8 text-center">
                <p class="text-sm text-gray-500">没有待确认的记忆建议</p>
                <p class="mt-1 text-xs text-gray-400">AI 只会在发现稳定偏好、重要事实或长期规律时提出建议。</p>
              </div>
            </template>

            <template v-else>
              <div>
                <label class="text-xs text-gray-500 mb-1 block">已记住（{{ memories.length }}/100，分析时按需读取）</label>
                <div v-if="memories.length" class="max-h-52 overflow-y-auto space-y-1 mb-2">
                  <div v-for="m in memories" :key="m.id"
                    class="flex items-start gap-2 rounded-xl bg-sakura-50/60 border border-sakura-50 px-3 py-2 text-sm text-gray-600">
                    <span class="shrink-0 text-[11px] px-1.5 py-0.5 rounded-md bg-white border border-sakura-100 text-sakura-500">{{ MEM_TYPE_LABELS[m.type] || m.type }}</span>
                    <span class="flex-1 break-all"><span class="text-gray-300 mr-1">[{{ m.createdAt.slice(0, 10) }}]</span>{{ m.content }}</span>
                    <button class="text-gray-300 hover:text-rose-400 shrink-0" title="删除记忆" @click="delMemory(m.id)">✕</button>
                  </div>
                </div>
                <p v-else class="py-5 text-center text-xs text-gray-400">还没有正式记住的内容。</p>
                <div class="flex gap-2">
                  <input v-model="newMemory" placeholder="手动添加结论 / 事件 / 偏好…"
                    class="flex-1 rounded-xl border border-sakura-100 bg-gray-50/60 px-3 py-2 text-sm outline-none focus:border-sakura-300"
                    @keydown.enter="addMemory" />
                  <button class="rounded-xl border border-sakura-100 px-3 text-sm text-gray-500 hover:bg-sakura-50" @click="addMemory">添加</button>
                </div>
              </div>
            </template>
          </div>
        </template>
      </div>
      </Transition>

      <div class="flex items-center justify-between mt-5 pt-3 border-t border-stone-200/60 shrink-0">
        <button v-if="!isNew()" class="ui-btn-pill danger" @click="showDeleteConfirm = true">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          <span>删除私聊档案</span>
        </button>
        <span v-else></span>
        <div class="flex gap-2.5">
          <button class="ui-btn-pill" @click="$emit('close')">取消</button>
          <button :disabled="saving || !form.sessionIds[0]"
            class="rounded-xl bg-rose-800 text-white px-5 py-2 text-sm font-medium hover:bg-rose-900 disabled:opacity-50 transition-all shadow-sm cursor-pointer" @click="save">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>

    <ConfirmDialog
      :open="showDeleteConfirm"
      :busy="deleting"
      title="删除私聊档案？"
      message="档案、长期记忆及关联信息将被永久删除，相关顾问会话会被解绑；已导入的原始聊天记录不会删除。此操作无法撤销。"
      confirm-text="删除档案"
      @cancel="showDeleteConfirm = false"
      @confirm="removeCase"
    />
  </div>
  </Transition>
</template>

<style scoped>
.workspace-analysis-progress {
  position: relative;
  overflow: hidden;
  background: linear-gradient(90deg, #f09ab0, #c95c7a 48%, #f09ab0);
}
.workspace-analysis-progress::after {
  position: absolute;
  inset: 0;
  content: '';
  background: linear-gradient(100deg, transparent 18%, rgba(255,255,255,.58) 50%, transparent 82%);
  transform: translateX(-110%);
  animation: workspace-progress-shimmer 1.45s ease-in-out infinite;
}
@keyframes workspace-progress-shimmer { to { transform: translateX(110%); } }
@media (prefers-reduced-motion: reduce) { .workspace-analysis-progress::after { animation: none; } }
</style>
