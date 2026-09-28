import axios from 'axios'

export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  (typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? '/api'
    : 'https://occ-chatbot.vercel.app')

// gpt-oss sometimes cites as 【1】 or 【1†source】 mid-stream; the backend
// normalizes the final text, this keeps the live-streamed text consistent.
export function normalizeCitations(text) {
  return (text || '').replace(/【\s*(\d+)[^】]*】/g, '[$1]')
}

// POST /chat/stream and hand each NDJSON event to onEvent as it arrives.
// Falls back to plain POST /chat (one final "done" event) if streaming isn't
// available — e.g. a proxy that buffers or rejects the request.
export async function streamChat({ message, sessionId }, onEvent) {
  let sawEvent = false
  try {
    const res = await fetch(`${API_BASE_URL}/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sessionId })
    })
    if (res.status === 429) {
      // Rate limited: retrying via /chat would just be limited too.
      const body = await res.json().catch(() => ({}))
      const error = new Error(body.error || 'Too many messages — try again in a minute.')
      error.rateLimited = true
      throw error
    }
    if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let done = false
    while (true) {
      const { value, done: finished } = await reader.read()
      if (finished) break
      buffer += decoder.decode(value, { stream: true })
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        const event = JSON.parse(line)
        sawEvent = true
        if (event.type === 'done') done = true
        if (event.type === 'error') throw new Error(event.error)
        onEvent(event)
      }
    }
    if (!done) throw new Error('stream ended without a final payload')
  } catch (error) {
    // Only retry without streaming if nothing was processed yet — otherwise
    // the message was already stored server-side and a retry would duplicate it.
    if (sawEvent || error.rateLimited) throw error
    const res = await axios.post(`${API_BASE_URL}/chat`, { message, sessionId })
    onEvent({ type: 'done', payload: res.data })
  }
}

export const api = {
  topics: () => axios.get(`${API_BASE_URL}/topics`).then(r => r.data),
  history: sessionId => axios.get(`${API_BASE_URL}/history`, { params: { sessionId } }).then(r => r.data.history || []),
  sessionTickets: sessionId => axios.get(`${API_BASE_URL}/session/${sessionId}/tickets`).then(r => r.data.tickets || []),
  sessionUpdates: (sessionId, after) => axios.get(`${API_BASE_URL}/session/${sessionId}/updates`, { params: { after } }).then(r => r.data.updates || []),
  checkLease: body => axios.post(`${API_BASE_URL}/lease/check`, body).then(r => r.data),
  escalateLease: body => axios.post(`${API_BASE_URL}/lease/escalate`, body).then(r => r.data),
  checkListing: text => axios.post(`${API_BASE_URL}/listing/check`, { text }).then(r => r.data)
}

export function staffApi(token) {
  const headers = { Authorization: `Bearer ${token}` }
  return {
    tickets: () => axios.get(`${API_BASE_URL}/staff/tickets`, { headers }).then(r => r.data.tickets),
    ticket: id => axios.get(`${API_BASE_URL}/staff/tickets/${id}`, { headers }).then(r => r.data),
    reply: (id, content, author) => axios.post(`${API_BASE_URL}/staff/tickets/${id}/reply`, { content, author }, { headers }).then(r => r.data),
    setStatus: (id, status) => axios.patch(`${API_BASE_URL}/staff/tickets/${id}`, { status }, { headers }).then(r => r.data)
  }
}

export function errorMessage(error, fallback) {
  return error?.response?.data?.error || fallback
}
