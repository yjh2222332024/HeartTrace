<script setup>
defineProps({ settings: { type: Object, required: true } })
defineEmits(['close'])
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <div class="absolute inset-0 bg-black/25 backdrop-blur-[2px]" @click="$emit('close')"></div>
    <div class="relative w-[440px] max-w-[92vw] max-h-[86vh] overflow-y-auto rounded-3xl bg-white shadow-float-lg border border-sakura-100 p-6 animate-bubble-in">
      <h2 class="text-lg font-semibold text-gray-800 mb-4">设置</h2>

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

      <!-- LLM 配置（占位说明） -->
      <div class="space-y-3">
        <div class="text-sm font-medium text-gray-700">模型服务（暂由服务端 .env 提供）</div>
        <div>
          <label class="block text-xs text-gray-500 mb-1.5">API 地址</label>
          <input v-model="settings.apiBase" disabled placeholder="服务端 .env 的 BASE_URL"
            class="w-full rounded-xl border border-sakura-100 px-3.5 py-2.5 text-sm bg-gray-50 text-gray-400 cursor-not-allowed" />
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1.5">API Key</label>
          <input v-model="settings.apiKey" type="password" disabled placeholder="服务端 .env 的 API_KEY"
            class="w-full rounded-xl border border-sakura-100 px-3.5 py-2.5 text-sm bg-gray-50 text-gray-400 cursor-not-allowed" />
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1.5">模型</label>
          <input v-model="settings.model" disabled placeholder="服务端 .env 的 BASE_MODEL"
            class="w-full rounded-xl border border-sakura-100 px-3.5 py-2.5 text-sm bg-gray-50 text-gray-400 cursor-not-allowed" />
        </div>
      </div>

      <p class="text-xs text-gray-400 mt-4 leading-relaxed">QCE 配置保存在本地浏览器，仅传给本机 love-advisor 后端。</p>

      <button class="w-full mt-5 rounded-xl bg-sakura-500 text-white text-sm py-2.5 hover:bg-sakura-600 active:scale-[0.98] transition-all shadow-float"
        @click="$emit('close')">
        保存
      </button>
    </div>
  </div>
</template>
