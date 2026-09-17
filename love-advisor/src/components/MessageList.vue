<script setup>
import { ref, reactive, computed, watch, nextTick, inject } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import logo from '../assets/logo.png'
import ToolResultCard from './ToolResultCard.vue'
import MemoryCandidateCard from './MemoryCandidateCard.vue'
import AiActivity from './AiActivity.vue'

const toast = inject('toast', () => {})

const props = defineProps({
  messages: { type: Array, default: () => [] },
  generating: Boolean,
  runState: { type: String, default: '' }, // Run 状态机：created/context_build/streaming/...
  autoSkill: { type: String, default: '' }, // router 自动启用的军师名
  caseId: { type: String, default: '' },
  memoryCandidates: { type: Array, default: () => [] },
  peerName: { type: String, default: '' },
  isSplit: { type: Boolean, default: false },
})
const emit = defineEmits(['fill', 'jump-messages', 'regenerate', 'memory-candidate-changed'])

// ── 复制回答全文 ──
const copiedMap = reactive({})
async function copyAnswer(content, index) {
  if (!content) return
  try {
    await navigator.clipboard.writeText(content)
    copiedMap[index] = true
    toast('已复制回答到剪贴板')
    setTimeout(() => {
      copiedMap[index] = false
    }, 2000)
  } catch (e) {
    toast('复制失败：' + (e.message || '剪贴板权限受限'))
  }
}

function candidatesForMessage(message) {
  const stored = new Map(props.memoryCandidates.map(candidate => [candidate.id, candidate]))
  const live = new Map((message.memoryCandidates || []).map(candidate => [candidate.id, candidate]))
  const ids = [...new Set([
    ...(message.memoryCandidateIds || []),
    ...live.keys(),
  ])]
  return ids.map(id => stored.get(id) || live.get(id)).filter(Boolean)
}

// Run 状态 → 用户可读的进度提示（首个 token 输出前展示）
const RUN_STATE_LABELS = {
  created: '正在准备…',
  context_build: '正在读取聊天证据…',
  streaming: '正在生成回复…',
}
const runStateLabel = computed(() => RUN_STATE_LABELS[props.runState] || '')
const activityLabel = computed(() => {
  const stage = runStateLabel.value || '正在整理回复…'
  return props.autoSkill ? `已启用 ${props.autoSkill} · ${stage}` : stage
})

// ── 工具调用时间线：agent loop 中模型的取证过程 ─────────
const TOOL_LABELS = {
  list_chat_sessions: '列出会话',
  get_session_overview: '会话总览',
  get_chat_stats: '统计数据',
  search_messages: '搜索原文',
  browse_messages: '浏览记录',
  get_message_context: '展开上下文',
  list_topics: '话题摘要',
  query_sql: 'SQL 查询',
}
const toolLabel = t => TOOL_LABELS[t] || t

// 默认：生成中且正文未出时展开（让用户看到正在查数据），其余收起；点过以用户为准
const toolToggles = reactive({})
function toolsOpen(m, i) {
  if (i in toolToggles) return toolToggles[i]
  return !!(props.generating && i === props.messages.length - 1 && !m.content)
}
function toggleTools(m, i) {
  toolToggles[i] = !toolsOpen(m, i)
}

// 首页快捷入口围绕当前工作区；无档案时仍可作为通用咨询使用。
const HOME_CARD_TEMPLATES = [
  {
    title: '解读 TA 的想法',
    desc: '从最近的互动里，判断 TA 的情绪、顾虑与真实意图。',
    fill: name => `请结合我和${name}最近的互动，分析 TA 现在可能是什么想法。`,
    paths: ['M21 11.5a8.4 8.4 0 0 1-9 8.4 9.8 9.8 0 0 1-4-.9L3 20l1.3-4.3A8.4 8.4 0 1 1 21 11.5Z'],
  },
  {
    title: '帮我回复 TA',
    desc: '给出自然、有分寸，也符合你们当前关系的回复。',
    fill: name => `请结合我和${name}的上下文，帮我组织一句自然的回复。`,
    paths: ['M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z'],
  },
  {
    title: '梳理你们的关系',
    desc: '看清现在的关系阶段、卡点，以及下一步该怎么推进。',
    fill: name => `请帮我梳理我和${name}目前的关系、核心卡点和下一步。`,
    paths: ['M6 2h9l4 4v16H6z', 'M14 2v5h5', 'M9 12h6M9 16h6'],
  },
]
const contextPeerName = computed(() => props.peerName || 'TA')
const homeTitle = computed(() => `关于你和${contextPeerName.value}，想聊些什么？`)
const homeCards = computed(() => HOME_CARD_TEMPLATES.map(template => ({
  ...template,
  title: template.title.replace('TA', contextPeerName.value),
  fill: template.fill(contextPeerName.value),
})))

// 思维链折叠：默认「思考中展开、出正文后收起」，用户点过就以用户为准
const collapseToggles = reactive({})
function isCollapsed(m, i) {
  if (i in collapseToggles) return collapseToggles[i]
  return !!m.content
}
function toggleCollapse(m, i) {
  collapseToggles[i] = !isCollapsed(m, i)
}

function renderMd(text) {
  return DOMPurify.sanitize(marked.parse(text || ''))
}

// ── 智能流式滚动与视口脱离检测 ──
const listEl = ref(null)
const userScrolledUp = ref(false)

function onListScroll() {
  if (!listEl.value) return
  const { scrollTop, scrollHeight, clientHeight } = listEl.value
  const distanceToBottom = scrollHeight - scrollTop - clientHeight
  // 离底部超过 90px 则判定用户正在主动向上阅读历史或推演，停止强制拉拽
  userScrolledUp.value = distanceToBottom > 90
}

function scrollToBottom(smooth = true) {
  if (!listEl.value) return
  userScrolledUp.value = false
  listEl.value.scrollTo({
    top: listEl.value.scrollHeight,
    behavior: smooth ? 'smooth' : 'auto',
  })
}

// 新 token 到达时：如果用户未主动上滑阅读，则贴住底部
watch(
  () => [props.messages.at(-1)?.content, props.messages.at(-1)?.reasoning],
  async () => {
    await nextTick()
    if (listEl.value && !userScrolledUp.value) {
      listEl.value.scrollTop = listEl.value.scrollHeight
    }
  },
)

// 新消息增加时平滑吸底
watch(
  () => props.messages.length,
  async () => {
    await nextTick()
    if (listEl.value) {
      userScrolledUp.value = false
      listEl.value.scrollTop = listEl.value.scrollHeight
    }
  },
)
</script>

<template>
  <!-- 首页态：Hero + 卡片 -->
  <div v-if="!messages.length" class="home-block" :class="{ 'is-split': isSplit }">
    <div class="hero-tagline">✦ THE INTIMATE SALON · 私密智囊沙龙 ✦</div>
    <div class="hero-logo"><img :src="logo" alt="恋爱顾问" /></div>
    <h1>{{ isSplit ? '向军师提问' : homeTitle }}</h1>
    <p class="subtitle">{{ isSplit ? '在左侧点击或框选聊天记录，直接获得深度剖析与回复策略。' : '把事情告诉我，为你拆解对话潜台词、情绪起伏与下一步对策。' }}</p>

    <div class="cards">
      <article v-for="(c, ci) in homeCards" :key="c.title" class="card" @click="$emit('fill', c.fill)">
        <div class="card-head">
          <div class="feature-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <path v-for="(d, i) in c.paths" :key="i" :d="d" />
            </svg>
          </div>
          <div class="flex-1 min-w-0">
            <div class="card-num">{{ ['NO. 01', 'NO. 02', 'NO. 03'][ci] }}</div>
            <div class="card-title">{{ c.title }}</div>
          </div>
        </div>
        <div class="card-desc">{{ c.desc }}</div>
        <svg class="card-arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="1.8"><path d="m9 18 6-6-6-6" /></svg>
      </article>
    </div>
  </div>

  <!-- 对话态：消息流 -->
  <div v-else ref="listEl" class="chat-wrap" @scroll.passive="onListScroll">
    <div class="chat-shell">
      <div
        v-for="(m, i) in messages"
        :key="i"
        class="msg animate-bubble-in"
        :class="m.role === 'user' ? 'user' : 'assistant'"
      >
        <img v-if="m.role !== 'user'" :src="logo" alt="恋爱顾问" class="msg-avatar" />
        <div v-else class="msg-avatar me">我</div>
        <div class="msg-body">
          <!-- 思考过程（可折叠胶囊容器） -->
          <div v-if="m.reasoning" class="thinking-capsule mb-3">
            <button
              class="ui-capsule-trigger"
              @click="toggleCollapse(m, i)"
            >
              <svg
                class="w-3.5 h-3.5 transition-transform duration-200"
                :class="isCollapsed(m, i) ? '-rotate-90' : 'rotate-0'"
                viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
                stroke-linecap="round" stroke-linejoin="round"
              ><path d="M6 9l6 6 6-6" /></svg>
              <span>{{ isCollapsed(m, i) ? '深度心理推演' : (generating && i === messages.length - 1 && !m.content ? '深度推演中…' : '深度心理推演过程') }}</span>
              <AiActivity
                v-if="generating && i === messages.length - 1 && !m.content"
                size="xs"
              />
            </button>
            <div v-if="isCollapsed(m, i)" class="text-[13.5px] mt-1.5 px-2 text-stone-500 font-normal leading-relaxed flex items-center gap-1.5">
              <span>✦ 已完成双方心理态势与情境解构</span>
              <span class="text-xs text-stone-400 font-mono">({{ m.reasoning.length }} 字思路)</span>
            </div>
            <div v-else class="text-[14.5px] leading-relaxed whitespace-pre-wrap break-words mt-2 px-3.5 py-2.5 text-stone-700 bg-rose-50/50 rounded-xl border border-rose-100/80 font-normal">
              {{ m.reasoning }}
            </div>
          </div>
          <!-- 自动启用的军师提示 + Run 状态指示：首 token 之前展示 -->
          <div
            v-if="generating && i === messages.length - 1 && m.role === 'assistant' && !m.content && !m.reasoning"
            class="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium mb-2 border border-rose-200/80 bg-rose-50/70 text-rose-800"
          >
            <AiActivity :label="activityLabel" size="sm" />
          </div>
          <!-- 工具调用时间线：数据取证胶囊 -->
          <div v-if="m.tools?.length" class="tool-capsule mb-3">
            <button
              class="ui-capsule-trigger"
              @click="toggleTools(m, i)"
            >
              <svg
                class="w-3.5 h-3.5 transition-transform duration-200"
                :class="toolsOpen(m, i) ? 'rotate-0' : '-rotate-90'"
                viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
                stroke-linecap="round" stroke-linejoin="round"
              ><path d="M6 9l6 6 6-6" /></svg>
              <span>数据取证 · {{ m.tools.length }} 次查询</span>
              <AiActivity
                v-if="generating && i === messages.length - 1 && !m.content"
                size="xs"
              />
            </button>
            <div v-if="toolsOpen(m, i)" class="mt-2 space-y-1.5 pl-1">
              <div v-for="(t, ti) in m.tools" :key="ti" class="tool-item">
                <div class="flex items-center gap-2 text-[13px] leading-5 tool-row px-3 py-1.5 rounded-lg bg-stone-50/85 border border-stone-200/60">
                  <span class="w-2 h-2 rounded-full flex-none" :style="{ background: t.state === 'retrying' ? '#d97706' : (t.ok ? '#16a34a' : '#e11d48') }" />
                  <code class="tool-name">{{ toolLabel(t.tool) }}</code>
                  <span class="truncate tool-meta">{{ t.args }}</span>
                  <span v-if="t.state === 'retrying'" class="truncate tool-retry">正在重试第 {{ t.attempts }} 次…</span>
                  <span v-else-if="t.error" class="truncate tool-err" :title="t.error">✕ {{ t.error }}<template v-if="t.attempts > 1">（已重试）</template></span>
                  <span v-else-if="t.attempts > 1" class="tool-retry">重试后成功</span>
                </div>
                <!-- 内嵌结果摘要卡片 -->
                <Transition name="content-reveal">
                  <ToolResultCard
                    v-if="t.ok && t.summary && toolsOpen(m, i)"
                    :t="t"
                    @jump="p => emit('jump-messages', p)"
                  />
                </Transition>
              </div>
            </div>
          </div>
          <!-- 正文：Markdown 渲染（AI）/ 纯文本（用户） -->
          <details v-if="m.selectionContext?.messages?.length" class="ui-quote-card mb-3">
            <summary class="flex items-center gap-2 cursor-pointer font-medium text-[13px] text-rose-800 select-none">
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              <span>{{ m.selectionContext.sessionName }} · 引用 {{ m.selectionContext.messages.length }} 条聊天记录</span>
            </summary>
            <div class="mt-2.5 space-y-2.5 border-t border-rose-100/70 pt-2.5">
              <div v-for="record in m.selectionContext.messages" :key="record.id" class="text-[13px] text-stone-700 whitespace-pre-wrap break-words pl-2.5 border-l-2 border-rose-300">
                <div class="text-xs text-stone-400 font-mono mb-0.5">{{ record.time }} {{ record.senderName }}</div>
                <p class="leading-relaxed">{{ record.content }}</p>
              </div>
            </div>
          </details>
          <div v-if="m.role === 'user'">
            <div class="whitespace-pre-wrap break-words text-[16.5px] leading-relaxed select-text">{{ m.content }}</div>
            <div class="mt-2.5 pt-2 border-t border-white/15 flex justify-end">
              <button
                class="text-xs text-white/80 hover:text-white inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/15 hover:bg-black/25 transition-colors"
                title="将此问题填入输入框重新编辑"
                @click="$emit('fill', m.content)"
              >
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                <span>重新编辑此问</span>
              </button>
            </div>
          </div>
          <div v-else class="md-content-wrap">
            <div class="md-content break-words select-text" v-html="renderMd(m.content)"></div>
            <span
              v-if="generating && i === messages.length - 1 && m.content"
              class="streaming-cursor"
            ></span>
          </div>
          <TransitionGroup v-if="m.role === 'assistant' && props.caseId && candidatesForMessage(m).length" name="content-reveal" tag="div" class="memory-candidate-list">
            <MemoryCandidateCard
              v-for="candidate in candidatesForMessage(m)"
              :key="candidate.id"
              :candidate="candidate"
              :case-id="props.caseId"
              @changed="emit('memory-candidate-changed', $event)"
            />
          </TransitionGroup>

          <!-- 消息操作底栏：复制回答、重新分析 -->
          <div
            v-if="m.role === 'assistant' && m.content && !(generating && i === messages.length - 1)"
            class="mt-3.5 pt-2.5 border-t border-stone-200/60 flex items-center justify-between flex-wrap gap-2 text-xs"
          >
            <div class="flex items-center gap-2">
              <!-- 一键复制回答 -->
              <button
                class="ui-seal-btn"
                :class="{ saved: copiedMap[i] }"
                title="一键复制回答建议"
                @click="copyAnswer(m.content, i)"
              >
                <svg v-if="copiedMap[i]" class="w-3.5 h-3.5 text-green-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6 9 17l-5-5"/></svg>
                <svg v-else class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                <span>{{ copiedMap[i] ? '已复制建议' : '复制回答' }}</span>
              </button>

            </div>

            <!-- 换个思路重新分析（最后一条 AI 回复可用） -->
            <button
              v-if="i === messages.length - 1 && !generating"
              class="ui-seal-btn"
              title="换个思路重新分析"
              @click="$emit('regenerate')"
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
              <span>换个思路分析</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 智能回到底部悬浮胶囊 -->
    <transition name="fade-slide">
      <button
        v-if="userScrolledUp"
        class="scroll-bottom-pill"
        title="回到底部最新消息"
        @click="scrollToBottom(true)"
      >
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>
        <span>{{ generating ? '推演生成中 · 回到底部' : '回到底部' }}</span>
      </button>
    </transition>
  </div>
</template>

<style scoped>
/* AI 气泡内的 Markdown 排版：沙龙典雅排版体系 */
.md-content {
  font-size: 17px;
  line-height: 1.82;
  color: #1a1e27;
  letter-spacing: -0.005em;
  font-variant-numeric: lining-nums tabular-nums;
  font-feature-settings: "lnum" 1, "tnum" 1;
}
.md-content :deep(p) { margin: 0.55em 0; }
.md-content :deep(p:first-child) { margin-top: 0; }
.md-content :deep(p:last-child) { margin-bottom: 0; }
.md-content :deep(ul),
.md-content :deep(ol) { margin: 0.65em 0; padding-left: 1.6em; }
.md-content :deep(li) { margin: 0.3em 0; }
.md-content :deep(h1) {
  font-family: var(--font-serif);
  font-size: 1.36em;
  font-weight: 700;
  color: var(--brand);
  letter-spacing: 0.02em;
  margin: 1.1em 0 0.5em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid rgba(139, 38, 67, 0.12);
  font-variant-numeric: lining-nums tabular-nums;
  font-feature-settings: "lnum" 1, "tnum" 1;
}
.md-content :deep(h2) {
  font-family: var(--font-serif);
  font-size: 1.26em;
  font-weight: 700;
  color: var(--brand);
  letter-spacing: 0.018em;
  margin: 1.05em 0 0.45em;
  display: flex;
  align-items: center;
  gap: 7px;
  font-variant-numeric: lining-nums tabular-nums;
  font-feature-settings: "lnum" 1, "tnum" 1;
}
.md-content :deep(h2)::before {
  content: "✦";
  font-size: 0.78em;
  color: var(--brand-2);
}
.md-content :deep(h3) {
  font-family: var(--font-serif);
  font-size: 1.16em;
  font-weight: 650;
  color: var(--brand-3);
  margin: 0.9em 0 0.4em;
  font-variant-numeric: lining-nums tabular-nums;
  font-feature-settings: "lnum" 1, "tnum" 1;
}
.md-content :deep(h4) {
  font-family: var(--font-serif);
  font-size: 1.08em;
  font-weight: 650;
  color: var(--text);
  margin: 0.8em 0 0.35em;
  font-variant-numeric: lining-nums tabular-nums;
  font-feature-settings: "lnum" 1, "tnum" 1;
}
.md-content :deep(h1:first-child),
.md-content :deep(h2:first-child),
.md-content :deep(h3:first-child),
.md-content :deep(h4:first-child) { margin-top: 0; }
.md-content :deep(strong) {
  font-weight: 700;
  color: #5c1024;
}
.md-content :deep(blockquote) {
  position: relative;
  border-left: 3.5px solid var(--brand);
  padding: 0.75em 1.2em 0.75em 1.25em;
  margin: 0.85em 0;
  color: #2b1f26;
  background: linear-gradient(135deg, rgba(255, 245, 247, 0.92) 0%, rgba(255, 252, 253, 0.5) 100%);
  border-radius: 4px 14px 14px 4px;
  font-family: var(--font-sans);
  font-size: 1em;
  line-height: 1.8;
  font-variant-numeric: lining-nums tabular-nums;
  font-feature-settings: "lnum" 1, "tnum" 1;
  box-shadow: 0 2px 10px rgba(139, 38, 67, 0.04);
}
.md-content :deep(code) {
  background: #fff0f4;
  color: var(--brand-3);
  padding: 0.18em 0.45em;
  border-radius: 6px;
  font-size: 0.92em;
  border: 1px solid rgba(139, 38, 67, 0.14);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.md-content :deep(pre) {
  background: #1e1720;
  color: #fceef3;
  padding: 1.1em 1.3em;
  border-radius: 14px;
  overflow-x: auto;
  margin: 0.8em 0;
  font-size: 0.92em;
  box-shadow: 0 4px 16px rgba(35, 18, 26, 0.15);
}
.md-content :deep(pre code) { background: transparent; color: inherit; padding: 0; border: none; }
.md-content :deep(a) { color: var(--brand); text-decoration: underline; font-weight: 500; }

/* 工具调用时间线 */
.tool-name {
  background: #fff0f4;
  color: var(--brand);
  padding: 0.12em 0.48em;
  border-radius: 5px;
  border: 1px solid rgba(139, 38, 67, 0.14);
  font-weight: 600;
  font-size: 12.5px;
  flex: none;
}
.tool-meta { color: #64748b; max-width: 22em; font-size: 12.5px; }
.tool-err { color: #dc2626; max-width: 18em; font-weight: 500; font-size: 12.5px; }
.tool-retry { color: #b45309; max-width: 18em; font-weight: 500; font-size: 12.5px; }
.tool-row:hover { background: #fdf2f5; border-color: rgba(139, 38, 67, 0.18); }

/* 流式输出动态光标 */
.md-content-wrap {
  position: relative;
  display: inline;
}
.streaming-cursor {
  display: inline-block;
  width: 2.5px;
  height: 16px;
  vertical-align: -2px;
  margin-left: 3px;
  background: var(--brand);
  border-radius: 1px;
  animation: cursorBlink 0.75s infinite;
}
@keyframes cursorBlink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .streaming-cursor { animation: none; opacity: .8; }
}
</style>
