<script setup>
import { ref, reactive, watch, nextTick } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const props = defineProps({
  messages: { type: Array, default: () => [] },
  generating: Boolean,
})

// 思维链折叠：默认「思考中展开、出正文后收起」，用户点过就以用户为准
const collapseToggles = reactive({})
function isCollapsed(m, i) {
  if (i in collapseToggles) return collapseToggles[i]
  return !!m.content
}
function toggleCollapse(m, i) {
  collapseToggles[i] = !isCollapsed(m, i)
}

// Markdown 渲染（AI 消息），DOMPurify 防 XSS
marked.setOptions({ breaks: true, gfm: true })
function renderMd(text) {
  if (!text) return ''
  return DOMPurify.sanitize(marked.parse(text))
}

const listEl = ref(null)

watch(
  () => props.messages.length,
  async () => {
    await nextTick()
    listEl.value?.scrollTo({ top: listEl.value.scrollHeight, behavior: 'smooth' })
  },
)

// 流式内容变化也跟随滚动
watch(
  () => props.messages.at(-1)?.content,
  async () => {
    await nextTick()
    if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
  },
)
</script>

<template>
  <div ref="listEl" class="overflow-y-auto">
    <div class="max-w-3xl mx-auto px-6 py-8 space-y-5">
      <!-- 空状态 -->
      <div v-if="!messages.length" class="pt-24 text-center">
        <div class="w-16 h-16 mx-auto rounded-3xl bg-gradient-to-br from-sakura-400 to-sakura-500 flex items-center justify-center text-2xl text-white shadow-float-lg mb-5">
          恋
        </div>
        <h1 class="text-xl font-semibold text-gray-800 mb-1.5">有什么感情问题，直接问我</h1>
        <p class="text-sm text-gray-400">输入 <kbd class="px-1.5 py-0.5 rounded-md bg-white border border-sakura-200 text-sakura-500 text-xs">@</kbd> 唤醒恋爱军师 skill，点 ➕ 导入 QQ 聊天记录</p>
      </div>

      <!-- 消息流 -->
      <template v-else>
        <div
          v-for="(m, i) in messages"
          :key="i"
          class="flex gap-3 animate-bubble-in"
          :class="m.role === 'user' ? 'justify-end' : 'justify-start'"
        >
          <!-- AI 头像 -->
          <div v-if="m.role !== 'user'"
            class="w-8 h-8 shrink-0 rounded-xl bg-gradient-to-br from-sakura-400 to-sakura-500 flex items-center justify-center text-white text-xs font-bold shadow-float mt-0.5"
          >恋</div>

          <!-- 气泡 -->
          <div
            class="max-w-[76%] px-4 py-2.5 text-[15px] leading-relaxed"
            :class="m.role === 'user'
              ? 'rounded-3xl rounded-br-md bg-sakura-500 text-white shadow-float'
              : 'rounded-3xl rounded-tl-md bg-white border border-sakura-100 text-gray-800'"
          >
            <!-- 思考过程（可折叠，思考型模型） -->
            <div v-if="m.reasoning" class="mb-2 pb-2 border-b border-sakura-50">
              <button
                class="text-[11px] text-sakura-400 flex items-center gap-1 hover:text-sakura-500 transition-colors select-none w-full text-left"
                @click="toggleCollapse(m, i)"
              >
                <svg
                  class="w-3 h-3 transition-transform duration-200"
                  :class="isCollapsed(m, i) ? '-rotate-90' : 'rotate-0'"
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
                ><path d="M6 9l6 6 6-6" /></svg>
                <span>{{ isCollapsed(m, i) ? '思考过程' : (generating && i === messages.length - 1 && !m.content ? '思考中' : '思考过程') }}</span>
                <span v-if="generating && i === messages.length - 1 && !m.content" class="w-1 h-1 rounded-full bg-sakura-300 animate-pulse"></span>
              </button>
              <!-- 折叠时显示单行尾部摘要 -->
              <div v-if="isCollapsed(m, i)" class="text-[11px] text-gray-300 truncate mt-0.5">…{{ m.reasoning.slice(-48) }}</div>
              <div v-else class="text-xs text-gray-400 leading-relaxed whitespace-pre-wrap break-words mt-1">{{ m.reasoning }}</div>
            </div>
            <!-- 正文：Markdown 渲染（AI）/ 纯文本（用户） -->
            <div v-if="m.role === 'user'" class="whitespace-pre-wrap break-words">{{ m.content }}</div>
            <div v-else class="md-content break-words" v-html="renderMd(m.content)"></div>
            <span v-if="generating && i === messages.length - 1 && m.role === 'assistant' && !m.content"
              class="inline-flex gap-1 align-middle ml-0.5">
              <span class="w-1.5 h-1.5 rounded-full bg-sakura-400 animate-pulse"></span>
              <span class="w-1.5 h-1.5 rounded-full bg-sakura-300 animate-pulse" style="animation-delay:150ms"></span>
              <span class="w-1.5 h-1.5 rounded-full bg-sakura-200 animate-pulse" style="animation-delay:300ms"></span>
            </span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* AI 气泡内的 Markdown 排版 */
.md-content :deep(p) { margin: 0.25em 0; }
.md-content :deep(p:first-child) { margin-top: 0; }
.md-content :deep(p:last-child) { margin-bottom: 0; }
.md-content :deep(ul),
.md-content :deep(ol) { margin: 0.4em 0; padding-left: 1.4em; }
.md-content :deep(li) { margin: 0.15em 0; }
.md-content :deep(h1),
.md-content :deep(h2),
.md-content :deep(h3),
.md-content :deep(h4) {
  font-size: 1em;
  font-weight: 600;
  color: #ec4899;
  margin: 0.7em 0 0.3em;
}
.md-content :deep(h1:first-child),
.md-content :deep(h2:first-child),
.md-content :deep(h3:first-child) { margin-top: 0; }
.md-content :deep(strong) { font-weight: 600; color: #db2777; }
.md-content :deep(blockquote) {
  border-left: 3px solid #f9a8d4;
  padding-left: 0.8em;
  margin: 0.4em 0;
  color: #6b7280;
}
.md-content :deep(code) {
  background: #fdf2f8;
  border: 1px solid #fce7f3;
  border-radius: 6px;
  padding: 0.05em 0.35em;
  font-size: 0.88em;
}
.md-content :deep(pre) {
  background: #fdf2f8;
  border: 1px solid #fce7f3;
  border-radius: 12px;
  padding: 0.7em 0.9em;
  overflow-x: auto;
  margin: 0.5em 0;
}
.md-content :deep(pre code) { background: none; border: none; padding: 0; }
.md-content :deep(hr) { border: none; border-top: 1px solid #fce7f3; margin: 0.8em 0; }
.md-content :deep(a) { color: #ec4899; text-decoration: underline; }
</style>
