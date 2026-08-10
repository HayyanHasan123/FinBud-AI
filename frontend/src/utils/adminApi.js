// Shared fetch wrapper for every /api/admin/* call across the console.
// Centralizing this means: one place handles session expiry (401 -> login),
// one place parses error bodies consistently, and CSV export/download only
// has to be implemented once for Global Transactions + Fee Reporting.

const BASE = '/api/admin'

async function request(method, path, body) {
  const opts = { method, credentials: 'include', headers: {} }
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }

  const res = await fetch(`${BASE}${path}`, opts)

  if (res.status === 401) {
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/admin/login')) {
      window.location.href = '/admin/login'
    }
    throw new Error('Session expired. Please sign in again.')
  }

  let data = null
  try { data = await res.json() } catch { /* non-JSON response */ }

  if (!res.ok) {
    throw new Error((data && data.message) || `Request failed (${res.status})`)
  }
  return data
}

export const adminGet    = (path)       => request('GET', path)
export const adminPost   = (path, body) => request('POST', path, body)
export const adminPatch  = (path, body) => request('PATCH', path, body)
export const adminDelete = (path)       => request('DELETE', path)

// Used by GET /api/admin/transactions/export and /api/admin/fees/export.
// Triggers a real browser file download instead of returning JSON.
export async function adminDownload(path, filename) {
  const res = await fetch(`${BASE}${path}`, { credentials: 'include' })
  if (res.status === 401) {
    window.location.href = '/admin/login'
    throw new Error('Session expired. Please sign in again.')
  }
  if (!res.ok) throw new Error(`Export failed (${res.status})`)
  const blob = await res.blob()
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.URL.revokeObjectURL(url)
}

// Small formatting helpers used across nearly every page, so numbers/dates
// render identically regardless of who wrote the page.
export function formatPKR(amount) {
  const n = Number(amount) || 0
  return `PKR ${n.toLocaleString('en-PK', { maximumFractionDigits: 0 })}`
}

export function formatTimestamp(isoString) {
  if (!isoString) return '—'
  const d = new Date(isoString)
  if (isNaN(d.getTime())) return isoString
  const datePart = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const timePart = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  return `${datePart} at ${timePart}`
}