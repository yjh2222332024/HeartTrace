<script setup>
import { ref, computed, watch, nextTick, inject, onMounted, onBeforeUnmount } from 'vue'
import {
  ChevronDown, ChevronRight, ChevronsLeft, Plus, Pencil, Check, X,
  Folder, MessageSquare, Trash2, FileText, ChartNoAxesCombined,
  Database, Settings, FolderInput, FolderPlus
} from 'lucide-vue-next'
import logo from '../assets/logo.png'
import ConfirmDialog from './ConfirmDialog.vue'

const props = defineProps({
  conversations: { type: Array, default: () => [] },
  currentId: [String, Number],
  cases: { type: Array, default: () => [] },
  currentCaseId: String,
  activeView: String,
  chatlabSessions: { type: Array, default: () => [] },
  importedSessions: Array
})

const emit = defineEmits([
  'new', 'new-case', 'select', 'delete', 'open-settings', 'open-advisors', 'open-training',
  'toggle-collapse', 'select-case', 'open-cases', 'browse-session',
  'insight-session', 'renamed', 'archive-conv', 'create-case-for-session'
])

const toast = inject('toast', () => {})
const expanded = ref(new Set())
const dataOpen = ref(false)
const editing = ref('')
const title = ref('')
const saving = ref(false)
const inputs = ref([])

const activeMenuId = ref('')
const activeArchiveConvId = ref('')
const deleteTarget = ref(null)

function toggleMenu(id, e) {
  e?.stopPropagation()
  activeArchiveConvId.value = ''
  activeMenuId.value = activeMenuId.value === id ? '' : id
}

function toggleArchiveMenu(convId, e) {
  e?.stopPropagation()
  activeMenuId.value = ''
  activeArchiveConvId.value = activeArchiveConvId.value === convId ? '' : convId
}

function closeMenu() {
  activeMenuId.value = ''
  activeArchiveConvId.value = ''
}

function doArchive(convId, caseId) {
  emit('archive-conv', { convId, caseId })
  closeMenu()
}

function requestDelete(conv, e) {
  e?.stopPropagation()
  closeMenu()
  deleteTarget.value = conv
}

function confirmDelete() {
  if (!deleteTarget.value) return
  emit('delete', deleteTarget.value.id)
  deleteTarget.value = null
}

const isSessionArchived = (session) => {
  return props.cases.some(c => (c.sessionIds || []).includes(session.id))
}

onMounted(() => {
  window.addEventListener('click', closeMenu)
})
onBeforeUnmount(() => {
  window.removeEventListener('click', closeMenu)
})

const groups = computed(() => {
  const result = props.cases.map(c => ({ ...c, children: props.conversations.filter(v => v.caseId === c.id) }))
  const loose = props.conversations.filter(v => !props.cases.some(c => c.id === v.caseId))
  if (loose.length) result.push({ id: '', title: '未归档', children: loose })
  return result
})

watch(() => [props.currentCaseId, props.currentId], () => {
  expanded.value = new Set([...expanded.value, props.currentCaseId || ''])
}, { immediate: true })

function toggle(group) {
  const next = new Set(expanded.value)
  if (next.has(group.id)) next.delete(group.id)
  else next.add(group.id)
  expanded.value = next
  if (group.id !== props.currentCaseId) emit('select-case', group.id)
}

async function rename(group) {
  editing.value = group.id
  title.value = group.title
  await nextTick()
  inputs.value[0]?.focus()
  inputs.value[0]?.select()
}

async function save() {
  if (saving.value) return
  if (!title.value.trim()) return toast('名称不能为空')
  saving.value = true
  try {
    const res = await fetch(`/api/cases/${editing.value}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.value.trim() })
    })
    const j = await res.json()
    if (!res.ok || !j.ok) throw new Error(j.error || '重命名失败')
    emit('renamed')
    editing.value = ''
  } catch (e) {
    toast(e.message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <aside class="sidebar tree-sidebar">
    <div class="brand-row">
      <div class="brand-mark"><img :src="logo" alt="心迹" /></div>
      <div class="brand-copy"><strong>心迹</strong><small>HeartTrace</small></div>
      <button class="collapse" aria-label="收起侧栏" title="收起侧栏" @click="emit('toggle-collapse')">
        <ChevronsLeft :size="20" />
      </button>
    </div>

    <button class="new-chat" @click="emit('new')">
      <Plus :size="21" />开始新对话
    </button>

    <button class="advisor-nav" :class="{ active: activeView === 'advisors' }" @click="emit('open-advisors')">
      <img :src="logo" alt="" />军师管理
      <ChevronRight class="push" :size="18" />
    </button>

    <button class="advisor-nav training-nav" :class="{ active: activeView === 'training' }" @click="emit('open-training')">
      <MessageSquare :size="19" />模拟训练
      <ChevronRight class="push" :size="18" />
    </button>

    <div class="tree-heading">
      <strong>私聊</strong>
      <button title="新建私聊档案" aria-label="新建私聊档案" @click="emit('new-case')">
        <Plus :size="18" />
      </button>
    </div>

    <nav class="workspace-tree" aria-label="私聊会话目录">
      <section v-for="group in groups" :key="group.id" class="folder-group">
        <form v-if="group.id && editing === group.id" class="rename-row" @submit.prevent="save">
          <input ref="inputs" v-model="title" aria-label="工作区名称" maxlength="60" :disabled="saving" @keydown.esc="editing = ''" />
          <button title="保存名称" aria-label="保存名称" :disabled="saving"><Check :size="18" /></button>
          <button type="button" aria-label="取消重命名" :disabled="saving" @click="editing = ''"><X :size="18" /></button>
        </form>

        <div v-else class="folder-row" :class="{ current: group.id === currentCaseId }">
          <button class="folder-label" :title="group.title" :aria-expanded="expanded.has(group.id)" @click="toggle(group)">
            <ChevronDown v-if="expanded.has(group.id)" :size="16" />
            <ChevronRight v-else :size="16" />
            <Folder :size="18" />
            <span>{{ group.title }}</span>
            <small>{{ group.children.length }}</small>
          </button>

          <div v-if="group.id" class="folder-menu-wrap">
            <button class="folder-menu-trigger" :aria-label="`${group.title}的操作`" title="工作区操作" type="button" @click="toggleMenu(group.id, $event)">···</button>
            <transition name="popover-fade">
              <div v-if="activeMenuId === group.id" class="folder-dropdown" @click.stop>
                <button type="button" @click="emit('new', group.id); closeMenu()"><Plus :size="14" /><span>新建会话</span></button>
                <button type="button" @click="rename(group); closeMenu()"><Pencil :size="14" /><span>重命名</span></button>
                <button type="button" @click="emit('open-cases', group.id); closeMenu()"><FileText :size="14" /><span>工作区档案</span></button>
              </div>
            </transition>
          </div>
        </div>

        <div v-if="expanded.has(group.id)" class="folder-children">
          <div
            v-for="conv in group.children"
            :key="conv.id"
            class="conversation-row"
            :class="{ selected: conv.id === currentId }"
          >
            <button class="conversation-link" :title="conv.title" @click="emit('select', conv.id)">
              <MessageSquare :size="16" />
              <span>{{ conv.title }}</span>
            </button>

            <div class="conv-btn-wrap">
              <!-- 归档操作入口 -->
              <button
                class="archive-conv-btn"
                :title="conv.caseId ? '移动至其他工作区' : '归档到工作区'"
                :aria-label="conv.caseId ? '移动至其他工作区' : '归档到工作区'"
                @click="toggleArchiveMenu(conv.id, $event)"
              >
                <FolderInput :size="14" />
              </button>

              <button
                class="delete-conversation"
                :title="`删除 ${conv.title}`"
                :aria-label="`删除 ${conv.title}`"
                @click="requestDelete(conv, $event)"
              >
                <Trash2 :size="15" />
              </button>

              <!-- 归档下拉弹窗 -->
              <transition name="popover-fade">
                <div v-if="activeArchiveConvId === conv.id" class="archive-dropdown" @click.stop>
                  <div class="archive-dropdown-title">
                    {{ conv.caseId ? '变更工作区归属' : '归档到工作区' }}
                  </div>
                  <div class="archive-options-list">
                    <button
                      v-for="c in cases"
                      :key="c.id"
                      type="button"
                      class="archive-option"
                      :class="{ current: c.id === conv.caseId }"
                      @click="doArchive(conv.id, c.id)"
                    >
                      <Folder :size="13" />
                      <span>{{ c.title }}</span>
                    </button>
                  </div>
                  <button
                    v-if="conv.caseId"
                    type="button"
                    class="archive-option unarchive-opt"
                    @click="doArchive(conv.id, '')"
                  >
                    <FolderInput :size="13" />
                    <span>移至未归档</span>
                  </button>
                  <button
                    type="button"
                    class="archive-option new-case-opt"
                    @click="emit('new-case'); closeMenu()"
                  >
                    <Plus :size="13" />
                    <span>新建工作区…</span>
                  </button>
                </div>
              </transition>
            </div>
          </div>

          <!-- 新建会话引导（空工作区或未归档空文件夹均可点） -->
          <button v-if="!group.children.length" class="empty-folder" @click="emit('new', group.id)">
            <Plus :size="16" />新建会话
          </button>
        </div>
      </section>

      <button v-if="!groups.length" class="empty-folder" @click="emit('new-case')">
        <Plus :size="16" />创建工作区
      </button>
    </nav>

    <!-- 聊天数据侧栏 -->
    <section class="chat-data-status">
      <button class="data-toggle" :aria-expanded="dataOpen" @click="dataOpen = !dataOpen">
        <Database :size="18" />
        <strong>聊天数据</strong>
        <span>{{ chatlabSessions.length }}</span>
        <ChevronDown v-if="dataOpen" :size="18" />
        <ChevronRight v-else :size="18" />
      </button>

      <div v-if="dataOpen" class="data-list">
        <p v-if="!chatlabSessions.length" class="empty-folder">暂无聊天记录</p>
        <div v-for="s in chatlabSessions" :key="s.id" class="session-row">
          <button class="session-browse" :title="`浏览 ${s.name}（${isSessionArchived(s) ? '已建档' : '未归档'}）`" @click="emit('browse-session', s)">
            <MessageSquare :size="16" />
            <span>{{ s.name }}</span>
            <span v-if="!isSessionArchived(s)" class="unarchived-badge" title="未关联独立工作区">未建档</span>
            <small>{{ s.totalMessages ?? 0 }} 条</small>
          </button>

          <!-- 未归档私聊专属：一键建档创建工作区 -->
          <button
            v-if="!isSessionArchived(s)"
            class="session-case-btn"
            :title="`为 ${s.name} 创建工作区档案`"
            :aria-label="`为 ${s.name} 创建工作区档案`"
            @click.stop="emit('create-case-for-session', s)"
          >
            <FolderPlus :size="16" />
          </button>

          <!-- 数据洞察 -->
          <button class="session-insight" :title="`${s.name}的数据洞察`" :aria-label="`${s.name}的数据洞察`" @click="emit('insight-session', s)">
            <ChartNoAxesCombined :size="18" />
          </button>
        </div>
      </div>
    </section>

    <button class="settings" @click="emit('open-settings')">
      <Settings :size="21" />
      <span>设置与模型配置</span>
      <ChevronRight class="push" :size="17" />
    </button>

    <ConfirmDialog
      :open="!!deleteTarget"
      title="删除会话？"
      :message="deleteTarget ? `会话「${deleteTarget.title}」及其中的 AI 对话将被永久删除，此操作无法撤销。` : ''"
      confirm-text="删除会话"
      @cancel="deleteTarget = null"
      @confirm="confirmDelete"
    />
  </aside>
</template>

<style scoped>
.tree-sidebar > :not(.workspace-tree) { flex-shrink: 0; }
.tree-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 22px 0 10px;
  font-size: 14px;
  font-weight: 650;
  color: var(--text-2);
}
.tree-heading button, .rename-row button {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid rgba(139, 38, 67, 0.18);
  background: #fff2f6;
  color: var(--brand);
  cursor: pointer;
  transition: all 0.16s;
}
.tree-heading button:hover {
  background: #ffe4ec;
  border-color: rgba(139, 38, 67, 0.3);
}
.workspace-tree {
  flex: 1;
  min-height: 80px;
  overflow-y: auto;
  overflow-x: hidden;
  padding-bottom: 32px;
}
.folder-row {
  display: flex;
  align-items: center;
  border-radius: 10px;
  margin-bottom: 4px;
  background: #fcfbfc;
  border: 1px solid rgba(226, 218, 222, 0.7);
  flex-wrap: nowrap;
  position: relative;
  transition: all 0.16s;
}
.folder-row:hover {
  background: #fff;
  border-color: rgba(139, 38, 67, 0.2);
}
.folder-row.current {
  background: #fdf1f4;
  border-color: rgba(139, 38, 67, 0.3);
  color: var(--brand);
}
.folder-label {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
  min-height: 44px;
  padding: 8px 10px;
  font-size: 14.5px;
  font-weight: 600;
  text-align: left;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.folder-label span, .conversation-link span, .session-browse span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}
svg { flex-shrink: 0; }
.folder-label small {
  font-size: 12.5px;
  color: var(--text-3);
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(226, 218, 222, 0.4);
}

.folder-menu-wrap { position: relative; flex-shrink: 0; }
.folder-menu-trigger {
  width: 28px;
  height: 28px;
  margin-right: 6px;
  display: grid;
  place-items: center;
  border: 0;
  background: transparent;
  cursor: pointer;
  font-weight: 700;
  font-size: 17px;
  color: var(--text-3);
  border-radius: 6px;
  transition: all 0.15s;
}
.folder-menu-trigger:hover {
  background: rgba(139, 38, 67, 0.08);
  color: var(--brand);
}
.folder-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  right: 4px;
  z-index: 70;
  min-width: 124px;
  background: rgba(255, 255, 255, 0.98);
  border: 1px solid rgba(139, 38, 67, 0.18);
  border-radius: 10px;
  box-shadow: 0 10px 28px rgba(35, 18, 26, 0.14), 0 2px 8px rgba(35, 18, 26, 0.05);
  backdrop-filter: blur(12px);
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.folder-dropdown button {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  font-size: 12.5px;
  font-weight: 500;
  padding: 7px 9px;
  border-radius: 6px;
  border: 0;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  text-align: left;
  transition: all 0.14s ease;
}
.folder-dropdown button:hover {
  background: #fff2f6;
  color: var(--brand);
}
.popover-fade-enter-active, .popover-fade-leave-active {
  transition: all 0.14s cubic-bezier(0.4, 0, 0.2, 1);
}
.popover-fade-enter-from, .popover-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.96);
}

.folder-children {
  margin: 4px 0 12px 14px;
  padding-left: 10px;
  border-left: 1.5px solid rgba(226, 218, 222, 0.85);
}
.conversation-row {
  display: flex;
  align-items: center;
  border-radius: 8px;
  margin: 3px 0;
  transition: all 0.15s;
  position: relative;
}
.conversation-row:hover { background: rgba(255, 255, 255, 0.7); }
.conversation-row.selected {
  background: #fdf1f4;
  color: var(--brand);
  font-weight: 550;
}
.conversation-link {
  display: flex;
  gap: 9px;
  align-items: center;
  flex: 1;
  min-width: 0;
  min-height: 42px;
  padding: 8px;
  font-size: 14px;
  text-align: left;
  color: inherit;
}

.conv-btn-wrap {
  position: relative;
  display: flex;
  align-items: center;
  gap: 2px;
  padding-right: 4px;
}
.archive-conv-btn, .delete-conversation {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  color: #987581;
  border: 0;
  background: transparent;
  opacity: 0;
  cursor: pointer;
  transition: all 0.15s;
}
.archive-conv-btn:hover {
  color: var(--brand);
  background: #ffe4ec;
}
.delete-conversation:hover {
  color: #be123c;
  background: #ffe4e6;
}
.conversation-row:hover .archive-conv-btn,
.conversation-row:hover .delete-conversation,
.conversation-row:focus-within .archive-conv-btn,
.conversation-row:focus-within .delete-conversation {
  opacity: 1;
}

/* 归档浮层 */
.archive-dropdown {
  position: absolute;
  top: calc(100% + 2px);
  right: 0;
  z-index: 80;
  min-width: 160px;
  background: #ffffff;
  border: 1px solid #ebd9df;
  border-radius: 10px;
  box-shadow: 0 10px 24px rgba(45, 20, 30, 0.14);
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.archive-dropdown-title {
  font-size: 11px;
  font-weight: 600;
  color: #8c97a8;
  padding: 4px 6px 3px;
  border-bottom: 1px solid #f6edf0;
  margin-bottom: 3px;
}
.archive-options-list {
  max-height: 140px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.archive-option {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 6px;
  border: 0;
  background: transparent;
  color: #3e4452;
  cursor: pointer;
  text-align: left;
  transition: all 0.12s;
}
.archive-option:hover {
  background: #fdf2f5;
  color: var(--brand);
}
.archive-option.current {
  background: #fdecf1;
  color: var(--brand);
  font-weight: 600;
}
.unarchive-opt {
  border-top: 1px solid #f6edf0;
  margin-top: 2px;
  color: #7a8290;
}
.new-case-opt {
  color: var(--brand);
  font-weight: 500;
}

.empty-folder {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 10px;
  font-size: 13.5px;
  color: var(--brand);
  cursor: pointer;
  border: 0;
  background: transparent;
}
.rename-row {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
}
.rename-row input {
  width: 0;
  flex: 1;
  border: 1px solid rgba(139, 38, 67, 0.3);
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 14px;
  outline: none;
}
.rename-row input:focus { border-color: var(--brand); }

/* 聊天数据栏 */
.chat-data-status {
  border-top: 1px solid rgba(226, 218, 222, 0.85);
  padding: 12px 0;
}
.data-toggle {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 44px;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid rgba(226, 218, 222, 0.8);
  background: #ffffff;
  color: var(--text-2);
  text-align: left;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s;
}
.data-toggle:hover {
  background: #fdfbfb;
  border-color: rgba(139, 38, 67, 0.2);
}
.data-toggle strong { flex: 1; color: var(--text); }
.data-toggle span {
  font-size: 12.5px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 999px;
  background: #f3f0f2;
  color: var(--text-2);
}
.data-list {
  max-height: 190px;
  overflow: auto;
  padding-top: 8px;
}
.session-row {
  display: flex;
  align-items: stretch;
  gap: 4px;
  margin: 4px 0;
}
.session-browse {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px;
  min-width: 0;
  flex: 1;
  text-align: left;
  background: #ffffff;
  border: 1px solid rgba(226, 218, 222, 0.7);
  border-radius: 8px;
  color: var(--text-2);
  font-size: 13.5px;
  cursor: pointer;
  transition: all 0.15s;
}
.session-browse:hover {
  background: #fdf6f8;
  border-color: rgba(139, 38, 67, 0.2);
  color: var(--brand);
}
.session-browse small {
  flex-shrink: 0;
  font-size: 11.5px;
  color: var(--text-3);
}
.unarchived-badge {
  font-size: 10.5px;
  font-weight: 500;
  color: #c4783c;
  background: #fef5ec;
  border: 1px solid #fae4ce;
  border-radius: 4px;
  padding: 1px 5px;
  flex-shrink: 0;
}
.session-case-btn {
  width: 36px;
  display: grid;
  place-items: center;
  background: #ffffff;
  border: 1px solid rgba(226, 218, 222, 0.7);
  color: #c4783c;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
}
.session-case-btn:hover {
  background: #fef5ec;
  border-color: #f7ceaa;
  color: #b56220;
}
.session-insight {
  width: 36px;
  display: grid;
  place-items: center;
  background: #ffffff;
  border: 1px solid rgba(226, 218, 222, 0.7);
  color: var(--text-2);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
}
.session-insight:hover {
  background: #fdf6f8;
  border-color: rgba(139, 38, 67, 0.2);
  color: var(--brand);
}

button:hover { filter: brightness(.98); }
.settings {
  width: 100%;
  text-align: left;
  margin-top: 0;
  font-size: 14.5px;
  color: var(--text-2);
  border-top: 1px solid rgba(226, 218, 222, 0.85);
  transition: color 0.15s;
}
.settings:hover { color: var(--brand); }
.push { margin-left: auto; }
@media(max-width:820px) {
  .archive-conv-btn, .delete-conversation { opacity: 1; }
}
</style>
