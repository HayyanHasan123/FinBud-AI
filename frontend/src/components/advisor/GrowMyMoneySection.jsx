import { useState, useEffect } from 'react'
import CheckInWizard from './CheckInWizard.jsx'
import SavingsGoalsPanel from './SavingsGoalsPanel.jsx'
import InvestingPanel from './InvestingPanel.jsx'
import AdvisorChatBubble from './AdvisorChatBubble.jsx'

// Single entry point Dashboard.jsx needs to import for the whole
// "Grow My Money" feature — keeps the diff to Dashboard.jsx to one import
// line and one <GrowMyMoneySection /> tag.
//
// Requires these backend pieces to be in place for full functionality:
//   - backend/goals_routes.py            (GET/POST/PUT/DELETE /api/advisor/goals)
//   - backend/advisor_profile_routes.py  (GET/POST /api/advisor/profile,
//                                          GET /api/advisor/investing/suggestion)
//   - backend/advisor_chat.py            (used by the isolated
//                                          `context: 'financial_advisor'` branch
//                                          inside app.py's /api/chat/message route)
// Without them, each panel below degrades gracefully to its own
// "coming online soon" placeholder — nothing crashes if the backend isn't
// live yet.
export default function GrowMyMoneySection() {
  const [profileLoaded, setProfileLoaded] = useState(false)
  const [profile, setProfile] = useState(null)
  const [showCheckIn, setShowCheckIn] = useState(false)

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/advisor/profile', { credentials: 'include' })
        const data = res.ok ? await res.json() : null
        // Only treat this as "no profile yet" if the backend actually exists
        // and explicitly confirmed it (success: true, profile: null). If the
        // route isn't built yet, res.ok/data.success will be falsy here, and
        // we skip the check-in gate entirely so the panels below (which have
        // their own "coming soon" states) are previewable without a backend.
        if (data && data.success) {
          setProfile(data.profile || null)
          setShowCheckIn(!data.profile)
        }
      } catch {
        // Backend unreachable — skip the check-in gate, fall through to panels.
      } finally {
        setProfileLoaded(true)
      }
    })()
  }, [])

  return (
    <>
      <div className="advisor-header" style={{ marginTop: 32 }}>
        <div>
          <h2 className="advisor-title">Grow My Money</h2>
          <p className="advisor-subtitle">A plan for saving toward what matters, and a gentle start with investing.</p>
        </div>
      </div>

      <div className="grow-money-grid">
        {profileLoaded && showCheckIn ? (
          <CheckInWizard onSaved={p => { setProfile(p); setShowCheckIn(false) }} />
        ) : (
          <>
            <SavingsGoalsPanel />
            <InvestingPanel />
          </>
        )}
      </div>

      <AdvisorChatBubble />
    </>
  )
}