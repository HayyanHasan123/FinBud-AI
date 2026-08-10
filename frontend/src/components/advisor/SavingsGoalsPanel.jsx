import { useState, useEffect } from 'react'

const GOAL_TYPES = [
  { value: 'emergency_fund', label: 'Emergency Fund', icon: 'fa-shield-heart' },
  { value: 'car', label: 'Car', icon: 'fa-car' },
  { value: 'house', label: 'House', icon: 'fa-house' },
  { value: 'wedding', label: 'Wedding', icon: 'fa-ring' },
  { value: 'education', label: 'Education', icon: 'fa-graduation-cap' },
  { value: 'just_saving', label: 'Just Saving', icon: 'fa-piggy-bank' },
  { value: 'custom', label: 'Custom', icon: 'fa-star' }
]

const FREQUENCIES = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'monthly', label: 'Monthly' },
]

function fmt(n) {
  return `PKR ${Math.round(n || 0).toLocaleString('en-PK')}`
}

export default function SavingsGoalsPanel() {
  const [loaded, setLoaded] = useState(false)
  const [available, setAvailable] = useState(true)
  const [goals, setGoals] = useState([])
  const [suggested, setSuggested] = useState(0)
  const [balance, setBalance] = useState(null)

  const [pickingType, setPickingType] = useState(null)
  const [form, setForm] = useState({ goal_name: '', target_amount: '', target_date: '' })
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState(null)

  // Per-goal transient UI state: which goal has its plan-setup or
  // add/withdraw controls open, and what's currently typed into them.
  const [planOpenFor, setPlanOpenFor] = useState(null)
  const [planForm, setPlanForm] = useState({ frequency: 'monthly', timeline_months: '' })
  const [moneyOpenFor, setMoneyOpenFor] = useState(null) // { goalId, mode: 'add'|'withdraw' }
  const [moneyAmount, setMoneyAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState(null)
  const [actionMessage, setActionMessage] = useState(null)

  useEffect(() => { loadGoals() }, [])

  async function loadGoals() {
    try {
      const res = await fetch('/api/advisor/goals', { credentials: 'include' })
      if (!res.ok) { setAvailable(false); setLoaded(true); return }
      const data = await res.json()
      if (data.success) {
        setGoals(data.goals || [])
        setSuggested(data.suggested_monthly_saving || 0)
        if (typeof data.balance === 'number') setBalance(data.balance)
        setAvailable(true)
      } else {
        setAvailable(false)
      }
    } catch {
      setAvailable(false)
    } finally {
      setLoaded(true)
    }
  }

  function startGoal(type) {
    setPickingType(type)
    setForm({ goal_name: GOAL_TYPES.find(g => g.value === type)?.label || '', target_amount: '', target_date: '' })
    setError(null)
  }

  async function submitGoal(e) {
    e.preventDefault()
    setCreating(true)
    setError(null)
    try {
      const res = await fetch('/api/advisor/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          goal_type: pickingType,
          goal_name: form.goal_name || GOAL_TYPES.find(g => g.value === pickingType)?.label,
          target_amount: form.target_amount ? Number(form.target_amount) : null,
          target_date: form.target_date || null
        })
      })
      const data = await res.json()
      if (data.success) {
        setPickingType(null)
        loadGoals()
      } else {
        setError(data.message || "Couldn't save that goal — please try again.")
      }
    } catch {
      setError("Couldn't reach the server — please try again.")
    } finally {
      setCreating(false)
    }
  }

  async function removeGoal(id) {
    try {
      await fetch(`/api/advisor/goals/${id}`, { method: 'DELETE', credentials: 'include' })
      loadGoals()
    } catch {
      // silently ignore — user can retry the tap
    }
  }

  function openPlan(goal) {
    setPlanOpenFor(goal.id)
    setMoneyOpenFor(null)
    setPlanForm({
      frequency: goal.frequency || 'monthly',
      timeline_months: goal.timeline_months ? String(goal.timeline_months) : ''
    })
    setActionError(null)
    setActionMessage(null)
  }

  async function submitPlan(goalId) {
    const months = Number(planForm.timeline_months)
    if (!months || months <= 0) {
      setActionError('Enter a timeline in months (e.g. 12).')
      return
    }
    setBusy(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/advisor/goals/${goalId}/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ frequency: planForm.frequency, timeline_months: months })
      })
      const data = await res.json()
      if (data.success) {
        setPlanOpenFor(null)
        loadGoals()
      } else {
        setActionError(data.message || "Couldn't work out a plan — please try again.")
      }
    } catch {
      setActionError("Couldn't reach the server — please try again.")
    } finally {
      setBusy(false)
    }
  }

  function openMoney(goal, mode) {
    setMoneyOpenFor({ goalId: goal.id, mode })
    setPlanOpenFor(null)
    setMoneyAmount('')
    setActionError(null)
    setActionMessage(null)
  }

  async function submitMoney(goalId, mode) {
    const amount = Number(moneyAmount)
    if (!amount || amount <= 0) {
      setActionError('Enter an amount greater than 0.')
      return
    }
    setBusy(true)
    setActionError(null)
    setActionMessage(null)
    try {
      const endpoint = mode === 'add' ? 'contribute' : 'withdraw'
      const res = await fetch(`/api/advisor/goals/${goalId}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ amount })
      })
      const data = await res.json()
      if (data.success) {
        setActionMessage(data.message)
        if (typeof data.new_balance === 'number') setBalance(data.new_balance)
        setMoneyOpenFor(null)
        loadGoals()
      } else {
        setActionError(data.message || "That didn't go through — please try again.")
      }
    } catch {
      setActionError("Couldn't reach the server — please try again.")
    } finally {
      setBusy(false)
    }
  }

  if (!loaded) {
    return (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Saving</h3>
        <p className="advisor-empty">Loading your goals…</p>
      </div>
    )
  }

  if (!available) {
    return (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Saving</h3>
        <p className="advisor-empty">Goal-based saving is coming online soon — this card will populate automatically once it's connected on the backend.</p>
      </div>
    )
  }

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Saving</h3>

      <p className="advisor-footnote" style={{ marginBottom: 10 }}>
        When you save toward a goal, that money is actually moved out of your available balance and set aside —
        so it's harder to accidentally spend. You can move it back to your balance any time you need it.
      </p>

      {balance !== null && (
        <p className="advisor-footnote" style={{ marginBottom: 16 }}>
          Available to save right now: <strong>{fmt(balance)}</strong>
        </p>
      )}

      {suggested > 0 && (
        <p className="advisor-footnote" style={{ marginBottom: 16 }}>
          Based on your income and expenses, saving about <strong>{fmt(suggested)}/month</strong> looks realistic for you right now.
        </p>
      )}

      {actionMessage && <p className="advisor-footnote" style={{ color: 'var(--primary-purple)', marginBottom: 12 }}>{actionMessage}</p>}

      {goals.length > 0 && (
        <div className="goals-list">
          {goals.map(g => {
            const type = GOAL_TYPES.find(t => t.value === g.goal_type)
            const pct = g.target_amount ? Math.min(100, Math.round(((g.saved_amount || 0) / g.target_amount) * 100)) : null
            return (
              <div key={g.id} className="goal-item">
                <div className="goal-item-header">
                  <span><i className={`fas ${type?.icon || 'fa-star'}`} style={{ marginRight: 8 }} />{g.goal_name || type?.label}</span>
                  <button type="button" className="goal-remove-btn" aria-label="Delete goal" onClick={() => removeGoal(g.id)}>×</button>
                </div>

                {g.target_amount ? (
                  <>
                    <div className="goal-progress-track">
                      <div className="goal-progress-fill" style={{ width: `${pct}%` }} />
                    </div>
                    <p className="advisor-footnote">
                      {fmt(g.saved_amount)} saved of {fmt(g.target_amount)} ({pct}%){g.target_date ? ` — target: ${g.target_date}` : ''}
                    </p>
                  </>
                ) : (
                  <p className="advisor-footnote">{fmt(g.saved_amount)} saved so far — no specific target set.</p>
                )}

                {g.per_period_amount ? (
                  <p className="advisor-footnote" style={{ fontWeight: 600 }}>
                    Your plan: save {fmt(g.per_period_amount)} {FREQUENCIES.find(f => f.value === g.frequency)?.label.toLowerCase() || g.frequency}
                    {g.timeline_months ? ` for the next ${g.timeline_months} month${g.timeline_months == 1 ? '' : 's'}` : ''}.
                  </p>
                ) : null}

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                  <button type="button" className="goal-add-btn" onClick={() => openMoney(g, 'add')}>+ Add money</button>
                  {g.saved_amount > 0 && (
                    <button type="button" className="goal-add-btn goal-withdraw-btn" onClick={() => openMoney(g, 'withdraw')}>Withdraw</button>
                  )}
                  <button type="button" className="goal-add-btn goal-plan-btn" onClick={() => openPlan(g)}>
                    {g.per_period_amount ? 'Edit plan' : 'Set a savings plan'}
                  </button>
                </div>

                {planOpenFor === g.id && (
                  <div className="goal-inline-form">
                    <p className="advisor-footnote">How often, and over how long, do you want to save toward this?</p>
                    <div className="goal-inline-row">
                      <select
                        value={planForm.frequency}
                        onChange={e => setPlanForm(f => ({ ...f, frequency: e.target.value }))}
                      >
                        {FREQUENCIES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                      </select>
                      <input
                        type="number" min="1" placeholder="Timeline (months)"
                        value={planForm.timeline_months}
                        onChange={e => setPlanForm(f => ({ ...f, timeline_months: e.target.value }))}
                      />
                    </div>
                    {actionError && <p className="advisor-footnote" style={{ color: 'var(--danger)' }}>{actionError}</p>}
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button type="button" className="topup-btn" disabled={busy} onClick={() => submitPlan(g.id)}>
                        {busy ? 'Working it out…' : 'Show me the amount'}
                      </button>
                      <button type="button" className="checkin-back-btn" onClick={() => setPlanOpenFor(null)} disabled={busy}>Cancel</button>
                    </div>
                  </div>
                )}

                {moneyOpenFor && moneyOpenFor.goalId === g.id && (
                  <div className="goal-inline-form">
                    <p className="advisor-footnote">
                      {moneyOpenFor.mode === 'add'
                        ? 'This amount will be moved out of your available balance into this goal.'
                        : 'This amount will be moved back into your available balance.'}
                    </p>
                    <div className="goal-inline-row">
                      <input
                        type="number" min="1" placeholder="Amount (PKR)"
                        value={moneyAmount}
                        onChange={e => setMoneyAmount(e.target.value)}
                      />
                    </div>
                    {actionError && <p className="advisor-footnote" style={{ color: 'var(--danger)' }}>{actionError}</p>}
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button type="button" className="topup-btn" disabled={busy} onClick={() => submitMoney(g.id, moneyOpenFor.mode)}>
                        {busy ? 'Processing…' : moneyOpenFor.mode === 'add' ? 'Move to savings' : 'Move to balance'}
                      </button>
                      <button type="button" className="checkin-back-btn" onClick={() => setMoneyOpenFor(null)} disabled={busy}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {pickingType === null ? (
        <div className="goal-type-grid">
          {GOAL_TYPES.map(t => (
            <button key={t.value} type="button" className="goal-type-btn" onClick={() => startGoal(t.value)}>
              <i className={`fas ${t.icon}`} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      ) : (
        <form className="goal-form" onSubmit={submitGoal}>
          <label>
            Goal name
            <input type="text" value={form.goal_name} onChange={e => setForm(f => ({ ...f, goal_name: e.target.value }))} />
          </label>
          <label>
            Target amount (optional)
            <input type="number" min="0" placeholder="e.g. 500000" value={form.target_amount}
              onChange={e => setForm(f => ({ ...f, target_amount: e.target.value }))} />
          </label>
          <label>
            Rough target date (optional)
            <input type="text" placeholder="e.g. in 2 years, or June 2028" value={form.target_date}
              onChange={e => setForm(f => ({ ...f, target_date: e.target.value }))} />
          </label>
          {error && <p className="advisor-footnote" style={{ color: 'var(--danger)' }}>{error}</p>}
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="submit" className="topup-btn" disabled={creating}>{creating ? 'Saving…' : 'Save goal'}</button>
            <button type="button" className="checkin-back-btn" onClick={() => setPickingType(null)} disabled={creating}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  )
}