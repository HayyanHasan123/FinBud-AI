import { useState } from 'react'
import InfoTip from './InfoTip.jsx'

// Short currency label for tight spaces (e.g. "45K" instead of "45,000") —
// used on the Monthly Trend bars so the numbers fit above thin bar columns.
function formatCompactPKR(n) {
  const v = Math.abs(n || 0)
  if (v >= 1000) return `${Math.round(v / 1000)}K`
  return `${Math.round(v)}`
}

// ── Anomaly icons ──────────────────────────────────────────
// Plain inline SVGs (no icon library dependency) — drop into
// <span className="anomaly-icon">, themeable via currentColor.
const iconProps = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }

function IconNewBiller(props) {
  return (
    <svg {...iconProps} {...props}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <line x1="19" y1="8" x2="19" y2="14" />
      <line x1="16" y1="11" x2="22" y2="11" />
    </svg>
  )
}

function IconAmountSpike(props) {
  return (
    <svg {...iconProps} {...props}>
      <polyline points="3 17 9 11 13 15 21 6" />
      <polyline points="15 6 21 6 21 12" />
    </svg>
  )
}

function IconDuplicateBill(props) {
  return (
    <svg {...iconProps} {...props}>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M4 16V4a2 2 0 0 1 2-2h10" />
    </svg>
  )
}

function IconLargeTransfer(props) {
  return (
    <svg {...iconProps} {...props}>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  )
}

function IconRapidFire(props) {
  return (
    <svg {...iconProps} {...props}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  )
}

function IconOddHours(props) {
  return (
    <svg {...iconProps} {...props}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  )
}

function IconFallbackWarning(props) {
  return (
    <svg {...iconProps} {...props}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

// Icon + severity styling per anomaly type returned by detect_anomalies().
// The backend already writes a human-readable `message` for each one, so
// the frontend just needs to decide how urgent it looks.
const ANOMALY_CONFIG = {
  new_biller:     { icon: IconNewBiller,     severity: 'info',    label: 'New Biller' },
  amount_spike:   { icon: IconAmountSpike,   severity: 'warning', label: 'Amount Spike' },
  duplicate_bill: { icon: IconDuplicateBill, severity: 'warning', label: 'Duplicate Bill' },
  large_transfer: { icon: IconLargeTransfer, severity: 'danger',  label: 'Large Transfer' },
  rapid_fire:     { icon: IconRapidFire,     severity: 'danger',  label: 'Rapid Transactions' },
  odd_hours:      { icon: IconOddHours,      severity: 'danger',  label: 'Unusual Hours' },
}

// How many rows a list-style section (anomalies, income sources, spending
// breakdown, subscriptions) shows before collapsing behind "Show more" —
// keeps long lists from making the whole page one giant scroll.
const LIST_PREVIEW_COUNT = 4

// Renders `items.slice(0, 4)` (or all of them once expanded) via `renderItem`,
// plus a "Show more (+N)" / "Show less" toggle when there's more to reveal.
// Reuses the existing .more-insights-btn styling so no new CSS is needed.
function ShowMoreList({ items, expanded, onToggle, renderItem, limit = LIST_PREVIEW_COUNT }) {
  const visible = expanded ? items : items.slice(0, limit)
  const hiddenCount = items.length - limit
  return (
    <>
      {visible.map(renderItem)}
      {hiddenCount > 0 && (
        <button type="button" className="more-insights-btn" style={{ marginTop: 10, padding: 10 }} onClick={onToggle}>
          {expanded ? 'Show less' : `Show more (+${hiddenCount})`} <i className={`fas fa-chevron-${expanded ? 'up' : 'down'}`} style={{ marginLeft: 6 }} />
        </button>
      )}
    </>
  )
}

// "Your Analytics" panel — income/expense summary, credit score, spending
// pace, income sources, spending breakdown, and subscriptions. Rendered by
// Dashboard.jsx (both website and mobile shells) when activeView === 'advisor'.
// All data (advisor, reminders, breakdown) and shared helpers (t, speak,
// setModal) are passed down as props so language switching, currency
// formatting, and modal-opening (e.g. "+ Log Income") keep working exactly
// as before.
export default function AnalyticsView({ t, advisor, reminders, breakdownEntries, breakdownTotal, isMobile, simpleMode, speak, setModal }) {
  const income = advisor.summary?.income ?? 0
  const expenses = advisor.summary?.expenses ?? 0
  const net = advisor.summary?.net ?? (income - expenses)
  const upcomingBillsTotal = reminders.reduce((s, r) => s + (r.amount || 0), 0)
  // Safe to Spend now prefers the backend's own calculation (new dedicated
  // logic on the backend) when it's present; falls back to the old local
  // Net-minus-upcoming-bills estimate only until that field ships.
  const backendSafeToSpend = advisor.summary?.safe_to_spend
  const usingBackendSafeToSpend = typeof backendSafeToSpend === 'number'
  const safeToSpend = advisor.summaryAvailable
    ? (usingBackendSafeToSpend ? backendSafeToSpend : net - upcomingBillsTotal)
    : null
  const incomeEntries = Object.entries(advisor.incomeBreakdown).sort((a, b) => b[1] - a[1])
  const incomeTotal = incomeEntries.reduce((s, [, v]) => s + v, 0)
  const maxTrend = Math.max(1, ...advisor.monthlyTrend.flatMap(m => [m.income || 0, m.expenses || 0]))
  const today = new Date()
  const dayOfMonth = today.getDate()
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
  const pctDaysElapsed = (dayOfMonth / daysInMonth) * 100
  // Spending Pace compares THIS month's spend-to-date against LAST
  // month's actual total (not an average that can include this same
  // in-progress month, which was quietly always showing 100%).
  const priorMonths = advisor.monthlyTrend.length > 1 ? advisor.monthlyTrend.slice(0, -1) : []
  const lastMonth = priorMonths.length > 0 ? priorMonths[priorMonths.length - 1] : null
  const lastMonthTotal = lastMonth ? (lastMonth.expenses || 0) : null
  const lastMonthLabel = lastMonth ? lastMonth.month : null
  const pctOfLastMonthSpent = (lastMonthTotal && lastMonthTotal > 0)
    ? Math.round((expenses / lastMonthTotal) * 100)
    : null
  const projectedThisMonth = (expenses / dayOfMonth) * daysInMonth
  const pctVsLastMonth = (lastMonthTotal && lastMonthTotal > 0)
    ? Math.round(((projectedThisMonth - lastMonthTotal) / lastMonthTotal) * 100)
    : null
  const paceAhead = pctVsLastMonth !== null && pctVsLastMonth > 10
  const paceSlower = pctVsLastMonth !== null && pctVsLastMonth < -10
  const subscriptionsTotal = advisor.subscriptions.reduce((s, sub) => s + sub.amount, 0)
  // Simple Mode (Module F): fewer things on screen at once — the three
  // more detailed/preview cards below collapse into one "More Insights"
  // toggle instead of all being shown simultaneously.
  const [showMore, setShowMore] = useState(false)
  // Expand/collapse state for each list-style section below — each starts
  // collapsed to LIST_PREVIEW_COUNT items with its own "Show more" toggle.
  const [anomaliesExpanded, setAnomaliesExpanded] = useState(false)
  const [incomeExpanded, setIncomeExpanded] = useState(false)
  const [breakdownExpanded, setBreakdownExpanded] = useState(false)
  const [subscriptionsExpanded, setSubscriptionsExpanded] = useState(false)

  return (
    <div className="advisor-wrap">
      <div className="advisor-header">
        <div>
          <h2 className="advisor-title">{t('analytics_title')}</h2>
          <p className="advisor-subtitle">{t('analytics_subtitle')}</p>
        </div>
        <button className="topup-btn" onClick={() => setModal({ type: 'logIncome' })}>{t('analytics_log_income')}</button>
      </div>

      <div className="advisor-grid">
        <div className="card advisor-summary-card">
          <div className="card-header-row">
            <h3 style={{ marginTop: 0, marginBottom: 0 }}>{t('analytics_this_month')}</h3>
            {advisor.summaryAvailable && (
              <button type="button" className="read-aloud-btn" aria-label="Read this month's summary aloud"
                onClick={() => speak(`This month, your income is PKR ${income.toLocaleString('en-PK')}, your expenses are PKR ${expenses.toLocaleString('en-PK')}, and it is safe to spend PKR ${safeToSpend.toLocaleString('en-PK')} today.`)}>
                {t('read_aloud')}
              </button>
            )}
          </div>
          {advisor.summaryAvailable ? (
            <div className="advisor-summary-row">
              <div className="advisor-stat">
                <span className="advisor-stat-label">{t('analytics_income')}</span>
                <strong className="advisor-stat-value income-text">PKR {income.toLocaleString('en-PK')}</strong>
              </div>
              <div className="advisor-stat">
                <span className="advisor-stat-label">{t('analytics_expenses')}</span>
                <strong className="advisor-stat-value expense-text">PKR {expenses.toLocaleString('en-PK')}</strong>
              </div>
              <div className="advisor-stat">
                <span className="advisor-stat-label">{t('analytics_net')}</span>
                <strong className={`advisor-stat-value ${net >= 0 ? 'income-text' : 'expense-text'}`}>PKR {net.toLocaleString('en-PK')}</strong>
              </div>
              <div className="advisor-stat">
                <span className="advisor-stat-label">{t('analytics_safe_to_spend')} <InfoTip text={usingBackendSafeToSpend
                  ? "What's left after income, minus expenses so far, minus a 20% savings target and a 10% investment amount — so spending today doesn't eat into money you're meant to be setting aside."
                  : "This is what's left after your income, minus your expenses so far and any bills still due — a rough amount you can spend today without dipping into money you already owe."} /></span>
                <strong className={`advisor-stat-value ${safeToSpend >= 0 ? 'income-text' : 'expense-text'}`}>PKR {safeToSpend.toLocaleString('en-PK')}</strong>
              </div>
              {usingBackendSafeToSpend && (
                <>
                  <div className="advisor-stat">
                    <span className="advisor-stat-label">{t('analytics_suggested_savings')}</span>
                    <strong className="advisor-stat-value" style={{ color: 'var(--primary-purple)' }}>PKR {(advisor.summary.savings_target || 0).toLocaleString('en-PK')}</strong>
                  </div>
                  <div className="advisor-stat">
                    <span className="advisor-stat-label">{t('analytics_suggested_investment')}</span>
                    <strong className="advisor-stat-value" style={{ color: 'var(--primary-purple)' }}>PKR {(advisor.summary.investment_amount || 0).toLocaleString('en-PK')}</strong>
                  </div>
                </>
              )}
            </div>
          ) : (
            <p className="advisor-empty">{t('analytics_summary_empty')}</p>
          )}
        </div>

        <div className="card">
          <div className="card-header-row">
            <h3 style={{ marginTop: 0, marginBottom: 0 }}>{t('analytics_credit_score')}</h3>
            {advisor.creditScoreAvailable && (
              <button type="button" className="read-aloud-btn" aria-label="Read credit score aloud"
                onClick={() => speak(`Your credit score is ${advisor.creditScore.score}, rated ${advisor.creditScore.label}. ${advisor.creditScore.advice || ''}`)}>
                {t('read_aloud')}
              </button>
            )}
          </div>
          {advisor.creditScoreAvailable && advisor.creditScore ? (
            <>
              <div className="credit-score-row">
                <div className="credit-score-value" style={{ color: advisor.creditScore.color }}>{advisor.creditScore.score}</div>
                <div>
                  <span className="credit-score-pill" style={{ background: advisor.creditScore.color }}>{advisor.creditScore.label}</span>
                  <p className="advisor-footnote" style={{ margin: '8px 0 0' }}>{advisor.creditScore.advice}</p>
                </div>
              </div>
              {advisor.creditScore.breakdown && (
                <div className="credit-breakdown-list">
                  <div className="credit-breakdown-row">
                    <span className="advisor-stat-label">{t('analytics_late_payments')}</span>
                    <strong>{advisor.creditScore.breakdown.late_payments}</strong>
                  </div>
                  <div className="credit-breakdown-row">
                    <span className="advisor-stat-label">Balance</span>
                    <strong>PKR {(advisor.creditScore.breakdown.balance || 0).toLocaleString('en-PK')}</strong>
                  </div>
                  <div className="credit-breakdown-row">
                    <span className="advisor-stat-label">Transactions (6mo)</span>
                    <strong>{advisor.creditScore.breakdown.transactions_6m}</strong>
                  </div>
                  <div className="credit-breakdown-row">
                    <span className="advisor-stat-label">Reward Points</span>
                    <strong>{advisor.creditScore.breakdown.reward_points}</strong>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="advisor-empty">Your credit score builds up as you use FinBud — pay bills on time and keep a healthy balance to see it here.</p>
          )}
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Anomaly Alerts</h3>
          {advisor.anomaliesAvailable && advisor.anomalies.length > 0 ? (
            <ShowMoreList
              items={advisor.anomalies}
              expanded={anomaliesExpanded}
              onToggle={() => setAnomaliesExpanded(e => !e)}
              renderItem={(a, i) => {
                const cfg = ANOMALY_CONFIG[a.type] || { icon: IconFallbackWarning, severity: 'warning', label: a.type }
                const Icon = cfg.icon
                return (
                  <div key={i} className={`anomaly-item anomaly-${cfg.severity}`}>
                    <span className="anomaly-icon"><Icon /></span>
                    <div>
                      <strong>{cfg.label}</strong>
                      <p style={{ margin: '3px 0 0', fontSize: 13 }}>{a.message}</p>
                    </div>
                  </div>
                )
              }}
            />
          ) : (
            <p className="advisor-empty">No unusual activity detected. We keep an eye on new billers, spending spikes, large transfers, and odd-hours activity automatically.</p>
          )}
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>{t('analytics_monthly_trend')}</h3>
          {advisor.trendAvailable && advisor.monthlyTrend.length > 0 ? (
            <div className="trend-chart">
              {advisor.monthlyTrend.map(m => (
                <div key={m.month} className="trend-col">
                  <div className="trend-bars">
                    <div className="trend-bar-wrap">
                      <span className="trend-bar-value income-text">{formatCompactPKR(m.income)}</span>
                      <div className="trend-bar income-bar" style={{ height: `${((m.income || 0) / maxTrend) * 100}%` }} title={`Income: PKR ${m.income}`} />
                    </div>
                    <div className="trend-bar-wrap">
                      <span className="trend-bar-value expense-text">{formatCompactPKR(m.expenses)}</span>
                      <div className="trend-bar expense-bar" style={{ height: `${((m.expenses || 0) / maxTrend) * 100}%` }} title={`Expenses: PKR ${m.expenses}`} />
                    </div>
                  </div>
                  <span className="trend-label">{m.month}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="advisor-empty">{t('analytics_trend_empty')}</p>
          )}
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>{t('analytics_spending_pace')}</h3>
          {pctOfLastMonthSpent !== null ? (
            <>
              <div className="pace-compare-row">
                <div className="pace-compare-stat">
                  <span className="pace-compare-label">{lastMonthLabel} (full month)</span>
                  <strong className="pace-compare-value">PKR {lastMonthTotal.toLocaleString('en-PK', { maximumFractionDigits: 0 })}</strong>
                </div>
                <div className="pace-compare-stat">
                  <span className="pace-compare-label">This month so far (Day {dayOfMonth} of {daysInMonth})</span>
                  <strong className="pace-compare-value">PKR {expenses.toLocaleString('en-PK', { maximumFractionDigits: 0 })}</strong>
                </div>
              </div>

              <div className="pace-row">
                <div className="pace-label-row"><span>You've spent this % of last month's total already</span><strong>{pctOfLastMonthSpent}%</strong></div>
                <div className="breakdown-bar-track"><div className={`breakdown-bar-fill ${paceAhead ? 'pace-bar-warning' : 'income-bar-fill'}`} style={{ width: `${Math.min(100, pctOfLastMonthSpent)}%` }} /></div>
              </div>
              <div className="pace-row">
                <div className="pace-label-row"><span>Days elapsed this month</span><strong>{pctDaysElapsed.toFixed(0)}%</strong></div>
                <div className="breakdown-bar-track"><div className="breakdown-bar-fill" style={{ width: `${pctDaysElapsed.toFixed(0)}%` }} /></div>
              </div>

              <p className={`advisor-footnote ${paceAhead ? 'pace-warning-text' : paceSlower ? 'pace-good-text' : ''}`}>
                {paceAhead && (
                  <>⚠️ At this rate, you're on track to spend about <strong>PKR {projectedThisMonth.toLocaleString('en-PK', { maximumFractionDigits: 0 })}</strong> this month — {pctVsLastMonth}% more than {lastMonthLabel}'s PKR {lastMonthTotal.toLocaleString('en-PK', { maximumFractionDigits: 0 })}.</>
                )}
                {paceSlower && (
                  <>✅ At this rate, you're on track to spend about <strong>PKR {projectedThisMonth.toLocaleString('en-PK', { maximumFractionDigits: 0 })}</strong> this month — {Math.abs(pctVsLastMonth)}% less than {lastMonthLabel}'s PKR {lastMonthTotal.toLocaleString('en-PK', { maximumFractionDigits: 0 })}.</>
                )}
                {!paceAhead && !paceSlower && (
                  <>You're tracking about the same as {lastMonthLabel} — on pace for roughly PKR {projectedThisMonth.toLocaleString('en-PK', { maximumFractionDigits: 0 })} this month.</>
                )}
              </p>
            </>
          ) : (
            <p className="advisor-empty">{t('analytics_pace_empty')}</p>
          )}
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>{t('analytics_income_sources')}</h3>
          {advisor.incomeAvailable && incomeEntries.length > 0 ? (
            <ShowMoreList
              items={incomeEntries}
              expanded={incomeExpanded}
              onToggle={() => setIncomeExpanded(e => !e)}
              renderItem={([src, amt]) => {
                const pct = incomeTotal > 0 ? (amt / incomeTotal) * 100 : 0
                return (
                  <div key={src} className="breakdown-row">
                    <div className="breakdown-label-row"><span>{src}</span><strong>{pct.toFixed(1)}% · PKR {amt.toLocaleString('en-PK', { maximumFractionDigits: 0 })}</strong></div>
                    <div className="breakdown-bar-track"><div className="breakdown-bar-fill income-bar-fill" style={{ width: `${pct.toFixed(1)}%` }} /></div>
                  </div>
                )
              }}
            />
          ) : (
            <p className="advisor-empty">{t('analytics_income_empty')}</p>
          )}
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>{t('analytics_spending_breakdown')}</h3>
          {breakdownEntries.length === 0 ? (
            <p className="advisor-empty">{t('analytics_breakdown_empty')}</p>
          ) : (
            <ShowMoreList
              items={breakdownEntries}
              expanded={breakdownExpanded}
              onToggle={() => setBreakdownExpanded(e => !e)}
              renderItem={([cat, amt]) => {
                const pct = breakdownTotal > 0 ? ((amt / breakdownTotal) * 100) : 0
                return (
                  <div key={cat} className="breakdown-row">
                    <div className="breakdown-label-row">
                      <span>{cat}</span>
                      <strong>{pct.toFixed(1)}% · PKR {amt.toLocaleString('en-PK', { maximumFractionDigits: 0 })}</strong>
                    </div>
                    <div className="breakdown-bar-track">
                      <div className="breakdown-bar-fill" style={{ width: `${pct.toFixed(1)}%` }} />
                    </div>
                  </div>
                )
              }}
            />
          )}
        </div>

        {simpleMode && !showMore ? (
          <div className="card advisor-insights-card">
            <button type="button" className="more-insights-btn" onClick={() => setShowMore(true)}>
              {t('analytics_show_more')} <i className="fas fa-chevron-down" style={{ marginLeft: 6 }} />
            </button>
          </div>
        ) : (
        <>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{t('analytics_subscriptions')} <span className="preview-tag">{t('analytics_preview')}</span></h3>
          {advisor.subscriptions.length > 0 ? (
            <>
              <ShowMoreList
                items={advisor.subscriptions}
                expanded={subscriptionsExpanded}
                onToggle={() => setSubscriptionsExpanded(e => !e)}
                renderItem={sub => (
                  <div key={sub.description} className="wallet-row">
                    <div>
                      <strong>{sub.description}</strong>
                      <div style={{ fontSize: 12, color: isMobile ? 'var(--text-dark)' : '#777' }}>Seen {sub.occurrences} times · consistent amount</div>
                    </div>
                    <span>PKR {sub.amount.toLocaleString('en-PK', { maximumFractionDigits: 0 })}</span>
                  </div>
                )}
              />
              <p className="advisor-footnote">Detected recurring spend: PKR {subscriptionsTotal.toLocaleString('en-PK', { maximumFractionDigits: 0 })}/month across your last 100 transactions.</p>
            </>
          ) : (
            <p className="advisor-empty">{t('analytics_subscriptions_empty')}</p>
          )}
        </div>

        </>
        )}
      </div>
    </div>
  )
}