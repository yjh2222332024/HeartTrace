<script setup>
import { computed, nextTick, ref, watch } from 'vue'

const props = defineProps({
  session: { type: Object, required: true },
  messages: { type: Array, default: null },
  peerName: { type: String, default: '对方' },
  ownerName: { type: String, default: '我' },
  typing: Boolean,
})

const scroller = ref(null)
const messages = computed(() => (props.messages || props.session?.messages || []).filter(message => message.role === 'me' || message.role === 'peer'))

function displayTime(minutes) {
  const started = new Date(props.session?.createdAt || Date.now())
  started.setMinutes(started.getMinutes() + (Number(minutes) || 0))
  return started.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function shouldShowTime(message, index) {
  if (index === 0) return true
  const previous = messages.value[index - 1]
  return (message.simulatedMinutes || 0) - (previous.simulatedMinutes || 0) >= 5
}

watch([messages, () => props.typing], async () => {
  await nextTick()
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
}, { deep: true })
</script>

<template>
  <div ref="scroller" class="training-chat-scroll" aria-live="polite">
    <div class="training-chat-inner">
      <div class="scene-message">
        {{ session.scenario.title }}
      </div>

      <template v-for="(message, index) in messages" :key="message.id">
        <div v-if="shouldShowTime(message, index)" class="sim-time">{{ displayTime(message.simulatedMinutes) }}</div>
        <article class="wechat-row" :class="message.role === 'me' ? 'mine' : 'peer'">
          <div class="wechat-avatar" :class="message.role === 'me' ? 'mine-avatar' : 'peer-avatar'">
            {{ (message.role === 'me' ? ownerName : peerName).slice(0, 1) || '?' }}
          </div>
          <div class="wechat-message">
            <span class="wechat-name">{{ message.role === 'me' ? ownerName : peerName }}</span>
            <div class="wechat-bubble">{{ message.content }}</div>
          </div>
        </article>
      </template>

      <article v-if="typing" class="wechat-row peer is-typing" aria-label="对方正在输入">
        <div class="wechat-avatar peer-avatar">{{ peerName.slice(0, 1) || '?' }}</div>
        <div class="typing-bubble"><i></i><i></i><i></i></div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.training-chat-scroll { flex: 1; min-height: 0; overflow-y: auto; background: #ededed; overscroll-behavior: contain; }
.training-chat-inner { width: min(800px, 100%); min-height: 100%; margin: 0 auto; padding: 26px clamp(16px, 3vw, 38px) 38px; }
.sim-time { width: fit-content; margin: 0 auto 14px; padding: 3px 8px; border-radius: 4px; background: rgba(0,0,0,.12); color: rgba(40,40,40,.56); font-size: 12px; line-height: 1.4; }
.sim-time { margin-top: 20px; }
.scene-message { width: fit-content; max-width: 90%; margin: 0 auto 25px; padding: 5px 10px; border-radius: 4px; background: rgba(0,0,0,.11); color: rgba(40,40,40,.6); font-size: 12px; line-height: 1.4; text-align: center; }
.wechat-row { display: flex; align-items: flex-start; gap: 10px; margin: 15px 0; }
.wechat-row.mine { flex-direction: row-reverse; }
.wechat-avatar { flex: 0 0 42px; width: 42px; height: 42px; display: grid; place-items: center; border-radius: 6px; color: #fff; font-size: 16px; font-weight: 700; }
.peer-avatar { background: linear-gradient(145deg, #c47d90, #9a3f5c); box-shadow: 0 2px 6px rgba(130, 56, 77, .2); }
.mine-avatar { background: linear-gradient(145deg, #6e9f69, #4b8252); box-shadow: 0 2px 6px rgba(61, 111, 67, .18); }
.wechat-message { max-width: min(78%, 520px); min-width: 0; }
.mine .wechat-message { display: flex; flex-direction: column; align-items: flex-end; }
.wechat-name { display: none; }
.wechat-bubble, .typing-bubble { position: relative; padding: 11px 13px; border-radius: 5px; background: #fff; color: #1f1f1f; font-size: 17px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; box-shadow: 0 1px 1px rgba(0,0,0,.03); }
.wechat-bubble::before, .typing-bubble::before { content: ''; position: absolute; top: 11px; left: -5px; width: 10px; height: 10px; background: #fff; clip-path: polygon(100% 0, 100% 100%, 0 50%); }
.mine .wechat-bubble { background: #95ec69; }
.mine .wechat-bubble::before { right: -5px; left: auto; background: #95ec69; transform: scaleX(-1); }
.typing-bubble { display: inline-flex; align-items: center; gap: 4px; min-width: 56px; min-height: 42px; padding: 0 15px; }
.typing-bubble i { width: 5px; height: 5px; border-radius: 50%; background: #a1a1a1; animation: typing-dot 1s infinite ease-in-out; }
.typing-bubble i:nth-child(2) { animation-delay: .16s; }.typing-bubble i:nth-child(3) { animation-delay: .32s; }
@keyframes typing-dot { 0%, 60%, 100% { transform: translateY(0); opacity: .35; } 30% { transform: translateY(-3px); opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .typing-bubble i { animation: none; opacity: .72; } }
@media (max-width: 560px) { .training-chat-inner { padding-inline: 12px; } .wechat-message { max-width: calc(100% - 52px); } .wechat-avatar { flex-basis: 37px; width: 37px; height: 37px; font-size: 14px; } .wechat-bubble { font-size: 16px; } }
</style>
