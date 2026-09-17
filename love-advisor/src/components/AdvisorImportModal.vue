<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import { Archive, CheckCircle2, FileCode2, FileUp, ShieldCheck, X } from 'lucide-vue-next'

const props = defineProps({ open: { type: Boolean, default: false } })
const emit = defineEmits(['close', 'imported'])

const inputRef = ref(null)
const selectedFile = ref(null)
const inspecting = ref(false)
const installing = ref(false)
const result = ref(null)
const error = ref('')
const installed = ref(null)

const fileLabel = computed(() => selectedFile.value ? `${selectedFile.value.name} · ${formatBytes(selectedFile.value.size)}` : '选择 .zip 军师包')

function formatBytes(value) {
  if (!Number.isFinite(value)) return ''
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function chooseFile() {
  inputRef.value?.click()
}

function onInput(event) {
  acceptFile(event.target.files?.[0])
  event.target.value = ''
}

function onDrop(event) {
  acceptFile(event.dataTransfer?.files?.[0])
}

function acceptFile(file) {
  if (!file) return
  discardPending()
  error.value = ''
  result.value = null
  installed.value = null
  if (!file.name.toLowerCase().endsWith('.zip')) {
    selectedFile.value = null
    error.value = '请选择 .zip 格式的军师包'
    return
  }
  if (file.size > 30 * 1024 * 1024) {
    selectedFile.value = null
    error.value = '军师包不能超过 30MB'
    return
  }
  selectedFile.value = file
  inspectPackage()
}

async function inspectPackage() {
  if (!selectedFile.value || inspecting.value) return
  inspecting.value = true
  error.value = ''
  result.value = null
  try {
    const form = new FormData()
    form.append('file', selectedFile.value)
    const res = await fetch('/api/advisor-imports/inspect', { method: 'POST', body: form })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || '军师包检查失败')
    result.value = data.data
  } catch (cause) {
    error.value = cause.message || '军师包检查失败'
  } finally {
    inspecting.value = false
  }
}

async function installPackage() {
  if (!result.value?.token || installing.value) return
  installing.value = true
  error.value = ''
  try {
    const res = await fetch(`/api/advisor-imports/${encodeURIComponent(result.value.token)}/install`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || '导入失败')
    installed.value = data.data
    emit('imported', data.data)
  } catch (cause) {
    error.value = cause.message || '导入失败'
  } finally {
    installing.value = false
  }
}

function discardPending() {
  if (result.value?.token && !installed.value) {
    fetch(`/api/advisor-imports/${encodeURIComponent(result.value.token)}`, { method: 'DELETE' }).catch(() => {})
  }
}

function handleClose() {
  discardPending()
  selectedFile.value = null
  result.value = null
  error.value = ''
  installed.value = null
  emit('close')
}

onBeforeUnmount(discardPending)
</script>

<template>
  <Transition name="modal-reveal">
    <div v-if="open" class="import-mask" @click.self="handleClose" @dragover.prevent @drop.prevent="onDrop">
      <section class="import-dialog" role="dialog" aria-modal="true" aria-labelledby="advisor-import-title">
        <header>
          <div>
            <span>本地导入</span>
            <h2 id="advisor-import-title">导入军师包</h2>
          </div>
          <button class="icon-button" aria-label="关闭" title="关闭" @click="handleClose"><X :size="19" /></button>
        </header>

        <template v-if="installed">
          <main class="import-success">
            <CheckCircle2 :size="42" stroke-width="1.6" />
            <h3>{{ installed.name }} 已导入</h3>
            <p>军师已安装到本地目录，现在可以在对话中选择使用。</p>
          </main>
          <footer><button class="primary-button" @click="handleClose">完成</button></footer>
        </template>

        <template v-else>
          <main>
            <button class="drop-zone" type="button" :disabled="inspecting" @click="chooseFile">
              <input ref="inputRef" type="file" accept=".zip,application/zip,application/x-zip-compressed" @change="onInput" />
              <Archive :size="30" stroke-width="1.5" />
              <strong>{{ inspecting ? '正在检查压缩包…' : fileLabel }}</strong>
              <small>{{ selectedFile ? '正在本机验证目录结构与引用关系' : '点击选择，或将 ZIP 拖到这里' }}</small>
            </button>

            <div class="import-rules">
              <ShieldCheck :size="17" />
              <span>包内必须有一个与 <code>manifest.id</code> 同名的根目录，并包含 <code>manifest.json</code> 与 <code>SKILL.md</code>。</span>
            </div>

            <section v-if="result" class="package-preview" aria-live="polite">
              <div class="preview-head">
                <div>
                  <span class="pass-label">结构校验通过</span>
                  <h3>{{ result.name }}</h3>
                  <p>{{ result.description || '未填写军师简介' }}</p>
                </div>
                <code>{{ result.id }}</code>
              </div>
              <dl>
                <div><dt>内容</dt><dd>{{ result.fileCount }} 个文件 · {{ result.documentCount }} 份文档 · {{ formatBytes(result.totalBytes) }}</dd></div>
                <div><dt>入口</dt><dd>SKILL.md 与 {{ result.referencedFiles.length - 1 }} 份路由资料已校验</dd></div>
                <div><dt>脚本</dt><dd>{{ result.scriptCount ? `含 ${result.scriptCount} 个脚本，仅随包保留，不会被系统执行` : '没有脚本文件' }}</dd></div>
              </dl>
              <div v-if="result.scriptPaths.length" class="script-list"><FileCode2 :size="15" /><code v-for="item in result.scriptPaths" :key="item">{{ item }}</code></div>
            </section>

            <p v-if="error" class="import-error" role="alert">{{ error }}</p>
          </main>
          <footer>
            <button class="secondary-button" :disabled="inspecting || installing" @click="handleClose">取消</button>
            <button class="primary-button" :disabled="!result || inspecting || installing" @click="installPackage">
              <FileUp :size="16" />{{ installing ? '正在导入…' : '确认导入' }}
            </button>
          </footer>
        </template>
      </section>
    </div>
  </Transition>
</template>

<style scoped>
.import-mask { position: fixed; inset: 0; z-index: 120; display: grid; place-items: center; padding: 20px; background: rgba(34, 22, 28, .42); backdrop-filter: blur(5px); }
.import-dialog { width: min(650px, 100%); max-height: min(760px, calc(100vh - 40px)); display: flex; flex-direction: column; overflow: auto; border: 1px solid #decbd3; border-radius: 8px; background: #fff; box-shadow: 0 24px 60px rgba(48, 24, 35, .22); }
.import-dialog > header, .import-dialog > footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 18px 22px; background: #fcfbfc; }.import-dialog > header { border-bottom: 1px solid #eee6e9; }.import-dialog > footer { justify-content: flex-end; border-top: 1px solid #eee6e9; }.import-dialog main { display: grid; gap: 16px; padding: 22px; }
.import-dialog header span { color: #9a6a7b; font-size: 11px; font-weight: 700; }.import-dialog h2 { margin: 3px 0 0; color: #343c46; font-size: 19px; font-weight: 650; }.icon-button { display: grid; width: 34px; height: 34px; place-items: center; padding: 0; border: 1px solid #ddc8d1; border-radius: 6px; color: #85344f; background: #fff; cursor: pointer; }.icon-button:hover { border-color: #bd8298; background: #fff6f8; }
.drop-zone { display: grid; min-height: 158px; place-items: center; align-content: center; gap: 7px; padding: 20px; border: 1px dashed #c692a4; border-radius: 8px; color: #7d3450; background: #fffafb; cursor: pointer; text-align: center; }.drop-zone:hover:not(:disabled) { border-color: #85344f; background: #fff6f8; }.drop-zone:disabled { opacity: .7; cursor: wait; }.drop-zone input { display: none; }.drop-zone strong { color: #4b3340; font-size: 14px; }.drop-zone small { color: #806b73; font-size: 12px; }
.import-rules { display: flex; gap: 9px; align-items: flex-start; padding: 10px 12px; border-left: 3px solid #c78144; border-radius: 5px; color: #715746; background: #fff8ed; font-size: 12px; line-height: 1.6; }.import-rules svg { flex: 0 0 auto; margin-top: 1px; color: #a85f21; }.import-rules code, .script-list code, .preview-head > code { font: 11px ui-monospace, SFMono-Regular, Consolas, monospace; }
.package-preview { display: grid; gap: 14px; padding: 16px; border: 1px solid #cbe4d8; border-radius: 8px; background: #fcfffd; }.preview-head { display: flex; justify-content: space-between; gap: 14px; }.pass-label { color: #277757; font-size: 11px; font-weight: 700; }.preview-head h3 { margin: 4px 0; color: #34443d; font-size: 16px; }.preview-head p { max-width: 430px; margin: 0; color: #64736b; font-size: 12px; line-height: 1.55; }.preview-head > code { align-self: start; padding: 4px 6px; border-radius: 4px; color: #347058; background: #edf8f1; white-space: nowrap; }.package-preview dl { display: grid; gap: 7px; margin: 0; }.package-preview dl div { display: grid; grid-template-columns: 48px 1fr; gap: 10px; font-size: 12px; line-height: 1.5; }.package-preview dt { color: #769183; }.package-preview dd { margin: 0; color: #40584c; }.script-list { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; color: #63776c; }.script-list code { padding: 2px 4px; border-radius: 3px; color: #5e4763; background: #f5f0f5; }
.import-error { margin: 0; color: #b4233f; font-size: 13px; line-height: 1.5; }.primary-button, .secondary-button { display: inline-flex; min-width: 92px; align-items: center; justify-content: center; gap: 7px; padding: 9px 14px; border: 1px solid #85344f; border-radius: 6px; color: #fff; background: #85344f; font-size: 13px; font-weight: 650; cursor: pointer; }.primary-button:hover:not(:disabled) { background: #6b283e; }.secondary-button { color: #625c63; border-color: #ddd7dc; background: #fff; }.secondary-button:hover:not(:disabled) { background: #f8f6f7; }.primary-button:disabled, .secondary-button:disabled { opacity: .5; cursor: not-allowed; }
.import-success { min-height: 260px; place-items: center; align-content: center; text-align: center; color: #39745b; }.import-success h3 { margin: 12px 0 5px; color: #34443d; font-size: 18px; }.import-success p { max-width: 380px; margin: 0; color: #637169; font-size: 13px; line-height: 1.6; }
@media (max-width: 560px) { .import-mask { padding: 12px; }.import-dialog > header, .import-dialog > footer, .import-dialog main { padding-inline: 16px; }.preview-head { display: grid; }.preview-head > code { justify-self: start; }.package-preview dl div { grid-template-columns: 42px 1fr; } }
</style>
