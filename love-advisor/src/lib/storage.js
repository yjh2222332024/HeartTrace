export const STORAGE_KEY = 'love-advisor-conversations'

export const defaultSettings = {
  apiBase: '', apiKey: '', model: '',
  qceBase: '', qceToken: '', qcePath: '',
}

export function loadSaved() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    try { localStorage.removeItem(STORAGE_KEY) } catch { /* storage disabled */ }
  }
  return null
}

export function savePrefs({ currentId, currentCaseId, settings }) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ currentId, currentCaseId, settings }))
}
