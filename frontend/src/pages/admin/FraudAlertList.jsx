import { useState, useEffect } from 'react'
import { adminGet, adminPatch, adminPost, formatPKR, formatTimestamp } from '../../utils/adminApi'
import StatCard from '../../components/shared/StatCard'
import DataTable from '../../components/shared/DataTable'
import Badge from '../../components/shared/Badge'
import Modal from '../../components/shared/Modal'
import LoadingSpinner from '../../components/shared/LoadingSpinner'
import EmptyState from '../../components/shared/EmptyState'

const ANOMALY_TYPES = [
  { key: 'emergency_lock', label: 'Emergency Lock', color: 'var(--color-anomaly-emergency)' },
  { key: 'new_biller', label: 'New Biller', color: 'var(--color-anomaly-new-biller)' },
  { key: 'amount_spike', label: 'Amount Spike', color: 'var(--color-anomaly-amount-spike)' },
  { key: 'duplicate_bill', label: 'Duplicate Bill', color: 'var(--color-anomaly-duplicate-bill)' },
  { key: 'large_transfer', label: 'Large Transfer', color: 'var(--color-anomaly-large-transfer)' },
  { key: 'rapid_fire', label: 'Rapid Fire', color: 'var(--color-anomaly-rapid-fire)' },
  { key: 'odd_hours', label: 'Odd Hours', color: 'var(--color-anomaly-odd-hours)' },
]
const ANOMALY_MAP = Object.fromEntries(ANOMALY_TYPES.map(a => [a.key, a]))

const STATUS_OPTIONS = ['unreviewed', 'under_review', 'dismissed', 'escalated']
const STATUS_COLOR = { unreviewed: 'danger', under_review: 'warning', dismissed: 'muted', escalated: 'primary' }

export default function FraudAlertList() {
  const [alerts, setAlerts] = useState([])
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({ anomaly_type: '', status: '', date_from: '', date_to: '', search: '' })

  const [selectedId, setSelectedId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const [freezeOpen, setFreezeOpen] = useState(false)
  const [freezeReason, setFreezeReason] = useState('')
  const [freezeBusy, setFreezeBusy] = useState(false)

  // Doc 15's stat bar (Total / Unreviewed / Escalated / Resolved This Week)
  // doesn't map to a dedicated summary endpoint — derived here from an
  // unfiltered fetch. "Resolved" isn't one of the 4 defined statuses, so
  // 'dismissed' is treated as the resolved-equivalent for that card.
  const [allAlerts, setAllAlerts] = useState([])

  useEffect(() => { loadAlerts() }, [filters])
  useEffect(() => { loadStatsSource() }, [])
  useEffect(() => { if (selectedId) loadDetail(selectedId) }, [selectedId])

  async function loadAlerts() {
    setLoading(true)
    const params = new URLSearchParams(Object.entries(filters).filter(([, v]) => v))
    try {
      const data = await adminGet(`/fraud/alerts?${params.toString()}`)
      if (data?.success !== false) setAlerts(Array.isArray(data) ? data : data?.alerts || [])
    } catch { setAlerts([]) }
    setLoading(false)
  }

  async function loadStatsSource() {
    try {
      const data = await adminGet('/fraud/alerts')
      setAllAlerts(Array.isArray(data) ? data : data?.alerts || [])
    } catch { setAllAlerts([]) }
  }

  async function loadDetail(id) {
    setDetailLoading(true)
    try {
      const data = await adminGet(`/fraud/alerts/${id}`)
      setDetail(data)
    } catch { setDetail(null) }
    setDetailLoading(false)
  }

  async function changeStatus(id, status) {
    try {
      await adminPatch(`/fraud/alerts/${id}/status`, { status })
      await loadAlerts()
      await loadStatsSource()
      if (selectedId === id) await loadDetail(id)
    } catch {}
  }

  async function confirmFreeze() {
    if (!selectedId || !freezeReason.trim()) return
    setFreezeBusy(true)
    try {
      await adminPost(`/fraud/alerts/${selectedId}/freeze-account`, { reason: freezeReason.trim() })
      setFreezeOpen(false)
      setFreezeReason('')
      await loadDetail(selectedId)
      await loadAlerts()
    } catch {}
    setFreezeBusy(false)
  }

  const now = Date.now()
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000
  const stats = {
    total: allAlerts.length,
    unreviewed: allAlerts.filter(a => a.status === 'unreviewed').length,
    escalated: allAlerts.filter(a => a.status === 'escalated').length,
    resolvedThisWeek: allAlerts.filter(a => a.status === 'dismissed' && new Date(a.created_at).getTime() >= weekAgo).length,
  }

  const columns = [
    { key: 'user', label: 'User', render: r => <div><strong>{r.name}</strong><div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{r.account_number}</div></div> },
    { key: 'anomaly_type', label: 'Anomaly Type', render: r => <Badge label={(ANOMALY_MAP[r.anomaly_type]?.label) || r.anomaly_type} color={ANOMALY_MAP[r.anomaly_type]?.color || 'muted'} /> },
    { key: 'message', label: 'Description' },
    { key: 'status', label: 'Status', render: r => <Badge label={r.status.replace('_', ' ')} color={STATUS_COLOR[r.status] || 'muted'} /> },
    { key: 'created_at', label: 'Date', render: r => formatTimestamp(r.created_at) },
    { key: 'reviewed_by_name', label: 'Reviewed By', render: r => r.reviewed_by_name || '—' },
    {
      key: 'actions', label: 'Actions', render: r => (
        <div style={{ display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
          <button className="fa-view-btn" onClick={() => setSelectedId(r.id)}>View</button>
          <select className="fa-status-select" value={r.status} onChange={e => changeStatus(r.id, e.target.value)}>
            {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select>
        </div>
      )
    },
  ]

  return (
    <div className="fa-wrap">
      <style>{`
        .fa-wrap { max-width: 1280px; margin: 0 auto; }
        .fa-stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 20px; }
        .fa-filter-bar { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; align-items: center; }
        .fa-filter-bar select, .fa-filter-bar input {
          padding: 8px 12px; border: 1px solid var(--color-border); border-radius: 7px; font-size: 12.5px;
          background: var(--color-card-bg); color: var(--color-text-primary);
        }
        .fa-view-btn { background: var(--color-primary-light); color: var(--color-primary); border: none; border-radius: 6px; padding: 5px 10px; font-size: 11.5px; font-weight: 700; cursor: pointer; }
        .fa-status-select { font-size: 11px; padding: 4px 6px; }
        .fa-drawer-overlay { position: fixed; inset: 0; background: rgba(15,10,25,0.4); z-index: 400; }
        .fa-drawer { position: fixed; top: 0; right: 0; width: min(480px, 92vw); height: 100%; background: var(--color-card-bg); z-index: 410; box-shadow: -10px 0 30px rgba(0,0,0,0.2); overflow-y: auto; padding: 24px; }
        .fa-drawer-close { position: absolute; top: 18px; right: 20px; background: none; border: none; font-size: 22px; cursor: pointer; color: var(--color-text-muted); }
        .fa-drawer h3 { margin: 4px 0 2px; font-size: 18px; color: var(--color-text-primary); }
        .fa-drawer-sub { font-size: 12.5px; color: var(--color-text-muted); margin-bottom: 18px; }
        .fa-drawer-section { margin-bottom: 20px; }
        .fa-drawer-section h4 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--color-text-secondary); margin: 0 0 10px; }
        .fa-info-row { display: flex; justify-content: space-between; padding: 7px 0; border-bottom: 1px solid var(--color-border); font-size: 13px; }
        .fa-info-row span { color: var(--color-text-secondary); }
        .fa-info-row strong { color: var(--color-text-primary); }
        .fa-txn-table { width: 100%; font-size: 12px; border-collapse: collapse; }
        .fa-txn-table td { padding: 6px 4px; border-bottom: 1px solid var(--color-border); }
        .fa-drawer-actions { display: flex; flex-direction: column; gap: 8px; margin-top: 24px; }
        .fa-btn { padding: 11px; border-radius: 7px; font-weight: 700; font-size: 12.5px; cursor: pointer; border: none; text-transform: uppercase; }
        .fa-btn-neutral { background: var(--color-content-bg); color: var(--color-text-primary); }
        .fa-btn-warning { background: var(--color-warning-light); color: #92400e; }
        .fa-btn-muted { background: var(--color-content-bg); color: var(--color-text-secondary); }
        .fa-btn-danger { background: var(--color-danger); color: #fff; }
        .fa-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        textarea.fa-reason { width: 100%; min-height: 90px; padding: 10px; border: 1px solid var(--color-border); border-radius: 7px; font-size: 13px; font-family: inherit; resize: vertical; }
      `}</style>

      <div className="fa-stats-row">
        <StatCard label="Total Alerts" value={stats.total} icon="fa-list" />
        <StatCard label="Unreviewed" value={stats.unreviewed} accent="danger" trendType={stats.unreviewed > 0 ? 'down' : 'up'} trend={stats.unreviewed > 0 ? 'Needs attention' : 'All clear'} icon="fa-triangle-exclamation" />
        <StatCard label="Escalated" value={stats.escalated} accent="warning" icon="fa-arrow-up" />
        <StatCard label="Resolved This Week" value={stats.resolvedThisWeek} accent="success" icon="fa-check" />
      </div>

      <div className="fa-filter-bar">
        <select value={filters.anomaly_type} onChange={e => setFilters(f => ({ ...f, anomaly_type: e.target.value }))}>
          <option value="">All Types</option>
          {ANOMALY_TYPES.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}
        </select>
        <select value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}>
          <option value="">All Statuses</option>
          {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </select>
        <input type="date" value={filters.date_from} onChange={e => setFilters(f => ({ ...f, date_from: e.target.value }))} />
        <input type="date" value={filters.date_to} onChange={e => setFilters(f => ({ ...f, date_to: e.target.value }))} />
        <input type="text" placeholder="Search account or name..." value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))} style={{ minWidth: 200 }} />
      </div>

      {loading ? <LoadingSpinner label="Loading fraud alerts..." /> : (
        <DataTable columns={columns} rows={alerts} onRowClick={r => setSelectedId(r.id)}
          emptyIcon="fa-shield-halved" emptyTitle="No fraud alerts" emptyMessage="Nothing matches the current filters — all clear." />
      )}

      {selectedId && (
        <>
          <div className="fa-drawer-overlay" onClick={() => setSelectedId(null)} />
          <div className="fa-drawer">
            <button className="fa-drawer-close" onClick={() => setSelectedId(null)}>×</button>
            {detailLoading || !detail ? <LoadingSpinner label="Loading alert..." /> : (
              <>
                <h3>{detail.user?.name}</h3>
                <div className="fa-drawer-sub">{detail.user?.account_number} · <Badge label={detail.user?.account_status || 'active'} color={detail.user?.account_status === 'frozen' ? 'danger' : 'success'} /></div>

                <div className="fa-drawer-section">
                  <h4>Alert Detail</h4>
                  <Badge label={ANOMALY_MAP[detail.alert?.anomaly_type]?.label || detail.alert?.anomaly_type} color={ANOMALY_MAP[detail.alert?.anomaly_type]?.color || 'muted'} />
                  <p style={{ fontSize: 13, color: 'var(--color-text-primary)', marginTop: 10 }}>{detail.alert?.message}</p>
                  <div className="fa-info-row"><span>Timestamp</span><strong>{formatTimestamp(detail.alert?.created_at)}</strong></div>
                  <div className="fa-info-row"><span>Current Balance</span><strong>{formatPKR(detail.user?.balance)}</strong></div>
                </div>

                <div className="fa-drawer-section">
                  <h4>Last 10 Transactions</h4>
                  <table className="fa-txn-table">
                    <tbody>
                      {(detail.recent_transactions || []).length === 0 ? (
                        <tr><td colSpan={3} style={{ color: 'var(--color-text-muted)', textAlign: 'center', padding: 12 }}>No transaction history</td></tr>
                      ) : detail.recent_transactions.map(t => (
                        <tr key={t.id}>
                          <td>{t.description}</td>
                          <td style={{ color: t.amount < 0 ? 'var(--color-danger)' : 'var(--color-success)' }}>{formatPKR(t.amount)}</td>
                          <td style={{ color: 'var(--color-text-muted)' }}>{t.date}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="fa-drawer-actions">
                  <button className="fa-btn fa-btn-neutral" onClick={() => changeStatus(detail.alert.id, 'under_review')}>Mark Reviewed</button>
                  <button className="fa-btn fa-btn-warning" onClick={() => changeStatus(detail.alert.id, 'escalated')}>Mark Escalated</button>
                  <button className="fa-btn fa-btn-muted" onClick={() => changeStatus(detail.alert.id, 'dismissed')}>Dismiss</button>
                  <button className="fa-btn fa-btn-danger" onClick={() => setFreezeOpen(true)}>Freeze Account</button>
                </div>
              </>
            )}
          </div>
        </>
      )}

      <Modal
        open={freezeOpen}
        onClose={() => setFreezeOpen(false)}
        title={`Freeze account for ${detail?.user?.name}?`}
        danger
        footer={<>
          <button className="fa-btn fa-btn-neutral" onClick={() => setFreezeOpen(false)}>Cancel</button>
          <button className="fa-btn fa-btn-danger" onClick={confirmFreeze} disabled={freezeBusy || !freezeReason.trim()}>{freezeBusy ? 'Freezing...' : 'Confirm Freeze'}</button>
        </>}
      >
        <p>This will lock all cards and block all transactions for {detail?.user?.name}. Enter a reason:</p>
        <textarea className="fa-reason" value={freezeReason} onChange={e => setFreezeReason(e.target.value)} placeholder="Reason for freezing this account..." />
      </Modal>
    </div>
  )
}