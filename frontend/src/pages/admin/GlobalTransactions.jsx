import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { adminGet, adminDownload, formatPKR, formatTimestamp } from '../../utils/adminApi'
import StatCard from '../../components/shared/StatCard'
import DataTable from '../../components/shared/DataTable'
import Badge from '../../components/shared/Badge'
import LoadingSpinner from '../../components/shared/LoadingSpinner'

const TYPES = ['transfer', 'bill', 'redemption', 'income', 'topup']

export default function GlobalTransactions() {
  const navigate = useNavigate()
  const [typeFilter, setTypeFilter] = useState('')
  const [amountMin, setAmountMin] = useState('')
  const [amountMax, setAmountMax] = useState('')
  const [anomalyOnly, setAnomalyOnly] = useState(false)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [accountSearch, setAccountSearch] = useState('')
  const [page, setPage] = useState(1)

  const [rows, setRows] = useState({ transactions: [], total: 0, page: 1, pages: 1, summary: { total_count: 0, total_volume: 0, flagged_count: 0 } })
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)

  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)

  useEffect(() => { load() }, [typeFilter, amountMin, amountMax, anomalyOnly, dateFrom, dateTo, accountSearch, page])

  function buildParams() {
    const params = new URLSearchParams({ page })
    if (typeFilter) params.set('type_filter', typeFilter)
    if (amountMin) params.set('amount_min', amountMin)
    if (amountMax) params.set('amount_max', amountMax)
    if (anomalyOnly) params.set('anomaly_only', 'true')
    if (dateFrom) params.set('date_from', dateFrom)
    if (dateTo) params.set('date_to', dateTo)
    if (accountSearch) params.set('account_number', accountSearch)
    return params
  }

  async function load() {
    setLoading(true)
    try {
      const data = await adminGet(`/transactions?${buildParams().toString()}`)
      if (data?.success !== false) {
        setRows({
          transactions: data.transactions || [],
          total: data.total || 0,
          page: data.page || 1,
          pages: data.pages || 1,
          summary: data.summary || { total_count: 0, total_volume: 0, flagged_count: 0 }
        })
      }
    } catch {
      setRows({ transactions: [], total: 0, page: 1, pages: 1, summary: { total_count: 0, total_volume: 0, flagged_count: 0 } })
    }
    setLoading(false)
  }

  async function openDetail(id) {
    setSelected(id)
    setDetailLoading(true)
    try {
      const data = await adminGet(`/transactions/${id}`)
      setDetail(data)
    } catch { setDetail(null) }
    setDetailLoading(false)
  }

  async function handleExport() {
    setExporting(true)
    try {
      await adminDownload(`/transactions/export?${buildParams().toString()}`, `finbud-transactions-${Date.now()}.csv`)
    } catch {}
    setExporting(false)
  }

  const columns = [
    { key: 'id', label: 'TXN ID', render: r => <strong>#{r.id}</strong> },
    { key: 'name', label: 'User', render: r => (
      <span className="gt-user-link" onClick={e => { e.stopPropagation(); navigate(`/admin/activity?account=${encodeURIComponent(r.account_number)}`) }}>
        {r.name}<div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{r.account_number}</div>
      </span>
    )},
    { key: 'transaction_type', label: 'Type', render: r => <Badge label={r.transaction_type} color="primary" /> },
    { key: 'description', label: 'Description' },
    { key: 'amount', label: 'Amount', align: 'right', render: r => <span style={{ color: r.amount < 0 ? 'var(--color-danger)' : 'var(--color-success)', fontWeight: 600 }}>{formatPKR(r.amount)}</span> },
    { key: 'status', label: 'Status', render: r => <Badge label={r.status} color={r.status === 'completed' ? 'success' : 'warning'} /> },
    { key: 'anomaly_flagged', label: 'Anomaly', render: r => r.anomaly_flagged ? <span title={r.anomaly_type} style={{ color: 'var(--color-danger)' }}><i className="fas fa-triangle-exclamation" /> {r.anomaly_type}</span> : '—' },
    { key: 'created_at', label: 'Date', render: r => formatTimestamp(r.created_at) },
    { key: 'actions', label: 'Actions', render: r => (
      <button className="gt-view-btn" onClick={e => { e.stopPropagation(); openDetail(r.id) }}>View Receipt</button>
    )},
  ]

  return (
    <div className="gt-wrap">
      <style>{`
        .gt-wrap { max-width: 1320px; margin: 0 auto; }
        .gt-top-row { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 20px; gap: 16px; }
        .gt-stats-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; flex-grow: 1; }
        .gt-export-btn { background: var(--color-primary); color: #fff; border: none; border-radius: 8px; padding: 12px 20px; font-weight: 700; font-size: 12.5px; cursor: pointer; white-space: nowrap; }
        .gt-export-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .gt-filter-bar { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
        .gt-filter-bar select, .gt-filter-bar input { padding: 8px 12px; border: 1px solid var(--color-border); border-radius: 7px; font-size: 12.5px; }
        .gt-toggle-label { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--color-text-secondary); cursor: pointer; }
        .gt-user-link { cursor: pointer; }
        .gt-user-link:hover { color: var(--color-primary); }
        .gt-view-btn { background: var(--color-primary-light); color: var(--color-primary); border: none; border-radius: 6px; padding: 5px 10px; font-size: 11.5px; font-weight: 700; cursor: pointer; }
        .gt-drawer-overlay { position: fixed; inset: 0; background: rgba(15,10,25,0.4); z-index: 400; }
        .gt-drawer { position: fixed; top: 0; right: 0; width: min(440px, 92vw); height: 100%; background: var(--color-card-bg); z-index: 410; box-shadow: -10px 0 30px rgba(0,0,0,0.2); overflow-y: auto; padding: 24px; }
        .gt-drawer-close { position: absolute; top: 18px; right: 20px; background: none; border: none; font-size: 22px; cursor: pointer; color: var(--color-text-muted); }
        .gt-drawer h3 { margin: 4px 0 18px; font-size: 24px; color: var(--color-text-primary); }
        .gt-info-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--color-border); font-size: 13px; }
        .gt-link { color: var(--color-primary); font-size: 12.5px; font-weight: 600; text-decoration: none; display: block; margin-top: 16px; }
      `}</style>

      <div className="gt-top-row">
        <div className="gt-stats-row">
          <StatCard label="Total Transactions" value={rows.summary.total_count.toLocaleString('en-PK')} icon="fa-list" />
          <StatCard label="Total PKR Volume" value={formatPKR(rows.summary.total_volume)} icon="fa-sack-dollar" />
          <StatCard label="Flagged Transactions" value={rows.summary.flagged_count} accent="danger" icon="fa-triangle-exclamation" />
        </div>
        <button className="gt-export-btn" onClick={handleExport} disabled={exporting}>
          <i className="fas fa-download" /> {exporting ? 'Exporting...' : 'Export CSV'}
        </button>
      </div>

      <div className="gt-filter-bar">
        <select value={typeFilter} onChange={e => { setTypeFilter(e.target.value); setPage(1) }}>
          <option value="">All Types</option>
          {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <input type="number" placeholder="Min PKR" value={amountMin} onChange={e => { setAmountMin(e.target.value); setPage(1) }} style={{ width: 100 }} />
        <input type="number" placeholder="Max PKR" value={amountMax} onChange={e => { setAmountMax(e.target.value); setPage(1) }} style={{ width: 100 }} />
        <label className="gt-toggle-label">
          <input type="checkbox" checked={anomalyOnly} onChange={e => { setAnomalyOnly(e.target.checked); setPage(1) }} />
          Flagged only
        </label>
        <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1) }} />
        <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1) }} />
        <input type="text" placeholder="Account number..." value={accountSearch} onChange={e => { setAccountSearch(e.target.value); setPage(1) }} style={{ minWidth: 160 }} />
      </div>

      {loading ? <LoadingSpinner label="Loading transactions..." /> : (
        <DataTable columns={columns} rows={rows.transactions} page={rows.page} totalPages={rows.pages} onPageChange={setPage}
          emptyIcon="fa-money-bill-transfer" emptyTitle="No transactions" emptyMessage="Nothing matches these filters." />
      )}

      {selected && (
        <>
          <div className="gt-drawer-overlay" onClick={() => setSelected(null)} />
          <div className="gt-drawer">
            <button className="gt-drawer-close" onClick={() => setSelected(null)}>×</button>
            {detailLoading || !detail ? <LoadingSpinner label="Loading receipt..." /> : (
              <>
                <h3>#{detail.transaction_id || detail.id}</h3>
                <div className="gt-info-row"><span>User</span><strong>{detail.user?.name} ({detail.account_number})</strong></div>
                <div className="gt-info-row"><span>Type</span><Badge label={detail.transaction_type} color="primary" /></div>
                <div className="gt-info-row"><span>Description</span><strong>{detail.description}</strong></div>
                <div className="gt-info-row"><span>Amount</span><strong>{formatPKR(detail.amount)}</strong></div>
                <div className="gt-info-row"><span>Status</span><Badge label={detail.status} color={detail.status === 'completed' ? 'success' : 'warning'} /></div>
                <div className="gt-info-row"><span>Date</span><strong>{formatTimestamp(detail.created_at)}</strong></div>
                {detail.recipient && <div className="gt-info-row"><span>Recipient</span><strong>{detail.recipient}</strong></div>}
                {detail.biller && <div className="gt-info-row"><span>Biller</span><strong>{detail.biller}</strong></div>}
                {detail.anomaly_flagged && (
                  <div className="gt-info-row"><span>Anomaly</span><Badge label={detail.anomaly_type} color="danger" /></div>
                )}
                <a className="gt-link" href={`/admin/activity?account=${encodeURIComponent(detail.account_number)}`}>View user's full activity log →</a>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}