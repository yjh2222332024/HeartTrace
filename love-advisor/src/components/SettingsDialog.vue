<script setup>
// ── 设置：QCE 直连（浏览器本地保存）+ LLM 服务（服务端持久化，即时生效）──
import { ref, reactive, onMounted, inject } from 'vue'

defineProps({ settings: { type: Object, required: true } })
const emit = defineEmits(['close'])
const toast = inject('toast', () => {})

const llm = reactive({ BASE_URL: '', API_KEY: '', BASE_MODEL: '', MAX_TOOL_ROUNDS: 12 })
const saving = ref(false)

onMounted(async () => {
  try {
    const j = await fetch('/api/settings').then(r => r.json())
    if (j.ok) Object.assign(llm, {
      BASE_URL: j.data.BASE_URL || '', API_KEY: j.data.API_KEY || '', BASE_MODEL: j.data.BASE_MODEL || '',
      MAX_TOOL_ROUNDS: j.data.MAX_TOOL_ROUNDS ?? 12,
    })
  } catch { /* 后端未启动时保持占位 */ }
})

async function save() {
  if (saving.value) return
  saving.value = true
  try {
    const j = await fetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...llm }),
    }).then(r => r.json())
    if (!j.ok) return toast(j.error || '模型配置保存失败')
    toast('设置已保存，立即生效')
    emit('close')
  } catch { toast('后端未启动') } finally { saving.value = false }
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <div class="absolute inset-0 bg-black/25 backdrop-blur-[2px]" @click="$emit('close')"></div>
    <div class="relative w-[440px] max-w-[92vw] max-h-[86vh] overflow-y-auto rounded-3xl bg-white shadow-float-lg border border-sakura-100 p-6 animate-bubble-in">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold text-stone-900">设置与模型配置</h2>
        <button class="ui-btn-pill" @click="emit('close')">关闭</button>
      </div>

      <!-- QCE 直连配置 -->
      <div class="space-y-3 rounded-2xl border border-sakura-100 bg-sakura-50/40 p-4 mb-5">
        <div class="text-sm font-medium text-gray-700">QQ Chat Exporter 直连</div>
        <div>
          <label class="block text-xs text-gray-500 mb-1.5">QCE 服务地址</label>
          <input v-model="settings.qceBase" placeholder="http://localhost:40653"
            class="w-full rounded-xl border border-sakura-100 focus:border-sakura-300 outline-none px-3.5 py-2.5 text-sm bg-white transition-colors" />
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1.5">QCE 访问令牌（Token）</label>
          <input v-model="settings.qceToken" type="password" placeholder="QCE 控制台日志 / security.json 中获取"
            class="w-full rounded-xl border border-sakura-100 focus:border-sakura-300 outline-none px-3.5 py-2.5 text-sm bg-white transition-colors" />
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1.5">QCE 程序路径（用于「自动启动」，可选）</label>
          <input v-model="settings.qcePath" placeholder="默认自动探测：%LOCALAPPDATA%\QQChatExporter\QQ Chat Exporter.exe"
            class="w-full rounded-xl border border-sakura-100 focus:border-sakura-300 outline-none px-3.5 py-2.5 text-sm bg-white transition-colors" />
        </div>
        <p class="text-[11px] text-gray-400 leading-relaxed">用于「导入 → QQ 直连」自动拉取会话列表、自动启动 QCE 与导出记录。留空则默认 localhost:40653、自动探测安装位置。</p>
      </div>

      <!-- LLM 配置（服务端持久化，即时生效） -->
      <div class="space-y-3">
        <div class="text-sm font-medium text-gray-700">模型服务</div>
        <div>
          <label class="block text-xs text-gray-500 mb-1.5">API 地址</label>
          <input v-model="llm.BASE_URL" placeholder="https://api.example.com/v1"
            class="w-full rounded-xl border border-sakura-100 focus:border-sakura-300 outline-none px-3.5 py-2.5 text-sm bg-white transition-colors" />
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1.5">API Key</label>
          <input v-model="llm.API_KEY" type="password" placeholder="sk-…（本地网关可留空）"
            class="w-full rounded-xl border border-sakura-100 focus:border-sakura-300 outline-none px-3.5 py-2.5 text-sm bg-white transition-colors" />
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1.5">模型</label>
          <input v-model="llm.BASE_MODEL" placeholder="模型名，如 gpt-4o-mini"
            class="w-full rounded-xl border border-sakura-100 focus:border-sakura-300 outline-none px-3.5 py-2.5 text-sm bg-white transition-colors" />
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1.5">最大工具取证轮数（MAX）</label>
          <input v-model.number="llm.MAX_TOOL_ROUNDS" type="number" min="1" max="30" placeholder="12"
            class="w-full rounded-xl border border-sakura-100 focus:border-sakura-300 outline-none px-3.5 py-2.5 text-sm bg-white transition-colors" />
        </div>
        <p class="text-[11px] text-gray-400 leading-relaxed">保存在服务端本机（server/.data/settings.json），对话与聊天记录分析共用同一份配置，保存后立即生效，优先于根目录 .env。</p>
      </div>

      <button :disabled="saving"
        class="w-full mt-5 rounded-xl bg-rose-800 text-white text-sm font-medium py-2.5 hover:bg-rose-900 active:scale-[0.98] transition-all shadow-sm disabled:opacity-50 cursor-pointer"
        @click="save">
        {{ saving ? '保存中…' : '保存设置' }}
      </button>
    </div>
  </div>
</template>
