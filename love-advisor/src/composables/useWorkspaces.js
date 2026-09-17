import { ref } from 'vue'
import { casesApi } from '../api.js'

export function useWorkspaces({ currentCaseId }) {
  const cases = ref([])
  const showCaseModal = ref(false)
  const caseModalId = ref('__new__')
  const initialCaseSession = ref(null)

  async function refreshCases() {
    try {
      const j = await casesApi.list()
      if (j.ok) cases.value = j.data.items
    } catch { /* 后端未起时静默 */ }
  }

  function openCaseModal(id, session = null) {
    caseModalId.value = id || '__new__'
    initialCaseSession.value = session || null
    showCaseModal.value = true
  }

  function onCaseDeleted() {
    refreshCases()
    currentCaseId.value = ''
  }

  return {
    cases, showCaseModal, caseModalId, initialCaseSession,
    refreshCases, openCaseModal, onCaseDeleted,
  }
}
