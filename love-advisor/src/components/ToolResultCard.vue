<script setup>
// ── 工具结果内嵌卡片：按工具类型渲染取证结果摘要 ─────────
// search/browse → 消息预览（可跳浏览器）；stats → CSS 迷你条形图
// 数据来自 tool.completed SSE 事件的 summary（4KB 截断）或落库的 tools[].summary
import { computed } from 'vue'

const props = defineProps({
  t: { type: Object, required: true }, // { tool, ok, args, summary, error }
})
const emit = defineEmits(['jump'])

const args = computed(() => {
  try { return JSON.parse(props.t.args || '{}') } catch { return {} }
})

const items = computed(() => props.t?.summary?.items || [])

const isMsgList = computed(() => ['search_messages', 'browse_messages', 'get_message_context'].includes(props.t.tool) && items.value.length)

// get_chat_stats 分型：hour / weekday / 占比 / 回复速度 / 通用词频
const statsKind = computed(() => {
  if (props.t.tool !== 'get_chat_stats' || !items.value.length) return ''
  const first = items.value[0]
  if ('hour' in first) return 'hour'
  if ('weekday' in first) return 'weekday'
  if ('percentage' in first) return 'share'
  if ('medianSeconds' in first) return 'response'
  return 'words'
})

// 通用词频字段探测（clb keywords 词典缺失时字段名不确定）
const wordKeys = computed(() => {
  if (statsKind.value !== 'words' || !items.value.length) return null
  const first = items.value[0]
  const keys = Object.keys(first)
  return {
    label: keys.find(k => typeof first[k] === 'string') || keys[0],
    value: keys.find(k => typeof first[k] === 'number') || keys[1],
  }
})

const bars = computed(() => {
  if (statsKind.value === 'hour') {
    const map = new Map(items.value.map(r => [r.hour, r.messageCount]))
    return Array.from({ length: 24 }, (_, h) => map.get(h) || 0)
  }
  if (statsKind.value === 'weekday') {
    const map = new Map(items.value.map(r => [r.weekday, r.messageCount]))
    return [1, 2, 3, 4, 5, 6, 7].map(d => map.get(d) || 0)
  }
  return []
})
const barMax = computed(() => Math.max(...bars.value, 1))
const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => (h % 6 === 0 ? `${h}` : ''))
const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日']

const shareMax = computed(() =>
  statsKind.value === 'share' ? Math.max(...items.value.map(r => r.messageCount || 0), 1) : 1)

function fmtMs(s) {
  return s >= 60 ? `${Math.round((s / 60) * 10) / 10} 分` : `${s} 秒`
}

// 消息预览 → 跳浏览器：带上搜索词或命中日期
function jumpToExplorer() {
  const payload = {}
  if (args.value.sessionId) payload.sessionId = args.value.sessionId
  if (Array.isArray(args.value.keywords) && args.value.keywords.length) payload.q = args.value.keywords.join(' ')
  else if (items.value[0]?.time) payload.since = items.value[0].time.slice(0, 10)
  emit('jump', payload)
}

const previewRows = computed(() => items.value.slice(0, 6))
const restCount = computed(() => Math.max(items.value.length - previewRows.value.length, 0))

// 军师手册文档：path + 截断徽标 + 首行预览
const skillDoc = computed(() => {
  if (props.t.tool !== 'read_skill_doc') return null
  const s = props.t.summary || {}
  const path = s.path || args.value.path || ''
  if (!path && !s.content && !s.preview) return null
  let raw = s.content || s.preview || ''
  if (typeof raw === 'string' && raw.startsWith('{"') && raw.includes('"content":')) {
    try {
      const clean = raw.replace(/\.\.\.\(truncated\)$/, '')
      const parsed = JSON.parse(clean + (clean.endsWith('}') ? '' : '"}'))
      raw = parsed.content || raw
    } catch {
      const m = raw.match(/"content":"([^"\\]*(?:\\.[^"\\]*)*)/)
      if (m) raw = m[1]
    }
  }
  return {
    path,
    truncated: !!s.truncated,
    preview: String(raw || '').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || '已参考军师专长手册',
  }
})

const hasContent = computed(() => {
  return !!(
    isMsgList.value ||
    ['hour', 'weekday', 'share', 'response'].includes(statsKind.value) ||
    (statsKind.value === 'words' && wordKeys.value) ||
    (props.t.tool === 'list_chat_sessions' && items.value.length) ||
    skillDoc.value
  )
})
</script>

<template>
  <div v-if="hasContent" class="trc">
    <!-- 消息预览 -->
    <template v-if="isMsgList">
      <div v-for="row in previewRows" :key="row.id" class="msg-preview" :class="{ hit: row.hit }">
        <span class="mp-meta">{{ (row.time || '').slice(5, 16) }} {{ row.senderName }}</span>
        <span class="mp-text">{{ String(row.content || '').slice(0, 60) }}</span>
      </div>
      <div v-if="restCount > 0" class="trc-more">…还有 {{ restCount }} 条</div>
      <div class="mt-2">
        <button class="ui-btn-pill" @click="jumpToExplorer">
          <svg class="w-3.5 h-3.5 text-rose-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          <span>在浏览器中查看</span>
        </button>
      </div>
    </template>

    <!-- stats: 时段迷你条形图 -->
    <template v-else-if="statsKind === 'hour' || statsKind === 'weekday'">
      <div class="mini-bars">
        <div v-for="(v, i) in bars" :key="i" class="bar-col">
          <div class="bar" :style="{ height: `${Math.max((v / barMax) * 34, 2)}px` }" :title="`${v} 条`" />
        </div>
      </div>
      <div class="bar-labels">
        <span v-for="(l, i) in (statsKind === 'hour' ? HOUR_LABELS : WEEK_LABELS)" :key="i">{{ l }}</span>
      </div>
    </template>

    <!-- stats: 占比横条 -->
    <template v-else-if="statsKind === 'share'">
      <div v-for="r in items" :key="r.id" class="share-row">
        <span class="share-name">{{ r.name }}</span>
        <div class="share-track">
          <div class="share-fill" :style="{ width: `${(r.messageCount / shareMax) * 100}%` }" />
        </div>
        <span class="share-pct">{{ Math.round(r.percentage) }}%</span>
      </div>
    </template>

    <!-- stats: 回复速度 -->
    <template v-else-if="statsKind === 'response'">
      <div v-for="r in items" :key="r.id" class="resp-row">
        <span class="share-name">{{ r.name }}</span>
        <span class="resp-val">中位 {{ fmtMs(r.medianSeconds) }} · 平均 {{ fmtMs(r.avgSeconds) }} · {{ r.responseCount }} 次</span>
      </div>
    </template>

    <!-- stats: 词频 chips -->
    <template v-else-if="statsKind === 'words' && wordKeys">
      <div class="word-chips">
        <span v-for="r in items.slice(0, 12)" :key="r[wordKeys.label]" class="word-chip">
          {{ r[wordKeys.label] }}<small v-if="r[wordKeys.value]">×{{ r[wordKeys.value] }}</small>
        </span>
      </div>
    </template>

    <!-- 会话列表 -->
    <template v-else-if="t.tool === 'list_chat_sessions' && items.length">
      <div v-for="s in items.slice(0, 6)" :key="s.id" class="msg-preview">
        <span class="mp-meta">{{ s.type === 'group' ? '[群]' : '[私]' }}</span>
        <span class="mp-text">{{ s.name }} · {{ s.totalMessages }} 条</span>
      </div>
    </template>

    <!-- 军师手册文档 -->
    <template v-else-if="skillDoc">
      <div class="doc-head">
        <span class="doc-path">📖 {{ skillDoc.path }}</span>
        <span v-if="skillDoc.truncated" class="doc-badge">已截断</span>
      </div>
      <div class="doc-body">{{ skillDoc.preview }}</div>
    </template>
  </div>
</template>

<style scoped>
.trc {
  margin: 6px 0 8px 10px;
  padding: 10px 14px;
  background: #ffffff;
  border: 1px solid rgba(226, 218, 222, 0.85);
  border-radius: 12px;
  max-width: 460px;
  font-size: 13px;
  box-shadow: 0 1px 4px rgba(35, 18, 26, 0.03);
}
.msg-preview {
  display: flex;
  gap: 8px;
  align-items: baseline;
  line-height: 1.7;
  min-width: 0;
}
.msg-preview.hit { background: #fff5f8; border-radius: 4px; }
.mp-meta { color: #717d96; font-size: 12px; flex: none; font-family: ui-monospace, monospace; }
.mp-text {
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  font-size: 13px;
}
.trc-more { color: #717d96; padding: 4px 0; font-size: 12.5px; }

.mini-bars {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 40px;
}
.bar-col { flex: 1; display: flex; align-items: flex-end; }
.bar {
  width: 100%;
  background: linear-gradient(180deg, var(--brand-2), var(--brand));
  border-radius: 3px 3px 0 0;
}
.bar-labels {
  display: flex;
  gap: 2px;
  color: #717d96;
  font-size: 11px;
}
.bar-labels span { flex: 1; text-align: center; }

.share-row, .resp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  line-height: 1.9;
}
.share-name { flex: none; color: var(--text-2); max-width: 6em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; }
.share-track {
  flex: 1;
  height: 8px;
  background: #fdf2f5;
  border-radius: 4px;
  overflow: hidden;
}
.share-fill { height: 100%; background: linear-gradient(90deg, var(--brand-2), var(--brand)); border-radius: 4px; }
.share-pct { flex: none; color: #717d96; font-size: 12px; }
.resp-val { color: var(--text-2); font-size: 13px; font-weight: 500; }

.word-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.word-chip {
  background: #fff;
  border: 1px solid rgba(139, 38, 67, 0.18);
  color: var(--brand);
  border-radius: 8px;
  padding: 3px 10px;
  font-size: 12.5px;
}
.word-chip small { color: #717d96; margin-left: 4px; }

.doc-head { display: flex; align-items: center; gap: 8px; line-height: 1.8; }
.doc-path { color: var(--brand); font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.doc-badge {
  flex: none;
  color: #92400e;
  background: #fef3c7;
  border: 1px solid #fde68a;
  border-radius: 6px;
  padding: 1px 6px;
  font-size: 11px;
  font-weight: 500;
}
.doc-body {
  color: var(--text-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-top: 4px;
  line-height: 1.6;
  font-size: 13px;
}
</style>
