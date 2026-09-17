<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'

const props = defineProps({ settings: { type: Object, required: true } })
const emit = defineEmits(['close', 'imported', 'update-settings'])

const tab = ref('qq') // 'qq' | 'file'

// ── 公共 ─────────────────────────────────────────────
const error = ref('')
const busy = ref(false)

function qceHeaders() {
  const s = props.settings
  const h = {}
  if (s.qceBase) h['X-QCE-Base'] = s.qceBase
  if (s.qceToken) h['X-QCE-Token'] = s.qceToken
  if (s.qcePath) h['X-QCE-Path'] = s.qcePath
  return h
}
function saveQceSettings(patch) {
  emit('update-settings', patch)
}

// ── Tab 1: QQ 直连 ───────────────────────────────────
const phase = ref('checking') // checking | offline | starting | unauth | ready | exporting | importing | done
const statusData = ref(null)
const tokenDraft = ref('')
const confirmLaunch = ref(false)
const launchStartTime = ref(0)
const peers = ref([])          // 好友/群列表
const peerTab = ref('friends') // 只允许一对一好友
const search = ref('')
const selected = ref(null)
const taskProgress = ref(0)
const taskMsgCount = ref(0)
const done = ref(null)
let pollTimer = null

function applyStatus(d) {
  statusData.value = d
  if (!d.online) { phase.value = 'offline'; return false }
  if (!d.authenticated) { phase.value = 'unauth'; return true }
  phase.value = 'ready'
  loadPeers()
  return true
}

async function checkStatus() {
  phase.value = 'checking'
  error.value = ''
  try {
    const res = await fetch('/api/qq/status', { headers: qceHeaders() })
    const j = await res.json()
    applyStatus(j.data)
  } catch (e) {
    phase.value = 'offline'
    error.value = '无法连接 love-advisor 后端: ' + e.message
  }
}

// 自动启动 QCE：spawn 后轮询上线（90s 超时），上线后走 token/列表流程
async function launchQce() {
  confirmLaunch.value = false
  phase.value = 'starting'
  error.value = ''
  launchStartTime.value = Date.now()
  try {
    const res = await fetch('/api/qq/launch', { method: 'POST', headers: qceHeaders() })
    const j = await res.json()
    if (!j.ok) throw new Error(j.error || '启动失败')
    while (Date.now() - launchStartTime.value < 300000) {
      await new Promise(r => setTimeout(r, 2000))
      if (phase.value !== 'starting') return // 用户已取消等待
      const s = await fetch('/api/qq/status', { headers: qceHeaders() }).then(r => r.json())
      if (applyStatus(s.data)) return
    }
    throw new Error('等待 QCE 上线超时（5 分钟）。请在 QCE 窗口完成 QQ 扫码登录后，点「重新检测」。')
  } catch (e) {
    error.value = e.message
    phase.value = 'offline'
  }
}

async function saveToken() {
  if (!tokenDraft.value.trim()) return
  saveQceSettings({ qceToken: tokenDraft.value.trim() })
  tokenDraft.value = ''
  checkStatus()
}

async function loadPeers() {
  try {
    const f = await fetch('/api/qq/friends', { headers: qceHeaders() }).then(r => r.json())
    const fr = Array.isArray(f.data) ? f.data : (f.data?.friends || f.data?.list || [])
    friends.value = fr.map(x => ({
      uid: String(x.uid || x.userUid || x.peerUid || x.uin || ''),
      name: x.nick || x.nickname || x.remark || x.name || x.userNick || String(x.uin || '未知好友'),
      sub: x.uin || x.QID || x.uid || '',
    })).filter(x => x.uid)
    if (!friends.value.length && f.error) {
      error.value = '获取好友列表失败: ' + f.error
    }
  } catch (e) {
    error.value = '获取会话列表失败: ' + e.message
  }
}
const friends = ref([])

const peerList = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return friends.value
  return friends.value.filter(p => p.name.toLowerCase().includes(q) || p.uid.toLowerCase().includes(q))
})

function pickPeer(p) {
  selected.value = p
}

async function exportAndImport() {
  if (!selected.value) return
  busy.value = true
  error.value = ''
  phase.value = 'exporting'
  taskProgress.value = 0
  try {
    if (peerTab.value === 'groups') throw new Error('群聊不能导入为恋爱工作区')
    const chatType = 1
    const res = await fetch('/api/qq/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...qceHeaders() },
      body: JSON.stringify({
        chatType,
        peerUid: selected.value.uid,
        sessionName: selected.value.name,
      }),
    })
    const j = await res.json()
    if (!j.ok) throw new Error(j.error || '创建导出任务失败')
    const taskId = j.data.taskId
    const downloadUrl = j.data.downloadUrl
    const fileName = j.data.fileName
    await pollTask(taskId, downloadUrl, fileName)
  } catch (e) {
    error.value = e.message
    phase.value = 'ready'
  } finally {
    busy.value = false
  }
}

function pollTask(taskId, downloadUrl, fileName) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = async () => {
      try {
        const res = await fetch(`/api/qq/tasks/${encodeURIComponent(taskId)}`, { headers: qceHeaders() })
        const j = await res.json()
        const t = j.data || {}
        taskProgress.value = Number(t.progress) || 0
        taskMsgCount.value = Number(t.messageCount) || 0
        const st = String(t.status || 'running').toLowerCase()
        if (/fail|error|cancel/.test(st)) {
          return reject(new Error('导出任务失败: ' + (t.error || st)))
        }
        if (/complete|success|finish/.test(st)) {
          return resolve({ downloadUrl: t.downloadUrl || downloadUrl, fileName: t.fileName || fileName })
        }
        if (Date.now() - started > 10 * 60 * 1000) {
          return reject(new Error('导出超时（10 分钟），请到 QCE 界面查看任务状态'))
        }
        pollTimer = setTimeout(tick, 1500)
      } catch (e) {
        reject(e)
      }
    }
    tick()
  }).then(({ downloadUrl: du, fileName: fn }) => doImport(du, fn))
}

async function doImport(downloadUrl, fileName) {
  phase.value = 'importing'
  try {
    const res = await fetch('/api/qq/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...qceHeaders() },
      body: JSON.stringify({ downloadUrl, fileName }),
    })
    const j = await res.json()
    if (!j.ok) throw new Error(j.error || '导入 ChatLab 失败')
    done.value = j.data
    phase.value = 'done'
    emit('imported', j.data)
  } catch (e) {
    error.value = e.message
    phase.value = 'ready'
  }
}

function openQcePage() {
  window.open((statusData.value?.base || 'http://localhost:40653') + '/qce', '_blank')
}

onMounted(() => { if (tab.value === 'qq') checkStatus() })
onUnmounted(() => { if (pollTimer) clearTimeout(pollTimer) })
function switchTab(t) {
  tab.value = t
  if (t === 'qq' && phase.value === 'checking') checkStatus()
}

// ── Tab 2: 文件上传 ───────────────────────────────────
const file = ref(null)
const preview = ref(null)
const fileDone = ref(null)
const fileBusy = ref('') // '' | 'dry' | 'import'

function onFileChange(e) {
  file.value = e.target.files[0] || null
  preview.value = null
  fileDone.value = null
  error.value = ''
  e.target.value = '' // 允许重复选择同一个文件
  if (file.value) dryRun() // 选完自动预览
}

async function dryRun() {
  if (!file.value) return
  fileBusy.value = 'dry'
  error.value = ''
  try {
    const fd = new FormData()
    fd.append('file', file.value)
    const res = await fetch('/api/import/dry-run', { method: 'POST', body: fd })
    const j = await res.json()
    if (!j.ok) throw new Error(j.error || '预览失败')
    if (j.data.type && j.data.type !== 'private') {
      throw new Error(`「${j.data.name || file.value.name}」是群聊。心迹只分析一对一私聊。`)
    }
    preview.value = j.data
  } catch (e) {
    error.value = e.message
  } finally {
    fileBusy.value = ''
  }
}

async function confirmImport() {
  if (!file.value || !preview.value) return
  fileBusy.value = 'import'
  error.value = ''
  try {
    const fd = new FormData()
    fd.append('file', file.value)
    const res = await fetch('/api/import', { method: 'POST', body: fd })
    const j = await res.json()
    if (!j.ok) throw new Error(j.error || '导入失败')
    // 回查会话列表，取友好名称与消息总数
    let friendly = null
    try {
      const s = await fetch('/api/sessions').then(r => r.json())
      if (s.ok) friendly = s.data.items.find(x => x.id === j.data.sessionId) || null
    } catch { /* 回查失败不影响导入结果 */ }
    fileDone.value = {
      ...j.data,
      name: friendly?.name || j.data.name,
      totalMessages: friendly?.totalMessages ?? j.data.totalMessages,
      platform: friendly?.platform || 'qq',
    }
    emit('imported', fileDone.value)
  } catch (e) {
    error.value = e.message
  } finally {
    fileBusy.value = ''
  }
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <div class="absolute inset-0 bg-black/25 backdrop-blur-[2px]" @click="$emit('close')"></div>
    <div class="relative w-[520px] max-w-[94vw] max-h-[86vh] flex flex-col rounded-3xl bg-white shadow-float-lg border border-sakura-100 p-6 animate-bubble-in">
      <div class="flex items-center justify-between mb-1">
        <h2 class="text-lg font-semibold text-stone-900">导入 QQ 聊天记录</h2>
        <button class="ui-btn-pill" @click="emit('close')">关闭</button>
      </div>
      <p class="text-xs text-stone-500 mb-4 leading-relaxed">聊天记录保存在本机，自动建档会将聊天内容发送到你配置的模型服务。</p>

      <!-- Tab 切换 -->
      <div class="flex gap-1 p-1 rounded-2xl bg-gray-50 border border-sakura-50 mb-4">
        <button class="flex-1 rounded-xl py-2 text-sm font-medium transition-all"
          :class="tab === 'qq' ? 'bg-white shadow-float text-sakura-600' : 'text-gray-400 hover:text-gray-600'"
          @click="switchTab('qq')">QQ 直连</button>
        <button class="flex-1 rounded-xl py-2 text-sm font-medium transition-all"
          :class="tab === 'file' ? 'bg-white shadow-float text-sakura-600' : 'text-gray-400 hover:text-gray-600'"
          @click="switchTab('file')">文件导入</button>
      </div>

      <!-- ══ Tab: QQ 直连 ══ -->
      <div v-if="tab === 'qq'" class="overflow-y-auto -mr-2 pr-2" style="min-height: 220px">
        <!-- checking -->
        <div v-if="phase === 'checking'" class="flex flex-col items-center gap-2 py-10 text-sm text-gray-400">
          <div class="w-5 h-5 border-2 border-sakura-200 border-t-sakura-400 rounded-full animate-spin"></div>
          正在检测 QCE 服务…
        </div>

        <!-- offline -->
        <div v-else-if="phase === 'offline'" class="rounded-2xl border border-sakura-100 bg-sakura-50/60 p-5 text-sm space-y-3">
          <div class="font-medium text-gray-700">未检测到 QCE 服务</div>
          <p class="text-gray-500 text-xs leading-relaxed">
            可以由本应用自动启动 QQ Chat Exporter（用于 QQ 扫码登录），也可以你手动启动后再检测。
          </p>
          <div class="flex flex-wrap gap-2">
            <button class="rounded-xl px-4 py-2 text-xs bg-sakura-500 text-white hover:bg-sakura-600 transition-colors" @click="confirmLaunch = true">自动启动 QCE</button>
            <button class="rounded-xl px-4 py-2 text-xs border border-sakura-200 text-gray-600 hover:bg-white transition-colors" @click="checkStatus">重新检测</button>
            <button class="rounded-xl px-4 py-2 text-xs border border-sakura-200 text-gray-600 hover:bg-white transition-colors" @click="openQcePage">打开 QCE 登录页 ↗</button>
          </div>
        </div>

        <!-- starting: 自动启动中 -->
        <div v-else-if="phase === 'starting'" class="rounded-2xl border border-sakura-100 bg-sakura-50/60 p-5 space-y-3">
          <div class="flex items-center gap-2 text-sm text-gray-600">
            <div class="w-4 h-4 border-2 border-sakura-200 border-t-sakura-400 rounded-full animate-spin"></div>
            正在启动 QCE…
          </div>
          <div class="text-xs text-gray-400 leading-relaxed">
            QCE 窗口已弹出，请<b class="text-gray-600">完成 QQ 扫码登录</b>——登录成功后 QCE 服务才会启动，此处会自动检测并继续（最长等 5 分钟）。
          </div>
          <button class="text-xs text-sakura-500 hover:text-sakura-600" @click="phase = 'offline'">取消等待</button>
        </div>

        <!-- unauth: 填 token -->
        <div v-else-if="phase === 'unauth'" class="rounded-2xl border border-sakura-100 bg-sakura-50/60 p-5 text-sm space-y-3">
          <div class="font-medium text-gray-700">QCE 需要访问令牌</div>
          <p class="text-xs text-gray-500 leading-relaxed">
            Token 在 QCE 界面或 <code class="bg-white px-1 rounded border">%LOCALAPPDATA%\QQChatExporter\.qce-config\security.json</code> 的 accessToken 字段里；若 QCE 装在默认路径，服务端会自动读取，通常无需手动填写。
          </p>
          <div class="flex gap-2">
            <input v-model="tokenDraft" type="password" placeholder="粘贴 Access Token"
              class="flex-1 rounded-xl border border-sakura-100 focus:border-sakura-300 outline-none px-3 py-2 text-xs" />
            <button class="rounded-xl px-4 py-2 text-xs bg-sakura-500 text-white hover:bg-sakura-600 transition-colors" @click="saveToken">保存并重试</button>
          </div>
          <button class="text-xs text-sakura-500 hover:text-sakura-600" @click="openQcePage">打开 QCE 界面 ↗</button>
        </div>

        <!-- ready / exporting / importing: 会话选择与进度 -->
        <template v-else-if="['ready', 'exporting', 'importing'].includes(phase)">
          <!-- 连接状态条 -->
          <div class="flex items-center gap-2 text-xs text-gray-400 mb-3">
            <span class="w-1.5 h-1.5 rounded-full bg-green-400"></span>
            QCE 已连接<span v-if="statusData?.base"> · {{ statusData.base }}</span>
            <button class="ml-auto text-sakura-400 hover:text-sakura-500" @click="checkStatus">刷新</button>
          </div>

          <div v-if="phase === 'ready'" class="space-y-3">
            <div class="text-[11px] text-gray-400">只导入一对一好友私聊，群聊已拦截。</div>
            <!-- 搜索 -->
            <input v-model="search" placeholder="搜索名称 / QQ号 / 群号…"
              class="w-full rounded-xl border border-sakura-100 focus:border-sakura-300 outline-none px-3.5 py-2 text-xs transition-colors" />
            <!-- 列表 -->
            <div class="rounded-2xl border border-sakura-50 divide-y divide-sakura-50 max-h-56 overflow-y-auto">
              <button v-for="p in peerList" :key="p.uid" class="w-full flex items-center gap-3 px-3.5 py-2.5 text-left hover:bg-sakura-50 transition-colors"
                :class="selected?.uid === p.uid ? 'bg-sakura-50' : ''" @click="pickPeer(p)">
                <div class="w-8 h-8 rounded-full bg-gradient-to-br from-pink-300 to-pink-400 flex items-center justify-center text-white text-xs font-medium shrink-0">
                  {{ p.name.slice(0, 1) }}
                </div>
                <div class="min-w-0">
                  <div class="text-xs font-medium text-gray-700 truncate">{{ p.name }}</div>
                  <div class="text-[10px] text-gray-300 truncate">{{ p.sub }}</div>
                </div>
                <div v-if="selected?.uid === p.uid" class="ml-auto text-sakura-500 text-xs">✓</div>
              </button>
              <div v-if="!peerList.length" class="px-4 py-6 text-xs text-gray-300 text-center">
                {{ search ? '没有匹配的会话' : '列表为空（若数量异常请检查 QCE 登录状态）' }}
              </div>
            </div>
          </div>

          <!-- 导出中 -->
          <div v-if="phase === 'exporting'" class="py-6 space-y-3">
            <div class="flex items-center gap-2 text-sm text-gray-600">
              <div class="w-4 h-4 border-2 border-sakura-200 border-t-sakura-400 rounded-full animate-spin"></div>
              正在从 QCE 导出「{{ selected?.name }}」…
            </div>
            <div class="h-2 rounded-full bg-sakura-50 overflow-hidden">
              <div class="h-full bg-gradient-to-r from-pink-300 to-pink-400 rounded-full transition-all duration-300"
                :style="{ width: Math.max(taskProgress, 4) + '%' }"></div>
            </div>
            <div class="text-[11px] text-gray-300">{{ taskMsgCount ? `已导出 ${taskMsgCount} 条` : '准备中…' }}</div>
          </div>

          <!-- 入库中 -->
          <div v-if="phase === 'importing'" class="flex flex-col items-center gap-2 py-10 text-sm text-gray-400">
            <div class="w-5 h-5 border-2 border-sakura-200 border-t-sakura-400 rounded-full animate-spin"></div>
            导出完成，正在写入本机 ChatLab…
          </div>
        </template>

        <!-- done -->
        <div v-else-if="phase === 'done'" class="rounded-2xl bg-green-50 border border-green-100 p-4 text-sm animate-bubble-in">
          <div class="text-green-600 font-medium mb-1">✓ 导入成功</div>
          <div class="text-gray-600">
            会话 <code class="text-xs bg-white px-1.5 py-0.5 rounded-md border">{{ done.sessionId }}</code>（{{ done.name }}）已导入。
            <span v-if="done.workspace">已创建工作区「{{ done.workspace.title }}」，请确认身份与档案草稿。</span>
            <span v-else-if="done.workspaceError" class="text-amber-600">工作区未建档：{{ done.workspaceError }}</span>
          </div>
        </div>
      </div>

      <!-- ══ Tab: 文件上传 ══ -->
      <div v-else>
        <label class="flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed transition-colors py-8 cursor-pointer"
          :class="file ? 'border-sakura-300 bg-sakura-50/60' : 'border-sakura-200 hover:border-sakura-300 hover:bg-sakura-50/50'">
          <!-- 预览/导入中：转圈 -->
          <div v-if="fileBusy" class="flex flex-col items-center gap-2">
            <div class="w-6 h-6 border-2 border-sakura-200 border-t-sakura-400 rounded-full animate-spin"></div>
            <span class="text-sm text-gray-500">{{ fileBusy === 'dry' ? '正在解析文件…' : '正在写入本机 ChatLab…' }}</span>
          </div>
          <!-- 已选文件：显示文件信息 -->
          <template v-else-if="file">
            <svg class="w-8 h-8 text-sakura-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span class="text-sm font-medium text-gray-700 max-w-[90%] truncate">{{ file.name }}</span>
            <span class="text-xs text-gray-400">{{ (file.size / 1024).toFixed(0) }} KB · 点击重新选择</span>
          </template>
          <!-- 空态 -->
          <template v-else>
            <svg class="w-8 h-8 text-sakura-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span class="text-sm text-gray-500">点击选择 QQ 导出的 JSON 文件</span>
            <span class="text-xs text-gray-300">选择后自动解析预览</span>
          </template>
          <input type="file" accept=".json" class="hidden" :disabled="!!fileBusy" @change="onFileChange" />
        </label>

        <!-- 预览卡（dry-run 实测数据） -->
        <div v-if="preview && !fileDone" class="mt-4 rounded-2xl bg-sakura-50 p-4 text-sm space-y-2 animate-bubble-in">
          <div class="flex justify-between items-center">
            <span class="text-gray-500 shrink-0">消息总数</span>
            <span class="font-semibold text-sakura-600">{{ preview.totalMessageCount }} 条</span>
          </div>
          <div class="flex justify-between items-center">
            <span class="text-gray-500 shrink-0">本次新增 / 已存在</span>
            <span>{{ preview.newMessageCount }} / {{ preview.duplicateCount }}</span>
          </div>
          <div v-if="preview.newMessageCount === 0 && preview.duplicateCount > 0"
            class="text-[11px] text-amber-500 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5">
            该文件此前已导入过，重复导入不会产生重复数据
          </div>
        </div>

        <!-- 成功卡（已回查友好会话名） -->
        <div v-if="fileDone" class="mt-4 rounded-2xl bg-green-50 border border-green-100 p-4 text-sm space-y-1.5 animate-bubble-in">
          <div class="text-green-600 font-medium">✓ 导入成功，已绑定一对一工作区</div>
          <div class="text-gray-700">{{ fileDone.name }} <span class="text-gray-400">· {{ fileDone.totalMessages }} 条消息</span></div>
          <div class="text-[11px] text-gray-300 font-mono truncate">{{ fileDone.sessionId }}</div>
        </div>
      </div>

      <div v-if="error" class="mt-4 rounded-2xl bg-red-50 border border-red-100 p-3 text-sm text-red-500">{{ error }}</div>

      <!-- 启动确认弹窗 -->
      <div v-if="confirmLaunch" class="fixed inset-0 z-[60] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="confirmLaunch = false"></div>
        <div class="relative w-[360px] max-w-[88vw] rounded-3xl bg-white shadow-float-lg border border-sakura-100 p-5 animate-bubble-in">
          <h3 class="text-sm font-semibold text-gray-800 mb-2">在本机启动 QCE 服务？</h3>
          <p class="text-xs text-gray-500 leading-relaxed mb-4">
            将启动 QQ Chat Exporter（本机已安装），其窗口会自动弹出并显示 QQ 扫码登录。聊天数据全程留在本机，不会上传。
          </p>
          <div class="flex gap-3">
            <button class="flex-1 rounded-xl py-2 text-sm border border-sakura-200 text-gray-600 hover:bg-sakura-50 transition-colors" @click="confirmLaunch = false">取消</button>
            <button class="flex-1 rounded-xl py-2 text-sm bg-sakura-500 text-white hover:bg-sakura-600 active:scale-[0.98] transition-all shadow-float" @click="launchQce">启动</button>
          </div>
        </div>
      </div>

      <!-- 按钮 -->
      <div class="flex gap-3 mt-5">
        <!-- QQ tab -->
        <template v-if="tab === 'qq'">
          <button v-if="phase !== 'done'" class="flex-1 rounded-xl py-2.5 text-sm bg-sakura-500 text-white hover:bg-sakura-600 active:scale-[0.98] transition-all shadow-float disabled:opacity-40"
            :disabled="phase !== 'ready' || !selected || busy" @click="exportAndImport">
            {{ selected ? `导出「${selected.name}」并导入` : '选择一个会话' }}
          </button>
          <button v-else class="flex-1 rounded-xl py-2.5 text-sm bg-sakura-500 text-white hover:bg-sakura-600 transition-colors" @click="$emit('close')">完成</button>
        </template>
        <!-- file tab -->
        <template v-else>
          <button v-if="!fileDone" class="flex-1 rounded-xl py-2.5 text-sm border border-sakura-200 text-gray-600 hover:bg-sakura-50 transition-colors disabled:opacity-40"
            :disabled="!file || !!fileBusy" @click="dryRun">{{ fileBusy === 'dry' ? '解析中…' : '重新预览' }}</button>
          <button v-if="!fileDone" class="flex-1 rounded-xl py-2.5 text-sm bg-sakura-500 text-white hover:bg-sakura-600 active:scale-[0.98] transition-all shadow-float disabled:opacity-40"
            :disabled="!preview || !!fileBusy" @click="confirmImport">{{ fileBusy === 'import' ? '写入中…' : '确认导入' }}</button>
          <button v-else class="flex-1 rounded-xl py-2.5 text-sm bg-sakura-500 text-white hover:bg-sakura-600 transition-colors" @click="$emit('close')">完成</button>
        </template>
      </div>
    </div>
  </div>
</template>
