<script setup>
import { ref, reactive, nextTick } from 'vue'
import Sidebar from './components/Sidebar.vue'
import MessageList from './components/MessageList.vue'
import ChatInput from './components/ChatInput.vue'
import ImportDialog from './components/ImportDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'

// ── 会话状态（MVP: localStorage 持久化）──────────────────
const STORAGE_KEY = 'love-advisor-conversations'
const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')

const conversations = ref(saved?.conversations || [])
const currentId = ref(saved?.currentId || null)
const settings = reactive(saved?.settings || {
  apiBase: '', apiKey: '', model: '', // LLM：暂由服务端 .env 提供，字段占位
  qceBase: '', qceToken: '', qcePath: '', // QQ Chat Exporter 直连配置
})
const showImport = ref(false)
const showSettings = ref(false)
const importedSessions = ref([]) // 已导入的 ChatLab 会话
const chatlabSessions = ref([])  // ChatLab 全部会话
const selectedSessionId = ref('') // 当前分析对象

async function fetchSessions() {
  try {
    const res = await fetch('/api/sessions')
    const j = await res.json()
    if (j.ok) {
      chatlabSessions.value = j.data.items
      if (!selectedSessionId.value && chatlabSessions.value.length) {
        selectedSessionId.value = chatlabSessions.value[0].id
      }
    }
  } catch { /* 后端未起时静默 */ }
}
fetchSessions()

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    conversations: conversations.value,
    currentId: currentId.value,
    settings,
  }))
}

function currentConv() {
  return conversations.value.find(c => c.id === currentId.value)
}

function newConversation() {
  const conv = { id: Date.now(), title: '新对话', messages: [], skills: [] }
  conversations.value.unshift(conv)
  currentId.value = conv.id
  persist()
}

function selectConversation(id) {
  currentId.value = id
  persist()
}

function deleteConversation(id) {
  conversations.value = conversations.value.filter(c => c.id !== id)
  if (currentId.value === id) currentId.value = conversations.value[0]?.id || null
  persist()
}

// ── 发送 & SSE 流式 ──────────────────────────────────
const generating = ref(false)

async function onSend(text, skills) {
  if (!currentConv()) newConversation()
  const conv = currentConv()
  conv.messages.push({ role: 'user', content: text })
  if (conv.title === '新对话') conv.title = text.slice(0, 18) || '新对话'

  const aiMsg = { role: 'assistant', content: '', reasoning: '' }
  conv.messages.push(aiMsg)
  generating.value = true
  persist()

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: conv.messages.slice(0, -1),
        skills,
        sessionId: selectedSessionId.value,
      }),
    })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6)
        if (payload === '[DONE]') continue
        try {
          const j = JSON.parse(payload)
          if (j.t) aiMsg.content += j.t
          if (j.r) aiMsg.reasoning += j.r
          if (j.error) aiMsg.content += '\n\n(错误：' + j.error + ')'
        } catch { /* 半包忽略 */ }
      }
    }
  } catch (e) {
    aiMsg.content += '\n\n(连接失败：' + e.message + ')'
  } finally {
    generating.value = false
    persist()
  }
}

// ── 导入回调 ─────────────────────────────────────────
function onImported(session) {
  importedSessions.value.push(session)
  fetchSessions()
}
</script>

<template>
  <div class="flex h-full overflow-hidden">
    <Sidebar
      :conversations="conversations"
      :current-id="currentId"
      :imported-sessions="importedSessions"
      @new="newConversation"
      @select="selectConversation"
      @delete="deleteConversation"
      @open-settings="showSettings = true"
    />
    <main class="flex-1 flex flex-col min-w-0">
      <MessageList
        :messages="currentConv()?.messages || []"
        :generating="generating"
        class="flex-1"
      />
      <ChatInput
        :generating="generating"
        :sessions="chatlabSessions"
        :selected-session-id="selectedSessionId"
        @send="onSend"
        @open-import="showImport = true"
        @select-session="id => (selectedSessionId = id)"
      />
    </main>

    <ImportDialog
      v-if="showImport"
      @close="showImport = false"
      @imported="onImported"
    />
    <SettingsDialog
      v-if="showSettings"
      :settings="settings"
      @close="showSettings = false"
    />
  </div>
</template>
