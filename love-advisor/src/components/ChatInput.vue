<script setup>
import { ref, computed } from 'vue'

const props = defineProps({
  generating: Boolean,
  sessions: { type: Array, default: () => [] },          // ChatLab 会话
  selectedSessionId: { type: String, default: '' },
})
const emit = defineEmits(['send', 'open-import', 'select-session'])

// ── Skill 注册表（MVP: 本地写死，后续扫描 skill 目录） ──
const SKILLS = [
  {
    id: 'relationship-advisor',
    name: '恋爱军师 · 谟西二十二',
    desc: '信号识别 · 边界判断 · 进攻策略 · 止损决策',
    path: 'D:/code/lianai/relationship-advisor-skill',
  },
]

const inputEl = ref(null)
const text = ref('')
const selectedSkills = ref([])
const showSkillMenu = ref(false)
const skillFilter = ref('')
const activeIndex = ref(0)

const filteredSkills = computed(() =>
  SKILLS.filter(s =>
    s.name.toLowerCase().includes(skillFilter.value.toLowerCase()) ||
    s.id.toLowerCase().includes(skillFilter.value.toLowerCase())
  )
)

// 当前选中的分析对象（ChatLab 会话）
const selectedSession = computed(() =>
  props.sessions.find(s => s.id === props.selectedSessionId) || null
)

function onInput(e) {
  const v = e.target.value
  // 输入 @ 时唤醒 skill 菜单
  if (v.endsWith('@')) {
    showSkillMenu.value = true
    skillFilter.value = ''
    activeIndex.value = 0
  } else if (showSkillMenu.value) {
    // @后面继续打字 -> 作为过滤词
    const m = v.match(/@([^@\s]*)$/)
    skillFilter.value = m ? m[1] : ''
    if (!m) showSkillMenu.value = false
  }
}

function pickSkill(skill) {
  if (!selectedSkills.value.find(s => s.id === skill.id)) {
    selectedSkills.value.push(skill)
  }
  // 移除输入框里的 @词根
  text.value = text.value.replace(/@([^@\s]*)$/, '')
  showSkillMenu.value = false
  inputEl.value?.focus()
}

function removeSkill(i) {
  selectedSkills.value.splice(i, 1)
}

function onKeydown(e) {
  if (showSkillMenu.value && filteredSkills.value.length) {
    if (e.key === 'ArrowDown') { activeIndex.value = (activeIndex.value + 1) % filteredSkills.value.length; e.preventDefault(); return }
    if (e.key === 'ArrowUp') { activeIndex.value = (activeIndex.value - 1 + filteredSkills.value.length) % filteredSkills.value.length; e.preventDefault(); return }
    if (e.key === 'Enter') { pickSkill(filteredSkills.value[activeIndex.value]); e.preventDefault(); return }
    if (e.key === 'Escape') { showSkillMenu.value = false; return }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    send()
  }
}

function send() {
  const t = text.value.trim()
  if ((!t && !selectedSkills.value.length) || props.generating) return
  emit('send', t, selectedSkills.value.map(s => s.id))
  text.value = ''
  selectedSkills.value = []
}
</script>

<template>
  <div class="shrink-0 pb-5 pt-2 px-6 bg-gradient-to-t from-[#FAFAFA] via-[#FAFAFA] to-transparent">
    <div class="max-w-3xl mx-auto relative">
      <!-- @ Skill 选择浮层 -->
      <div
        v-if="showSkillMenu"
        class="absolute bottom-full left-0 right-0 mb-3 rounded-2xl bg-white border border-sakura-100 shadow-float-lg overflow-hidden animate-bubble-in"
      >
        <div class="px-4 pt-3 pb-1.5 text-xs text-gray-400">选择 Skill</div>
        <button
          v-for="(s, i) in filteredSkills"
          :key="s.id"
          class="w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors"
          :class="i === activeIndex ? 'bg-sakura-50' : 'hover:bg-sakura-50/60'"
          @mouseenter="activeIndex = i"
          @click="pickSkill(s)"
        >
          <div class="w-8 h-8 rounded-xl bg-gradient-to-br from-sakura-400 to-sakura-500 flex items-center justify-center text-white text-xs shrink-0">
            军
          </div>
          <div class="min-w-0">
            <div class="text-sm font-medium text-gray-800">{{ s.name }}</div>
            <div class="text-xs text-gray-400 truncate">{{ s.desc }}</div>
          </div>
        </button>
        <div v-if="!filteredSkills.length" class="px-4 py-3 text-xs text-gray-300">没有匹配的 skill</div>
        <div class="px-4 py-2 text-[11px] text-gray-300 border-t border-sakura-50">↑↓ 选择 · Enter 确认 · Esc 关闭</div>
      </div>

      <!-- 已选 skill chips + 分析对象 chip -->
      <div v-if="selectedSkills.length || selectedSession" class="flex gap-2 mb-2 flex-wrap">
        <span
          v-for="(s, i) in selectedSkills"
          :key="s.id"
          class="inline-flex items-center gap-1.5 rounded-full bg-sakura-100 text-sakura-600 text-xs font-medium pl-2.5 pr-1.5 py-1 animate-bubble-in"
        >
          @{{ s.name }}
          <button class="w-4 h-4 rounded-full hover:bg-sakura-200 flex items-center justify-center text-sakura-500" @click="removeSkill(i)">✕</button>
        </span>
        <!-- 分析对象：已关联聊天数据 -->
        <span
          v-if="selectedSession"
          class="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-100 text-xs font-medium pl-2.5 pr-1.5 py-1 animate-bubble-in"
          title="军师回答时将引用该会话的聊天数据（统计+原文证据）"
        >
          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          {{ selectedSession.name }} · {{ selectedSession.totalMessages }}条
          <button class="w-4 h-4 rounded-full hover:bg-emerald-100 flex items-center justify-center text-emerald-500"
            title="取消关联" @click="$emit('select-session', '')">✕</button>
        </span>
      </div>

      <!-- 输入卡片 -->
      <div class="rounded-2xl bg-white border border-sakura-100 shadow-float focus-within:border-sakura-300 transition-colors">
        <textarea
          ref="inputEl"
          v-model="text"
          rows="2"
          placeholder="描述你的感情问题… 输入 @ 唤醒恋爱军师"
          class="w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] outline-none placeholder:text-gray-300"
          :disabled="generating"
          @input="onInput"
          @keydown="onKeydown"
        />
        <div class="flex items-center justify-between px-3 pb-2.5">
          <div class="flex items-center gap-2">
            <!-- ➕ 导入 QQ 聊天记录 -->
            <button
              class="w-8 h-8 rounded-xl flex items-center justify-center text-gray-400 hover:bg-sakura-50 hover:text-sakura-500 transition-colors"
              title="导入 QQ 聊天记录"
              @click="$emit('open-import')"
            >
              <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            <!-- 分析对象：ChatLab 会话选择 -->
            <select
              v-if="sessions.length"
              :value="selectedSessionId"
              class="max-w-[180px] rounded-lg border bg-white px-2 py-1.5 text-xs outline-none transition-colors cursor-pointer"
              :class="selectedSessionId ? 'border-emerald-200 text-emerald-600 font-medium' : 'border-sakura-100 text-gray-400'"
              title="分析对象（选中后，恋爱军师将基于该会话的聊天数据回答）"
              @change="$emit('select-session', $event.target.value)"
            >
              <option value="" disabled>分析对象…</option>
              <option v-for="s in sessions" :key="s.id" :value="s.id">
                {{ s.name }} · {{ s.totalMessages }}条
              </option>
            </select>
          </div>
          <!-- 发送 -->
          <button
            class="w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-200"
            :class="generating
              ? 'bg-sakura-100 text-sakura-300 cursor-not-allowed'
              : 'bg-sakura-500 text-white hover:bg-sakura-600 active:scale-[0.96] shadow-float'"
            :disabled="generating"
            @click="send"
            title="发送"
          >
            <svg class="w-4.5 h-4.5" style="width:18px;height:18px" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a.993.993 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z" />
            </svg>
          </button>
        </div>
      </div>

      <p class="text-center text-[11px] text-gray-300 mt-2">内容由 AI 生成，仅供参考 · Enter 发送 / Shift+Enter 换行</p>
    </div>
  </div>
</template>
