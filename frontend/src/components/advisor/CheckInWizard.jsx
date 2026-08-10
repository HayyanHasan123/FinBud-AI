import { useState } from 'react'

// One-time, plain-language check-in. No jargon like "risk tolerance" — just
// two human questions. The answers become the user's "profile" and quietly
// steer tone + defaults everywhere else in Grow My Money (goals, investing
// explainer, and the advisor chat bubble).
const EXPERIENCE_OPTIONS = [
  { value: 'never', label: 'Never' },
  { value: 'a_little', label: 'A little' },
  { value: 'comfortable', label: "Yes, I'm comfortable with it" }
]

const RISK_OPTIONS = [
  { value: 'safe', label: 'Keep it safe' },
  { value: 'balanced', label: 'A little of both' },
  { value: 'growth', label: "I'm open to more growth" }
]

export default function CheckInWizard({ onSaved }) {
  const [step, setStep] = useState(1)
  const [experienceLevel, setExperienceLevel] = useState(null)
  const [riskPreference, setRiskPreference] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function finish(finalRisk) {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/advisor/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ experience_level: experienceLevel, risk_preference: finalRisk })
      })
      const data = await res.json()
      if (data.success) {
        onSaved(data.profile || { experience_level: experienceLevel, risk_preference: finalRisk })
      } else {
        setError(data.message || "Couldn't save that — please try again.")
      }
    } catch {
      setError("Couldn't reach the server — please try again.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card checkin-card">
      <h3 style={{ marginTop: 0 }}>Let's set up Grow My Money</h3>
      <p className="advisor-subtitle" style={{ marginBottom: 18 }}>
        Two quick questions — this helps us tailor everything below to you. We only ask once.
      </p>

      {step === 1 && (
        <div className="checkin-step">
          <p className="checkin-question">Have you ever put money into savings or investing before?</p>
          <div className="checkin-options">
            {EXPERIENCE_OPTIONS.map(opt => (
              <button
                key={opt.value}
                type="button"
                className="checkin-option-btn"
                onClick={() => { setExperienceLevel(opt.value); setStep(2) }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="checkin-step">
          <p className="checkin-question">
            If you set money aside, do you want it to stay 100% safe even if it grows slowly,
            or are you okay with some ups and downs for a chance at more growth?
          </p>
          <div className="checkin-options">
            {RISK_OPTIONS.map(opt => (
              <button
                key={opt.value}
                type="button"
                className="checkin-option-btn"
                disabled={saving}
                onClick={() => { setRiskPreference(opt.value); finish(opt.value) }}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button type="button" className="checkin-back-btn" onClick={() => setStep(1)} disabled={saving}>
            ← Back
          </button>
        </div>
      )}

      {saving && <p className="advisor-footnote">Saving your answers…</p>}
      {error && <p className="advisor-footnote" style={{ color: 'var(--danger)' }}>{error}</p>}
    </div>
  )
}