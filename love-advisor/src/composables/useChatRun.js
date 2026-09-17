import { ref, reactive } from 'vue'
import { conversationsApi, runsApi, parseJson } from '../api.js'
import { applyRunEvent, readSseStream } from '../lib/sse.js'

export function useChatRun({
  generating, currentConv, newConversation, refreshConversation,
  selectedChat, selectedSessionId, currentCaseId, showToast, refreshCases,
}) {
  const runState = ref('')
  const activeRunId = ref(null)
  const autoSkillName = ref('')

  async function onSend(text, skills, { regenerateMessageId } = {}) {
    if (generating.value) return
    const selection = selectedChat.value
    if (selection && selectedSessionId.value && selection.sessionId !== selectedSessionId.value) {
      return showToast('所选聊天记录与当前工作区不一致')
    }
    // 在创建会话前锁定，避免慢网络下连续发送创建多个会话或 Run。
    generating.value = true
    runState.value = 'created'
    let conv = null
    let reactiveMsg = null

    try {
      if (!currentConv()) await newConversation(undefined, { allowWhileGenerating: true })
      conv = currentConv()
      if (!conv) return
      conv.messages ||= []
      if (!regenerateMessageId) conv.messages.push({ role: 'user', content: text, selectionContext: selection })
      if (conv.title === '新对话') {
        conv.title = text.slice(0, 18) || '新对话'
        conversationsApi.patch(conv.id, { title: conv.title }).catch(() => {})
      }

      const aiMsg = reactive({
        role: 'assistant', content: '', reasoning: '', tools: [],
        memoryCandidateIds: [], memoryCandidates: [],
      })
      conv.messages.push(aiMsg)
      reactiveMsg = conv.messages[conv.messages.length - 1] || aiMsg
      const effectiveSessionId = selectedSessionId.value || selection?.sessionId || ''
      const res = await runsApi.start({
        conversationId: conv.id,
        regenerateMessageId,
        text,
        skills,
        sessionId: effectiveSessionId,
        caseId: currentCaseId.value || '',
        selection: selection ? { sessionId: selection.sessionId, messageIds: selection.messages.map(m => m.id) } : undefined,
      })
      if (!res.ok || !res.body) {
        const j = await parseJson(res)
        throw new Error(j?.error || `HTTP ${res.status}`)
      }
      selectedChat.value = null

      const session = { aiMsg: reactiveMsg, activeRunId, autoSkillName, runState, showToast }
      await readSseStream(res.body, event => applyRunEvent(event, session))
    } catch (e) {
      const message = e instanceof Error ? e.message : '请求失败'
      if (reactiveMsg) reactiveMsg.content += `\n\n(连接失败：${message})`
      showToast(message)
    } finally {
      generating.value = false
      activeRunId.value = null
      runState.value = ''
      autoSkillName.value = ''
      if (conv?.id) await refreshConversation(conv.id)
      if (currentCaseId.value) await refreshCases?.()
    }
  }

  function cancelRun() {
    if (!activeRunId.value) return
    runsApi.cancel(activeRunId.value).catch(() => {})
  }

  return { runState, autoSkillName, onSend, cancelRun }
}
