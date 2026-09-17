import { ref } from 'vue'

export function useToast() {
  const toastText = ref('')
  let toastTimer = null
  function showToast(text) {
    toastText.value = text
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toastText.value = ''), 1700)
  }
  return { toastText, showToast }
}
