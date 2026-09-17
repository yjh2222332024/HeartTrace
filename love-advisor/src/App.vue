<script setup>
import { computed, onBeforeUnmount, provide, ref } from 'vue'
import Sidebar from './components/Sidebar.vue'
import ImportDialog from './components/ImportDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import WorkspaceModal from './components/WorkspaceModal.vue'
import ChatExplorer from './components/ChatExplorer.vue'
import InsightPanel from './components/InsightPanel.vue'
import AdvisorManager from './components/AdvisorManager.vue'
import ChatView from './views/ChatView.vue'
import TrainingView from './views/TrainingView.vue'
import { useAdvisorApp } from './composables/useAdvisorApp.js'

const {
  toastText, showToast,
  settings, updateSettings,
  currentId, currentCaseId,
  generating,
  collapsed, showImport, showSettings,
  activeView, layoutMode, setLayoutMode, dataSession, explorerFilter,
  draft, selectedChat,
  openExplorer, openInsight, backToChat, openAdvisors, openTraining,
  fillDraft, clearSelection, removeSelection,
  cases, showCaseModal, caseModalId, initialCaseSession,
  refreshCases, openCaseModal, onCaseDeleted,
  importedSessions, chatlabSessions, selectedSessionId,
  conversations, currentConv, hasMessages, loadingConversation,
  newConversation, selectConversation, deleteConversation,
  runState, autoSkillName, onSend, cancelRun,
  askAboutMessage, chooseChatMessages, importForWorkspace,
  onJumpMessages, onImported, onSelectCase, onCaseChanged, selectSession,
  archiveConversation, createCaseForSession,
  regenerate, onMemoryCandidateChanged,
} = useAdvisorApp()

provide('toast', showToast)

const currentCaseMemoryCandidates = computed(() => {
  const caseId = currentConv()?.caseId
  return cases.value?.find?.(item => item.id === caseId)?.memoryCandidates || []
})

// 空会话首页也明确标出当前工作区的对方，避免用户误以为军师会引用其他私聊。
const currentWorkspacePeerName = computed(() => {
  const caseId = currentConv()?.caseId || currentCaseId.value
  return cases.value?.find?.(item => item.id === caseId)?.profileStatus?.peerName || ''
})

const splitBodyRef = ref(null)
const splitRatio = ref(57)
const resizingSplit = ref(false)
const splitStyle = computed(() => ({ '--split-left': `${splitRatio.value}%` }))

function updateSplitRatio(clientX) {
  const rect = splitBodyRef.value?.getBoundingClientRect()
  if (!rect || rect.width <= 0) return
  const minPaneWidth = Math.min(320, Math.max(220, (rect.width - 9) / 2))
  const leftWidth = Math.min(
    Math.max(clientX - rect.left, minPaneWidth),
    rect.width - minPaneWidth - 9,
  )
  splitRatio.value = Math.round((leftWidth / rect.width) * 1000) / 10
}

function stopSplitResize() {
  if (!resizingSplit.value) return
  resizingSplit.value = false
  window.removeEventListener('pointermove', onSplitPointerMove)
  window.removeEventListener('pointerup', stopSplitResize)
  window.removeEventListener('pointercancel', stopSplitResize)
}

function onSplitPointerMove(event) {
  updateSplitRatio(event.clientX)
}

function startSplitResize(event) {
  if (event.button !== 0 || window.matchMedia('(max-width: 1024px)').matches) return
  event.preventDefault()
  resizingSplit.value = true
  updateSplitRatio(event.clientX)
  window.addEventListener('pointermove', onSplitPointerMove)
  window.addEventListener('pointerup', stopSplitResize)
  window.addEventListener('pointercancel', stopSplitResize)
}

function resizeSplitWithKeyboard(event) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  const rect = splitBodyRef.value?.getBoundingClientRect()
  if (!rect) return
  const nextRatio = splitRatio.value + (event.key === 'ArrowLeft' ? -2 : 2)
  updateSplitRatio(rect.left + rect.width * nextRatio / 100)
}

onBeforeUnmount(stopSplitResize)

// 当前左栏活跃的私聊会话
const activeExplorerSession = computed(() => {
  if (dataSession.value) return dataSession.value
  if (selectedSessionId.value) {
    const found = chatlabSessions.value?.find(s => s.id === selectedSessionId.value)
    if (found) return found
  }
  if (chatlabSessions.value?.length > 0) {
    return chatlabSessions.value[0]
  }
  return null
})

function startSidebarConversation(caseId) {
  setLayoutMode('chat')
  return newConversation(caseId)
}
</script>

<template>
  <div class="app" :class="{ 'sidebar-collapsed': collapsed }">
    <Transition name="sidebar-expand">
      <button v-if="collapsed" class="expand" title="展开侧栏" @click="collapsed = false">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
          stroke-linecap="round" stroke-linejoin="round">
          <path d="m11 17 5-5-5-5" /><path d="m6 17 5-5-5-5" />
        </svg>
      </button>
    </Transition>

    <Sidebar
      :conversations="conversations"
      :current-id="currentId"
      :imported-sessions="importedSessions"
      :cases="cases"
      :current-case-id="currentCaseId"
      :active-view="activeView"
      :chatlab-sessions="chatlabSessions"
      @new="startSidebarConversation"
      @select="selectConversation"
      @delete="deleteConversation"
      @select-case="onSelectCase"
      @open-cases="openCaseModal"
      @renamed="refreshCases"
      @new-case="openCaseModal()"
      @open-settings="showSettings = true"
      @open-advisors="openAdvisors"
      @open-training="openTraining"
      @toggle-collapse="collapsed = true"
      @browse-session="s => openExplorer(s)"
      @insight-session="openInsight"
      @archive-conv="({ convId, caseId }) => archiveConversation(convId, caseId)"
      @create-case-for-session="s => createCaseForSession(s)"
    />

    <main class="main" :class="{ 'chat-mode': hasMessages && (activeView === 'chat' || layoutMode === 'chat') }">
      <Transition name="app-view" mode="out-in">
        <!-- 智囊管理系统全屏视图 -->
        <AdvisorManager v-if="activeView === 'advisors'" key="advisors" @back="backToChat" />

        <!-- 独立模拟聊天训练场 -->
        <TrainingView
          v-else-if="activeView === 'training'"
          key="training"
          :cases="cases"
          @back="backToChat"
        />

        <!-- 数据洞察全屏视图 -->
        <InsightPanel
          v-else-if="activeView === 'insight' && (activeExplorerSession || dataSession)"
          key="insight"
          :session="activeExplorerSession || dataSession"
          @back="backToChat"
          @browse="s => openExplorer(s)"
        />

        <!-- IDE 风格工作台：左侧聊天记录 + 右侧军师对话 -->
        <div v-else key="workspace" class="ide-workspace">
        <!-- IDE 顶栏 -->
        <header class="ide-header">
          <!-- 左侧：当前私聊 -->
          <div class="ide-header-left">
            <div class="ide-session-selector">
              <span class="ide-label">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </span>
              <span
                v-if="activeExplorerSession"
                class="ide-session-name"
                :title="activeExplorerSession.name"
              >
                {{ activeExplorerSession.name }}
              </span>
              <button v-else class="ide-import-mini-btn" @click="showImport = true">
                + 导入记录
              </button>
            </div>
          </div>

          <!-- 中间：全屏会话 / 双栏对照 -->
          <div class="ide-header-center">
            <div class="ide-layout-switch" role="group" aria-label="工作区布局模式">
              <button
                type="button"
                class="layout-btn"
                :class="{ active: layoutMode === 'chat' }"
                title="全屏会话：专注军师对话"
                aria-label="全屏会话"
                @click="setLayoutMode('chat')"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M16 3v18" />
                </svg>
                <span>全屏会话</span>
              </button>

              <button
                type="button"
                class="layout-btn"
                :class="{ active: layoutMode === 'split' }"
                title="双栏对照：左侧聊天记录 + 右侧军师会话"
                aria-label="双栏对照"
                @click="setLayoutMode('split')"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M12 3v18" />
                </svg>
                <span>双栏对照</span>
              </button>
            </div>
          </div>

          <!-- 右侧：数据洞察与辅助工具入口 -->
          <div class="ide-header-right">
            <button
              v-if="activeExplorerSession"
              class="ide-tool-btn"
              title="查看当前私聊记录的沟通趋势、话题与情绪分析"
              aria-label="数据洞察"
              @click="openInsight(activeExplorerSession)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 3v18h18" /><path d="M7 14l4-4 3 3 5-6" />
              </svg>
            </button>
          </div>
        </header>

        <!-- IDE 主区分栏区域 -->
        <div
          ref="splitBodyRef"
          class="ide-workspace-body"
          :class="[`mode-${layoutMode}`, { 'is-resizing': resizingSplit }]"
          :style="splitStyle"
        >
          <!-- 左栏：聊天记录浏览器 -->
          <div class="ide-pane-left">
            <ChatExplorer
              v-if="activeExplorerSession"
              :session="activeExplorerSession"
              :key="activeExplorerSession.id"
              :is-split="layoutMode === 'split'"
              :initial-selection="selectedChat?.sessionId === activeExplorerSession.id ? selectedChat.messages : []"
              :initial-q="explorerFilter.q"
              :initial-since="explorerFilter.since"
              @back="setLayoutMode('chat')"
              @ask="askAboutMessage"
              @insight="openInsight(activeExplorerSession)"
            />
            <div v-else class="ide-empty-left">
              <div class="ide-empty-card">
                <div class="empty-icon-wrap">💬</div>
                <h3>未选择私聊记录</h3>
                <p>请从左侧私聊列表选择会话，或导入聊天数据开启深度剖析。</p>
                <button class="ide-empty-btn" @click="showImport = true">
                  + 导入私聊记录
                </button>
              </div>
            </div>
          </div>

          <!-- 双栏分界线 -->
          <div
            class="ide-split-divider"
            role="separator"
            aria-label="调整聊天记录与军师会话的宽度"
            aria-orientation="vertical"
            :aria-valuenow="Math.round(splitRatio)"
            :aria-hidden="layoutMode !== 'split'"
            :tabindex="layoutMode === 'split' ? 0 : -1"
            @pointerdown="startSplitResize"
            @keydown="resizeSplitWithKeyboard"
          ></div>

          <!-- 右栏：军师 Copilot 对话 -->
          <div class="ide-pane-right">
            <ChatView
              v-model:draft="draft"
              :loading="loadingConversation"
              :has-messages="hasMessages"
              :messages="currentConv()?.messages || []"
              :generating="generating"
              :run-state="runState"
              :auto-skill="autoSkillName"
              :case-id="currentConv()?.caseId || ''"
              :memory-candidates="currentCaseMemoryCandidates"
              :peer-name="currentWorkspacePeerName"
              :selection="selectedChat"
              :is-split="layoutMode === 'split'"
              @fill="fillDraft"
              @jump-messages="onJumpMessages"
              @send="onSend"
              @cancel="cancelRun"
              @choose-messages="chooseChatMessages"
              @clear-selection="clearSelection"
              @remove-selection="removeSelection"
              @open-import="showImport = true"
              @regenerate="regenerate"
              @memory-candidate-changed="onMemoryCandidateChanged"
            />
          </div>
        </div>
        </div>
      </Transition>
    </main>

    <div class="toast" :class="{ show: !!toastText }">{{ toastText }}</div>

    <Transition name="modal-reveal">
      <ImportDialog
        v-if="showImport"
        :settings="settings"
        @close="showImport = false"
        @imported="onImported"
        @update-settings="updateSettings"
      />
    </Transition>
    <Transition name="modal-reveal">
      <SettingsDialog
        v-if="showSettings"
        :settings="settings"
        @close="showSettings = false"
      />
    </Transition>
    <WorkspaceModal
      :open="showCaseModal"
      :case-id="caseModalId"
      :sessions="chatlabSessions"
      :initial-session="initialCaseSession"
      @close="showCaseModal = false; initialCaseSession = null"
      @deleted="onCaseDeleted"
      @changed="onCaseChanged"
      @import="importForWorkspace"
    />
  </div>
</template>
