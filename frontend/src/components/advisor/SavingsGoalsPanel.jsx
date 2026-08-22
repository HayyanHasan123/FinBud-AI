import { useState, useEffect, useRef } from 'react'

const GOAL_TYPES = [
  { value: 'emergency_fund', label: 'Emergency Fund', icon: 'fa-shield-heart' },
  { value: 'car', label: 'Car', icon: 'fa-car' },
  { value: 'house', label: 'House', icon: 'fa-house' },
  { value: 'wedding', label: 'Wedding', icon: 'fa-ring' },
  { value: 'education', label: 'Education', icon: 'fa-graduation-cap' },
  { value: 'just_saving', label: 'Just Saving', icon: 'fa-piggy-bank' },
  { value: 'custom', label: 'Custom', icon: 'fa-star' }
]

// 'yearly' added for the plan-picker step (weekly / monthly / yearly).
// 'biweekly' kept only in case older goal records were saved with it —
// still used to look up the display label for g.frequency below.
const FREQUENCIES = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
]

// Average weeks per month (52 / 12) — used only to convert a target amount
// into a weekly figure for display in the plan picker. Purely a frontend
// display calculation, nothing persisted server-side.
const WEEKS_PER_MONTH = 52 / 12

const TIMELINE_UNITS = [
  { value: 'months', label: 'Months' },
  { value: 'years', label: 'Years' },
]

function fmt(n) {
  return `PKR ${Math.round(n || 0).toLocaleString('en-PK')}`
}

// Turns a target amount + a total number of months into what saving toward
// it looks like weekly / monthly / yearly. Purely frontend arithmetic — no
// backend calculation involved for this step (see per-goal comment below).
function computePlanOptions(targetAmount, totalMonths) {
  if (!targetAmount || targetAmount <= 0 || !totalMonths || totalMonths <= 0) return null
  return {
    weekly: targetAmount / (totalMonths * WEEKS_PER_MONTH),
    monthly: targetAmount / totalMonths,
    yearly: (targetAmount * 12) / totalMonths,
  }
}

function timelineToMonths(value, unit) {
  const n = Number(value)
  if (!n || n <= 0) return 0
  return unit === 'years' ? n * 12 : n
}

function timelineLabel(value, unit) {
  const n = Number(value)
  const unitLabel = unit === 'years' ? (n === 1 ? 'year' : 'years') : (n === 1 ? 'month' : 'months')
  return `${n} ${unitLabel}`
}

export default function SavingsGoalsPanel() {
  const [loaded, setLoaded] = useState(false)
  const [available, setAvailable] = useState(true)
  const [goals, setGoals] = useState([])
  const [suggested, setSuggested] = useState(0)
  const [balance, setBalance] = useState(null)

  // ── New goal wizard: null | 'type' | 'details' | 'frequency' | 'confirm' ──
  const [wizStep, setWizStep] = useState(null)
  const [wizType, setWizType] = useState(null)
  const [wizGoalName, setWizGoalName] = useState('')
  const [wizAmount, setWizAmount] = useState('')
  const [wizTimelineValue, setWizTimelineValue] = useState('')
  const [wizTimelineUnit, setWizTimelineUnit] = useState('months')
  const [wizDetailsError, setWizDetailsError] = useState(null)
  const [wizPlans, setWizPlans] = useState(null)
  const [wizChosenFrequency, setWizChosenFrequency] = useState(null)
  const [wizCreating, setWizCreating] = useState(false)
  const [wizError, setWizError] = useState(null)
  const [wizUnitOpen, setWizUnitOpen] = useState(false)
  const unitDropdownRef = useRef(null)

  // Close the Months/Years dropdown on an outside tap/click.
  useEffect(() => {
    if (!wizUnitOpen) return
    function handleOutside(e) {
      if (unitDropdownRef.current && !unitDropdownRef.current.contains(e.target)) {
        setWizUnitOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [wizUnitOpen])

  // Per-goal transient UI state: which goal has its add/withdraw controls
  // open (and what's typed into them), and which goal has a delete
  // confirmation showing.
  const [moneyOpenFor, setMoneyOpenFor] = useState(null) // { goalId, mode: 'add'|'withdraw' }
  const [moneyAmount, setMoneyAmount] = useState('')
  const [deleteConfirmFor, setDeleteConfirmFor] = useState(null)
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

  // ── Wizard step helpers ─────────────────────────────────────────────
  function openWizard() {
    setWizStep('type')
    setWizType(null)
    setWizGoalName('')
    setWizAmount('')
    setWizTimelineValue('')
    setWizTimelineUnit('months')
    setWizDetailsError(null)
    setWizPlans(null)
    setWizChosenFrequency(null)
    setWizError(null)
    setWizUnitOpen(false)
  }

  function closeWizard() {
    setWizStep(null)
  }

  function chooseType(type) {
    setWizType(type)
    setWizGoalName(type.label)
    setWizDetailsError(null)
    setWizStep('details')
  }

  function continueToFrequency() {
    const amount = Number(wizAmount)
    if (!amount || amount <= 0) {
      setWizDetailsError('Enter how much you want to save (more than 0).')
      return
    }
    const totalMonths = timelineToMonths(wizTimelineValue, wizTimelineUnit)
    if (!totalMonths) {
      setWizDetailsError('Enter how long you want to save for.')
      return
    }
    const plans = computePlanOptions(amount, totalMonths)
    setWizDetailsError(null)
    setWizPlans(plans)
    setWizStep('frequency')
  }

  function chooseFrequency(frequency) {
    setWizChosenFrequency(frequency)
    setWizError(null)
    setWizStep('confirm')
  }

  // Wording for the reminder step, e.g. "every week" / "every month" / "every year".
  function freqAdverb(frequency) {
    if (frequency === 'weekly') return 'every week'
    if (frequency === 'yearly') return 'every year'
    return 'every month'
  }

  async function pickFrequencyAndCreate(frequency, perPeriodAmount) {
    setWizCreating(true)
    setWizError(null)
    const totalMonths = timelineToMonths(wizTimelineValue, wizTimelineUnit)
    try {
      // STUB — assumes a single combined endpoint that creates the goal
      // and its saving plan in one call. Today /api/advisor/goals only
      // creates the goal itself; frequency/timeline_months/per_period_amount
      // would need to be accepted here too, and the backend would set up
      // the plan in the same request instead of a separate call.
      const res = await fetch('/api/advisor/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          goal_type: wizType.value,
          goal_name: wizGoalName || wizType.label,
          target_amount: Number(wizAmount),
          frequency,
          timeline_months: totalMonths,
          per_period_amount: Math.round(perPeriodAmount)
        })
      })
      const data = await res.json()
      if (data.success) {
        closeWizard()
        loadGoals()
      } else {
        setWizError(data.message || "Couldn't save that goal — please try again.")
      }
    } catch {
      setWizError("Couldn't reach the server — please try again.")
    } finally {
      setWizCreating(false)
    }
  }

  function askDeleteGoal(goal) {
    setDeleteConfirmFor(goal.id)
    setMoneyOpenFor(null)
    setActionError(null)
    setActionMessage(null)
  }

  async function confirmDeleteGoal(goal) {
    setBusy(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/advisor/goals/${goal.id}`, { method: 'DELETE', credentials: 'include' })
      // The backend is expected to move saved_amount back into the user's
      // available balance as part of this delete and return the updated
      // balance — same pattern as contribute/withdraw below. Falls back
      // to just refetching goals/balance if new_balance isn't sent.
      const data = await res.json().catch(() => null)
      if (data && typeof data.new_balance === 'number') setBalance(data.new_balance)
      setDeleteConfirmFor(null)
      loadGoals()
    } catch {
      setActionError("Couldn't reach the server — please try again.")
    } finally {
      setBusy(false)
    }
  }

  function openMoney(goal, mode) {
    setMoneyOpenFor({ goalId: goal.id, mode })
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
      <style>{`
        .goal-start-cta {
          display: flex;
          align-items: center;
          gap: 16px;
          width: 100%;
          padding: 20px 22px;
          margin-top: 8px;
          border: 2px dashed var(--primary-purple, #7c3aed);
          border-radius: 14px;
          background: transparent;
          cursor: pointer;
          text-align: left;
          transition: background 0.15s ease, border-style 0.15s ease;
        }
        .goal-start-cta:hover {
          background: rgba(124, 58, 237, 0.06);
          border-style: solid;
        }
        .goal-start-cta-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 44px;
          height: 44px;
          border-radius: 50%;
          background: var(--primary-purple, #7c3aed);
          color: #fff;
          font-size: 18px;
          flex-shrink: 0;
        }
        .goal-start-cta-text {
          display: flex;
          flex-direction: column;
          gap: 2px;
          flex: 1;
        }
        .goal-start-cta-text strong {
          font-size: 17px;
          font-weight: 800;
          letter-spacing: 0.3px;
          color: #1a1a1a;
        }
        .goal-start-cta-text span:last-child {
          font-size: 13.5px;
          color: var(--primary-purple, #7c3aed);
          font-weight: 600;
        }
        .goal-start-cta-arrow {
          font-size: 20px;
          color: var(--primary-purple, #7c3aed);
          flex-shrink: 0;
        }
        .goal-add-another-btn {
          width: 100%;
          margin-top: 14px;
          padding: 12px;
          border: 1.5px solid var(--secondary-purple, #ede9fe);
          border-radius: 10px;
          background: transparent;
          color: var(--primary-purple, #7c3aed);
          font-weight: 600;
          font-size: 13.5px;
          cursor: pointer;
          transition: background 0.15s ease;
        }
        .goal-add-another-btn:hover {
          background: rgba(124, 58, 237, 0.06);
        }
        .goal-wizard-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.45);
          display: flex;
          align-items: flex-start;
          justify-content: center;
          overflow-y: auto;
          z-index: 1000;
          padding: 32px 16px;
        }
        .goal-wizard-modal {
          position: relative;
          width: 100%;
          max-width: 440px;
          background: #fff;
          border-radius: 16px;
          padding: 26px 22px 22px;
          box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
        }
        .goal-wizard-close {
          position: absolute;
          top: 14px;
          right: 14px;
          width: 30px;
          height: 30px;
          border: none;
          border-radius: 50%;
          background: var(--secondary-purple, #ede9fe);
          color: var(--primary-purple, #7c3aed);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .goal-wizard-field {
          display: flex;
          flex-direction: column;
          gap: 6px;
          margin-top: 16px;
          font-size: 13.5px;
          font-weight: 600;
          color: #444;
        }
        .goal-wizard-field input {
          font-weight: 400;
          font-size: 14px;
          padding: 10px 12px;
          border: 1.5px solid var(--secondary-purple, #ede9fe);
          border-radius: 8px;
        }
        .goal-timeline-row {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .goal-timeline-row input {
          flex: 1;
          min-width: 0;
        }
        .goal-unit-dropdown {
          position: relative;
          flex: 0 0 108px;
        }
        .goal-unit-trigger {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          width: 100%;
          padding: 10px 12px;
          border: 1.5px solid var(--secondary-purple, #ede9fe);
          border-radius: 8px;
          background: #fff;
          font-size: 14px;
          color: #333;
          cursor: pointer;
        }
        .goal-unit-trigger i {
          font-size: 10px;
          color: var(--primary-purple, #7c3aed);
          transition: transform 0.15s ease;
        }
        .goal-unit-trigger.open i {
          transform: rotate(180deg);
        }
        .goal-unit-menu {
          position: absolute;
          top: calc(100% + 6px);
          left: 0;
          right: 0;
          background: #fff;
          border-radius: 10px;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
          overflow: hidden;
          z-index: 20;
        }
        .goal-unit-option {
          display: block;
          width: 100%;
          text-align: left;
          padding: 10px 14px;
          border: none;
          background: transparent;
          font-size: 14px;
          color: #333;
          cursor: pointer;
        }
        .goal-unit-option:hover {
          background: rgba(124, 58, 237, 0.06);
        }
        .goal-unit-option.selected {
          background: var(--secondary-purple, #ede9fe);
          color: var(--primary-purple, #7c3aed);
          font-weight: 600;
        }
        .goal-delete-confirm-btn {
          padding: 10px 18px;
          border: none;
          border-radius: 8px;
          background: var(--danger, #dc2626);
          color: #fff;
          font-weight: 600;
          font-size: 13.5px;
          cursor: pointer;
        }
        .goal-delete-confirm-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
        .goal-confirm-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 56px;
          height: 56px;
          margin: 8px auto 4px;
          border-radius: 50%;
          background: var(--secondary-purple, #ede9fe);
          color: var(--primary-purple, #7c3aed);
          font-size: 22px;
        }
        .goal-freq-grid {
          display: flex;
          gap: 10px;
        }
        .goal-freq-btn {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          padding: 16px 8px;
          border: 1.5px solid var(--secondary-purple, #ede9fe);
          border-radius: 12px;
          background: transparent;
          cursor: pointer;
          transition: border-color 0.15s ease, background 0.15s ease;
        }
        .goal-freq-btn:hover:not(:disabled) {
          border-color: var(--primary-purple, #7c3aed);
          background: rgba(124, 58, 237, 0.06);
        }
        .goal-freq-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .goal-freq-label {
          font-size: 12.5px;
          font-weight: 700;
          color: var(--primary-purple, #7c3aed);
          text-transform: uppercase;
          letter-spacing: 0.3px;
        }
        .goal-freq-amount {
          font-size: 14px;
          font-weight: 700;
          color: #1f1f1f;
          text-align: center;
        }
        .goal-freq-suffix {
          font-size: 11px;
          color: #888;
        }
        @media (max-width: 480px) {
          .goal-freq-grid { flex-direction: column; }
          .goal-freq-btn { flex-direction: row; justify-content: space-between; padding: 12px 14px; }
        }
      `}</style>

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
                  <button type="button" className="goal-remove-btn" aria-label="Delete goal" onClick={() => askDeleteGoal(g)}>×</button>
                </div>

                {deleteConfirmFor === g.id && (
                  <div className="goal-inline-form">
                    <p className="advisor-footnote">
                      Delete "{g.goal_name || type?.label}"?
                      {g.saved_amount > 0
                        ? ` ${fmt(g.saved_amount)} you've saved so far will be moved back into your available balance.`
                        : ' This goal has no saved amount yet.'}
                    </p>
                    {actionError && <p className="advisor-footnote" style={{ color: 'var(--danger)' }}>{actionError}</p>}
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button type="button" className="goal-delete-confirm-btn" disabled={busy} onClick={() => confirmDeleteGoal(g)}>
                        {busy ? 'Deleting…' : 'Delete goal'}
                      </button>
                      <button type="button" className="checkin-back-btn" onClick={() => setDeleteConfirmFor(null)} disabled={busy}>Cancel</button>
                    </div>
                  </div>
                )}

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
                </div>

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

      {/* Entry point: only shown before the user has any goal at all. */}
      {goals.length === 0 && (
        <button type="button" className="goal-start-cta" onClick={openWizard}>
          <span className="goal-start-cta-icon"><i className="fas fa-piggy-bank" /></span>
          <span className="goal-start-cta-text">
            <strong>WANT TO SAVE YOUR MONEY?!</strong>
            <span>Start from here</span>
          </span>
          <span className="goal-start-cta-arrow">→</span>
        </button>
      )}

      {/* Once at least one goal exists, this replaces the big CTA above. */}
      {goals.length > 0 && (
        <button type="button" className="goal-add-another-btn" onClick={openWizard}>
          + Add another goal
        </button>
      )}

      {/* ── New goal wizard modal ─────────────────────────────────────── */}
      {wizStep && (
        <div className="goal-wizard-overlay" role="presentation" onClick={closeWizard}>
          <div className="goal-wizard-modal" role="dialog" aria-label="Set up a savings goal" onClick={e => e.stopPropagation()}>
            <button type="button" className="goal-wizard-close" aria-label="Close" onClick={closeWizard}>
              <i className="fas fa-xmark" />
            </button>

            {wizStep === 'type' && (
              <>
                <h3 style={{ marginTop: 0 }}>What do you want to save for?</h3>
                <div className="goal-type-grid">
                  {GOAL_TYPES.map(t => (
                    <button key={t.value} type="button" className="goal-type-btn" onClick={() => chooseType(t)}>
                      <i className={`fas ${t.icon}`} />
                      <span>{t.label}</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {wizStep === 'details' && wizType && (
              <>
                <button type="button" className="checkin-back-btn" onClick={() => setWizStep('type')}>← Back</button>
                <h3 style={{ marginTop: 10 }}>
                  <i className={`fas ${wizType.icon}`} style={{ marginRight: 10 }} />
                  {wizType.label}
                </h3>

                {wizType.value === 'custom' && (
                  <label className="goal-wizard-field">
                    Goal name
                    <input type="text" value={wizGoalName} onChange={e => setWizGoalName(e.target.value)} />
                  </label>
                )}

                <label className="goal-wizard-field">
                  How much do you want to save?
                  <input
                    type="number" min="1" placeholder="e.g. 500000"
                    value={wizAmount}
                    onChange={e => setWizAmount(e.target.value)}
                  />
                </label>

                <label className="goal-wizard-field">
                  How long do you want to save for?
                  <div className="goal-timeline-row">
                    <input
                      type="number" min="1" placeholder="e.g. 3"
                      value={wizTimelineValue}
                      onChange={e => setWizTimelineValue(e.target.value)}
                    />
                    <div className="goal-unit-dropdown" ref={unitDropdownRef}>
                      <button
                        type="button"
                        className={`goal-unit-trigger ${wizUnitOpen ? 'open' : ''}`}
                        onClick={() => setWizUnitOpen(o => !o)}
                      >
                        {TIMELINE_UNITS.find(u => u.value === wizTimelineUnit)?.label}
                        <i className="fas fa-chevron-down" />
                      </button>
                      {wizUnitOpen && (
                        <div className="goal-unit-menu">
                          {TIMELINE_UNITS.map(u => (
                            <button
                              key={u.value}
                              type="button"
                              className={`goal-unit-option ${wizTimelineUnit === u.value ? 'selected' : ''}`}
                              onClick={() => { setWizTimelineUnit(u.value); setWizUnitOpen(false) }}
                            >
                              {u.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </label>

                {wizDetailsError && <p className="advisor-footnote" style={{ color: 'var(--danger)' }}>{wizDetailsError}</p>}

                <button type="button" className="topup-btn" style={{ marginTop: 8 }} onClick={continueToFrequency}>
                  Show me a plan
                </button>
              </>
            )}

            {wizStep === 'frequency' && wizType && wizPlans && (
              <>
                <button type="button" className="checkin-back-btn" onClick={() => setWizStep('details')}>← Back</button>
                <h3 style={{ marginTop: 10 }}>Choose your saving plan</h3>
                <p className="advisor-subtitle" style={{ marginBottom: 16 }}>
                  To save {fmt(Number(wizAmount))} in {timelineLabel(wizTimelineValue, wizTimelineUnit)}, here's what that looks like:
                </p>

                <div className="goal-freq-grid">
                  <button type="button" className="goal-freq-btn" onClick={() => chooseFrequency('weekly')}>
                    <span className="goal-freq-label">Weekly</span>
                    <span className="goal-freq-amount">{fmt(wizPlans.weekly)}</span>
                    <span className="goal-freq-suffix">/week</span>
                  </button>
                  <button type="button" className="goal-freq-btn" onClick={() => chooseFrequency('monthly')}>
                    <span className="goal-freq-label">Monthly</span>
                    <span className="goal-freq-amount">{fmt(wizPlans.monthly)}</span>
                    <span className="goal-freq-suffix">/month</span>
                  </button>
                  <button type="button" className="goal-freq-btn" onClick={() => chooseFrequency('yearly')}>
                    <span className="goal-freq-label">Yearly</span>
                    <span className="goal-freq-amount">{fmt(wizPlans.yearly)}</span>
                    <span className="goal-freq-suffix">/year</span>
                  </button>
                </div>
              </>
            )}

            {wizStep === 'confirm' && wizType && wizPlans && wizChosenFrequency && (
              <>
                <button type="button" className="checkin-back-btn" onClick={() => setWizStep('frequency')} disabled={wizCreating}>← Back</button>
                <div className="goal-confirm-icon"><i className="fas fa-bell" /></div>
                <h3 style={{ marginTop: 10, textAlign: 'center' }}>Stay on track</h3>
                <p className="advisor-subtitle" style={{ textAlign: 'center', marginBottom: 20 }}>
                  FinBud will check in with you <strong>{freqAdverb(wizChosenFrequency)}</strong> — if you
                  haven't saved <strong>{fmt(wizPlans[wizChosenFrequency])}</strong> toward
                  "{wizGoalName || wizType.label}" yet in that period, we'll send a gentle reminder to help you keep going.
                </p>

                {wizError && <p className="advisor-footnote" style={{ color: 'var(--danger)' }}>{wizError}</p>}

                <button
                  type="button"
                  className="topup-btn"
                  style={{ width: '100%' }}
                  disabled={wizCreating}
                  onClick={() => pickFrequencyAndCreate(wizChosenFrequency, wizPlans[wizChosenFrequency])}
                >
                  {wizCreating ? 'Setting up your goal…' : 'Okay, sounds good'}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}