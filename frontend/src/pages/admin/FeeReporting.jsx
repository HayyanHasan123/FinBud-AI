import { useState, useEffect } from 'react'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import { adminGet, adminDownload, formatPKR, formatTimestamp } from '../../utils/adminApi'
import StatCard from '../../components/shared/StatCard'
import DataTable from '../../components/shared/DataTable'
import LoadingSpinner from '../../components/shared/LoadingSpinner'
import EmptyState from '../../components/shared/EmptyState'

export default function FeeReporting() {
  const [summary, setSummary] = useState(null)
  const [summaryLoading, setSummaryLoading] = useState(true)

  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [page, setPage] = useState(1)
  const [ledger, setLedger] = useState({ fees: [], total: 0, page: 1, pages: 1 })
  const [ledgerLoading, setLedgerLoading] = useState(true)
  const [exporting, setExporting] = useState(false)

  useEffect(() => { loadSummary() }, [])
  useEffect(() => { loadLedger() }, [dateFrom, dateTo, page])

  async function loadSummary() {
    setSummaryLoading(true)
    try {
      const data = await adminGet('/fees/summary')
      if (data?.success) setSummary(data)
    } catch {}
    setSummaryLoading(false)
  }

  function buildParams() {
    const params = new URLSearchParams({ page })
    if (dateFrom) params.set('date_from', dateFrom)
    if (dateTo) params.set('date_to', dateTo)
    return params
  }

  async function loadLedger() {
    setLedgerLoading(true)
    try {
      const data = await adminGet(`/fees/ledger?${buildParams().toString()}`)
      if (data?.success !== false) setLedger({ fees: data.fees || [], total: data.total || 0, page: data.page || 1, pages: data.pages || 1 })
    } catch { setLedger({ fees: [], total: 0, page: 1, pages: 1 }) }
    setLedgerLoading(false)
  }

  async function handleExport() {
    setExporting(true)
    try {
      await adminDownload(`/fees/export?${buildParams().toString()}`, `finbud-fees-${Date.now()}.csv`)
    } catch {}
    setExporting(false)
  }

  const projectedAnnual = summary ? summary.fees_this_month * 12 : null
  const avgFeeRate = summary && summary.transaction_count_this_month > 0
    ? (summary.fees_this_month / summary.transaction_count_this_month)
    : null

  const columns = [
    { key: 'created_at', label: 'Date', render: r => formatTimestamp(r.created_at) },
    { key: 'transaction_id', label: 'Transaction ID', render: r => `#${r.transaction_id}` },
    { key: 'account_number', label: 'Account' },
    { key: 'name', label: 'User Name' },
    { key: 'transfer_amount', label: 'Transfer Amount', align: 'right', render: r => formatPKR(r.transfer_amount) },
    { key: 'fee_amount', label: 'Fee Amount', align: 'right', render: r => formatPKR(r.fee_amount) },
    { key: 'fee_percentage', label: 'Fee %', align: 'right', render: r => `${(Number(r.fee_percentage) * 100).toFixed(2)}%` },
  ]

  return (
    <div className="fr-wrap">
      <style>{`
        .fr-wrap { max-width: 1280px; margin: 0 auto; }
        .fr-stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 20px; }
        .fr-card { background: var(--color-card-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 20px; box-shadow: var(--shadow-card); margin-bottom: 20px; }
        .fr-card h3 { margin: 0 0 16px; font-size: 14.5px; font-weight: 700; color: var(--color-text-primary); }
        .fr-filter-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; flex-wrap: wrap; gap: 10px; }
        .fr-filter-bar { display: flex; gap: 10px; }
        .fr-filter-bar input { padding: 8px 12px; border: 1px solid var(--color-border); border-radius: 7px; font-size: 12.5px; }
        .fr-export-btn { background: var(--color-primary); color: #fff; border: none; border-radius: 8px; padding: 9px 18px; font-weight: 700; font-size: 12px; cursor: pointer; }
        .fr-export-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .fr-canvas-card { background: linear-gradient(135deg, var(--color-primary) 0%, #7c3fb3 100%); color: #fff; border: none; }
        .fr-canvas-card h3 { color: #fff; }
        .fr-canvas-row { display: flex; gap: 32px; flex-wrap: wrap; margin-top: 10px; }
        .fr-canvas-stat span { display: block; font-size: 11px; opacity: 0.8; text-transform: uppercase; margin-bottom: 4px; }
        .fr-canvas-stat strong { font-size: 22px; font-weight: 700; }
      `}</style>

      {summaryLoading ? <LoadingSpinner label="Loading fee summary..." /> : (
        <div className="fr-stats-row">
          <StatCard label="Fees Today" value={formatPKR(summary?.fees_today)} icon="fa-sack-dollar" />
          <StatCard label="Fees This Month" value={formatPKR(summary?.fees_this_month)} icon="fa-calendar" accent="success" />
          <StatCard label="Fees All Time" value={formatPKR(summary?.fees_all_time)} icon="fa-vault" />
          <StatCard label="Avg Fee / Transaction" value={formatPKR(summary?.avg_fee_per_transaction)} icon="fa-calculator" />
        </div>
      )}

      <div className="fr-card">
        <h3>Daily Fee Revenue — Last 30 Days</h3>
        {!summary?.daily_trend || summary.daily_trend.length === 0 ? (
          <EmptyState icon="fa-chart-column" title="No fee data yet" message="This fills in once transfers start generating fees." />
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={summary.daily_trend}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={v => formatPKR(v)} />
              <Bar dataKey="fee_total" fill="#5c2d91" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="fr-filter-row">
        <h3 style={{ margin: 0, fontSize: 15, color: 'var(--color-text-primary)' }}>Fee Ledger</h3>
        <div className="fr-filter-bar">
          <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1) }} />
          <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1) }} />
          <button className="fr-export-btn" onClick={handleExport} disabled={exporting}>{exporting ? 'Exporting...' : 'Export CSV'}</button>
        </div>
      </div>

      {ledgerLoading ? <LoadingSpinner label="Loading ledger..." /> : (
        <DataTable columns={columns} rows={ledger.fees} page={ledger.page} totalPages={ledger.pages} onPageChange={setPage}
          emptyIcon="fa-receipt" emptyTitle="No fees recorded" emptyMessage="Nothing matches this date range." />
      )}

      {summary && (
        <div className="fr-card fr-canvas-card" style={{ marginTop: 20 }}>
          <h3>Fee & Revenue Summary — Business Model Canvas</h3>
          <div className="fr-canvas-row">
            <div className="fr-canvas-stat"><span>Revenue This Month</span><strong>{formatPKR(summary.fees_this_month)}</strong></div>
            <div className="fr-canvas-stat"><span>Avg Fee / Transaction</span><strong>{avgFeeRate != null ? formatPKR(avgFeeRate) : '—'}</strong></div>
            <div className="fr-canvas-stat"><span>Projected Annual Revenue</span><strong>{projectedAnnual != null ? formatPKR(projectedAnnual) : '—'}</strong></div>
          </div>
          <p style={{ fontSize: 11.5, opacity: 0.85, marginTop: 14, marginBottom: 0 }}>Projection = current month's fee revenue × 12 — a simple run-rate estimate for the pitch deck, not a forecast model.</p>
        </div>
      )}
    </div>
  )
}