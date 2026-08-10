import { useState, useEffect, useRef } from 'react'
import { useNavigate, useLocation, Outlet, Link } from 'react-router-dom'
import { useAdminAuth } from '../../context/AdminAuthContext'
import { adminGet } from '../../utils/adminApi'

// Sidebar nav config — Part 2 of the spec. Role filtering happens once here;
// individual pages don't need to re-check "am I allowed to be here."
const NAV_ITEMS = [
  { path: '/admin/dashboard',    label: 'Overview',              icon: 'fa-gauge-high',           roles: ['admin'] },
  { path: '/admin/chat-monitor', label: 'Live Chat Monitor',     icon: 'fa-comments',              roles: ['admin', 'banker'] },
  { path: '/admin/tickets',      label: 'Support Tickets',       icon: 'fa-ticket',                roles: ['admin', 'banker'] },
  { path: '/admin/fraud',        label: 'Fraud Alerts',          icon: 'fa-triangle-exclamation',  roles: ['admin'] },
  { path: '/admin/activity',     label: 'User Activity Log',     icon: 'fa-clock-rotate-left',     roles: ['admin'] },
  { path: '/admin/users',        label: 'User Management',       icon: 'fa-users',                 roles: ['admin', 'banker'] },
  { path: '/admin/rewards',      label: 'Rewards & Points',      icon: 'fa-gift',                  roles: ['admin'] },
  { path: '/admin/kyc',          label: 'KYC Review',            icon: 'fa-id-card',               roles: ['admin'] },
  { path: '/admin/transactions', label: 'Transaction Oversight', icon: 'fa-money-bill-transfer',   roles: ['admin'] },
  { path: '/admin/fees',         label: 'Fee & Revenue',         icon: 'fa-chart-line',            roles: ['admin'] },
  { path: '/admin/settings',     label: 'Admin Settings',        icon: 'fa-gear',                  roles: ['admin'] },
]

const PAGE_TITLES = Object.fromEntries(NAV_ITEMS.map(n => [n.path, n.label]))

export default function AdminLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { admin, logout } = useAdminAuth()

  const [health, setHealth] = useState({ online: null })
  const [notifCounts, setNotifCounts] = useState({ fraud_alerts_unread: 0, kyc_pending: 0 })
  const [notifOpen, setNotifOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const searchTimeoutRef = useRef(null)

  useEffect(() => {
    pingHealth()
    const healthInterval = setInterval(pingHealth, 30000)
    return () => clearInterval(healthInterval)
  }, [])

  useEffect(() => {
    if (admin.role !== 'admin') return
    loadNotifCounts()
    const notifInterval = setInterval(loadNotifCounts, 60000)
    return () => clearInterval(notifInterval)
  }, [admin.role])

  async function pingHealth() {
    try {
      const data = await adminGet('/health')
      setHealth({ online: !!(data && data.success && data.flask_status === 'ok' && data.postgres_status === 'ok') })
    } catch {
      setHealth({ online: false })
    }
  }

  async function loadNotifCounts() {
    try {
      const data = await adminGet('/notifications/summary')
      if (data && data.success) {
        setNotifCounts({
          fraud_alerts_unread: data.fraud_alerts_unread || 0,
          kyc_pending: data.kyc_pending || 0
        })
      }
    } catch {}
  }

  function handleSearchChange(v) {
    setSearchQuery(v)
    clearTimeout(searchTimeoutRef.current)
    if (!v.trim()) { setSearchResults([]); setSearchOpen(false); return }
    searchTimeoutRef.current = setTimeout(async () => {
      setSearchLoading(true)
      try {
        const data = await adminGet(`/users/search?q=${encodeURIComponent(v.trim())}`)
        if (data && data.success) { setSearchResults(data.results || []); setSearchOpen(true) }
      } catch {}
      setSearchLoading(false)
    }, 300)
  }

  function goToUser(accountNumber) {
    setSearchOpen(false); setSearchQuery('')
    navigate(`/admin/users?account=${encodeURIComponent(accountNumber)}`)
  }

  const visibleNav = NAV_ITEMS.filter(n => n.roles.includes(admin.role))
  const totalNotifs = notifCounts.fraud_alerts_unread + notifCounts.kyc_pending
  const pageTitle = PAGE_TITLES[location.pathname] || 'FinBud Ops Console'
  const initials = admin.name ? admin.name.trim().split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase() : '?'

  return (
    <>
      <style>{`
        html, body { margin: 0; padding: 0; min-height: 100vh; width: 100%; background: var(--color-content-bg); }
        #root { width: 100%; max-width: none; margin: 0; padding: 0; border-inline: none; text-align: left; display: block; min-height: 100vh; }
        * { box-sizing: border-box; font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue", Arial; }
        .aops-shell { display: flex; min-height: 100vh; width: 100%; }
        .aops-sidebar { width: var(--sidebar-width); flex-shrink: 0; background: var(--color-sidebar-bg); border-right: 1px solid var(--color-border); display: flex; flex-direction: column; position: sticky; top: 0; height: 100vh; }
        .aops-sidebar-brand { display: flex; align-items: center; gap: 10px; padding: 22px 20px 18px; border-bottom: 1px solid var(--color-border); }
        .aops-logo-circle { width: 34px; height: 34px; border-radius: 50%; background: var(--color-primary); color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 13px; flex-shrink: 0; }
        .aops-brand-text { color: var(--color-primary); font-weight: 700; font-size: 15px; line-height: 1.2; }
        .aops-brand-sub { color: var(--color-sidebar-text-muted); font-size: 10px; letter-spacing: 1px; text-transform: uppercase; }
        .aops-sidebar-admin { padding: 16px 20px; border-bottom: 1px solid var(--color-border); }
        .aops-admin-name { color: var(--color-sidebar-text); font-size: 13px; font-weight: 600; margin-bottom: 6px; }
        .aops-role-badge { display: inline-block; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; padding: 3px 9px; border-radius: 20px; }
        .aops-role-badge.admin { background: var(--color-primary-light); color: var(--color-primary); }
        .aops-role-badge.banker { background: var(--color-warning-light); color: var(--color-warning); }
        .aops-nav { flex-grow: 1; list-style: none; margin: 0; padding: 12px; overflow-y: auto; }
        .aops-nav li { margin-bottom: 2px; }
        .aops-nav a { display: flex; align-items: center; gap: 12px; padding: 11px 14px; border-radius: 7px; color: var(--color-sidebar-text); font-size: 13.5px; font-weight: 500; text-decoration: none; cursor: pointer; transition: background var(--transition-fast), color var(--transition-fast); }
        .aops-nav a i { width: 16px; text-align: center; font-size: 14px; color: var(--color-primary); }
        .aops-nav a:hover { background: var(--color-sidebar-bg-hover); color: var(--color-primary); }
        .aops-nav a.active { background: var(--color-sidebar-active); color: #fff; }
        .aops-nav a.active i { color: #fff; }
        .aops-sidebar-footer { padding: 16px; border-top: 1px solid var(--color-border); }
        .aops-logout-btn { width: 100%; background: transparent; border: 1px solid var(--color-border); color: var(--color-text-secondary); padding: 10px; border-radius: 7px; cursor: pointer; font-weight: 600; font-size: 12.5px; }
        .aops-logout-btn:hover { background: var(--color-danger-light); border-color: var(--color-danger); color: var(--color-danger); }
        .aops-main { flex-grow: 1; min-width: 0; display: flex; flex-direction: column; }
        .aops-header { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 0 32px; height: var(--header-height); background: var(--color-header-bg); border-bottom: 1px solid var(--color-border); position: sticky; top: 0; z-index: 20; }
        .aops-header-title { font-size: 19px; font-weight: 700; color: var(--color-text-primary); margin: 0; flex-shrink: 0; }
        .aops-search-wrap { position: relative; flex-grow: 1; max-width: 380px; }
        .aops-search-input { width: 100%; padding: 9px 14px 9px 34px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); font-size: 13px; background: var(--color-content-bg); outline: none; }
        .aops-search-input:focus { border-color: var(--color-primary); background: #fff; }
        .aops-search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--color-text-muted); font-size: 13px; }
        .aops-search-dropdown { position: absolute; top: 42px; left: 0; width: 100%; background: #fff; border-radius: 8px; box-shadow: var(--shadow-modal); z-index: 50; max-height: 320px; overflow-y: auto; }
        .aops-search-row { padding: 10px 14px; cursor: pointer; font-size: 13px; border-bottom: 1px solid var(--color-border); }
        .aops-search-row:hover { background: var(--color-content-bg); }
        .aops-search-row strong { color: var(--color-text-primary); }
        .aops-search-row span { display: block; color: var(--color-text-muted); font-size: 11.5px; margin-top: 2px; }
        .aops-search-empty { padding: 14px; font-size: 12.5px; color: var(--color-text-muted); text-align: center; }
        .aops-header-right { display: flex; align-items: center; gap: 18px; flex-shrink: 0; }
        .aops-live-dot-wrap { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--color-text-muted); }
        .aops-live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--color-text-muted); }
        .aops-live-dot.online { background: var(--color-success); box-shadow: 0 0 0 3px var(--color-success-light); }
        .aops-live-dot.offline { background: var(--color-danger); box-shadow: 0 0 0 3px var(--color-danger-light); }
        .aops-bell-wrap { position: relative; cursor: pointer; padding: 6px; }
        .aops-bell-wrap i { font-size: 18px; color: var(--color-primary); }
        .aops-bell-badge { position: absolute; top: 2px; right: 2px; background: var(--color-danger); color: #fff; border-radius: 50%; width: 16px; height: 16px; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; }
        .aops-bell-dropdown { position: absolute; top: 48px; right: 0; width: 280px; background: #fff; border-radius: 10px; box-shadow: var(--shadow-modal); z-index: 100; padding: 16px; }
        .aops-bell-dropdown h4 { margin: 0 0 12px; color: var(--color-text-primary); font-size: 14px; }
        .aops-bell-row { display: flex; justify-content: space-between; padding: 8px 0; font-size: 13px; color: var(--color-text-secondary); border-bottom: 1px solid var(--color-border); }
        .aops-bell-row:last-child { border-bottom: none; }
        .aops-bell-row strong { color: var(--color-primary); }
        .aops-profile-wrap { position: relative; }
        .aops-profile-btn { display: flex; align-items: center; gap: 10px; background: none; border: none; cursor: pointer; padding: 4px; }
        .aops-profile-avatar { width: 34px; height: 34px; border-radius: 50%; background: var(--color-primary); color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 13px; }
        .aops-profile-dropdown { position: absolute; top: 46px; right: 0; width: 190px; background: #fff; border-radius: 8px; box-shadow: var(--shadow-modal); z-index: 100; overflow: hidden; }
        .aops-profile-dropdown a { display: block; padding: 12px 16px; font-size: 13px; color: var(--color-text-secondary); text-decoration: none; cursor: pointer; }
        .aops-profile-dropdown a:hover { background: var(--color-content-bg); }
        .aops-profile-dropdown a.danger { color: var(--color-danger); }
        .aops-content { flex-grow: 1; padding: 28px 32px; }
        @media (max-width: 1024px) { .aops-search-wrap { display: none; } }
      `}</style>

      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css" />

      <div className="aops-shell" onClick={() => { setNotifOpen(false); setProfileOpen(false); setSearchOpen(false) }}>
        <nav className="aops-sidebar">
          <div className="aops-sidebar-brand">
            <div className="aops-logo-circle">AI</div>
            <div>
              <div className="aops-brand-text">FinBud</div>
              <div className="aops-brand-sub">Ops Console</div>
            </div>
          </div>
          <div className="aops-sidebar-admin">
            <div className="aops-admin-name">{admin.name}</div>
            <span className={`aops-role-badge ${admin.role}`}>{admin.role === 'admin' ? 'Admin' : 'Banker'}</span>
          </div>
          <ul className="aops-nav">
            {visibleNav.map(item => (
              <li key={item.path}>
                <Link to={item.path} className={location.pathname === item.path ? 'active' : ''}>
                  <i className={`fas ${item.icon}`} /> {item.label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="aops-sidebar-footer">
            <button className="aops-logout-btn" onClick={logout}>LOG OUT</button>
          </div>
        </nav>

        <div className="aops-main">
          <header className="aops-header" onClick={e => e.stopPropagation()}>
            <h1 className="aops-header-title">{pageTitle}</h1>

            {admin.role === 'admin' && (
              <div className="aops-search-wrap">
                <i className="fas fa-magnifying-glass aops-search-icon" />
                <input
                  className="aops-search-input"
                  placeholder="Search users by name, account, or email..."
                  value={searchQuery}
                  onChange={e => handleSearchChange(e.target.value)}
                  onFocus={() => searchResults.length > 0 && setSearchOpen(true)}
                />
                {searchOpen && (
                  <div className="aops-search-dropdown">
                    {searchLoading && <div className="aops-search-empty">Searching...</div>}
                    {!searchLoading && searchResults.length === 0 && <div className="aops-search-empty">No users found.</div>}
                    {!searchLoading && searchResults.map(u => (
                      <div key={u.account_number} className="aops-search-row" onClick={() => goToUser(u.account_number)}>
                        <strong>{u.name}</strong>
                        <span>{u.account_number} · {u.email}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="aops-header-right">
              <div className="aops-live-dot-wrap">
                <span className={`aops-live-dot ${health.online === null ? '' : health.online ? 'online' : 'offline'}`} />
                {health.online === null ? 'Checking...' : health.online ? 'Systems online' : 'Backend unreachable'}
              </div>

              {admin.role === 'admin' && (
                <div className="aops-bell-wrap" onClick={e => { e.stopPropagation(); setNotifOpen(o => !o); setProfileOpen(false) }}>
                  <i className="fas fa-bell" />
                  {totalNotifs > 0 && <span className="aops-bell-badge">{totalNotifs > 9 ? '9+' : totalNotifs}</span>}
                  {notifOpen && (
                    <div className="aops-bell-dropdown" onClick={e => e.stopPropagation()}>
                      <h4>Needs Attention</h4>
                      <div className="aops-bell-row"><span>Unreviewed fraud alerts</span><strong>{notifCounts.fraud_alerts_unread}</strong></div>
                      <div className="aops-bell-row"><span>Pending KYC reviews</span><strong>{notifCounts.kyc_pending}</strong></div>
                    </div>
                  )}
                </div>
              )}

              <div className="aops-profile-wrap">
                <button className="aops-profile-btn" onClick={e => { e.stopPropagation(); setProfileOpen(o => !o); setNotifOpen(false) }}>
                  <div className="aops-profile-avatar">{initials}</div>
                </button>
                {profileOpen && (
                  <div className="aops-profile-dropdown" onClick={e => e.stopPropagation()}>
                    <a onClick={() => { setProfileOpen(false); navigate('/admin/settings') }}>Change Password</a>
                    <a className="danger" onClick={logout}>Log Out</a>
                  </div>
                )}
              </div>
            </div>
          </header>

          <div className="aops-content">
            <Outlet />
          </div>
        </div>
      </div>
    </>
  )
}