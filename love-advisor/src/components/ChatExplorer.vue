<script setup>
// ── 聊天记录浏览器：QQ 式双栏气泡 + 鼠标长按拖拽快速多选 + 问军师闭环 ───────────
// 数据源 GET /api/clb/messages（clb messages list/search 薄透传，cursor 分页）
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'

const props = defineProps({
  session: { type: Object, required: true }, // { id, name }
  initialQ: { type: String, default: '' },     // 外部入口注入的初始过滤（工具卡片跳转）
  initialSince: { type: String, default: '' },
  initialSelection: { type: Array, default: () => [] },
  isSplit: { type: Boolean, default: false },
})
const emit = defineEmits(['back', 'ask', 'insight'])

// ── 消息选择状态 ──────────────────────────────────────────────
const selected = ref(new Map(props.initialSelection.map(m => [m.id, m])))

// 鼠标长按 / 滑动连续多选状态
const isMouseDown = ref(false)
const dragStartIndex = ref(-1)
const dragTargetMode = ref(true) // true: 选中, false: 取消选中
const lastClickedIndex = ref(-1)
let longPressTimer = null

const msgs = ref([])          // 已加载消息（页内升序；翻页向更早扩展）
const cursor = ref('')        // 下一页（更早）游标
const hasMore = ref(false)
const ownerName = ref('')     // 机主昵称（右侧气泡）；空则全部左置
const isMine = m => !!m && !!ownerName.value && m.senderName === ownerName.value
const loading = ref(false)
const loadingOlder = ref(false)
const error = ref('')

// 筛选条件（改动即重查）
const q = ref(props.initialQ)
const member = ref('')        // ''=全部 / 机主名 / 对方名
const since = ref(props.initialSince)
const until = ref('')
const searched = ref(false)   // 当前结果是否为搜索模式
const showFilters = ref(false)

const scroller = ref(null)
let requestVersion = 0
let pageController = null
let lastLoadKey = ''

// 建立 ID -> msgs 索引映射，用于 O(1) 快速范围选择
const msgIndexMap = computed(() => {
  const map = new Map()
  msgs.value.forEach((m, idx) => map.set(m.id, idx))
  return map
})

// ── 鼠标按住连续滑动多选（类似 QQ 多选）───────────────────────
function onRowMouseDown(m, e) {
  // 忽略按钮点击、图片预览等交互控件
  if (e.target.closest('button') || e.target.closest('.ask-btn') || e.target.closest('.pic') || e.target.closest('a')) {
    return
  }
  // 左键点击
  if (e.button !== 0) return

  const idx = msgIndexMap.value.get(m.id)
  if (idx === undefined) return

  isMouseDown.value = true
  dragStartIndex.value = idx

  // 判断本次拖拽是加选还是减选
  const willSelect = !selected.value.has(m.id)
  dragTargetMode.value = willSelect

  toggleSingleMessage(m, willSelect)
  lastClickedIndex.value = idx

  // 添加全局事件监听
  window.addEventListener('mouseup', onWindowMouseUp)
}

function onRowMouseEnter(m) {
  if (!isMouseDown.value || dragStartIndex.value === -1) return
  const currentIdx = msgIndexMap.value.get(m.id)
  if (currentIdx === undefined) return

  // 计算连续区间
  const start = Math.min(dragStartIndex.value, currentIdx)
  const end = Math.max(dragStartIndex.value, currentIdx)

  const next = new Map(selected.value)
  for (let i = start; i <= end; i++) {
    const item = msgs.value[i]
    if (!item) continue
    if (dragTargetMode.value) {
      if (next.size < 50) next.set(item.id, item)
    } else {
      next.delete(item.id)
    }
  }
  selected.value = next
}

function onWindowMouseUp() {
  isMouseDown.value = false
  dragStartIndex.value = -1
  window.removeEventListener('mouseup', onWindowMouseUp)
}

// 勾选或取消单个消息
function toggleSingleMessage(m, forceState) {
  const next = new Map(selected.value)
  const shouldSelect = forceState !== undefined ? forceState : !next.has(m.id)
  if (shouldSelect) {
    if (next.size >= 50) {
      error.value = '每次最多选择 50 条聊天记录'
      return
    }
    next.set(m.id, m)
  } else {
    next.delete(m.id)
  }
  selected.value = next
}

// 支持 Shift+点击快速连选
function onRowClick(m, e) {
  if (e.target.closest('button') || e.target.closest('.ask-btn') || e.target.closest('.pic')) return
  const currentIdx = msgIndexMap.value.get(m.id)
  if (currentIdx === undefined) return

  if (e.shiftKey && lastClickedIndex.value !== -1) {
    const start = Math.min(lastClickedIndex.value, currentIdx)
    const end = Math.max(lastClickedIndex.value, currentIdx)
    const next = new Map(selected.value)
    for (let i = start; i <= end; i++) {
      const item = msgs.value[i]
      if (item && next.size < 50) next.set(item.id, item)
    }
    selected.value = next
    lastClickedIndex.value = currentIdx
  }
}

// ── 快捷多选辅助工具（一键选最近10/20条、全选、反选、清空）────────
function selectRecent(count = 10) {
  if (!msgs.value.length) return
  const items = msgs.value.slice(-count)
  const next = new Map()
  items.forEach(m => next.set(m.id, m))
  selected.value = next
}

function selectAllVisible() {
  const items = msgs.value.slice(-50)
  const next = new Map()
  items.forEach(m => next.set(m.id, m))
  selected.value = next
}

function invertSelection() {
  const next = new Map()
  msgs.value.forEach(m => {
    if (!selected.value.has(m.id) && next.size < 50) {
      next.set(m.id, m)
    }
  })
  selected.value = next
}

function clearSelection() {
  selected.value = new Map()
}

// ── 问军师功能闭环 ─────────────────────────────────────────────
// 单条快捷问军师弹窗状态
const activeAskModal = ref(null)

const INTENT_PRESETS = [
  {
    id: 'reply',
    icon: '💬',
    label: '高情商回复方案',
    desc: '提供幽默拉扯/真诚共情/反向推拉等不同策略的高情商回复',
    makePrompt: (m) => isMine(m)
      ? `请结合私聊上下文分析我（${m.senderName}）发的这句「${m.content}」及对方的后续反应：我接下来该如何推进？请为我（机主）提供3种不同策略（幽默拉扯/真诚走心/适度推拉）的后续应对建议与具体话术，并说明推荐理由。`
      : `请结合私聊上下文分析对方（${m.senderName}）说的这句「${m.content}」，我该如何回复TA？请为我（机主）提供3种不同策略（幽默拉扯/真诚走心/适度推拉）的高情商回复方案，并说明推荐理由。`
  },
  {
    id: 'psychology',
    icon: '🔍',
    label: '深度潜台词剖析',
    desc: '剖析真实情绪、心理防备与未言明的心思',
    makePrompt: (m) => isMine(m)
      ? `请帮我深度复盘我（${m.senderName}）说「${m.content}」时的心态及对当时对话氛围的影响：对方可能会产生什么心理反应？`
      : `请帮我深度剖析对方（${m.senderName}）说「${m.content}」时的真实心理与潜台词：TA当前的情绪状态如何？字面之下隐藏了什么真实意图？`
  },
  {
    id: 'affection',
    icon: '🌡️',
    label: '好感度与态势评估',
    desc: '从当前话语评估好感层级与关系核心症结',
    makePrompt: (m) => isMine(m)
      ? `结合我（${m.senderName}）发送的「${m.content}」以及双方近期互动来看，对方目前对我处于什么好感度层级？我们当前互动关系的核心症结与突破口在哪里？`
      : `结合对方（${m.senderName}）发送的「${m.content}」以及双方近期互动来看，TA目前对我处于什么好感度层级？我们当前互动关系的核心症结与突破口在哪里？`
  },
  {
    id: 'icebreak',
    icon: '🎯',
    label: '破冰推进深聊',
    desc: '化解尴尬或冷淡，将话题自然引向情感深度交流',
    makePrompt: (m) => isMine(m)
      ? `针对我（${m.senderName}）说的「${m.content}」及目前的聊天气氛，我该如何自然打破僵局/推进话题，把对话引向更深层的情感交流？`
      : `针对对方（${m.senderName}）说的「${m.content}」，我该如何自然接话并化解冷场，把话题平稳引向更深层的情感交流？`
  }
]

function openQuickAsk(m) {
  const defaultIntent = INTENT_PRESETS[0]
  activeAskModal.value = {
    message: m,
    intentId: defaultIntent.id,
    prompt: defaultIntent.makePrompt(m)
  }
}

function selectIntent(preset) {
  if (!activeAskModal.value) return
  activeAskModal.value.intentId = preset.id
  activeAskModal.value.prompt = preset.makePrompt(activeAskModal.value.message)
}

function closeQuickAsk() {
  activeAskModal.value = null
}

// 提交单条「问军师」
function submitQuickAsk(immediateSend = false) {
  if (!activeAskModal.value) return
  const m = activeAskModal.value.message
  const prompt = activeAskModal.value.prompt.trim()
  closeQuickAsk()

  emit('ask', {
    sessionId: props.session.id,
    sessionName: props.session.name,
    messages: [{ ...m, isMine: isMine(m) }],
    prompt,
    immediateSend
  })
}

// 紧凑分栏模式下：一键快速引用至右侧输入框
function quickQuoteMessage(m) {
  emit('ask', {
    sessionId: props.session.id,
    sessionName: props.session.name,
    messages: [{ ...m, isMine: isMine(m) }],
    prompt: '',
    immediateSend: false,
  })
}

// 提交选中的多条消息「问军师」
function submitBatchAsk(immediateSend = false) {
  if (!selected.value.size) return
  const sortedMessages = [...selected.value.values()].sort(
    (a, b) => String(a.time).localeCompare(String(b.time)) || a.id - b.id
  )

  const count = sortedMessages.length
  const first = sortedMessages[0]
  const prompt = count === 1
    ? (isMine(first)
        ? `请结合私聊上下文分析我（${first.senderName}）发的这句「${first.content?.slice(0, 32) || ''}」及对方反应：对方此时的心态与反应如何？我接下来该如何推进？`
        : `请结合私聊上下文分析对方（${first.senderName}）发的这句「${first.content?.slice(0, 32) || ''}」，TA 此时的真实潜台词是什么？我该如何回复？`)
    : `请结合所选的 ${count} 条私聊记录，深入剖析双方目前的对话互动动态与情感态势，给出最佳破局与回复方案。`

  emit('ask', {
    sessionId: props.session.id,
    sessionName: props.session.name,
    messages: sortedMessages.map(m => ({ ...m, isMine: isMine(m) })),
    prompt,
    immediateSend
  })
  clearSelection()
}

// ── 数据请求与滚动逻辑 ──────────────────────────────────────────
function buildUrl(extra = {}) {
  const p = new URLSearchParams({ sessionId: props.session.id, limit: '120', ...extra })
  if (q.value.trim()) p.set('q', q.value.trim())
  if (member.value) p.set('member', member.value)
  if (since.value) p.set('since', since.value)
  if (until.value) p.set('until', until.value)
  return `/api/clb/messages?${p}`
}

async function fetchPage({ cursor: cur = '', append = false } = {}) {
  const version = requestVersion
  const signal = pageController?.signal
  const extra = {}
  if (cur) extra.cursor = cur
  const res = await fetch(buildUrl(extra), { signal }).then(r => r.json())
  if (version !== requestVersion) return
  if (!res.ok) throw new Error(res.error || '查询失败')
  const items = res.data?.items || []
  const meta = res.meta || {}
  if (append) msgs.value = [...new Map([...items, ...msgs.value].map(m => [m.id, m])).values()]
  else msgs.value = items
  cursor.value = meta.nextCursor || ''
  hasMore.value = !!meta.hasMore && !!meta.nextCursor
  if (meta.ownerName) ownerName.value = meta.ownerName
}

async function initialLoad() {
  const key = JSON.stringify([props.session.id, q.value, member.value, since.value, until.value])
  if (key === lastLoadKey && msgs.value.length) return
  lastLoadKey = key
  const version = ++requestVersion
  pageController?.abort()
  pageController = new AbortController()
  loading.value = true
  error.value = ''
  msgs.value = []
  ownerName.value = ''
  searched.value = !!q.value.trim()
  try {
    await fetchPage()
    await nextTick()
    const el = scroller.value?.$el
    if (el) el.scrollTop = el.scrollHeight
  } catch (e) {
    if (version === requestVersion && e.name !== 'AbortError') error.value = e.message
  } finally {
    if (version === requestVersion) loading.value = false
  }
}

const topGuard = ref(false)
async function onScroll() {
  if (searched.value || topGuard.value || loadingOlder.value || !hasMore.value) return
  const el = scroller.value?.$el
  if (!el || el.scrollTop > 80) return
  topGuard.value = true
  try {
    loadingOlder.value = true
    const prevHeight = el.scrollHeight
    const prevTop = el.scrollTop
    await fetchPage({ cursor: cursor.value, append: true })
    await nextTick()
    el.scrollTop = prevTop + (el.scrollHeight - prevHeight)
  } catch (e) {
    error.value = e.message
  } finally {
    loadingOlder.value = false
    setTimeout(() => (topGuard.value = false), 400)
  }
}

let debounce = null
watch([q, member, since, until], () => {
  clearTimeout(debounce)
  debounce = setTimeout(initialLoad, 350)
})
watch(() => props.session.id, initialLoad, { immediate: true })

onUnmounted(() => {
  clearTimeout(debounce)
  pageController?.abort()
  requestVersion++
  window.removeEventListener('mouseup', onWindowMouseUp)
})

async function loadMoreResults() {
  if (loadingOlder.value || loading.value || !hasMore.value) return
  loadingOlder.value = true
  try { await fetchPage({ cursor: cursor.value, append: true }) }
  catch (e) { if (e.name !== 'AbortError') error.value = e.message }
  finally { loadingOlder.value = false }
}

// ── 渲染列表：消息 + 天级分隔 + 长间隔标记 ──────────────────────
const displayItems = computed(() => {
  const out = []
  let prev = null
  for (const m of msgs.value) {
    const day = (m.time || '').slice(0, 10)
    if (day && (!prev || prev.day !== day)) {
      out.push({ kind: 'day', id: `d_${day}`, label: fmtDay(day) })
    } else if (prev) {
      const gapH = (new Date(m.time) - new Date(prev.m.time)) / 3600000
      if (gapH >= 12) out.push({ kind: 'gap', id: `g_${m.id}`, label: `${Math.round(gapH)} 小时后` })
    }
    out.push({ kind: 'msg', id: `m_${m.id}`, m, segs: contentSegs(m.content) })
    prev = { m, day }
  }
  return out
})

function fmtDay(day) {
  const d = new Date(`${day}T00:00:00`)
  if (Number.isNaN(d.getTime())) return day
  const today = new Date()
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (same(d, today)) return '今天'
  const y = new Date(today)
  y.setDate(today.getDate() - 1)
  if (same(d, y)) return '昨天'
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

function fmtTime(t) {
  return (t || '').slice(11, 16)
}

function displayContent(c) {
  return String(c || '')
    .replace(/\[图片:[^\]]*\]/g, '[图片]')
    .replace(/\[语音:([^\]]*)\]/g, (_m, d) => `[语音${d ? ' ' + d : ''}]`)
    .replace(/\[视频:[^\]]*\]/g, '[视频]')
    .replace(/\[文件:[^\]]*\]/g, '[文件]')
    .replace(/\[JSON消息\]/g, '[引用/卡片消息]')
}

function contentSegs(c) {
  const s = String(c || '')
  const segs = []
  const re = /\[图片:([0-9a-fA-F]{32})(?:\.\w+)?\]/g
  let last = 0, m
  while ((m = re.exec(s))) {
    if (m.index > last) segs.push({ kind: 'text', text: displayContent(s.slice(last, m.index)) })
    segs.push({ kind: 'img', hash: m[1].toLowerCase() })
    last = re.lastIndex
  }
  if (last < s.length) segs.push({ kind: 'text', text: displayContent(s.slice(last)) })
  return segs.length ? segs : [{ kind: 'text', text: '' }]
}

const picFailed = ref(new Set())
function markPicFailed(hash) {
  const next = new Set(picFailed.value)
  next.add(hash)
  picFailed.value = next
}

const memberOptions = computed(() => {
  const opts = [{ value: '', label: '全部成员' }]
  if (ownerName.value) opts.push({ value: ownerName.value, label: `${ownerName.value}（我）` })
  if (props.session?.name) opts.push({ value: props.session.name, label: props.session.name })
  return opts
})

const activeFilters = computed(() =>
  !!(q.value.trim() || member.value || since.value || until.value))

function resetFilters() {
  q.value = ''
  member.value = ''
  since.value = ''
  until.value = ''
}

// 计算选中的消息时间跨度标签
const selectedTimeSpan = computed(() => {
  if (!selected.value.size) return ''
  const sorted = [...selected.value.values()].sort((a, b) => String(a.time).localeCompare(String(b.time)))
  const first = sorted[0].time?.slice(11, 16) || ''
  const last = sorted[sorted.length - 1].time?.slice(11, 16) || ''
  return first === last ? first : `${first} ~ ${last}`
})
</script>

<template>
  <div class="explorer" :class="{ 'is-selecting': isMouseDown }">
    <!-- 顶栏：返回 + 会话对象卡片 + 洞察入口 -->
    <header class="explorer-header" :class="{ 'is-split': isSplit }">
      <button v-if="!isSplit" class="back-pill-btn" title="返回智囊对话" @click="emit('back')">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m15 18-6-6 6-6" />
        </svg>
        <span>返回对话</span>
      </button>

      <div class="header-center">
        <div class="header-avatar">
          {{ (session.name || '私').slice(0, 1).toUpperCase() }}
        </div>
        <div class="header-meta">
          <div class="header-name-row">
            <strong class="header-title">{{ session.name }}</strong>
            <span class="header-tag">私聊记录</span>
          </div>
        </div>
      </div>

      <div v-if="!isSplit" class="header-actions">
        <button class="insight-btn" title="查看对话数据洞察" @click="emit('insight')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 3v18h18" /><path d="M7 14l4-4 3 3 5-6" />
          </svg>
          <span>数据洞察</span>
        </button>
      </div>
    </header>

    <!-- 筛选与控制中心 -->
    <div class="filter-panel">
      <div class="filter-row-top">
        <!-- 搜索输入框 -->
        <div class="search-wrap">
          <svg class="search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
          </svg>
          <input v-model="q" class="search-input" type="search" placeholder="搜索此私聊中的关键词…" />
          <button v-if="q" class="search-clear" @click="q = ''">✕</button>
        </div>

        <button
          type="button"
          class="filter-toggle-btn"
          :class="{ active: showFilters || activeFilters }"
          :aria-expanded="showFilters"
          @click="showFilters = !showFilters"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M4 6h16M7 12h10M10 18h4" />
          </svg>
          <span>筛选</span>
          <span v-if="activeFilters" class="filter-active-dot" aria-label="筛选已生效"></span>
        </button>
      </div>

      <div v-if="showFilters" class="filter-details">
        <div class="filter-options-row">

        <!-- 成员选择 -->
        <div class="member-pills">
          <button
            v-for="o in memberOptions"
            :key="o.value"
            type="button"
            class="member-pill"
            :class="{ active: member === o.value }"
            @click="member = o.value"
          >
            {{ o.label }}
          </button>
        </div>

        <!-- 日期区间 -->
        <div class="date-range-wrap">
          <input v-model="since" class="date-input" type="date" title="开始日期" />
          <span class="date-sep">~</span>
          <input v-model="until" class="date-input" type="date" title="结束日期" />
        </div>

        <button v-if="activeFilters" class="btn-reset-filters" @click="resetFilters">
          重置筛选
        </button>
        </div>

        <!-- 快速批选工具条（类似 QQ 高效批量选择） -->
        <div class="quick-select-bar">
          <div class="quick-actions-left">
            <span class="quick-label">快速多选：</span>
            <button type="button" class="quick-pill" @click="selectRecent(10)">最近 10 条</button>
            <button type="button" class="quick-pill" @click="selectRecent(20)">最近 20 条</button>
            <button type="button" class="quick-pill" @click="selectAllVisible">全选可见</button>
            <button type="button" class="quick-pill" @click="invertSelection">反选</button>
            <button v-if="selected.size" type="button" class="quick-pill text-rose-700" @click="clearSelection">
              清空已选 ({{ selected.size }})
            </button>
          </div>
          <div class="quick-hint">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" />
            </svg>
            <span>拖拽或 Shift+点击可连续选择</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 异常与加载状态 -->
    <div v-if="error" class="explorer-error">
      <p>{{ error }}</p>
      <button @click="initialLoad">重新加载</button>
    </div>
    <div v-else-if="loading" class="explorer-loading">
      <div class="loading-spinner"></div>
      <p>正在载入 {{ session.name }} 的私聊记录…</p>
    </div>
    <div v-else-if="!msgs.length" class="explorer-empty">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="empty-icon">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <p>{{ searched ? '未找到包含该关键词的聊天记录' : '当前时间范围内没有找到对话消息' }}</p>
    </div>

    <!-- QQ 风格虚拟滚动消息视窗 -->
    <DynamicScroller
      v-else
      ref="scroller"
      class="msg-list"
      :items="displayItems"
      :min-item-size="58"
      key-field="id"
      @scroll="onScroll"
    >
      <template #before>
        <div v-if="loadingOlder" class="load-older">
          <span class="loading-mini-dot"></span>
          <span>正在向上翻查更早的历史记录…</span>
        </div>
        <div v-else-if="searched && hasMore" class="load-more-wrap">
          <button class="load-more" :disabled="loadingOlder" @click="loadMoreResults">
            加载更多搜索结果
          </button>
        </div>
        <div v-else-if="hasMore" class="load-hint">
          <span>↑ 向上滚动载入更早对话</span>
        </div>
        <div v-else class="load-hint end">
          <span>— 已经触达最早的聊天记录 —</span>
        </div>
      </template>

      <template #default="{ item, active, index }">
        <DynamicScrollerItem :item="item" :active="active" :data-index="index">
          <!-- 日期天级分隔条 -->
          <div v-if="item.kind === 'day'" class="sep-day">
            <span class="sep-day-text">{{ item.label }}</span>
          </div>

          <!-- 较长间隔时间戳提示 -->
          <div v-else-if="item.kind === 'gap'" class="sep-gap">
            <span class="sep-gap-text">{{ item.label }}</span>
          </div>

          <!-- 消息行（QQ 风格双向气泡 + 多选支持） -->
          <div
            v-else
            class="msg-row"
            :data-msg-id="item.m.id"
            :class="{
              mine: isMine(item.m),
              selected: selected.has(item.m.id)
            }"
            @mousedown="onRowMouseDown(item.m, $event)"
            @mouseenter="onRowMouseEnter(item.m)"
            @click="onRowClick(item.m, $event)"
          >
            <!-- QQ 风格自制圆形多选复选框 -->
            <div
              class="qq-check-wrap"
              :class="{ checked: selected.has(item.m.id) }"
              @click.stop="toggleSingleMessage(item.m)"
            >
              <div class="qq-check-circle">
                <svg v-if="selected.has(item.m.id)" class="qq-check-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
            </div>

            <!-- 头像（根据身份左右放置） -->
            <div class="msg-avatar" :class="{ mine: isMine(item.m) }">
              {{ (isMine(item.m) ? (ownerName || '我') : (item.m.senderName || session.name || 'TA')).slice(0, 1).toUpperCase() }}
            </div>

            <!-- 气泡及元信息区 -->
            <div class="bubble-col">
              <!-- 对方消息显示昵称 -->
              <div v-if="!isMine(item.m)" class="sender-header">
                <span class="sender-name">{{ item.m.senderName }}</span>
              </div>

              <!-- 气泡本体 -->
              <div class="bubble" :class="{ nonText: item.m.type !== 'text' && !item.segs.some(s => s.kind === 'img') }">
                <template v-for="(seg, i) in item.segs" :key="i">
                  <img
                    v-if="seg.kind === 'img' && !picFailed.has(seg.hash)"
                    class="pic"
                    :src="`/api/qq/pic/${seg.hash}?fallback=1`"
                    alt=""
                    loading="lazy"
                    @error="markPicFailed(seg.hash)"
                  />
                  <span v-else-if="seg.kind === 'img'" class="content-tag">[图片]</span>
                  <span v-else class="content-text">{{ seg.text }}</span>
                </template>
              </div>

              <!-- 底部辅助行：时间戳 + 问军师快捷按钮 -->
              <div class="meta-row">
                <span class="time-stamp">{{ fmtTime(item.m.time) }}</span>
                <div class="meta-actions">
                  <button
                    v-if="isSplit"
                    type="button"
                    class="quote-btn"
                    title="引用此消息至右侧输入框"
                    @click.stop="quickQuoteMessage(item.m)"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                      <path d="M7 17l9.2-9.2M17 17V7H7" />
                    </svg>
                    <span>引用</span>
                  </button>
                  <button
                    type="button"
                    class="ask-btn"
                    title="针对此单条消息向军师请教分析"
                    @click.stop="openQuickAsk(item.m)"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.8 9.8 0 0 1-4-.9L3 20l1.3-4.3A8.4 8.4 0 1 1 21 11.5Z" />
                    </svg>
                    <span>问军师</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </DynamicScrollerItem>
      </template>
    </DynamicScroller>

    <!-- 底部多选控制底座（QQ 风格 Floating Dock） -->
    <footer v-if="selected.size" class="selection-dock">
      <div class="dock-summary">
        <div class="dock-count-badge">
          <span>已选 <strong>{{ selected.size }}</strong> / 50 条</span>
        </div>
        <div v-if="selectedTimeSpan" class="dock-time-span">
          时间跨度：{{ selectedTimeSpan }}
        </div>
      </div>

      <div class="dock-actions">
        <button type="button" class="dock-btn-secondary" @click="clearSelection">
          清空
        </button>
        <button
          type="button"
          class="dock-btn-draft"
          :title="isSplit ? '将已选消息引用至右侧输入框' : '将已选消息带回对话输入框，保留修改编辑空间'"
          @click="submitBatchAsk(false)"
        >
          {{ isSplit ? '📌 引用到右侧' : '带入草稿箱' }}
        </button>
        <button
          type="button"
          class="dock-btn-hero"
          :title="isSplit ? '立即携带所选聊天记录在右侧发起军师深度分析' : '立即携带所选聊天记录发起军师深度分析'"
          @click="submitBatchAsk(true)"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="m5 4 15 8-15 8 3-8-3-8Z" /><path d="M8 12h12" />
          </svg>
          <span>{{ isSplit ? '⚡ 立即分析' : '立即问军师' }} ({{ selected.size }}条)</span>
        </button>
      </div>
    </footer>

    <!-- 单条消息「问军师」意图与快捷提问弹窗 -->
    <div v-if="activeAskModal" class="ask-modal-mask" @click.self="closeQuickAsk">
      <div class="ask-modal-card">
        <div class="modal-header">
          <div class="flex items-center gap-2">
            <span class="text-rose-700 font-bold text-base">✨ 向军师提问</span>
            <span class="text-xs text-stone-400">· 单条深度分析</span>
          </div>
          <button class="modal-close-btn" @click="closeQuickAsk">✕</button>
        </div>

        <!-- 引用消息微卡片 -->
        <div class="quoted-preview">
          <div class="quote-sender">{{ activeAskModal.message.senderName }} ({{ fmtTime(activeAskModal.message.time) }})</div>
          <div class="quote-text">{{ activeAskModal.message.content }}</div>
        </div>

        <!-- 快捷意图方向选择 -->
        <div class="intent-section">
          <div class="intent-title">选择分析偏好方向：</div>
          <div class="intent-grid">
            <button
              v-for="preset in INTENT_PRESETS"
              :key="preset.id"
              type="button"
              class="intent-card"
              :class="{ active: activeAskModal.intentId === preset.id }"
              @click="selectIntent(preset)"
            >
              <div class="intent-icon">{{ preset.icon }}</div>
              <div class="intent-body">
                <div class="intent-name">{{ preset.label }}</div>
                <div class="intent-desc">{{ preset.desc }}</div>
              </div>
            </button>
          </div>
        </div>

        <!-- 问题草稿编辑 -->
        <div class="prompt-custom-section">
          <label class="intent-title" for="ask-custom-prompt">发送给军师的问题：</label>
          <textarea
            id="ask-custom-prompt"
            v-model="activeAskModal.prompt"
            class="custom-prompt-input"
            rows="3"
            placeholder="自定义你想让军师重点分析的角度…"
          />
        </div>

        <!-- 弹窗底部操作栏 -->
        <div class="modal-footer">
          <button type="button" class="modal-btn-cancel" @click="closeQuickAsk">取消</button>
          <button
            type="button"
            class="modal-btn-draft"
            @click="submitQuickAsk(false)"
          >
            带入草稿箱编辑
          </button>
          <button
            type="button"
            class="modal-btn-send"
            @click="submitQuickAsk(true)"
          >
            立即向军师提问
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ══ 聊天记录浏览器体系（The Intimate Salon QQ Desktop 风格）════════ */
.explorer {
  flex: 1;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #fdfbfb;
  position: relative;
  user-select: auto;
}
.explorer.is-selecting {
  user-select: none; /* 拖拽选择时防止网页原生文本被选蓝 */
}

/* 顶栏 */
.explorer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 24px;
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid rgba(230, 218, 222, 0.7);
  box-shadow: 0 2px 10px rgba(45, 20, 30, 0.03);
  z-index: 10;
}
.explorer-header.is-split {
  min-height: 48px;
  padding: 7px 16px;
  box-shadow: none;
}
.explorer-header.is-split .header-avatar {
  width: 30px;
  height: 30px;
  font-size: 12px;
}
.explorer-header.is-split .header-title { font-size: 14px; }
.explorer-header.is-split .header-tag { display: none; }
.explorer-header.is-split .header-sub { font-size: 11px; }

.back-pill-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: 999px;
  border: 1px solid rgba(220, 195, 205, 0.8);
  background: #ffffff;
  color: var(--brand);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}
.back-pill-btn:hover {
  background: #fff3f6;
  border-color: var(--brand);
  transform: translateX(-1px);
}

.header-center {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}

.header-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--brand), var(--brand-2));
  color: #ffffff;
  font-size: 14px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 8px rgba(139, 38, 67, 0.2);
  flex: none;
}

.header-meta {
  min-width: 0;
}
.header-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.header-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: -0.01em;
}
.header-tag {
  font-size: 10.5px;
  padding: 1px 7px;
  border-radius: 999px;
  background: #fdf0f4;
  color: var(--brand);
  font-weight: 600;
  border: 1px solid rgba(184, 74, 104, 0.2);
}
.header-sub {
  font-size: 11.5px;
  color: var(--text-3);
  margin-top: 1px;
}

.insight-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: 999px;
  border: 1px solid rgba(184, 74, 104, 0.3);
  background: linear-gradient(135deg, #fff7f9 0%, #feedf2 100%);
  color: var(--brand);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}
.insight-btn:hover {
  background: #fce4eb;
  box-shadow: 0 2px 8px rgba(139, 38, 67, 0.12);
}

/* 筛选与多选面板 */
.filter-panel {
  background: #ffffff;
  border-bottom: 1px solid rgba(230, 218, 222, 0.7);
  padding: 8px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  z-index: 5;
}

.filter-row-top {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.search-wrap {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 220px;
  flex: 1;
}
.search-icon {
  position: absolute;
  left: 12px;
  color: var(--text-3);
  pointer-events: none;
}
.search-input {
  width: 100%;
  height: 36px;
  padding: 0 32px 0 34px;
  border-radius: 999px;
  border: 1px solid rgba(220, 205, 212, 0.9);
  background: #fcf9fa;
  font-size: 13px;
  color: var(--text);
  outline: none;
  transition: all 0.15s ease;
}
.search-input:focus {
  border-color: var(--brand-2);
  background: #ffffff;
  box-shadow: 0 0 0 3px rgba(184, 74, 104, 0.1);
}
.filter-toggle-btn {
  position: relative;
  height: 34px;
  padding: 0 11px;
  border-radius: 9px;
  border: 1px solid rgba(220, 205, 212, 0.9);
  background: #ffffff;
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.filter-toggle-btn:hover,
.filter-toggle-btn.active {
  border-color: rgba(184, 74, 104, 0.4);
  background: #fff5f8;
  color: var(--brand);
}
.filter-active-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--brand);
}
.filter-details {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 2px;
}
.filter-options-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.search-clear {
  position: absolute;
  right: 10px;
  background: none;
  border: none;
  color: var(--text-3);
  cursor: pointer;
  font-size: 12px;
  padding: 4px;
}

.member-pills {
  display: flex;
  align-items: center;
  background: #f8f2f4;
  padding: 3px;
  border-radius: 999px;
  gap: 2px;
}
.member-pill {
  border: none;
  background: transparent;
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-2);
  cursor: pointer;
  transition: all 0.15s ease;
}
.member-pill:hover {
  color: var(--brand);
}
.member-pill.active {
  background: #ffffff;
  color: var(--brand);
  font-weight: 650;
  box-shadow: 0 1px 4px rgba(45, 20, 30, 0.08);
}

.date-range-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
}
.date-input {
  height: 34px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid rgba(220, 205, 212, 0.9);
  background: #ffffff;
  font-size: 12px;
  color: var(--text-2);
  outline: none;
}
.date-sep {
  color: var(--text-3);
  font-size: 12px;
}

.btn-reset-filters {
  border: none;
  background: none;
  color: var(--brand-2);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  padding: 6px 10px;
}
.btn-reset-filters:hover {
  text-decoration: underline;
}

/* 快速批选工具条 */
.quick-select-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 4px;
  border-top: 1px dashed rgba(230, 218, 222, 0.6);
  flex-wrap: wrap;
}
.quick-actions-left {
  display: flex;
  align-items: center;
  gap: 6px;
}
.quick-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-3);
}
.quick-pill {
  border: 1px solid rgba(215, 195, 204, 0.8);
  background: #fffdfd;
  color: var(--text-2);
  font-size: 11.5px;
  font-weight: 500;
  padding: 3px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.12s ease;
}
.quick-pill:hover {
  border-color: var(--brand-2);
  color: var(--brand);
  background: #fdf2f5;
}

.quick-hint {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--text-3);
}

/* 消息流 */
.msg-list {
  flex: 1;
  min-height: 0;
  background: #fdfbfb;
  padding: 12px 0 30px;
}

.sep-day, .sep-gap {
  text-align: center;
  padding: 12px 0 6px;
}
.sep-day-text {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-3);
  background: rgba(238, 228, 232, 0.6);
  padding: 3px 14px;
  border-radius: 999px;
  letter-spacing: 0.02em;
}
.sep-gap-text {
  font-size: 11px;
  color: #a4abb8;
  letter-spacing: 0.04em;
}
.sep-gap::before, .sep-gap::after {
  content: '—';
  margin: 0 8px;
  color: #dfd5d9;
}

/* 消息行样式 */
.msg-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 8px 24px;
  position: relative;
  transition: background-color 0.12s ease;
  cursor: pointer;
}
.msg-row:hover {
  background: rgba(184, 74, 104, 0.03);
}
.msg-row.selected {
  background: rgba(184, 74, 104, 0.07) !important;
  border-left: 3px solid var(--brand);
  padding-left: 21px;
}
.msg-row.mine {
  flex-direction: row-reverse;
}
.msg-row.mine.selected {
  border-left: none;
  border-right: 3px solid var(--brand);
  padding-left: 24px;
  padding-right: 21px;
}

/* 自制 QQ 圆形复选框 */
.qq-check-wrap {
  width: 22px;
  height: 22px;
  margin-top: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  cursor: pointer;
}
.qq-check-circle {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 1.5px solid rgba(190, 165, 175, 0.8);
  background: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s cubic-bezier(0.4, 0, 0.2, 1);
}
.qq-check-wrap:hover .qq-check-circle {
  border-color: var(--brand);
  transform: scale(1.1);
}
.qq-check-wrap.checked .qq-check-circle {
  border-color: transparent;
  background: linear-gradient(135deg, var(--brand), var(--brand-2));
  box-shadow: 0 2px 6px rgba(139, 38, 67, 0.25);
  transform: scale(1.05);
}
.qq-check-svg {
  width: 12px;
  height: 12px;
  color: #ffffff;
}

/* 头像 */
.msg-avatar {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: #fae8ee;
  color: var(--brand);
  font-size: 14px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  box-shadow: 0 2px 6px rgba(45, 20, 30, 0.05);
}
.msg-avatar.mine {
  background: linear-gradient(135deg, var(--brand), var(--brand-2));
  color: #ffffff;
  box-shadow: 0 2px 8px rgba(139, 38, 67, 0.2);
}

/* 气泡列 */
.bubble-col {
  max-width: 65%;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.msg-row.mine .bubble-col {
  align-items: flex-end;
}

.sender-header {
  margin-bottom: 3px;
}
.sender-name {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-3);
}

/* 气泡本体 */
.bubble {
  background: #ffffff;
  border: 1px solid rgba(226, 218, 222, 0.85);
  border-radius: 16px;
  border-top-left-radius: 4px;
  padding: 10px 15px;
  font-size: 14.5px;
  line-height: 1.6;
  color: #1a1e27;
  box-shadow: 0 2px 8px rgba(45, 20, 30, 0.04);
  width: fit-content;
  max-width: 100%;
  overflow-wrap: break-word;
  white-space: pre-wrap;
  transition: box-shadow 0.15s ease;
}
.msg-row.mine .bubble {
  background: linear-gradient(135deg, #8b2643 0%, #b84a68 100%);
  border: none;
  border-radius: 16px;
  border-top-right-radius: 4px;
  color: #ffffff;
  box-shadow: 0 4px 14px rgba(139, 38, 67, 0.18);
}
.msg-row.selected .bubble {
  box-shadow: 0 0 0 2px rgba(184, 74, 104, 0.4);
}

.bubble .pic {
  display: block;
  max-width: 280px;
  max-height: 280px;
  border-radius: 10px;
  margin: 4px 0;
  background: #f6edf0;
}
.content-tag {
  color: var(--brand-2);
  font-weight: 500;
}

/* 气泡元信息与问军师动作 */
.meta-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-3);
}
.msg-row.mine .meta-row {
  flex-direction: row-reverse;
}

.time-stamp {
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
}

.ask-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid rgba(184, 74, 104, 0.3);
  background: #fff4f7;
  color: var(--brand);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}
.ask-btn:hover {
  background: var(--brand);
  color: #ffffff;
  border-color: var(--brand);
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(139, 38, 67, 0.2);
}

.meta-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.quote-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid rgba(139, 38, 67, 0.2);
  background: #ffffff;
  color: var(--brand);
  font-size: 11px;
  font-weight: 550;
  cursor: pointer;
  transition: all 0.12s ease;
}
.quote-btn:hover {
  background: #fff2f6;
  border-color: var(--brand);
  transform: translateY(-1px);
}

/* 底部多选控制底座 (Floating Selection Dock) */
.selection-dock {
  position: sticky;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 24px;
  background: rgba(255, 255, 255, 0.98);
  backdrop-filter: blur(16px);
  border-top: 1px solid rgba(220, 185, 198, 0.8);
  box-shadow: 0 -8px 24px rgba(45, 20, 30, 0.08);
  animation: slideUpDock 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes slideUpDock {
  from { transform: translateY(100%); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

.dock-summary {
  display: flex;
  align-items: center;
  gap: 12px;
}
.dock-count-badge {
  font-size: 13px;
  color: var(--brand);
  background: #fdf0f4;
  border: 1px solid rgba(184, 74, 104, 0.25);
  padding: 4px 12px;
  border-radius: 999px;
  font-weight: 550;
}
.dock-count-badge strong {
  font-weight: 750;
}
.dock-time-span {
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.dock-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.dock-btn-secondary {
  border: 1px solid rgba(215, 195, 204, 0.8);
  background: #ffffff;
  color: var(--text-2);
  font-size: 13px;
  font-weight: 500;
  padding: 8px 14px;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.dock-btn-secondary:hover {
  background: #fdf2f5;
  color: var(--brand);
}

.dock-btn-draft {
  border: 1px solid rgba(184, 74, 104, 0.35);
  background: #fff5f8;
  color: var(--brand);
  font-size: 13px;
  font-weight: 600;
  padding: 8px 16px;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.dock-btn-draft:hover {
  background: #fce7ed;
  border-color: var(--brand);
}

.dock-btn-hero {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: none;
  background: linear-gradient(135deg, var(--brand) 0%, var(--brand-2) 100%);
  color: #ffffff;
  font-size: 13.5px;
  font-weight: 650;
  padding: 9px 20px;
  border-radius: 10px;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(139, 38, 67, 0.25);
  transition: all 0.15s cubic-bezier(0.4, 0, 0.2, 1);
}
.dock-btn-hero:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 18px rgba(139, 38, 67, 0.35);
}
.dock-btn-hero:active {
  transform: translateY(0);
}

/* 问军师弹出弹层 */
.ask-modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(30, 15, 22, 0.45);
  backdrop-filter: blur(8px);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  animation: fadeIn 0.15s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.ask-modal-card {
  width: 100%;
  max-width: 540px;
  background: #ffffff;
  border-radius: 20px;
  border: 1px solid rgba(220, 185, 198, 0.8);
  box-shadow: 0 24px 48px -12px rgba(45, 15, 25, 0.25);
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  animation: scaleUp 0.18s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes scaleUp {
  from { transform: scale(0.96); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.modal-close-btn {
  border: none;
  background: #f4eaee;
  color: var(--text-3);
  width: 28px;
  height: 28px;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  transition: all 0.15s ease;
}
.modal-close-btn:hover {
  background: #ebd8df;
  color: var(--brand);
}

.quoted-preview {
  background: #fdf5f7;
  border-left: 3px solid var(--brand);
  padding: 10px 14px;
  border-radius: 4px 10px 10px 4px;
}
.quote-sender {
  font-size: 11px;
  font-weight: 600;
  color: var(--brand-2);
}
.quote-text {
  font-size: 13.5px;
  color: var(--text);
  margin-top: 2px;
  line-height: 1.5;
  word-break: break-word;
}

.intent-title {
  font-size: 12.5px;
  font-weight: 650;
  color: var(--text-2);
  margin-bottom: 8px;
  display: block;
}

.intent-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}
.intent-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid rgba(220, 205, 212, 0.8);
  background: #ffffff;
  cursor: pointer;
  text-align: left;
  transition: all 0.15s ease;
}
.intent-card:hover {
  border-color: var(--brand-2);
  background: #fff7fa;
}
.intent-card.active {
  border-color: var(--brand);
  background: #fdf0f4;
  box-shadow: 0 0 0 1px var(--brand);
}
.intent-icon {
  font-size: 18px;
  line-height: 1;
  flex: none;
}
.intent-name {
  font-size: 12.5px;
  font-weight: 650;
  color: var(--text);
}
.intent-card.active .intent-name {
  color: var(--brand);
}
.intent-desc {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
  line-height: 1.35;
}

.custom-prompt-input {
  width: 100%;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid rgba(220, 205, 212, 0.9);
  background: #fcf9fa;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text);
  outline: none;
  resize: vertical;
  box-sizing: border-box;
}
.custom-prompt-input:focus {
  border-color: var(--brand-2);
  background: #ffffff;
  box-shadow: 0 0 0 3px rgba(184, 74, 104, 0.1);
}

.modal-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 8px;
  border-top: 1px solid rgba(235, 225, 228, 0.7);
}
.modal-btn-cancel {
  border: 1px solid rgba(215, 195, 204, 0.8);
  background: #ffffff;
  color: var(--text-2);
  font-size: 13px;
  padding: 8px 16px;
  border-radius: 10px;
  cursor: pointer;
}
.modal-btn-draft {
  border: 1px solid rgba(184, 74, 104, 0.3);
  background: #fff4f7;
  color: var(--brand);
  font-size: 13px;
  font-weight: 600;
  padding: 8px 16px;
  border-radius: 10px;
  cursor: pointer;
}
.modal-btn-send {
  border: none;
  background: linear-gradient(135deg, var(--brand), var(--brand-2));
  color: #ffffff;
  font-size: 13px;
  font-weight: 650;
  padding: 8px 20px;
  border-radius: 10px;
  cursor: pointer;
  box-shadow: 0 3px 10px rgba(139, 38, 67, 0.25);
}

/* 顶部与辅助加载指示 */
.load-older, .load-hint, .load-more-wrap {
  text-align: center;
  padding: 10px 0;
  font-size: 11.5px;
  color: var(--text-3);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.load-more {
  border: 1px solid rgba(184, 74, 104, 0.3);
  background: #fff8fa;
  color: var(--brand);
  font-size: 12px;
  font-weight: 600;
  padding: 6px 16px;
  border-radius: 999px;
  cursor: pointer;
}

.explorer-loading, .explorer-error, .explorer-empty {
  text-align: center;
  padding: 60px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-3);
  font-size: 13.5px;
}
.empty-icon {
  color: #d8c2cb;
}
.loading-spinner {
  width: 28px;
  height: 28px;
  border: 2.5px solid rgba(184, 74, 104, 0.15);
  border-top-color: var(--brand);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 640px) {
  .bubble-col { max-width: 80% !important; }
  .msg-row { padding: 6px 12px !important; }
  .intent-grid { grid-template-columns: 1fr; }
}
</style>
