<script setup>
import MessageList from '../components/MessageList.vue'
import ChatInput from '../components/ChatInput.vue'
import AiActivity from '../components/AiActivity.vue'

defineProps({
  loading: Boolean,
  hasMessages: Boolean,
  messages: { type: Array, default: () => [] },
  generating: Boolean,
  runState: { type: String, default: '' },
  autoSkill: { type: String, default: '' },
  caseId: { type: String, default: '' },
  memoryCandidates: { type: Array, default: () => [] },
  peerName: { type: String, default: '' },
  selection: { type: Object, default: null },
  isSplit: { type: Boolean, default: false },
})

const draft = defineModel('draft', { type: String, default: '' })
const emit = defineEmits([
  'fill', 'jump-messages', 'send', 'cancel', 'choose-messages',
  'clear-selection', 'remove-selection', 'open-import', 'regenerate',
  'memory-candidate-changed',
])
</script>

<template>
  <section v-if="loading" class="center-shell conversation-loading" :class="{ 'is-split': isSplit }" aria-busy="true">
    <AiActivity label="正在载入这段对话" size="md" />
  </section>

  <!-- 首页态：Hero + 卡片 + 输入框 -->
  <section v-else-if="!hasMessages" class="center-shell" :class="{ 'is-split': isSplit }">
    <MessageList :messages="[]" :is-split="isSplit" :peer-name="peerName" @fill="emit('fill', $event)" />
    <ChatInput
      v-model="draft"
      :generating="generating"
      :compact="isSplit"
      :selection="selection"
      @clear-selection="emit('clear-selection')"
      @remove-selection="emit('remove-selection', $event)"
      @choose-messages="emit('choose-messages')"
      @cancel="emit('cancel')"
      @send="(text, skills) => emit('send', text, skills)"
      @open-import="emit('open-import')"
    />
  </section>

  <!-- 对话态：消息流 + 底部输入框 -->
  <template v-else>
    <MessageList
      :messages="messages"
      :generating="generating"
      :run-state="runState"
      :auto-skill="autoSkill"
      :case-id="caseId"
      :memory-candidates="memoryCandidates"
      :peer-name="peerName"
      :is-split="isSplit"
      @fill="emit('fill', $event)"
      @jump-messages="emit('jump-messages', $event)"
      @regenerate="emit('regenerate')"
      @memory-candidate-changed="emit('memory-candidate-changed', $event)"
    />
    <div class="composer-dock" :class="{ 'is-split': isSplit }">
      <ChatInput
        v-model="draft"
        :generating="generating"
        :compact="isSplit"
        :selection="selection"
        @clear-selection="emit('clear-selection')"
        @remove-selection="emit('remove-selection', $event)"
        @choose-messages="emit('choose-messages')"
        @send="(text, skills) => emit('send', text, skills)"
        @cancel="emit('cancel')"
        @open-import="emit('open-import')"
      />
    </div>
  </template>
</template>

<style scoped>
.conversation-loading {
  display: grid;
  place-items: center;
}
</style>
