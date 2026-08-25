import SavingsGoalsPanel from './SavingsGoalsPanel.jsx'
import InvestingPanel from './InvestingPanel.jsx'
import AdvisorChatBubble from './AdvisorChatBubble.jsx'

// Single entry point Dashboard.jsx needs to import for the whole
// "Grow My Money" feature — keeps the diff to Dashboard.jsx to one import
// line and one <GrowMyMoneySection /> tag.
//
// Requires these backend pieces to be in place for full functionality:
//   - backend/goals_routes.py            (GET/POST/PUT/DELETE /api/advisor/goals)
//   - backend/investing_guide_routes.py  (GET /api/investing/questions,
//                                          GET/POST /api/investing/guide,
//                                          POST /api/investing/guide/retake)
//   - backend/advisor_chat.py            (used by the isolated
//                                          `context: 'financial_advisor'` branch
//                                          inside app.py's /api/chat/message route)
// Without them, each panel below degrades gracefully to its own
// "coming online soon" placeholder — nothing crashes if the backend isn't
// live yet.
//
// No check-in gate here on purpose — InvestingPanel already runs its own
// 5-question quiz (GET /api/investing/questions -> POST /api/investing/guide)
// the first time it loads with no saved profile, so a separate CheckInWizard
// step in front of it was just a duplicate question flow.
export default function GrowMyMoneySection() {
  return (
    <>
      <div className="advisor-header grow-money-header" style={{ marginTop: 32 }}>
        <div>
          <h2 className="advisor-title">Grow My Money</h2>
          <p className="advisor-subtitle">A plan for saving toward what matters, and a gentle start with investing.</p>
        </div>
      </div>

      <div className="grow-money-grid">
        <SavingsGoalsPanel />
        <InvestingPanel />
      </div>

      <AdvisorChatBubble />
    </>
  )
}