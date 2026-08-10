import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAdminAuth } from '../../context/AdminAuthContext'
import { adminGet, adminPatch, formatPKR, formatTimestamp } from '../../utils/adminApi'
import DataTable from '../../components/shared/DataTable'
import Badge from '../../components/shared/Badge'
import Modal from '../../components/shared/Modal'
import LoadingSpinner from '../../components/shared/LoadingSpinner'

const KYC_COLOR = { pending: 'warning', approved: 'success', flagged: 'danger' }

export default function UserManagement() {
  const { isAdmin } = useAdminAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  const [search, setSearch] = useState('')
  const [kycStatus, setKycStatus] = useState('')
  const [accountStatus, setAccountStatus] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState({ users: [], total: 0, page: 1, pages: 1 })
  const [loading, setLoading] = useState(true)

  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const [freezeOpen, setFreezeOpen] = useState(false)
  const [freezeReason, setFreezeReason] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => { load() }, [search, kycStatus, accountStatus, dateFrom, dateTo, page])

  // Deep-link from AdminLayout's header search bar (?account=ACC123)
  useEffect(() => {
    const acc = searchParams.get('account')
    if (acc) { openDetail(acc); }
  }, [searchParams])

  async function load() {
    setLoading(true)
    const params = new URLSearchParams({ page })
    if (search) params.set('search', search)
    if (kycStatus) params.set('kyc_status', kycStatus)
    if (accountStatus) params.set('account_status', accountStatus)
    if (dateFrom) params.set('date_from', dateFrom)
    if (dateTo) params.set('date_to', dateTo)
    try {
      const data = await adminGet(`/users?${params.toString()}`)
      if (data?.success !== false) setRows({ users: data.users || [], total: data.total || 0, page: data.page || 1, pages: data.pages || 1 })
    } catch { setRows({ users: [], total: 0, page: 1, pages: 1 }) }
    setLoading(false)
  }

  async function openDetail(accountNumber) {
    setSelected(accountNumber)
    setDetailLoading(true)
    try {
      const data = await adminGet(`/users/${encodeURIComponent(accountNumber)}`)
      setDetail(data)
    } catch { setDetail(null) }
    setDetailLoading(false)
  }

  function closeDetail() {
    setSelected(null)
    setDetail(null)
    if (searchParams.get('account')) {
      const next = new URLSearchParams(searchParams)
      next.delete('account')
      setSearchParams(next)
    }
  }

  async function toggleFreeze(newStatus) {
    if (newStatus === 'frozen') { setFreezeOpen(true); return }
    // Unfreeze doesn't need a reason per spec — only freezing does
    setBusy(true)
    try {
      await adminPatch(`/users/${encodeURIComponent(selected)}/status`, { status: 'active', reason: 'Unfrozen by admin' })
      await openDetail(selected)
      await load()
    } catch {}
    setBusy(false)
  }

  async function confirmFreeze() {
    if (!freezeReason.trim()) return
    setBusy(true)
    try {
      await adminPatch(`/users/${encodeURIComponent(selected)}/status`, { status: 'frozen', reason: freezeReason.trim() })
      setFreezeOpen(false)
      setFreezeReason('')
      await openDetail(selected)
      await load()
    } catch {}
    setBusy(false)
  }

  const columns = [
    { key: 'user', label: 'User', render: r => <div><strong>{r.name}</strong><div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{r.account_number}</div></div> },
    { key: 'email', label: 'Email', render: r => r.email ?? <span style={{ color: 'var(--color-text-muted)' }}>hidden</span> },
    { key: 'balance', label: 'Balance', align: 'right', render: r => r.balance != null ? formatPKR(r.balance) : <span style={{ color: 'var(--color-text-muted)' }}>••••••</span> },
    { key: 'points', label: 'Points', align: 'right', render: r => r.points != null ? r.points : <span style={{ color: 'var(--color-text-muted)' }}>••</span> },
    { key: 'kyc_status', label: 'KYC', render: r => <Badge label={r.kyc_status} color={KYC_COLOR[r.kyc_status] || 'muted'} /> },
    { key: 'account_status', label: 'Account', render: r => <Badge label={r.account_status} color={r.account_status === 'frozen' ? 'danger' : 'success'} /> },
    { key: 'created_at', label: 'Registered', render: r => formatTimestamp(r.created_at) },
    { key: 'actions', label: 'Actions', render: r => (
      <button className="um-view-btn" onClick={e => { e.stopPropagation(); openDetail(r.account_number) }}>View</button>
    )},
  ]

  return (
    <div className="um-wrap">
      <style>{`
        .um-wrap { max-width: 1280px; margin: 0 auto; }
        .um-filter-bar { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; }
        .um-filter-bar select, .um-filter-bar input { padding: 8px 12px; border: 1px solid var(--color-border); border-radius: 7px; font-size: 12.5px; }
        .um-view-btn { background: var(--color-primary-light); color: var(--color-primary); border: none; border-radius: 6px; padding: 5px 10px; font-size: 11.5px; font-weight: 700; cursor: pointer; }
        .um-drawer-overlay { position: fixed; inset: 0; background: rgba(15,10,25,0.4); z-index: 400; }
        .um-drawer { position: fixed; top: 0; right: 0; width: min(460px, 92vw); height: 100%; background: var(--color-card-bg); z-index: 410; box-shadow: -10px 0 30px rgba(0,0,0,0.2); overflow-y: auto; padding: 24px; }
        .um-drawer-close { position: absolute; top: 18px; right: 20px; background: none; border: none; font-size: 22px; cursor: pointer; color: var(--color-text-muted); }
        .um-drawer h3 { margin: 4px 0 14px; font-size: 18px; color: var(--color-text-primary); }
        .um-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; margin-bottom: 20px; }
        .um-field { padding: 8px 0; border-bottom: 1px solid var(--color-border); }
        .um-field span { display: block; font-size: 10.5px; text-transform: uppercase; color: var(--color-text-muted); margin-bottom: 2px; }
        .um-field strong { font-size: 13px; color: var(--color-text-primary); }
        .um-section { margin-bottom: 20px; }
        .um-section h4 { font-size: 12px; text-transform: uppercase; color: var(--color-text-secondary); margin: 0 0 10px; }
        .um-card-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--color-border); font-size: 12.5px; }
        .um-link { color: var(--color-primary); font-size: 12.5px; font-weight: 600; text-decoration: none; }
        .um-btn { width: 100%; padding: 11px; border-radius: 7px; font-weight: 700; font-size: 12.5px; cursor: pointer; border: none; text-transform: uppercase; margin-top: 8px; }
        textarea.um-reason { width: 100%; min-height: 90px; padding: 10px; border: 1px solid var(--color-border); border-radius: 7px; font-size: 13px; font-family: inherit; resize: vertical; }
      `}</style>

      <div className="um-filter-bar">
        <input type="text" placeholder="Search name, email, account..." value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} style={{ minWidth: 220 }} />
        <select value={kycStatus} onChange={e => { setKycStatus(e.target.value); setPage(1) }}>
          <option value="">All KYC Status</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="flagged">Flagged</option>
        </select>
        <select value={accountStatus} onChange={e => { setAccountStatus(e.target.value); setPage(1) }}>
          <option value="">All Account Status</option>
          <option value="active">Active</option>
          <option value="frozen">Frozen</option>
        </select>
        <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1) }} />
        <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1) }} />
      </div>

      {loading ? <LoadingSpinner label="Loading users..." /> : (
        <DataTable columns={columns} rows={rows.users} page={rows.page} totalPages={rows.pages} onPageChange={setPage}
          onRowClick={r => openDetail(r.account_number)}
          emptyIcon="fa-users" emptyTitle="No users found" emptyMessage="Nothing matches these filters." />
      )}

      {selected && (
        <>
          <div className="um-drawer-overlay" onClick={closeDetail} />
          <div className="um-drawer">
            <button className="um-drawer-close" onClick={closeDetail}>×</button>
            {detailLoading || !detail ? <LoadingSpinner label="Loading user..." /> : (
              <>
                <h3>{detail.user?.name} <Badge label={detail.user?.account_status} color={detail.user?.account_status === 'frozen' ? 'danger' : 'success'} /></h3>

                {isAdmin ? (
                  <div className="um-grid">
                    <div className="um-field"><span>Email</span><strong>{detail.user?.email}</strong></div>
                    <div className="um-field"><span>Phone</span><strong>{detail.user?.phone || '—'}</strong></div>
                    <div className="um-field"><span>Account Number</span><strong>{detail.user?.account_number}</strong></div>
                    <div className="um-field"><span>Language</span><strong>{detail.user?.language || 'en'}</strong></div>
                    <div className="um-field"><span>Balance</span><strong>{formatPKR(detail.user?.balance)}</strong></div>
                    <div className="um-field"><span>Points</span><strong>{detail.user?.points ?? 0}</strong></div>
                    <div className="um-field"><span>Registered</span><strong>{formatTimestamp(detail.user?.created_at)}</strong></div>
                    <div className="um-field"><span>Fraud Alerts</span><strong>{detail.fraud_alert_count ?? 0}</strong></div>
                  </div>
                ) : (
                  <div className="um-grid">
                    <div className="um-field"><span>Account Number</span><strong>{detail.user?.account_number}</strong></div>
                    <div className="um-field"><span>KYC Status</span><Badge label={detail.kyc?.status} color={KYC_COLOR[detail.kyc?.status] || 'muted'} /></div>
                  </div>
                )}

                <div className="um-section">
                  <h4>KYC</h4>
                  <div className="um-card-row"><span>Status</span><Badge label={detail.kyc?.status} color={KYC_COLOR[detail.kyc?.status] || 'muted'} /></div>
                  {isAdmin && <a className="um-link" href="/admin/kyc">Open in KYC queue →</a>}
                </div>

                <div className="um-section">
                  <h4>Cards</h4>
                  {(detail.cards || []).length === 0 ? <p style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>No cards on file.</p> : detail.cards.map((c, i) => (
                    <div key={i} className="um-card-row">
                      <span>{isAdmin ? c.card_number_masked : '**** **** **** ****'}{c.nickname ? ` · ${c.nickname}` : ''}</span>
                      <Badge label={c.status} color={c.status === 'locked' ? 'danger' : 'success'} />
                    </div>
                  ))}
                </div>

                {isAdmin && (
                  <>
                    <a className="um-link" href={`/admin/activity?account=${encodeURIComponent(selected)}`} style={{ display: 'block', marginBottom: 16 }}>View Full Activity Log →</a>
                    {detail.user?.account_status === 'frozen' ? (
                      <button className="um-btn" style={{ background: 'var(--color-success)', color: '#fff' }} onClick={() => toggleFreeze('active')} disabled={busy}>Unfreeze Account</button>
                    ) : (
                      <button className="um-btn" style={{ background: 'var(--color-danger)', color: '#fff' }} onClick={() => toggleFreeze('frozen')} disabled={busy}>Freeze Account</button>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}

      <Modal open={freezeOpen} onClose={() => setFreezeOpen(false)} title={`Freeze account for ${detail?.user?.name}?`} danger
        footer={<>
          <button className="um-view-btn" onClick={() => setFreezeOpen(false)}>Cancel</button>
          <button className="um-view-btn" style={{ background: 'var(--color-danger)', color: '#fff' }} onClick={confirmFreeze} disabled={busy || !freezeReason.trim()}>{busy ? 'Freezing...' : 'Confirm Freeze'}</button>
        </>}>
        <p>All cards will be locked and no transactions will be possible until unfrozen.</p>
        <textarea className="um-reason" value={freezeReason} onChange={e => setFreezeReason(e.target.value)} placeholder="Reason for freezing this account..." />
      </Modal>
    </div>
  )
}