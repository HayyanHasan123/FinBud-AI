import { useState, useEffect } from 'react'
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts'
import { adminGet, formatPKR, formatTimestamp } from '../../utils/adminApi'
import StatCard from '../../components/shared/StatCard'
import DataTable from '../../components/shared/DataTable'
import SearchInput from '../../components/shared/SearchInput'
import Badge from '../../components/shared/Badge'
import LoadingSpinner from '../../components/shared/LoadingSpinner'
import EmptyState from '../../components/shared/EmptyState'

const TIERS = [
  { key: 'cash_voucher', label: 'Cash Voucher (500 pts)' },
  { key: 'product_purchase', label: 'Product Purchase (1000 pts)' },
  { key: 'investment_pocket', label: 'Investment Pocket (750 pts)' },
]
const TIER_LABEL = Object.fromEntries(TIERS.map(t => [t.key, t.label]))

export default function RewardsManagement() {
  const [summary, setSummary] = useState(null)
  const [summaryLoading, setSummaryLoading] = useState(true)

  const [tierFilter, setTierFilter] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [ledger, setLedger] = useState({ redemptions: [], total: 0, page: 1, pages: 1 })
  const [ledgerLoading, setLedgerLoading] = useState(true)

  const [lookupUser, setLookupUser] = useState(null)
  const [lookupData, setLookupData] = useState(null)
  const [lookupLoading, setLookupLoading] = useState(false)

  useEffect(() => { loadSummary() }, [])
  useEffect(() => { loadLedger() }, [tierFilter, dateFrom, dateTo, search, page])

  async function loadSummary() {
    setSummaryLoading(true)
    try {
      const data = await adminGet('/rewards/summary')
      if (data?.success) setSummary(data)
    } catch {}
    setSummaryLoading(false)
  }

  async function loadLedger() {
    setLedgerLoading(true)
    const params = new URLSearchParams({ page })
    if (tierFilter) params.set('tier_filter', tierFilter)
    if (dateFrom) params.set('date_from', dateFrom)
    if (dateTo) params.set('date_to', dateTo)
    if (search) params.set('search', search)
    try {
      const data = await adminGet(`/rewards/redemptions?${params.toString()}`)
      if (data?.success !== false) setLedger({ redemptions: data.redemptions || [], total: data.total || 0, page: data.page || 1, pages: data.pages || 1 })
    } catch { setLedger({ redemptions: [], total: 0, page: 1, pages: 1 }) }
    setLedgerLoading(false)
  }

  async function searchUsers(q) {
    const data = await adminGet(`/activity/search-users?q=${encodeURIComponent(q)}`)
    return data?.success ? data.results : []
  }

  async function selectLookupUser(u) {
    setLookupUser(u)
    setLookupLoading(true)
    try {
      const data = await adminGet(`/rewards/user/${encodeURIComponent(u.account_number)}`)
      setLookupData(data)
    } catch { setLookupData(null) }
    setLookupLoading(false)
  }

  const ledgerColumns = [
    { key: 'created_at', label: 'Date', render: r => formatTimestamp(r.created_at) },
    { key: 'name', label: 'User Name' },
    { key: 'account_number', label: 'Account' },
    { key: 'points_used', label: 'Points Used', align: 'right' },
    { key: 'reward_value', label: 'Reward Value', align: 'right', render: r => formatPKR(r.reward_value) },
    { key: 'tier_label', label: 'Tier', render: r => <Badge label={r.tier_label || TIER_LABEL[r.tier] || r.tier} color="primary" /> },
  ]

  return (
    <div className="rw-wrap">
      <style>{`
        .rw-wrap { max-width: 1280px; margin: 0 auto; }
        .rw-stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 20px; }
        .rw-card { background: var(--color-card-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 20px; box-shadow: var(--shadow-card); margin-bottom: 20px; }
        .rw-card h3 { margin: 0 0 16px; font-size: 14.5px; font-weight: 700; color: var(--color-text-primary); }
        .rw-filter-bar { display: flex; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
        .rw-filter-bar select, .rw-filter-bar input { padding: 8px 12px; border: 1px solid var(--color-border); border-radius: 7px; font-size: 12.5px; }
        .rw-lookup-section { margin-top: 24px; }
        .rw-lookup-balance { font-size: 30px; font-weight: 700; color: var(--color-primary); margin: 14px 0 4px; }
        .rw-lookup-sub { font-size: 12px; color: var(--color-text-secondary); margin-bottom: 18px; }
        .rw-mini-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--color-border); font-size: 12.5px; }
      `}</style>

      {summaryLoading ? <LoadingSpinner label="Loading summary..." /> : (
        <div className="rw-stats-row">
          <StatCard label="Total Points Held" value={(summary?.total_points_held ?? 0).toLocaleString('en-PK')} icon="fa-coins" />
          <StatCard label="Redeemed This Month" value={(summary?.total_redeemed_this_month ?? 0).toLocaleString('en-PK')} icon="fa-gift" />
          <StatCard label="Cash Paid This Month" value={formatPKR(summary?.total_cash_paid_this_month)} icon="fa-money-bill" accent="success" />
          <StatCard label="Most Popular Tier" value={TIER_LABEL[summary?.most_popular_tier] || summary?.most_popular_tier || '—'} icon="fa-star" accent="warning" />
        </div>
      )}

      <div className="rw-card">
        <h3>Points Issued vs Redeemed — Last 8 Weeks</h3>
        {!summary?.weekly_trend || summary.weekly_trend.length === 0 ? (
          <EmptyState icon="fa-chart-line" title="No trend data yet" message="This chart fills in as more weeks of activity accumulate." />
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={summary.weekly_trend}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="week" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="points_issued" name="Points Issued" stroke="#5c2d91" strokeWidth={2.5} dot={{ r: 3 }} />
              <Line type="monotone" dataKey="points_redeemed" name="Points Redeemed" stroke="#22c55e" strokeWidth={2.5} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <h3 style={{ fontSize: 15, color: 'var(--color-text-primary)', marginBottom: 12 }}>Redemption Ledger</h3>
      <div className="rw-filter-bar">
        <select value={tierFilter} onChange={e => { setTierFilter(e.target.value); setPage(1) }}>
          <option value="">All Tiers</option>
          {TIERS.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1) }} />
        <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1) }} />
        <input type="text" placeholder="Search user..." value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} style={{ minWidth: 200 }} />
      </div>
      {ledgerLoading ? <LoadingSpinner label="Loading redemptions..." /> : (
        <DataTable columns={ledgerColumns} rows={ledger.redemptions} page={ledger.page} totalPages={ledger.pages} onPageChange={setPage}
          emptyIcon="fa-gift" emptyTitle="No redemptions" emptyMessage="Nothing matches these filters." />
      )}

      <div className="rw-lookup-section">
        <h3 style={{ fontSize: 15, color: 'var(--color-text-primary)', marginBottom: 12 }}>Per-User Points Lookup</h3>
        <div style={{ maxWidth: 420, marginBottom: 16 }}>
          <SearchInput placeholder="Search a user..." onSearch={searchUsers}
            renderResult={u => <><strong>{u.name}</strong><span>{u.account_number}</span></>}
            onSelect={selectLookupUser} />
        </div>
        {lookupUser && (
          <div className="rw-card" style={{ marginBottom: 0 }}>
            {lookupLoading ? <LoadingSpinner label="Loading..." /> : !lookupData ? (
              <EmptyState icon="fa-user" title="Could not load" message="Try selecting the user again." />
            ) : (
              <>
                <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>{lookupUser.name} · {lookupUser.account_number}</div>
                <div className="rw-lookup-balance">{(lookupData.current_points ?? 0).toLocaleString('en-PK')} pts</div>
                <div className="rw-lookup-sub">Earned all-time: {(lookupData.total_earned_all_time ?? 0).toLocaleString('en-PK')} · Redeemed all-time: {(lookupData.total_redeemed_all_time ?? 0).toLocaleString('en-PK')}</div>
                {(lookupData.redemption_history || []).length === 0 ? (
                  <p style={{ color: 'var(--color-text-muted)', fontSize: 12.5 }}>No redemption history yet.</p>
                ) : lookupData.redemption_history.map((r, i) => (
                  <div key={i} className="rw-mini-row">
                    <span>{formatTimestamp(r.created_at)}</span>
                    <strong>{r.points_used} pts → {formatPKR(r.reward_value)}</strong>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}