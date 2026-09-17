import { ref } from 'vue'
import { sessionsApi } from '../api.js'

export function useChatSessions({ cases, currentCaseId }) {
  const importedSessions = ref([])
  const chatlabSessions = ref([])
  const selectedSessionId = ref('')

  function syncSessionFromCase() {
    const c = cases.value.find(x => x.id === currentCaseId.value)
    selectedSessionId.value = c?.sessionIds?.[0] || ''
  }

  async function fetchSessions() {
    try {
      const j = await sessionsApi.list()
      if (j.ok) {
        chatlabSessions.value = (j.data.items || []).filter(s => s.type !== 'group' && s.type !== 'groups')
        syncSessionFromCase()
      }
    } catch { /* 后端未起时静默 */ }
  }

  return {
    importedSessions, chatlabSessions, selectedSessionId,
    syncSessionFromCase, fetchSessions,
  }
}
