<script setup>
defineProps({
  open: Boolean,
  title: { type: String, default: '确认操作' },
  message: { type: String, default: '' },
  confirmText: { type: String, default: '确认删除' },
  busy: Boolean,
})

const emit = defineEmits(['confirm', 'cancel'])
</script>

<template>
  <Transition name="modal-reveal">
  <div v-if="open" class="confirm-mask" @click.self="!busy && emit('cancel')">
    <section class="confirm-dialog" role="alertdialog" aria-modal="true" :aria-label="title">
      <div class="confirm-icon" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      </div>
      <div class="confirm-copy">
        <h2>{{ title }}</h2>
        <p>{{ message }}</p>
      </div>
      <footer>
        <button type="button" class="cancel-btn" :disabled="busy" @click="emit('cancel')">取消</button>
        <button type="button" class="danger-btn" :disabled="busy" @click="emit('confirm')">
          {{ busy ? '删除中…' : confirmText }}
        </button>
      </footer>
    </section>
  </div>
  </Transition>
</template>

<style scoped>
.confirm-mask { position: fixed; inset: 0; z-index: 200; display: grid; place-items: center; padding: 20px; background: rgba(34, 22, 28, .4); backdrop-filter: blur(4px); }
.confirm-dialog { width: min(420px, 100%); display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 14px; padding: 22px; border: 1px solid #ead4dc; border-radius: 8px; background: #fff; box-shadow: 0 24px 60px rgba(48, 24, 35, .22); }
.confirm-icon { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 8px; background: #fff1f2; color: #be123c; }
.confirm-copy { min-width: 0; }
h2 { margin: 1px 0 7px; color: #302a2d; font-size: 17px; font-weight: 700; }
p { margin: 0; color: #766d72; font-size: 13.5px; line-height: 1.65; overflow-wrap: anywhere; }
footer { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 9px; margin-top: 8px; }
button { height: 36px; padding: 0 16px; border-radius: 7px; font-size: 13px; font-weight: 650; cursor: pointer; }
.cancel-btn { border: 1px solid #ddd5d9; background: #fff; color: #625b60; }
.cancel-btn:hover { background: #f8f5f6; }
.danger-btn { border: 1px solid #be123c; background: #be123c; color: #fff; }
.danger-btn:hover { background: #9f1239; border-color: #9f1239; }
button:disabled { opacity: .55; cursor: not-allowed; }
</style>
