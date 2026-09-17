<script setup>
defineProps({
  label: { type: String, default: '' },
  size: { type: String, default: 'sm' },
  tone: { type: String, default: 'rose' },
})
</script>

<template>
  <span
    :class="['ai-activity', `ai-activity--${size}`, `ai-activity--${tone}`]"
    role="status"
    aria-live="polite"
  >
    <span class="ai-activity__mark" aria-hidden="true">
      <i></i><i></i><i></i>
    </span>
    <span v-if="label" class="ai-activity__label">{{ label }}</span>
  </span>
</template>

<style scoped>
.ai-activity {
  --activity-ink: #a3425c;
  display: inline-flex;
  align-items: center;
  gap: .48em;
  max-width: 100%;
  color: var(--activity-ink);
  font-weight: 650;
  line-height: 1.35;
  vertical-align: middle;
}
.ai-activity--xs { gap: 4px; font-size: 11px; }
.ai-activity--sm { font-size: 12px; }
.ai-activity--md { font-size: 14px; }
.ai-activity--hero {
  gap: 12px;
  padding: 18px 27px;
  border: 1px solid rgba(203, 139, 158, .38);
  border-radius: 999px;
  background: rgba(255, 255, 255, .92);
  box-shadow: 0 14px 34px rgba(117, 50, 70, .13);
  color: #b96f83;
  font-size: 21px;
  font-weight: 720;
  line-height: 1.2;
}
.ai-activity--muted { --activity-ink: #8d8182; }
.ai-activity--inverse { --activity-ink: rgba(255, 255, 255, .96); }

.ai-activity__mark { display: inline-flex; align-items: center; gap: 3px; flex: 0 0 auto; }
.ai-activity__mark i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  animation: ai-activity-breathe 1.15s ease-in-out infinite;
}
.ai-activity--xs .ai-activity__mark { gap: 2px; }
.ai-activity--xs .ai-activity__mark i { width: 3.5px; height: 3.5px; }
.ai-activity--md .ai-activity__mark { gap: 4px; }
.ai-activity--md .ai-activity__mark i { width: 6px; height: 6px; }
.ai-activity--hero .ai-activity__mark { gap: 6px; }
.ai-activity--hero .ai-activity__mark i { width: 8px; height: 8px; }
.ai-activity__mark i:nth-child(2) { animation-delay: .14s; }
.ai-activity__mark i:nth-child(3) { animation-delay: .28s; }
.ai-activity__label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-activity--hero .ai-activity__label {
  overflow: visible;
  background: linear-gradient(100deg, #8d314d 4%, #d58ba0 49%, #a4425d 96%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

@keyframes ai-activity-breathe {
  0%, 64%, 100% { transform: translateY(0) scale(.78); opacity: .38; }
  30% { transform: translateY(-2px) scale(1); opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .ai-activity__mark i { animation: none; transform: none; opacity: .72; }
}

@media (max-width: 560px) {
  .ai-activity--hero { gap: 9px; padding: 15px 19px; font-size: 18px; }
  .ai-activity--hero .ai-activity__mark { gap: 4px; }
  .ai-activity--hero .ai-activity__mark i { width: 7px; height: 7px; }
}
</style>
