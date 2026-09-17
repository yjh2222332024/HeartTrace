import { nextTick, ref } from 'vue'

export function useShell() {
  const collapsed = ref(false)
  const showImport = ref(false)
  const showSettings = ref(false)
  // 'workspace' | 'insight' | 'advisors' | 'training'
  const activeView = ref('workspace')
  // 工作台只保留双栏对照和专注军师两种模式。
  const initialLayoutMode = (() => {
    try {
      const saved = localStorage.getItem('love_advisor_layout_mode')
      if (['split', 'chat'].includes(saved)) return saved
    } catch { /* 忽略异常 */ }
    return 'split'
  })()
  const layoutMode = ref(initialLayoutMode)

  const dataSession = ref(null)
  const explorerFilter = ref({ q: '', since: '' })
  const draft = ref('')
  const selectedChat = ref(null)

  function setLayoutMode(mode) {
    if (!['split', 'chat'].includes(mode)) return
    layoutMode.value = mode
    try {
      localStorage.setItem('love_advisor_layout_mode', mode)
    } catch { /* 忽略异常 */ }
  }

  function openExplorer(session, filter = {}) {
    dataSession.value = session
    explorerFilter.value = { q: filter.q || '', since: filter.since || '' }
    activeView.value = 'workspace'
    // 从军师专注模式进入聊天记录时，回到双栏对照。
    if (layoutMode.value === 'chat') {
      setLayoutMode('split')
    }
  }

  function openInsight(session) {
    dataSession.value = session
    activeView.value = 'insight'
  }

  function backToChat() {
    activeView.value = 'workspace'
  }

  function openAdvisors() {
    activeView.value = 'advisors'
    if (window.matchMedia('(max-width: 820px)').matches) collapsed.value = true
  }

  function openTraining() {
    activeView.value = 'training'
    if (window.matchMedia('(max-width: 820px)').matches) collapsed.value = true
  }

  function fillDraft(text) {
    draft.value = text
    nextTick(() => document.getElementById('composer-input')?.focus())
  }

  function clearSelection() {
    selectedChat.value = null
  }

  function removeSelection(id) {
    if (!selectedChat.value) return
    selectedChat.value.messages = selectedChat.value.messages.filter(m => m.id !== id)
    if (!selectedChat.value.messages.length) selectedChat.value = null
  }

  return {
    collapsed, showImport, showSettings,
    activeView, layoutMode, setLayoutMode,
    dataSession, explorerFilter,
    draft, selectedChat,
    openExplorer, openInsight, backToChat, openAdvisors, openTraining,
    fillDraft, clearSelection, removeSelection,
  }
}
