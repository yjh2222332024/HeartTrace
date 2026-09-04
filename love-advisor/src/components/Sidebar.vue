<script setup>
defineProps({
  conversations: { type: Array, default: () => [] },
  currentId: { type: Number, default: null },
  importedSessions: { type: Array, default: () => [] },
})
defineEmits(['new', 'select', 'delete', 'open-settings'])

function fmtTime(ts) {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}
</script>

<template>
  <aside class="w-60 shrink-0 flex flex-col bg-white border-r border-sakura-100">
    <!-- Logo 区（占位） -->
    <div class="flex items-center gap-2.5 px-4 pt-4 pb-3">
      <div class="w-8 h-8 rounded-xl bg-gradient-to-br from-sakura-400 to-sakura-500 flex items-center justify-center text-white text-sm font-bold shadow-float">
        恋
      </div>
      <div class="leading-tight">
        <div class="font-semibold text-sm text-gray-800">恋爱分析助手</div>
        <div class="text-[11px] text-gray-400">Love Advisor</div>
      </div>
    </div>

    <!-- 新对话 -->
    <div class="px-3">
      <button
        class="w-full rounded-full bg-sakura-50 hover:bg-sakura-100 text-sakura-600 text-sm font-medium py-2 transition-colors"
        @click="$emit('new')"
      >
        ＋ 新对话
      </button>
    </div>

    <!-- 历史对话 -->
    <nav class="flex-1 overflow-y-auto mt-3 px-3 space-y-0.5">
      <button
        v-for="c in conversations"
        :key="c.id"
        class="group w-full text-left rounded-full px-3.5 py-2 text-sm transition-colors flex items-center justify-between"
        :class="c.id === currentId
          ? 'bg-sakura-500 text-white font-medium'
          : 'text-gray-600 hover:bg-sakura-50'"
        @click="$emit('select', c.id)"
      >
        <span class="truncate">{{ c.title }}</span>
        <span
          class="shrink-0 ml-2 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
          :class="c.id === currentId ? 'text-white/70' : 'text-gray-300 hover:text-gray-500'"
          @click.stop="$emit('delete', c.id)"
          title="删除"
        >✕</span>
      </button>
      <div v-if="!conversations.length" class="px-3 py-6 text-xs text-gray-300 text-center">
        还没有对话
      </div>
    </nav>

    <!-- 已导入会话（ChatLab） -->
    <div v-if="importedSessions.length" class="px-4 pt-3 pb-1 border-t border-sakura-100">
      <div class="text-[11px] text-gray-400 mb-1">已导入聊天记录</div>
      <div v-for="s in importedSessions" :key="s.sessionId"
        class="text-xs text-gray-500 truncate py-0.5"
        :title="s.name"
      >• {{ s.name }}（{{ s.totalMessages }}条）</div>
    </div>

    <!-- 左下角设置 -->
    <div class="p-3 border-t border-sakura-100">
      <button
        class="flex items-center gap-2 w-full rounded-full px-3.5 py-2 text-sm text-gray-500 hover:bg-sakura-50 transition-colors"
        @click="$emit('open-settings')"
      >
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        设置与模型配置
      </button>
    </div>
  </aside>
</template>
