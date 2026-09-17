import { computed, ref } from 'vue'
import { conversationsApi } from '../api.js'

export function useConversations({
  saved, currentId, currentCaseId, persist, showToast, generating,
  openCaseModal, syncSessionFromCase, activeView, selectedChat,
}) {
  const conversations = ref([])
  const loadingConversationId = ref('')
  const hydratedConversationIds = new Set()

  function currentConv() {
    return conversations.value.find(c => c.id === currentId.value)
  }

  const hasMessages = computed(() => {
    const conversation = currentConv()
    return Number(conversation?.messageCount || conversation?.messages?.length || 0) > 0
  })
  const loadingConversation = computed(() => loadingConversationId.value === currentId.value)

  function replaceConversation(conversation) {
    const index = conversations.value.findIndex(item => item.id === conversation.id)
    if (index >= 0) conversations.value[index] = conversation
  }

  async function loadConversation(id) {
    const conversationId = String(id || '')
    if (!conversationId) return null
    if (hydratedConversationIds.has(conversationId)) {
      return conversations.value.find(item => item.id === conversationId) || null
    }
    loadingConversationId.value = conversationId
    try {
      const j = await conversationsApi.get(conversationId)
      if (!j?.ok) return null
      hydratedConversationIds.add(conversationId)
      replaceConversation(j.data)
      return j.data
    } catch {
      return null
    } finally {
      if (loadingConversationId.value === conversationId) loadingConversationId.value = ''
    }
  }

  async function loadConversations() {
    try {
      let j = await conversationsApi.list()
      if (!j?.ok) return
      if (!j.data.items.length && saved?.conversations?.length) {
        await conversationsApi.migrate(saved.conversations).catch(() => {})
        j = await conversationsApi.list().catch(() => null)
      }
      if (!j?.ok) return
      conversations.value = j.data.items
      hydratedConversationIds.clear()
      if (!conversations.value.some(item => item.id === currentId.value)) {
        currentId.value = conversations.value[0]?.id || null
      }
      currentCaseId.value = conversations.value.find(c => c.id === currentId.value)?.caseId || ''
      syncSessionFromCase()
      if (currentId.value) await loadConversation(currentId.value)
    } catch { /* 后端未起时保持空列表 */ }
  }

  async function refreshConversation(id) {
    const conversationId = String(id || '')
    hydratedConversationIds.delete(conversationId)
    await loadConversation(conversationId)
  }

  async function newConversation(caseId, { allowWhileGenerating = false } = {}) {
    if (generating.value && !allowWhileGenerating) {
      showToast('请等待当前回答结束')
      return null
    }
    if (typeof caseId === 'string') currentCaseId.value = caseId
    syncSessionFromCase()
    activeView.value = 'chat'
    selectedChat.value = null
    try {
      const j = await conversationsApi.create({ title: '新对话', caseId: currentCaseId.value || '' })
      if (j.ok) {
        conversations.value.unshift(j.data)
        hydratedConversationIds.add(j.data.id)
        currentId.value = j.data.id
        persist()
        showToast('已开始新对话')
        return j.data
      }
    } catch { /* 使用下方统一错误提示 */ }
    showToast('无法创建新对话，请确认服务端正在运行后重试')
    return null
  }

  async function activateConversation(id, { caseId } = {}) {
    activeView.value = 'chat'
    selectedChat.value = null
    currentId.value = id || null
    const conv = conversations.value.find(c => c.id === currentId.value)
    currentCaseId.value = caseId !== undefined ? caseId : (conv?.caseId || '')
    syncSessionFromCase()
    persist()
    if (currentId.value) return loadConversation(currentId.value)
    return null
  }

  async function selectConversation(id) {
    if (generating.value) return showToast('请等待当前回答结束')
    return activateConversation(id)
  }

  async function deleteConversation(id) {
    let result
    try {
      result = await conversationsApi.remove(id)
    } catch { /* 使用下方统一错误提示 */ }
    if (!result?.ok) {
      showToast(result?.error || '删除会话失败，请稍后重试')
      return false
    }

    conversations.value = conversations.value.filter(c => c.id !== id)
    hydratedConversationIds.delete(String(id || ''))
    if (currentId.value === id) {
      const next = conversations.value[0]
      await activateConversation(next?.id || null, { caseId: next?.caseId || '' })
    } else {
      persist()
    }
    return true
  }

  return {
    conversations, currentConv, hasMessages, loadingConversation,
    loadConversations, refreshConversation,
    newConversation, activateConversation, selectConversation, deleteConversation,
  }
}
