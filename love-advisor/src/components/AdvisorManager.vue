<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { Pencil, RotateCcw, Save, X } from 'lucide-vue-next'
import logo from '../assets/logo.png'
import AdvisorImportModal from './AdvisorImportModal.vue'

const emit = defineEmits(['back'])
const advisors = ref([])
const loading = ref(true)
const error = ref('')
const search = ref('')
const preferencesOpen = ref(false)
const showImport = ref(false)
const defaultPromptCustomized = ref(false)
const promptEditor = ref(null)
const promptDraft = ref('')
const promptLoading = ref(false)
const promptSaving = ref(false)
const promptError = ref('')
const fields = { summary: '角色简介', strengths: '擅长领域', limitations: '能力边界', style: '表达风格', source: '资料来源' }
const visible = ref(Object.keys(fields))
try {
  const saved = JSON.parse(localStorage.getItem('advisor-card-fields') || 'null')
  if (Array.isArray(saved)) visible.value = saved.filter(key => key in fields)
} catch { /* Use default display fields. */ }
watch(visible, value => { try { localStorage.setItem('advisor-card-fields', JSON.stringify(value)) } catch {} }, { deep: true })
const defaultAdvisor = computed(() => ({
  id: 'default',
  name: '默认情感军师',
  description: '未指定专属军师时使用的通用情感顾问。',
  promptCustomized: defaultPromptCustomized.value,
  presentation: {
    summary: '负责日常关系分析、情绪梳理与下一步建议。',
    strengths: ['关系分析', '沟通建议', '行动规划'],
    limitations: ['不替代心理咨询或专业支持'],
    style: '清晰、克制、先判断再给建议',
    source: '系统内置',
  },
}))
const allAdvisors = computed(() => [defaultAdvisor.value, ...advisors.value])
const filtered = computed(() => allAdvisors.value.filter(a => `${a.name} ${a.presentation?.summary || a.description}`.toLowerCase().includes(search.value.trim().toLowerCase())))

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = await fetch('/api/skills')
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || '加载失败')
    advisors.value = data.data.items
    const defaultRes = await fetch('/api/advisor-prompts/default')
    const defaultData = await defaultRes.json()
    if (defaultRes.ok && defaultData.ok) defaultPromptCustomized.value = !!defaultData.data.customized
  } catch (e) { error.value = e.message }
  finally { loading.value = false }
}

async function editPrompt(advisor) {
  promptEditor.value = advisor
  promptDraft.value = ''
  promptError.value = ''
  promptLoading.value = true
  try {
    const res = await fetch(`/api/advisor-prompts/${encodeURIComponent(advisor.id)}`)
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || '加载提示词失败')
    promptDraft.value = data.data.prompt
    promptEditor.value = { ...advisor, customized: !!data.data.customized }
  } catch (e) {
    promptError.value = e.message
  } finally {
    promptLoading.value = false
  }
}

function updateCustomized(id, value) {
  if (id === 'default') defaultPromptCustomized.value = value
  else {
    const advisor = advisors.value.find(item => item.id === id)
    if (advisor) advisor.promptCustomized = value
  }
}

async function savePrompt() {
  if (!promptEditor.value || promptSaving.value) return
  promptSaving.value = true
  promptError.value = ''
  try {
    const res = await fetch(`/api/advisor-prompts/${encodeURIComponent(promptEditor.value.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: promptDraft.value }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || '保存失败')
    updateCustomized(promptEditor.value.id, true)
    promptEditor.value = null
  } catch (e) {
    promptError.value = e.message
  } finally {
    promptSaving.value = false
  }
}

async function resetPrompt() {
  if (!promptEditor.value || promptSaving.value) return
  promptSaving.value = true
  promptError.value = ''
  try {
    const res = await fetch(`/api/advisor-prompts/${encodeURIComponent(promptEditor.value.id)}`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || '恢复失败')
    promptDraft.value = data.data.prompt
    promptEditor.value = { ...promptEditor.value, customized: false }
    updateCustomized(promptEditor.value.id, false)
  } catch (e) {
    promptError.value = e.message
  } finally {
    promptSaving.value = false
  }
}
onMounted(load)
</script>

<template>
  <section class="advisor-manager">
    <header class="manager-heading">
      <div><h1>军师管理</h1><span>{{ allAdvisors.length }} 位军师</span></div>
      <div class="header-actions">
        <button class="create-btn" @click="showImport = true">导入军师包</button>
        <button class="back" @click="emit('back')">返回对话</button>
      </div>
    </header>
    <div class="manager-toolbar">
      <input v-model="search" type="search" placeholder="搜索军师" aria-label="搜索军师" />
      <button :aria-expanded="preferencesOpen" @click="preferencesOpen = !preferencesOpen">显示项</button>
      <button :disabled="loading" @click="load">刷新列表</button>
    </div>
    <div v-if="preferencesOpen" class="display-options">
      <label v-for="(label, key) in fields" :key="key"><input v-model="visible" type="checkbox" :value="key" />{{ label }}</label>
    </div>
    <p v-if="error" role="alert">{{ error }} <button @click="load">重试</button></p>
    <p v-else-if="loading" class="empty">正在加载军师…</p>
    <p v-else-if="!filtered.length" class="empty">{{ search ? '没有匹配的军师' : '暂无军师' }}</p>
    <TransitionGroup v-else name="content-reveal" tag="div" class="advisor-grid">
      <article v-for="advisor in filtered" :key="advisor.id" class="advisor-card">
        <div class="card-heading">
          <img :src="logo" alt="" />
          <div class="card-title-wrap">
            <h2>{{ advisor.name }}</h2>
            <span class="status">{{ advisor.promptCustomized ? '提示词已自定义' : '可用' }}</span>
          </div>
          <button class="edit-prompt-btn" :aria-label="`编辑 ${advisor.name} 的 system prompt`" :title="`编辑 ${advisor.name} 的 system prompt`" @click="editPrompt(advisor)">
            <Pencil :size="16" />
          </button>
        </div>
        <template v-for="(label, key) in fields" :key="key">
          <div v-if="visible.includes(key) && advisor.presentation?.[key]?.length" class="card-field">
            <h3>{{ label }}</h3>
            <ul v-if="Array.isArray(advisor.presentation[key])"><li v-for="item in advisor.presentation[key]" :key="item">{{ item }}</li></ul>
            <p v-else>{{ advisor.presentation[key] }}</p>
          </div>
        </template>
      </article>
    </TransitionGroup>

    <Transition name="modal-reveal">
      <div v-if="promptEditor" class="prompt-modal-mask" @click.self="promptEditor = null">
        <section class="prompt-modal" role="dialog" aria-modal="true" :aria-label="`编辑 ${promptEditor.name} 的 system prompt`">
        <header>
          <div>
            <span>System Prompt</span>
            <h2>{{ promptEditor.name }}</h2>
          </div>
          <button class="icon-btn" aria-label="关闭" title="关闭" @click="promptEditor = null"><X :size="19" /></button>
        </header>
        <div v-if="promptLoading" class="prompt-loading">正在加载…</div>
        <template v-else>
          <textarea v-model="promptDraft" maxlength="12000" spellcheck="false" aria-label="System prompt 内容"></textarea>
          <p v-if="promptError" class="prompt-error" role="alert">{{ promptError }}</p>
          <footer>
            <button class="reset-btn" :disabled="promptSaving" @click="resetPrompt"><RotateCcw :size="16" />恢复默认</button>
            <button class="save-btn" :disabled="promptSaving || !promptDraft.trim()" @click="savePrompt"><Save :size="16" />{{ promptSaving ? '保存中…' : '保存' }}</button>
          </footer>
        </template>
        </section>
      </div>
    </Transition>

    <AdvisorImportModal
      :open="showImport"
      @close="showImport = false"
      @imported="load"
    />
  </section>
</template>

<style scoped>
.advisor-manager { min-height: 100%; padding: 36px; background: #fafafb; color: #343c46; }
.manager-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.header-actions { display: flex; align-items: center; gap: 10px; }
h1 { font-size: 24px; font-weight: 650; margin: 0 0 6px; }
.manager-heading span { font-size: 13px; color: #75808b; }
button { border: 1px solid #ddc8d1; border-radius: 8px; padding: 10px 16px; background: #f3e7ed; color: #85344f; font-size: 15px; font-weight: 600; cursor: pointer; }
button:hover { background: #f4edf1; }
.create-btn { background: #85344f; color: white; border-color: #85344f; }
.create-btn:hover { background: #6b283e; }
.manager-toolbar { display: flex; gap: 8px; flex-wrap: wrap; padding: 24px 0 16px; border-bottom: 1px solid #e5e5e9; }
.manager-toolbar > input { flex: 1; min-width: 140px; padding: 8px 12px; border: 1px solid #dddfe4; border-radius: 6px; background: white; }
.display-options { display: flex; flex-wrap: wrap; gap: 16px; padding: 16px 0; border-bottom: 1px solid #e5e5e9; }
.display-options label { display: flex; gap: 6px; align-items: center; font-size: 13px; }
input[type=checkbox] { accent-color: #bf4f76; }
.advisor-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 420px)); gap: 20px; padding-top: 24px; }
.advisor-card { background: white; border: 1px solid #e3e1e7; border-radius: 8px; padding: 24px; overflow-wrap: anywhere; }
.card-heading { display: flex; align-items: center; gap: 12px; }
.card-title-wrap { flex: 1; min-width: 0; }
.card-heading img { width: 52px; height: 52px; border-radius: 8px; flex-shrink: 0; }
.edit-prompt-btn, .icon-btn { width: 36px; height: 36px; padding: 0; display: grid; place-items: center; flex-shrink: 0; background: #fff; }
.edit-prompt-btn:hover, .icon-btn:hover { border-color: #bd8298; color: #762b46; background: #fff6f8; }
h2 { font-size: 17px; font-weight: 650; margin: 0 0 5px; }
.status { color: #287a63; font-size: 12px; }
.card-field { margin-top: 20px; }
h3 { font-size: 12px; color: #85808b; margin: 0 0 7px; }
p, li { font-size: 15px; line-height: 1.8; }
ul { padding-left: 18px; list-style: disc; }
.empty { padding: 32px 0; color: #85808b; }
.prompt-modal-mask { position: fixed; inset: 0; z-index: 120; display: grid; place-items: center; padding: 20px; background: rgba(34, 22, 28, 0.42); backdrop-filter: blur(5px); }
.prompt-modal { width: min(720px, 100%); max-height: min(760px, calc(100vh - 40px)); display: flex; flex-direction: column; gap: 16px; padding: 22px; border: 1px solid #decbd3; border-radius: 8px; background: #fff; box-shadow: 0 24px 60px rgba(48, 24, 35, 0.22); }
.prompt-modal header, .prompt-modal footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.prompt-modal header span { color: #9a6a7b; font-size: 11px; font-weight: 700; text-transform: uppercase; }
.prompt-modal header h2 { margin-top: 3px; }
.prompt-modal textarea { width: 100%; min-height: 360px; max-height: 58vh; resize: vertical; padding: 14px 16px; border: 1px solid #dcd7dc; border-radius: 7px; background: #fcfbfc; color: #2f333b; font: 13px/1.7 ui-monospace, SFMono-Regular, Consolas, monospace; outline: none; }
.prompt-modal textarea:focus { border-color: #aa5b78; box-shadow: 0 0 0 3px rgba(170, 91, 120, 0.1); background: #fff; }
.prompt-loading { min-height: 360px; display: grid; place-items: center; color: #85808b; }
.prompt-error { margin: -6px 0 0; color: #b4233f; font-size: 13px; }
.prompt-modal footer { justify-content: flex-end; }
.prompt-modal footer button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
.reset-btn { margin-right: auto; background: #fff; color: #6f6870; border-color: #ddd7dc; }
.save-btn { min-width: 104px; background: #85344f; color: #fff; border-color: #85344f; }
.save-btn:hover { background: #6b283e; }
button:disabled { opacity: .5; cursor: not-allowed; }
@media(max-width:820px) { .advisor-manager { padding: 76px 16px 24px; } .advisor-card { padding: 20px; } }
</style>
