<script setup>
import { computed, inject, reactive, ref, watch } from 'vue'
import {
  BookmarkCheck, Check, LoaderCircle, Pencil, Save, X,
} from 'lucide-vue-next'
import { casesApi } from '../api.js'

const props = defineProps({
  candidate: { type: Object, required: true },
  caseId: { type: String, required: true },
})
const emit = defineEmits(['changed'])
const toast = inject('toast', () => {})

const current = reactive({})
const editing = ref(false)
const titleDraft = ref('')
const contentDraft = ref('')
const pendingAction = ref('')
const errorText = ref('')

watch(
  () => props.candidate,
  candidate => {
    Object.assign(current, candidate || {})
    if (!editing.value) resetDrafts()
  },
  { immediate: true, deep: true },
)

const TOPIC_LABELS = {
  her: '她', me: '我', relationship: '关系', risk: '风险', evidence: '聊天证据',
}
const TYPE_LABELS = {
  episodic: '具体事件', semantic: '长期规律', risk: '风险提醒', preference: '偏好',
}

const evidenceCount = computed(() => current.sourceMessageIds?.length || 0)
const isPending = computed(() => current.status === 'pending')
const isBusy = computed(() => !!pendingAction.value)

function resetDrafts() {
  titleDraft.value = current.title || ''
  contentDraft.value = current.content || ''
}

function startEditing() {
  resetDrafts()
  errorText.value = ''
  editing.value = true
}

function stopEditing() {
  resetDrafts()
  errorText.value = ''
  editing.value = false
}

function applyCandidate(candidate, memory = null) {
  Object.assign(current, candidate)
  resetDrafts()
  emit('changed', { candidate: { ...candidate }, memory })
}

async function saveEdit() {
  const content = contentDraft.value.trim()
  if (!content) {
    errorText.value = '记忆内容不能为空'
    return
  }
  pendingAction.value = 'edit'
  errorText.value = ''
  try {
    const result = await casesApi.updateMemoryCandidate(props.caseId, current.id, {
      title: titleDraft.value.trim(),
      content,
    })
    if (!result?.ok) throw new Error(result?.error || '保存失败')
    applyCandidate(result.data)
    editing.value = false
    toast('记忆建议已更新')
  } catch (error) {
    errorText.value = error.message || '保存失败'
  } finally {
    pendingAction.value = ''
  }
}

async function acceptCandidate() {
  pendingAction.value = 'accept'
  errorText.value = ''
  try {
    const result = await casesApi.acceptMemoryCandidate(props.caseId, current.id)
    if (!result?.ok) throw new Error(result?.error || '确认失败')
    applyCandidate(result.data.candidate, result.data.memory)
    toast('已记住这件事')
  } catch (error) {
    errorText.value = error.message || '确认失败'
  } finally {
    pendingAction.value = ''
  }
}

async function rejectCandidate() {
  pendingAction.value = 'reject'
  errorText.value = ''
  try {
    const result = await casesApi.rejectMemoryCandidate(props.caseId, current.id)
    if (!result?.ok) throw new Error(result?.error || '忽略失败')
    applyCandidate(result.data)
    toast('已忽略这条记忆建议')
  } catch (error) {
    errorText.value = error.message || '忽略失败'
  } finally {
    pendingAction.value = ''
  }
}
</script>

<template>
  <section class="memory-candidate" :class="`is-${current.status || 'pending'}`">
    <template v-if="current.status === 'accepted'">
      <div class="candidate-result">
        <span class="candidate-result-icon"><Check :size="14" stroke-width="2.5" /></span>
        <div>
          <div class="candidate-result-title">已记住</div>
          <p>{{ current.content }}</p>
        </div>
      </div>
    </template>

    <template v-else-if="current.status === 'rejected'">
      <div class="candidate-result is-muted">
        <span class="candidate-result-icon"><X :size="14" stroke-width="2.2" /></span>
        <div>
          <div class="candidate-result-title">已忽略这条建议</div>
          <p>{{ current.content }}</p>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="candidate-heading">
        <span class="candidate-mark"><BookmarkCheck :size="15" stroke-width="2" /></span>
        <span>建议记住</span>
      </div>

      <div v-if="editing" class="candidate-editor">
        <input
          v-model="titleDraft"
          maxlength="80"
          aria-label="记忆标题"
          placeholder="标题（可选）"
        />
        <textarea
          v-model="contentDraft"
          maxlength="500"
          rows="3"
          aria-label="记忆内容"
          placeholder="值得长期记住的内容"
        />
        <div class="candidate-editor-foot">
          <span>{{ contentDraft.length }}/500</span>
          <div class="candidate-actions">
            <button type="button" :disabled="isBusy" @click="stopEditing">
              <X :size="14" />取消
            </button>
            <button type="button" class="is-primary" :disabled="isBusy" @click="saveEdit">
              <LoaderCircle v-if="pendingAction === 'edit'" class="spin" :size="14" />
              <Save v-else :size="14" />保存
            </button>
          </div>
        </div>
      </div>

      <template v-else>
        <h4 v-if="current.title">{{ current.title }}</h4>
        <p class="candidate-content">{{ current.content }}</p>
        <div class="candidate-meta">
          <span>{{ TOPIC_LABELS[current.topic] || '关系' }}</span>
          <span>{{ TYPE_LABELS[current.type] || '长期规律' }}</span>
          <span v-if="evidenceCount">依据 {{ evidenceCount }} 条聊天</span>
        </div>
        <div class="candidate-actions">
          <button type="button" :disabled="isBusy" @click="rejectCandidate">
            <LoaderCircle v-if="pendingAction === 'reject'" class="spin" :size="14" />
            <X v-else :size="14" />忽略
          </button>
          <button type="button" :disabled="isBusy" @click="startEditing">
            <Pencil :size="14" />编辑
          </button>
          <button type="button" class="is-primary" :disabled="isBusy" @click="acceptCandidate">
            <LoaderCircle v-if="pendingAction === 'accept'" class="spin" :size="14" />
            <BookmarkCheck v-else :size="14" />记住
          </button>
        </div>
      </template>
    </template>

    <p v-if="errorText" class="candidate-error" role="alert">{{ errorText }}</p>
  </section>
</template>

<style scoped>
.memory-candidate {
  width: min(100%, 560px);
  margin-top: 14px;
  padding: 12px 14px;
  border: 1px solid rgba(139, 38, 67, 0.16);
  border-left: 3px solid #9f3655;
  border-radius: 7px;
  background: rgba(255, 249, 250, 0.82);
  color: #382a30;
  letter-spacing: 0;
}
.candidate-heading {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #7e203e;
  font-size: 13px;
  font-weight: 650;
}
.candidate-mark,
.candidate-result-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: none;
  border-radius: 50%;
  color: #8b2643;
  background: #fbe7ed;
}
h4 {
  margin: 8px 0 3px;
  color: #34252b;
  font-size: 14px;
  font-weight: 650;
}
.candidate-content,
.candidate-result p {
  margin: 7px 0 0;
  color: #514047;
  font-size: 14px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.candidate-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 9px;
}
.candidate-meta span {
  padding: 2px 7px;
  border: 1px solid rgba(139, 38, 67, 0.12);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.8);
  color: #816d75;
  font-size: 11px;
}
.candidate-actions {
  display: flex;
  justify-content: flex-end;
  gap: 5px;
  margin-top: 10px;
}
.candidate-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 30px;
  gap: 5px;
  padding: 5px 9px;
  border: 1px solid transparent;
  border-radius: 6px;
  color: #705d65;
  background: transparent;
  font-size: 12px;
  font-weight: 550;
  transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease;
}
.candidate-actions button:hover:not(:disabled) {
  border-color: #ead2da;
  background: #fff;
  color: #7e203e;
}
.candidate-actions button.is-primary {
  border-color: #8b2643;
  background: #8b2643;
  color: #fff;
}
.candidate-actions button.is-primary:hover:not(:disabled) { background: #711b35; }
.candidate-actions button:disabled { cursor: wait; opacity: 0.55; }
.candidate-editor { margin-top: 9px; }
.candidate-editor input,
.candidate-editor textarea {
  display: block;
  width: 100%;
  border: 1px solid #ead2da;
  border-radius: 6px;
  outline: none;
  background: #fff;
  color: #382a30;
  font-size: 13px;
}
.candidate-editor input { padding: 7px 9px; }
.candidate-editor textarea { margin-top: 7px; padding: 8px 9px; line-height: 1.55; resize: vertical; }
.candidate-editor input:focus,
.candidate-editor textarea:focus { border-color: #a84b68; box-shadow: 0 0 0 2px rgba(159, 54, 85, 0.08); }
.candidate-editor-foot {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  color: #a18c94;
  font-size: 11px;
}
.candidate-result { display: flex; align-items: flex-start; gap: 9px; }
.candidate-result-title { color: #5b6f50; font-size: 13px; font-weight: 650; }
.is-accepted { border-color: #d9e4d2; border-left-color: #708f60; background: #fbfdf9; }
.is-accepted .candidate-result-icon { color: #587647; background: #e8f1e3; }
.is-rejected { border-color: #e5e1e2; border-left-color: #b8afb2; background: #faf9f9; }
.candidate-result.is-muted .candidate-result-title,
.candidate-result.is-muted p { color: #8b8185; }
.candidate-result.is-muted .candidate-result-icon { color: #8b8185; background: #efeced; }
.candidate-error { margin: 8px 0 0; color: #be123c; font-size: 12px; }
.spin { animation: spin 800ms linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 520px) {
  .memory-candidate { padding: 11px 12px; }
  .candidate-actions { width: 100%; }
  .candidate-actions button { flex: 1; }
}
</style>
