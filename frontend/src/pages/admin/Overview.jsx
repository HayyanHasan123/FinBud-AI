import { useState, useEffect } from 'react'
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, BarChart, Bar, Legend
} from 'recharts'
import { useAdminAuth } from '../../context/AdminAuthContext'
import { adminGet, formatPKR, formatTimestamp } from '../../utils/adminApi'
import StatCard from '../../components/shared/StatCard'
import LoadingSpinner from '../../components/shared/LoadingSpinner'
import EmptyState from '../../components/shared/EmptyState'
import Badge from '../../components/shared/Badge'

const PIE_COLORS = ['#5c2d91', '#a855f7', '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#64748b', '#eab308', '#f97316']

export default function AdminOverview() {
  const { isAdmin } = useAdminAuth()
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState(null)
  const [volumeData, setVolumeData] = useState([])
  const [intentData, setIntentData] = useState({ data: [], insufficientData: false })
  const [fallbackData, setFallbackData] = useState({ data: [], insufficientData: false })
  const [feed, setFeed] = useState({ fraud_alerts: [], tickets: [], kyc: [] })

  useEffect(() => { if (isAdmin) loadAll() }, [isAdmin])

  async function loadAll() {
    setLoading(true)
    const [statsRes, volumeRes, intentRes, fallbackRes, feedRes] = await Promise.allSettled([
      adminGet('/overview/stats'),
      adminGet('/overview/transaction-volume'),
      adminGet('/overview/intent-distribution'),
      adminGet('/overview/llm-fallback-rate'),
      adminGet('/overview/recent-feed')
    ])

    if (statsRes.status === 'fulfilled' && statsRes.value?.success) setStats(statsRes.value)
    if (volumeRes.status === 'fulfilled' && volumeRes.value?.success) setVolumeData(volumeRes.value.days || [])
    if (intentRes.status === 'fulfilled' && intentRes.value?.success) {
      setIntentData({ data: intentRes.value.data || [], insufficientData: !!intentRes.value.insufficient_data })
    }
    if (fallbackRes.status === 'fulfilled' && fallbackRes.value?.success) {
      setFallbackData({ data: fallbackRes.value.data || [], insufficientData: !!fallbackRes.value.insufficient_data })
    }
    if (feedRes.status === 'fulfilled' && feedRes.value?.success) {
      setFeed({
        fraud_alerts: feedRes.value.fraud_alerts || [],
        tickets: feedRes.value.tickets || [],
        kyc: feedRes.value.kyc || []
      })
    }
    setLoading(false)
  }

  if (!isAdmin) {
    return <EmptyState icon="fa-lock" title="Admin access required" message="Bankers don't have a landing dashboard — use the sidebar to jump straight to Chat Monitor or Tickets." />
  }

  return (
    <div className="ov-wrap">
      <style>{`
        .ov-wrap { max-width: 1280px; margin: 0 auto; }
        .ov-stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px; }
        .ov-charts-row { display: grid; grid-template-columns: 1.3fr 1fr 1fr; gap: 16px; margin-bottom: 24px; }
        .ov-card { background: var(--color-card-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 20px; box-shadow: var(--shadow-card); }
        .ov-card h3 { margin: 0 0 16px; font-size: 14.5px; font-weight: 700; color: var(--color-text-primary); }
        .ov-feeds-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
        .ov-feed-item { padding: 10px 0; border-bottom: 1px solid var(--color-border); font-size: 12.5px; }
        .ov-feed-item:last-child { border-bottom: none; }
        .ov-feed-item .ov-feed-main { color: var(--color-text-primary); font-weight: 600; margin-bottom: 3px; }
        .ov-feed-item .ov-feed-sub { color: var(--color-text-muted); }
        .ov-legend { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 10px; font-size: 11.5px; color: var(--color-text-secondary); }
        .ov-legend-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
        @media (max-width: 1200px) { .ov-charts-row { grid-template-columns: 1fr; } .ov-stats-row { grid-template-columns: repeat(2, 1fr); } .ov-feeds-row { grid-template-columns: 1fr; } }
      `}</style>

      {loading ? <LoadingSpinner label="Loading overview..." /> : (
        <>
          <div className="ov-stats-row">
            <StatCard label="Total Users" value={stats?.total_users?.toLocaleString('en-PK') ?? '—'}
              trend={stats ? `+${stats.new_users_today} today` : null} trendType="up" icon="fa-users" />
            <StatCard label="Transactions Today" value={stats ? `${stats.transactions_today_count} · ${formatPKR(stats.transactions_today_volume)}` : '—'}
              icon="fa-money-bill-transfer" />
            <StatCard label="Open Fraud Alerts" value={stats?.open_fraud_alerts ?? '—'}
              trendType={stats?.open_fraud_alerts > 0 ? 'down' : 'neutral'}
              trend={stats?.open_fraud_alerts > 0 ? 'Needs review' : 'All clear'}
              icon="fa-triangle-exclamation" accent="danger" />
            <StatCard label="Pending KYC Reviews" value={stats?.pending_kyc ?? '—'}
              trend={stats?.pending_kyc > 0 ? 'Awaiting review' : 'Queue clear'}
              trendType={stats?.pending_kyc > 0 ? 'neutral' : 'up'}
              icon="fa-id-card" accent="warning" />
          </div>

          <div className="ov-charts-row">
            <div className="ov-card">
              <h3>Transaction Volume — Last 7 Days</h3>
              {volumeData.length === 0 ? (
                <EmptyState icon="fa-chart-line" title="No data yet" message="Volume will appear once transactions start flowing." />
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={volumeData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v) => formatPKR(v)} />
                    <Line type="monotone" dataKey="volume" stroke="#5c2d91" strokeWidth={2.5} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="ov-card">
              <h3>Intent Distribution — Last 24h</h3>
              {intentData.data.length === 0 ? (
                <EmptyState icon="fa-comments" title="No chat activity" message="Intent breakdown appears once messages come in." />
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={190}>
                    <PieChart>
                      <Pie data={intentData.data} dataKey="count" nameKey="intent" cx="50%" cy="50%" outerRadius={75}>
                        {intentData.data.map((entry, i) => <Cell key={entry.intent} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="ov-legend">
                    {intentData.data.map((entry, i) => (
                      <span key={entry.intent}><span className="ov-legend-dot" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />{entry.intent}</span>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="ov-card">
              <h3>LLM Fallback Rate — By Hour</h3>
              {fallbackData.insufficientData ? (
                <EmptyState icon="fa-microchip" title="Coming online soon" message="This chart needs the regex/LLM engine tag on chat messages — part of the hybrid NLP work in progress. It'll populate automatically once that ships." />
              ) : fallbackData.data.length === 0 ? (
                <EmptyState icon="fa-chart-column" title="No data yet" message="Fallback rate appears once messages come in." />
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={fallbackData.data}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                    <XAxis dataKey="hour" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="regex_count" stackId="a" fill="#5c2d91" name="Regex" />
                    <Bar dataKey="llm_count" stackId="a" fill="#a855f7" name="LLM" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="ov-feeds-row">
            <div className="ov-card">
              <h3>Recent Fraud Alerts</h3>
              {feed.fraud_alerts.length === 0 ? <EmptyState icon="fa-shield-halved" title="All clear" message="No recent fraud alerts." /> : (
                feed.fraud_alerts.map(a => (
                  <div key={a.id} className="ov-feed-item">
                    <div className="ov-feed-main">{a.name || a.account_number} <Badge label={a.anomaly_type} color="danger" /></div>
                    <div className="ov-feed-sub">{formatTimestamp(a.created_at)}</div>
                  </div>
                ))
              )}
            </div>
            <div className="ov-card">
              <h3>Recent Ticket Activity</h3>
              {feed.tickets.length === 0 ? <EmptyState icon="fa-ticket" title="No recent activity" message="No ticket status changes yet." /> : (
                feed.tickets.map(t => (
                  <div key={t.id} className="ov-feed-item">
                    <div className="ov-feed-main">TKT-{String(t.id).padStart(5, '0')} <Badge label={t.status} color={t.status === 'resolved' ? 'success' : t.status === 'in_progress' ? 'warning' : 'muted'} /></div>
                    <div className="ov-feed-sub">{t.account} · {formatTimestamp(t.created_at)}</div>
                  </div>
                ))
              )}
            </div>
            <div className="ov-card">
              <h3>Pending KYC</h3>
              {feed.kyc.length === 0 ? <EmptyState icon="fa-id-card" title="Queue clear" message="No pending KYC submissions." /> : (
                feed.kyc.map(k => (
                  <div key={k.id} className="ov-feed-item">
                    <div className="ov-feed-main">{k.name}</div>
                    <div className="ov-feed-sub">{k.account_number} · submitted {formatTimestamp(k.submitted_at)}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}