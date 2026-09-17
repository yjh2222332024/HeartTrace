<script setup>
import { ref, computed, inject, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'

const props = defineProps({
  generating: Boolean,
  compact: { type: Boolean, default: false },
  selection: { type: Object, default: null },
})
const emit = defineEmits(['send', 'cancel', 'open-import', 'choose-messages', 'clear-selection', 'remove-selection'])

const text = defineModel({ type: String, default: '' })
const toast = inject('toast', () => {})

// ── Skill（军师）注册表：从服务端 skills/ 目录扫描 ─────
const skills = ref([])
const showToolsMenu = ref(false)

function closeMenus(e) {
  if (!e.target.closest('.composer-tools-wrap')) {
    showToolsMenu.value = false
  }
  if (!e.target.closest('.skill-btn') && !e.target.closest('.skill-menu')) {
    showSkillMenu.value = false
  }
}

function toggleToolsMenu() {
  showToolsMenu.value = !showToolsMenu.value
  if (showToolsMenu.value) {
    showSkillMenu.value = false
  }
}

onMounted(async () => {
  window.addEventListener('click', closeMenus)
  adjustHeight()
  try {
    const j = await fetch('/api/skills').then(r => r.json())
    if (j.ok) skills.value = j.data.items.map(s => ({ id: s.id, name: s.name, desc: s.description }))
  } catch { /* 后端未起时空列表 */ }
})

onBeforeUnmount(() => {
  window.removeEventListener('click', closeMenus)
})

const inputEl = ref(null)
const selectedSkills = ref([])
const showSkillMenu = ref(false)
const skillFilter = ref('')
const activeIndex = ref(0)

function adjustHeight() {
  nextTick(() => {
    if (!inputEl.value) return
    inputEl.value.style.height = 'auto'
    const scrollH = inputEl.value.scrollHeight
    const targetH = Math.min(Math.max(scrollH, props.compact ? 52 : 72), 220)
    inputEl.value.style.height = `${targetH}px`
  })
}

watch(text, () => {
  adjustHeight()
})
watch(() => props.compact, adjustHeight)

const filteredSkills = computed(() =>
  skills.value.filter(s =>
    s.name.toLowerCase().includes(skillFilter.value.toLowerCase()) ||
    s.id.toLowerCase().includes(skillFilter.value.toLowerCase())
  )
)

function onInput(e) {
  adjustHeight()
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
    activeIndex.value = 0
    if (!m) showSkillMenu.value = false
  }
}

function toggleSkillMenu() {
  showSkillMenu.value = !showSkillMenu.value
  skillFilter.value = ''
  activeIndex.value = 0
  if (showSkillMenu.value) {
    showToolsMenu.value = false
    inputEl.value?.focus()
  }
}

function pickSkill(skill) {
  if (!skill) return
  if (!selectedSkills.value.find(s => s.id === skill.id)) {
    selectedSkills.value.push(skill)
  }
  // 移除输入框里的 @词根
  text.value = text.value.replace(/@([^@\s]*)$/, '')
  showSkillMenu.value = false
  inputEl.value?.focus()
  adjustHeight()
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
  if (!t && !selectedSkills.value.length && !props.selection?.messages.length) {
    toast('先和我说说发生了什么')
    inputEl.value?.focus()
    return
  }
  if (props.generating) return
  emit('send', t || '请分析所选聊天记录，我该怎么回复？', selectedSkills.value.map(s => s.id))
  text.value = ''
  selectedSkills.value = []
  nextTick(() => {
    if (inputEl.value) inputEl.value.style.height = `${props.compact ? 52 : 72}px`
  })
}
</script>

<template>
  <div class="composer-wrap">
    <!-- @ Skill 选择浮层 -->
    <Transition name="menu-pop">
    <div v-if="showSkillMenu" class="skill-menu">
      <div class="skill-menu-title">选择 Skill</div>
      <button
        v-for="(s, i) in filteredSkills"
        :key="s.id"
        class="skill-item"
        :class="{ on: i === activeIndex }"
        @mouseenter="activeIndex = i"
        @click="pickSkill(s)"
      >
        <img src="../assets/logo.png" alt="" style="width:32px;height:32px;border-radius:10px" />
        <div class="min-w-0">
          <div class="name">{{ s.name }}</div>
          <div class="desc">{{ s.desc }}</div>
        </div>
      </button>
      <div v-if="!filteredSkills.length" class="skill-menu-title" style="padding-top:0">没有匹配的 skill</div>
    </div>
    </Transition>

    <div class="composer" :class="{ compact }">
      <Transition name="content-reveal">
      <details v-if="selection?.messages.length" class="selection-preview">
        <summary class="flex items-center gap-2 cursor-pointer font-medium select-none">
          <svg class="w-3.5 h-3.5 text-rose-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <span>{{ selection.sessionName }} · 已引用 {{ selection.messages.length }} 条聊天记录</span>
        </summary>
        <div class="selection-items mt-2">
          <div v-for="m in selection.messages" :key="m.id" class="selection-item">
            <div><small class="text-[11px] text-stone-400 font-mono">{{ m.time }} {{ m.senderName }}</small><p class="text-xs text-stone-700">{{ m.content }}</p></div>
            <button :title="`移除消息 ${m.id}`" :aria-label="`移除消息 ${m.id}`" @click="emit('remove-selection', m.id)">×</button>
          </div>
        </div>
        <button class="ui-btn-pill danger mt-2.5" @click="emit('clear-selection')">
          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
          <span>移除全部引用</span>
        </button>
      </details>
      </Transition>
      <textarea
        id="composer-input"
        ref="inputEl"
        v-model="text"
        placeholder="和我说说发生了什么，或是贴上一段令你困惑的对话…"
        :disabled="generating"
        @input="onInput"
        @keydown="onKeydown"
      />

      <div class="composer-bar">
        <div class="composer-primary-actions">
          <!-- 低频上下文工具统一收纳 -->
          <div class="composer-tools-wrap">
            <button
              class="compact-tool-btn"
              :class="{ active: showToolsMenu }"
              :disabled="generating"
              type="button"
              title="添加上下文"
              aria-label="添加上下文"
              @click.stop="toggleToolsMenu"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>

            <Transition name="menu-pop">
            <div v-if="showToolsMenu" class="composer-tools-menu" @click.stop>
              <button type="button" @click="showToolsMenu = false; emit('choose-messages')">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M9 10h6M9 14h4"/></svg>
                <span>引用聊天记录</span>
              </button>
            </div>
            </Transition>
          </div>

          <!-- 显性化 @ 军师按钮 -->
          <button
            class="compact-skill-btn skill-btn"
            :class="{ active: showSkillMenu }"
            :disabled="generating"
            type="button"
            title="选择军师专长方向"
            @click="toggleSkillMenu"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/>
            </svg>
            <span>军师</span>
          </button>
        </div>

        <div class="composer-send-actions">
          <!-- 清空草稿 -->
          <button
            v-if="text.trim() && !generating"
            type="button"
            class="clear-draft-btn"
            title="清空输入草稿"
            @click="text = ''; adjustHeight(); inputEl?.focus()"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>

          <button
            v-if="generating"
            class="send stop"
            aria-label="停止生成"
            title="停止生成"
            @click="emit('cancel')"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <rect x="5" y="5" width="14" height="14" rx="2.5" />
            </svg>
          </button>
          <button
            v-else
            class="send"
            aria-label="发送"
            title="发送"
            @click="send"
          >
            <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m5 4 15 8-15 8 3-8-3-8Z" /><path d="M8 12h12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.selection-preview {
  border-bottom: 1px solid rgba(226, 218, 222, 0.85);
  padding: 10px 14px;
  font-size: 13px;
  color: var(--brand);
  background: rgba(253, 244, 246, 0.45);
  border-radius: 14px 14px 0 0;
}
.selection-preview summary { cursor: pointer; overflow-wrap: anywhere; }
.selection-items { max-height: 180px; overflow-y: auto; }
.selection-item { display: flex; align-items: flex-start; gap: 10px; padding: 8px 0; border-bottom: 1px solid rgba(226, 218, 222, 0.6); }
.selection-item > div { flex: 1; min-width: 0; }
.selection-item p { white-space: pre-wrap; overflow-wrap: anywhere; margin: 3px 0 0; }
.selection-item button {
  width: 24px; height: 24px; flex-shrink: 0; font-size: 15px; line-height: 1;
  border: 1px solid rgba(226, 218, 222, 0.8);
  border-radius: 50%;
  background: #ffffff;
  color: #8892a4;
  display: grid; place-items: center;
  cursor: pointer;
  transition: all 0.15s ease;
}
.selection-item button:hover {
  color: #be123c;
  border-color: #fecdd3;
  background: #fff1f2;
}
/* 停止按钮：生成中替代发送按钮 */
.send.stop {
  background: #fff1f2;
  color: #be123c;
  border: 1px solid #fda4af;
  box-shadow: 0 4px 12px rgba(190, 18, 60, 0.15);
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.send.stop:hover {
  background: #ffe4e6;
  color: #9f1239;
  border-color: #fb7185;
  transform: scale(1.05);
}
.send.stop:active {
  transform: scale(0.96);
}

/* 紧凑输入区：常驻输入、军师和发送，其余上下文能力放入 + 菜单。 */
.composer.compact {
  min-height: 92px;
  padding: 10px 12px 9px;
  border-radius: 14px;
}
.composer.compact textarea {
  min-height: 52px;
  padding: 0 4px;
  line-height: 1.5;
}
.composer.compact .selection-preview {
  margin: -10px -12px 8px;
  padding: 8px 12px;
  border-radius: 14px 14px 0 0;
}
.compact-context-row {
  padding: 0 2px 7px;
  gap: 6px;
}
.composer-primary-actions,
.composer-send-actions {
  display: flex;
  align-items: center;
  gap: 7px;
}
.composer-tools-wrap {
  position: relative;
  display: inline-flex;
}
.compact-tool-btn,
.compact-skill-btn,
.clear-draft-btn {
  height: 34px;
  border: 1px solid rgba(139, 38, 67, 0.16);
  background: #fffafb;
  color: var(--brand);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}
.compact-tool-btn,
.clear-draft-btn {
  width: 34px;
  padding: 0;
  border-radius: 9px;
}
.compact-skill-btn {
  gap: 5px;
  padding: 0 10px;
  border-radius: 9px;
  font-size: 12.5px;
  font-weight: 600;
}
.compact-tool-btn:hover,
.compact-skill-btn:hover,
.compact-tool-btn.active,
.compact-skill-btn.active {
  background: #fff0f4;
  border-color: rgba(139, 38, 67, 0.34);
  color: var(--brand-3);
}
.compact-tool-btn:disabled,
.compact-skill-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.clear-draft-btn {
  border-color: transparent;
  background: transparent;
  color: var(--text-3);
}
.clear-draft-btn:hover {
  background: #f7f2f4;
  color: var(--text-2);
}
.composer-tools-menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 9px);
  z-index: 70;
  width: 190px;
  padding: 6px;
  border: 1px solid rgba(220, 185, 198, 0.7);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.98);
  box-shadow: 0 14px 32px rgba(58, 20, 32, 0.15);
  backdrop-filter: blur(16px);
}
.composer-tools-menu button {
  width: 100%;
  height: 38px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-2);
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.composer-tools-menu button:hover {
  background: #fff2f6;
  color: var(--brand);
}
.composer.compact .send {
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  box-shadow: 0 5px 14px rgba(139, 38, 67, 0.22);
}
.composer.compact .send svg {
  width: 20px;
  height: 20px;
}

@container (max-width: 440px) {
  .composer.compact {
    padding-inline: 10px;
  }
  .compact-skill-btn span {
    display: none;
  }
  .compact-skill-btn {
    width: 34px;
    padding: 0;
  }
  .composer-tools-menu {
    max-width: calc(100cqw - 20px);
  }
}

@container (max-width: 350px) {
  .composer-bar {
    gap: 6px;
  }
  .clear-draft-btn {
    display: none;
  }
}

@media (max-width: 520px) {
  .compact-skill-btn span { display: none; }
  .compact-skill-btn { width: 34px; padding: 0; }
}
</style>
