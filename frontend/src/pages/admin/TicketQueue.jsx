import { useState, useEffect } from 'react'
import { useAdminAuth } from '../../context/AdminAuthContext'
import { adminGet, adminPost, formatTimestamp } from '../../utils/adminApi'
import DataTable from '../../components/shared/DataTable'
import Badge from '../../components/shared/Badge'
import Modal from '../../components/shared/Modal'
import LoadingSpinner from '../../components/shared/LoadingSpinner'

const STATUS_TABS = [
  { key: '', label: 'All' },
  { key: 'pending', label: 'Open' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'canceled', label: 'Cancelled' },
]
const STATUS_COLOR = { pending: 'danger', in_progress: 'warning', resolved: 'success', canceled: 'muted' }
const STATUS_LABEL = { pending: 'Open', in_progress: 'In Progress', resolved: 'Resolved', canceled: 'Cancelled' }

export default function SupportTicketQueue() {
  const { admin } = useAdminAuth()
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [tickets, setTickets] = useState([])
  const [loading, setLoading] = useState(true)

  const [viewOpen, setViewOpen] = useState(false)
  const [viewTicket, setViewTicket] = useState(null)
  const [viewLoading, setViewLoading] = useState(false)

  const [resolveOpen, setResolveOpen] = useState(false)
  const [resolveNote, setResolveNote] = useState('')
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [actionTicketId, setActionTicketId] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { load() }, [status, search])

  async function load() {
    setLoading(true)
    const params = new URLSearchParams()
    if (status) params.set('status', status)
    if (search) params.set('search', search)
    try {
      const data = await adminGet(`/tickets/?${params.toString()}`)
      setTickets(Array.isArray(data) ? data : data?.tickets || [])
    } catch { setTickets([]) }
    setLoading(false)
  }

  async function openView(id) {
    setViewOpen(true)
    setViewLoading(true)
    try {
      const data = await adminGet(`/tickets/${id}`)
      setViewTicket(data)
    } catch { setViewTicket(null) }
    setViewLoading(false)
  }

  async function handleClaim(id) {
    try {
      await adminPost(`/tickets/${id}/claim`, {})
      await load()
    } catch {}
  }

  function openResolve(id) { setActionTicketId(id); setResolveNote(''); setResolveOpen(true) }
  function openCancel(id) { setActionTicketId(id); setCancelReason(''); setCancelOpen(true) }

  async function confirmResolve() {
    if (!actionTicketId || !resolveNote.trim()) return
    setBusy(true)
    try {
      await adminPost(`/tickets/${actionTicketId}/resolve`, { resolution_note: resolveNote.trim() })
      setResolveOpen(false)
      setViewOpen(false)
      await load()
    } catch {}
    setBusy(false)
  }

  async function confirmCancel() {
    if (!actionTicketId || !cancelReason.trim()) return
    setBusy(true)
    try {
      await adminPost(`/tickets/${actionTicketId}/cancel`, { reason: cancelReason.trim() })
      setCancelOpen(false)
      setViewOpen(false)
      await load()
    } catch {}
    setBusy(false)
  }

  const columns = [
    { key: 'id', label: 'Ticket ID', render: r => <strong>TKT-{String(r.id).padStart(5, '0')}</strong> },
    { key: 'account', label: 'User', render: r => <div><strong>{r.name || r.account}</strong><div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{r.account}</div></div> },
    { key: 'reason', label: 'Issue Summary' },
    { key: 'status', label: 'Status', render: r => <Badge label={STATUS_LABEL[r.status] || r.status} color={STATUS_COLOR[r.status] || 'muted'} /> },
    { key: 'created_at', label: 'Created', render: r => formatTimestamp(r.created_at) },
    { key: 'assigned_to', label: 'Assigned Banker', render: r => r.assigned_to || <span style={{ color: 'var(--color-text-muted)' }}>Unassigned</span> },
    {
      key: 'actions', label: 'Actions', render: r => (
        <div style={{ display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
          {r.status === 'pending' && <button className="stq-btn" onClick={() => handleClaim(r.id)}>Claim</button>}
          <button className="stq-btn" onClick={() => openView(r.id)}>View</button>
        </div>
      )
    },
  ]

  return (
    <div className="stq-wrap">
      <style>{`
        .stq-wrap { max-width: 1280px; margin: 0 auto; }
        .stq-filter-bar { display: flex; gap: 10px; margin-bottom: 16px; align-items: center; flex-wrap: wrap; }
        .stq-tab { background: var(--color-card-bg); border: 1px solid var(--color-border); border-radius: 20px; padding: 7px 16px; font-size: 12.5px; font-weight: 600; cursor: pointer; color: var(--color-text-secondary); }
        .stq-tab.active { background: var(--color-primary); border-color: var(--color-primary); color: #fff; }
        .stq-search { padding: 8px 12px; border: 1px solid var(--color-border); border-radius: 7px; font-size: 12.5px; min-width: 220px; }
        .stq-btn { background: var(--color-primary-light); color: var(--color-primary); border: none; border-radius: 6px; padding: 5px 10px; font-size: 11.5px; font-weight: 700; cursor: pointer; }
        .stq-view-body { font-size: 13px; }
        .stq-view-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--color-border); }
        .stq-chat-line { padding: 8px 0; border-bottom: 1px solid var(--color-border); font-size: 12.5px; }
        .stq-chat-line .stq-u { color: var(--color-text-primary); font-weight: 600; }
        .stq-chat-line .stq-a { color: var(--color-text-secondary); margin-top: 2px; }
        .stq-view-actions { display: flex; gap: 8px; margin-top: 18px; }
        .stq-view-actions button { flex: 1; padding: 10px; border-radius: 7px; font-weight: 700; font-size: 12.5px; border: none; cursor: pointer; text-transform: uppercase; }
        textarea.stq-reason { width: 100%; min-height: 90px; padding: 10px; border: 1px solid var(--color-border); border-radius: 7px; font-size: 13px; font-family: inherit; resize: vertical; }
      `}</style>

      <div className="stq-filter-bar">
        {STATUS_TABS.map(t => <button key={t.key} className={`stq-tab ${status === t.key ? 'active' : ''}`} onClick={() => setStatus(t.key)}>{t.label}</button>)}
        <input className="stq-search" placeholder="Search by user name or account..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {loading ? <LoadingSpinner label="Loading tickets..." /> : (
        <DataTable columns={columns} rows={tickets} onRowClick={r => openView(r.id)}
          emptyIcon="fa-ticket" emptyTitle="No tickets" emptyMessage={admin.role === 'banker' ? "You don't have any tickets assigned right now." : 'Nothing matches these filters.'} />
      )}

      <Modal open={viewOpen} onClose={() => setViewOpen(false)} title={viewTicket ? `Ticket TKT-${String(viewTicket.ticket?.id ?? viewTicket.id).padStart(5, '0')}` : 'Ticket'} width={520}
        footer={viewTicket && viewTicket.ticket?.status !== 'resolved' && viewTicket.ticket?.status !== 'canceled' ? (
          <div className="stq-view-actions" style={{ width: '100%' }}>
            <button style={{ background: 'var(--color-content-bg)', color: 'var(--color-text-secondary)' }} onClick={() => openCancel(viewTicket.ticket.id)}>Cancel Ticket</button>
            <button style={{ background: 'var(--color-success)', color: '#fff' }} onClick={() => openResolve(viewTicket.ticket.id)}>Resolve</button>
          </div>
        ) : null}
      >
        {viewLoading || !viewTicket ? <LoadingSpinner label="Loading ticket..." /> : (
          <div className="stq-view-body">
            <div className="stq-view-row"><span>User</span><strong>{viewTicket.ticket?.name} ({viewTicket.ticket?.account})</strong></div>
            <div className="stq-view-row"><span>Reason</span><strong>{viewTicket.ticket?.reason}</strong></div>
            <div className="stq-view-row"><span>Status</span><Badge label={STATUS_LABEL[viewTicket.ticket?.status] || viewTicket.ticket?.status} color={STATUS_COLOR[viewTicket.ticket?.status] || 'muted'} /></div>
            <div className="stq-view-row"><span>Created</span><strong>{formatTimestamp(viewTicket.ticket?.created_at)}</strong></div>

            <h4 style={{ marginTop: 18, marginBottom: 8, fontSize: 12, textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>Chat History Since Handoff</h4>
            {(viewTicket.messages || []).length === 0 ? (
              <p style={{ color: 'var(--color-text-muted)', fontSize: 12.5 }}>No messages recorded since handoff.</p>
            ) : viewTicket.messages.map(m => (
              <div key={m.id} className="stq-chat-line">
                <div className="stq-u">{m.user_message}</div>
                <div className="stq-a">{m.ai_response}</div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      <Modal open={resolveOpen} onClose={() => setResolveOpen(false)} title="Resolve Ticket"
        footer={<>
          <button className="stq-btn" onClick={() => setResolveOpen(false)}>Cancel</button>
          <button className="stq-btn" style={{ background: 'var(--color-success)', color: '#fff' }} onClick={confirmResolve} disabled={busy || !resolveNote.trim()}>{busy ? 'Saving...' : 'Confirm Resolve'}</button>
        </>}>
        <p>Enter a short resolution note:</p>
        <textarea className="stq-reason" value={resolveNote} onChange={e => setResolveNote(e.target.value)} placeholder="e.g. Verified identity, unlocked account manually." />
      </Modal>

      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancel Ticket" danger
        footer={<>
          <button className="stq-btn" onClick={() => setCancelOpen(false)}>Back</button>
          <button className="stq-btn" style={{ background: 'var(--color-danger)', color: '#fff' }} onClick={confirmCancel} disabled={busy || !cancelReason.trim()}>{busy ? 'Saving...' : 'Confirm Cancel'}</button>
        </>}>
        <p>Enter a reason for cancelling this ticket:</p>
        <textarea className="stq-reason" value={cancelReason} onChange={e => setCancelReason(e.target.value)} placeholder="e.g. Duplicate ticket, user resolved independently." />
      </Modal>
    </div>
  )
}