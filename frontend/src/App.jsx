import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Login from './pages/Login.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Chat from './pages/Chat.jsx'

import { AdminAuthProvider } from './context/AdminAuthContext.jsx'
import AdminLayout from './components/layout/AdminLayout.jsx'
import AdminLogin from './pages/admin/Login.jsx'
import AdminOverview from './pages/admin/Overview.jsx'
import LiveChatMonitor from './pages/admin/LiveChatMonitor.jsx'
import TicketQueue from './pages/admin/TicketQueue.jsx'
import FraudAlertList from './pages/admin/FraudAlertList.jsx'
import UserActivityLog from './pages/admin/UserActivityLog.jsx'
import RewardsManagement from './pages/admin/RewardsManagement.jsx'
import KYCReviewQueue from './pages/admin/KYCReviewQueue.jsx'
import UserManagement from './pages/admin/UserManagement.jsx'
import GlobalTransactions from './pages/admin/GlobalTransactions.jsx'
import FeeReporting from './pages/admin/FeeReporting.jsx'
import AdminSettings from './pages/admin/AdminSettings.jsx'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Customer app — unchanged */}
        <Route path="/" element={<Login />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/chat" element={<Chat />} />

        {/* Admin console — unlinked from the customer app on purpose.
            /admin/login has no wrapper (not authenticated yet). Every
            other /admin/* route is nested under AdminAuthProvider (session
            check) + AdminLayout (sidebar/header chrome + <Outlet/>). */}
        <Route path="/admin/login" element={<AdminLogin />} />
        <Route path="/admin" element={<AdminAuthProvider><AdminLayout /></AdminAuthProvider>}>
          <Route path="dashboard" element={<AdminOverview />} />
          <Route path="chat-monitor" element={<LiveChatMonitor />} />
          <Route path="tickets" element={<TicketQueue />} />
          <Route path="fraud" element={<FraudAlertList />} />
          <Route path="activity" element={<UserActivityLog />} />
          <Route path="rewards" element={<RewardsManagement />} />
          <Route path="kyc" element={<KYCReviewQueue />} />
          <Route path="users" element={<UserManagement />} />
          <Route path="transactions" element={<GlobalTransactions />} />
          <Route path="fees" element={<FeeReporting />} />
          <Route path="settings" element={<AdminSettings />} />
        </Route>

        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </BrowserRouter>
  )
}