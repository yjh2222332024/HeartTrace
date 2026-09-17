function jsonInit(method, body) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

export async function parseJson(res) {
  return res.json().catch(() => null)
}

export const conversationsApi = {
  list: () => fetch('/api/conversations').then(parseJson),
  get: (id) => fetch(`/api/conversations/${id}`).then(parseJson),
  create: (body) => fetch('/api/conversations', jsonInit('POST', body)).then(parseJson),
  patch: (id, body) => fetch(`/api/conversations/${id}`, jsonInit('PATCH', body)).then(parseJson),
  remove: (id) => fetch(`/api/conversations/${id}`, { method: 'DELETE' }).then(parseJson),
  migrate: (conversations) => fetch('/api/conversations/migrate', jsonInit('POST', { conversations })),
}

export const casesApi = {
  list: () => fetch('/api/cases').then(parseJson),
  listMemoryCandidates: (id) => fetch(`/api/cases/${id}/memory-candidates`).then(parseJson),
  updateMemoryCandidate: (id, candidateId, body) => fetch(
    `/api/cases/${id}/memory-candidates/${candidateId}`,
    jsonInit('PATCH', body),
  ).then(parseJson),
  acceptMemoryCandidate: (id, candidateId, body = {}) => fetch(
    `/api/cases/${id}/memory-candidates/${candidateId}/accept`,
    jsonInit('POST', body),
  ).then(parseJson),
  rejectMemoryCandidate: (id, candidateId) => fetch(
    `/api/cases/${id}/memory-candidates/${candidateId}/reject`,
    { method: 'POST' },
  ).then(parseJson),
}

export const sessionsApi = {
  list: () => fetch('/api/sessions').then(parseJson),
}

export const runsApi = {
  start: (body) => fetch('/api/runs', jsonInit('POST', body)),
  cancel: (id) => fetch(`/api/runs/${id}/cancel`, { method: 'POST' }),
}

export const trainingApi = {
  scenarios: (body) => fetch('/api/training/scenarios', jsonInit('POST', body)).then(parseJson),
  create: (body) => fetch('/api/training/sessions', jsonInit('POST', body)).then(parseJson),
  list: (caseId = '') => fetch(`/api/training/sessions${caseId ? `?caseId=${encodeURIComponent(caseId)}` : ''}`).then(parseJson),
  get: (id) => fetch(`/api/training/sessions/${id}`).then(parseJson),
  turn: (id, body) => fetch(`/api/training/sessions/${id}/turn`, jsonInit('POST', body)).then(parseJson),
  deliverInitiative: (id) => fetch(`/api/training/sessions/${id}/deliver-initiative`, { method: 'POST' }).then(parseJson),
  resume: (id) => fetch(`/api/training/sessions/${id}/resume`, { method: 'POST' }).then(parseJson),
  coach: (id, body) => fetch(`/api/training/sessions/${id}/coach`, jsonInit('POST', body)).then(parseJson),
  review: (id) => fetch(`/api/training/sessions/${id}/review`, { method: 'POST' }).then(parseJson),
}

// Retry only requests rejected before execution by the server's consent gate.
export function installPrivacyConsent() {
  const originalFetch = window.fetch.bind(window)
  let pending = null
  window.fetch = async (input, init) => {
    const response = await originalFetch(input, init)
    const url = new URL(typeof input === 'string' ? input : input.url, location.href)
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/') || response.status !== 428) return response
    const payload = await response.clone().json().catch(() => null)
    if (payload?.code !== 'AI_CONSENT_REQUIRED') return response
    if (!pending) {
      pending = (async () => {
        const d = payload.data
        const accepted = window.confirm(`AI 分析数据授权\n\n服务商（按地址识别）：${d.provider || '未配置'}\nBase URL：${d.baseUrl}\n模型：${d.model}\n\n${d.scope}\n\n聊天解析和保存发生在本机，以上内容会发送至配置的模型服务。是否允许本次服务运行期间使用此配置分析？`)
        if (!accepted) return false
        const result = await originalFetch('/api/privacy/consent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accepted: true, challenge: d.challenge }) })
        return result.ok
      })().finally(() => { pending = null })
    }
    if (!await pending) return response
    return originalFetch(input, init)
  }
}
