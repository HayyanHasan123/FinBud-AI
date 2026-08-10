import { useState, useEffect } from 'react'

// Fixed list mirrors backend/advisor_chat.py's INVESTMENT_TYPES — kept as a
// local fallback so the cards render even before /api/advisor/investing/types
// responds (or if that endpoint isn't live yet).
const FALLBACK_TYPES = [
  { value: 'stocks', label: 'Stocks', icon: 'fa-chart-line' },
  { value: 'mutual_funds', label: 'Mutual Funds', icon: 'fa-layer-group' },
  { value: 'government_bonds', label: 'Government Bonds & Savings', icon: 'fa-landmark' },
  { value: 'gold', label: 'Gold', icon: 'fa-coins' },
  { value: 'fixed_deposits', label: 'Fixed Deposits', icon: 'fa-piggy-bank' },
  { value: 'crypto', label: 'Crypto', icon: 'fa-bitcoin-sign' },
]

function fmt(n) {
  return `PKR ${Math.round(n || 0).toLocaleString('en-PK')}`
}

export default function InvestingPanel() {
  const [loaded, setLoaded] = useState(false)
  const [available, setAvailable] = useState(true)
  const [amount, setAmount] = useState(0)
  const [types, setTypes] = useState(FALLBACK_TYPES)

  const [selectedType, setSelectedType] = useState(null)
  const [guideText, setGuideText] = useState('')
  const [guideLoading, setGuideLoading] = useState(false)
  const [guideError, setGuideError] = useState(null)

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/advisor/investing/suggestion', { credentials: 'include' })
        if (res.ok) {
          const data = await res.json()
          if (data.success) setAmount(data.recommended_monthly_amount || 0)
        }
      } catch {
        // Suggested amount is a nice-to-have — panel still works without it.
      }

      try {
        const typesRes = await fetch('/api/advisor/investing/types', { credentials: 'include' })
        if (typesRes.ok) {
          const typesData = await typesRes.json()
          if (typesData.success && Array.isArray(typesData.types)) {
            setTypes(typesData.types.map(t => ({
              ...t,
              icon: FALLBACK_TYPES.find(f => f.value === t.value)?.icon || 'fa-circle-info'
            })))
          }
        }
        setAvailable(true)
      } catch {
        // Fall back to the static FALLBACK_TYPES list already in state.
        setAvailable(true)
      } finally {
        setLoaded(true)
      }
    })()
  }, [])

  async function openGuide(type) {
    setSelectedType(type)
    setGuideText('')
    setGuideError(null)
    setGuideLoading(true)
    try {
      const res = await fetch(`/api/advisor/investing/guide/${type.value}`, { credentials: 'include' })
      const data = await res.json()
      if (data.success) {
        setGuideText(data.guide)
      } else {
        setGuideError(data.message || "Couldn't load that guide right now — please try again.")
      }
    } catch {
      setGuideError("Couldn't reach the server — please try again.")
    } finally {
      setGuideLoading(false)
    }
  }

  if (!loaded) {
    return (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Investing</h3>
        <p className="advisor-empty">Loading investing guides…</p>
      </div>
    )
  }

  if (!available) {
    return (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Investing</h3>
        <p className="advisor-empty">Investing guides are coming online soon — this card will populate automatically once it's connected on the backend.</p>
      </div>
    )
  }

  // ── Guide detail view ──────────────────────────────────────────────────
  if (selectedType) {
    return (
      <div className="card invest-guide-card">
        <button type="button" className="checkin-back-btn" onClick={() => setSelectedType(null)}>
          ← Back to investing
        </button>
        <h3 style={{ marginTop: 10 }}>
          <i className={`fas ${selectedType.icon}`} style={{ marginRight: 10 }} />
          {selectedType.label}
        </h3>
        {guideLoading && <p className="advisor-empty">Putting together a complete guide for you…</p>}
        {guideError && <p className="advisor-footnote" style={{ color: 'var(--danger)' }}>{guideError}</p>}
        {!guideLoading && guideText && (
          <div className="invest-guide-text">
            {guideText.split('\n').filter(l => l.trim()).map((para, i) => (
              <p key={i}>{para}</p>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ── Category picker view ───────────────────────────────────────────────
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Investing</h3>
      <p className="advisor-subtitle" style={{ marginBottom: 16 }}>
        FinBud doesn't invest on your behalf — pick a topic below for a complete, plain-language guide on how you could get started.
      </p>

      {amount > 0 && (
        <p className="advisor-footnote" style={{ marginBottom: 16 }}>
          Once your saving goals are on track, setting aside about <strong>{fmt(amount)}/month</strong> is a reasonable starting point to consider, based on your income.
        </p>
      )}

      <div className="invest-type-grid">
        {types.map(t => (
          <button key={t.value} type="button" className="invest-type-btn" onClick={() => openGuide(t)}>
            <i className={`fas ${t.icon}`} />
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      <p className="advisor-footnote" style={{ marginTop: 16 }}>
        This is educational information, not formal financial advice.
      </p>
    </div>
  )
}