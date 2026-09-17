import { reactive, ref, watch } from 'vue'
import { defaultSettings, loadSaved, savePrefs } from '../lib/storage.js'

export function usePrefs() {
  const saved = loadSaved()
  const currentId = ref(saved?.currentId || null)
  const currentCaseId = ref(saved?.currentCaseId || '')
  const settings = reactive({
    ...defaultSettings,
    ...(saved?.settings && typeof saved.settings === 'object' && !Array.isArray(saved.settings) ? saved.settings : {}),
  })

  function persist() {
    savePrefs({ currentId: currentId.value, currentCaseId: currentCaseId.value, settings })
  }

  watch(settings, persist, { deep: true })

  function updateSettings(patch) {
    Object.assign(settings, patch)
  }

  return { saved, currentId, currentCaseId, settings, persist, updateSettings }
}
