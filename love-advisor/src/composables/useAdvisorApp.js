import { nextTick, onMounted, ref } from 'vue'
import { conversationsApi } from '../api.js'
import { useToast } from './useToast.js'
import { usePrefs } from './usePrefs.js'
import { useShell } from './useShell.js'
import { useWorkspaces } from './useWorkspaces.js'
import { useChatSessions } from './useChatSessions.js'
import { useConversations } from './useConversations.js'
import { useChatRun } from './useChatRun.js'

export function useAdvisorApp() {
  const { toastText, showToast } = useToast()
  const { saved, currentId, currentCaseId, settings, persist, updateSettings } = usePrefs()
  const shell = useShell()
  const workspaces = useWorkspaces({ currentCaseId })
  const sessions = useChatSessions({ cases: workspaces.cases, currentCaseId })
  const generating = ref(false)

  const conversations = useConversations({
    saved, currentId, currentCaseId, persist, showToast, generating,
    openCaseModal: workspaces.openCaseModal,
    syncSessionFromCase: sessions.syncSessionFromCase,
    activeView: shell.activeView,
    selectedChat: shell.selectedChat,
  })

  const chatRun = useChatRun({
    generating,
    currentConv: conversations.currentConv,
    newConversation: conversations.newConversation,
    refreshConversation: conversations.refreshConversation,
    selectedChat: shell.selectedChat,
    selectedSessionId: sessions.selectedSessionId,
    currentCaseId,
    showToast,
    refreshCases: workspaces.refreshCases,
  })

  // 根组件先完成一帧可交互渲染，再启动数据加载。聊天记录正文采用按需加载，
  // 所以这里的并发请求只会取得导航和工作区所需的轻量数据。
  async function initializeAfterFirstPaint() {
    await nextTick()
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    await Promise.allSettled([
      workspaces.refreshCases(),
      sessions.fetchSessions(),
      conversations.loadConversations(),
    ])
    sessions.syncSessionFromCase()
  }

  onMounted(() => { void initializeAfterFirstPaint() })

  async function onMemoryCandidateChanged() {
    await workspaces.refreshCases()
  }

  async function askAboutMessage(payload) {
    if (generating.value) return showToast('请等待当前回答结束')
    const workspace = workspaces.cases.value.find(c => c.sessionIds?.[0] === payload.sessionId)
    if (workspace) {
      if (currentCaseId.value !== workspace.id) {
        currentCaseId.value = workspace.id
        sessions.syncSessionFromCase()
        await conversations.newConversation()
      }
    } else {
      // 未建档的私聊：直接支持提问分析！
      sessions.selectedSessionId.value = payload.sessionId
      if (currentCaseId.value) {
        // 若当前处于特定工作区，切至未归档以隔离工作区上下文
        currentCaseId.value = ''
        await conversations.newConversation()
      }
    }
    // 无论是否归档，保持选中的私聊会话 ID 一致，避免 useChatRun 拦截
    if (payload.sessionId) {
      sessions.selectedSessionId.value = payload.sessionId
    }

    shell.selectedChat.value = {
      sessionId: payload.sessionId,
      sessionName: payload.sessionName,
      messages: payload.messages || [],
    }

    const firstMsg = payload.messages?.[0]
    const isMine = !!firstMsg?.isMine
    const defaultPrompt = (payload.messages?.length === 1)
      ? (isMine
          ? `请结合私聊上下文分析我（${firstMsg.senderName}）发的这句「${firstMsg.content?.slice(0, 32) || ''}」及对方反应：对方此时的心态如何？我接下来该如何推进？`
          : `请结合私聊上下文分析对方（${firstMsg.senderName}）发的这句「${firstMsg.content?.slice(0, 32) || ''}」，TA 此时的真实潜台词是什么？我该如何回复？`)
      : `请结合所选的 ${payload.messages?.length || 0} 条私聊记录，深入剖析双方目前的沟通互动与情感态势，给出最佳破局与回复建议。`

    const promptText = (payload.prompt && payload.prompt.trim()) || shell.draft.value.trim() || defaultPrompt

    shell.draft.value = promptText
    shell.activeView.value = 'chat'

    if (payload.immediateSend) {
      shell.draft.value = ''
      await chatRun.onSend(promptText, payload.skills || [])
    }
  }

  function chooseChatMessages() {
    let session = sessions.chatlabSessions.value.find(s => s.id === sessions.selectedSessionId.value)
    if (!session && sessions.chatlabSessions.value.length > 0) {
      session = sessions.chatlabSessions.value[0]
      sessions.selectedSessionId.value = session.id
    }
    if (!session) return workspaces.openCaseModal()
    shell.openExplorer(session)
  }

  async function archiveConversation(convId, targetCaseId) {
    try {
      const j = await conversationsApi.patch(convId, { caseId: targetCaseId || '' })
      if (!j.ok) throw new Error(j.error || '归档失败')
      await conversations.loadConversations()
      await workspaces.refreshCases()
      if (conversations.currentConv()?.id === convId) {
        currentCaseId.value = targetCaseId || ''
        sessions.syncSessionFromCase()
      }
      const targetCase = workspaces.cases.value.find(c => c.id === targetCaseId)
      showToast(targetCase ? `已归档至「${targetCase.title}」` : '已移至未归档')
    } catch (e) {
      showToast(e.message || '操作失败')
    }
  }

  function createCaseForSession(session) {
    workspaces.openCaseModal('__new__', session)
  }

  function importForWorkspace() {
    workspaces.showCaseModal.value = false
    shell.showImport.value = true
  }

  function onJumpMessages(payload = {}) {
    const id = payload.sessionId || sessions.selectedSessionId.value
    const session = sessions.chatlabSessions.value.find(s => s.id === id)
      || shell.dataSession.value
      || { id, name: '聊天记录' }
    shell.openExplorer(session, payload)
  }

  async function onImported(session) {
    sessions.importedSessions.value.push(session)
    await sessions.fetchSessions()
    await workspaces.refreshCases()
    if (session.workspace?.id) {
      shell.showImport.value = false
      currentCaseId.value = session.workspace.id
      sessions.selectedSessionId.value = session.sessionId || session.workspace.sessionIds?.[0] || ''
      persist()
      await conversations.newConversation()
      workspaces.openCaseModal(session.workspace.id)
      showToast(session.workspace.profileStatus?.status === 'draft' ? '已建档，请确认身份' : '已绑定工作区')
    }
  }

  async function onSelectCase(caseId) {
    if (generating.value) return showToast('请等待当前回答结束')
    if (caseId === currentCaseId.value) return
    shell.selectedChat.value = null
    const targetId = conversations.conversations.value.find(c => (c.caseId || '') === caseId)?.id || null
    await conversations.activateConversation(targetId, { caseId })
  }

  async function onCaseChanged(savedId) {
    await workspaces.refreshCases()
    if (savedId) {
      workspaces.caseModalId.value = savedId
      if (currentCaseId.value !== savedId) {
        currentCaseId.value = savedId
        await conversations.newConversation()
      }
      sessions.syncSessionFromCase()
      persist()
    }
  }

  function selectSession(id) {
    sessions.selectedSessionId.value = id
  }

  function regenerate() {
    if (generating.value) return
    const conv = conversations.currentConv()
    if (!conv || !conv.messages.length) return
    let lastUserMsg = null
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'user') {
        lastUserMsg = conv.messages[i]
        break
      }
    }
    if (!lastUserMsg) return
    const answer = conv.messages.at(-1)
    if (answer?.role !== 'assistant' || !answer.id) return showToast('请刷新对话后重试')
    chatRun.onSend(lastUserMsg.content, [], { regenerateMessageId: answer.id })
  }

  return {
    toastText, showToast,
    settings, updateSettings,
    currentId, currentCaseId,
    persist,
    generating,
    ...shell,
    ...workspaces,
    ...sessions,
    ...conversations,
    ...chatRun,
    askAboutMessage, chooseChatMessages, importForWorkspace,
    onJumpMessages, onImported, onSelectCase, onCaseChanged, selectSession,
    archiveConversation, createCaseForSession,
    regenerate, onMemoryCandidateChanged,
  }
}
