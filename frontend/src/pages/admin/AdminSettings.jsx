import { useState, useEffect } from 'react'
import { useAdminAuth } from '../../context/AdminAuthContext'
import { adminGet, adminPost, adminPatch, formatTimestamp } from '../../utils/adminApi'
import DataTable from '../../components/shared/DataTable'
import Badge from '../../components/shared/Badge'
import Modal from '../../components/shared/Modal'
import LoadingSpinner from '../../components/shared/LoadingSpinner'
import EmptyState from '../../components/shared/EmptyState'

const SECTIONS = [
  { key: 'admins', label: 'Admin User Management', icon: 'fa-users-gear' },
  { key: 'health', label: 'System Health', icon: 'fa-heart-pulse' },
  { key: 'thresholds', label: 'Fraud Detection Thresholds', icon: 'fa-sliders' },
  { key: 'password', label: 'Change My Password', icon: 'fa-key' },
]

const THRESHOLD_FIELDS = [
  { key: 'large_transfer_threshold', label: 'Large Transfer Threshold (PKR)', helper: 'Flag transfers at or above this amount' },
  { key: 'amount_spike_multiplier', label: 'Amount Spike Multiplier (×)', helper: 'e.g. 5 = flag if 5x above user\'s average' },
  { key: 'rapid_fire_count', label: 'Rapid Fire Count', helper: 'Number of transactions' },
  { key: 'rapid_fire_window_minutes', label: 'Rapid Fire Window (minutes)', helper: 'Time window for the count above' },
  { key: 'odd_hours_start', label: 'Odd Hours Start (24h)', helper: '0–23' },
  { key: 'odd_hours_end', label: 'Odd Hours End (24h)', helper: '0–23' },
]

export default function AdminSettings() {
  const { admin, isAdmin } = useAdminAuth()
  const [section, setSection] = useState('admins')

  if (!isAdmin) {
    return <EmptyState icon="fa-lock" title="Admin access required" message="Bankers can change their own password from the profile menu, but full settings are admin-only." />
  }

  return (
    <div className="as-wrap">
      <style>{`
        .as-wrap { max-width: 1100px; margin: 0 auto; display: grid; grid-template-columns: 220px 1fr; gap: 20px; }
        .as-nav { display: flex; flex-direction: column; gap: 4px; }
        .as-nav-btn { display: flex; align-items: center; gap: 10px; padding: 11px 14px; border-radius: 8px; background: var(--color-card-bg); border: 1px solid var(--color-border); color: var(--color-text-secondary); font-size: 12.5px; font-weight: 600; cursor: pointer; text-align: left; }
        .as-nav-btn.active { background: var(--color-primary); border-color: var(--color-primary); color: #fff; }
        .as-panel { background: var(--color-card-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 24px; box-shadow: var(--shadow-card); min-height: 400px; }
        .as-panel h3 { margin: 0 0 6px; font-size: 17px; color: var(--color-text-primary); }
        .as-panel .as-sub { font-size: 12.5px; color: var(--color-text-secondary); margin: 0 0 20px; }
        @media (max-width: 900px) { .as-wrap { grid-template-columns: 1fr; } .as-nav { flex-direction: row; flex-wrap: wrap; } }
      `}</style>

      <nav className="as-nav">
        {SECTIONS.map(s => (
          <button key={s.key} className={`as-nav-btn ${section === s.key ? 'active' : ''}`} onClick={() => setSection(s.key)}>
            <i className={`fas ${s.icon}`} /> {s.label}
          </button>
        ))}
      </nav>

      <div className="as-panel">
        {section === 'admins' && <AdminsSection currentAdminEmail={admin.email} />}
        {section === 'health' && <HealthSection />}
        {section === 'thresholds' && <ThresholdsSection />}
        {section === 'password' && <PasswordSection />}
      </div>
    </div>
  )
}

// ── SUB-SECTION 1: Admin User Management ─────────────────
function AdminsSection({ currentAdminEmail }) {
  const [admins, setAdmins] = useState([])
  const [loading, setLoading] = useState(true)

  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'banker' })
  const [createError, setCreateError] = useState('')
  const [busy, setBusy] = useState(false)

  const [editTarget, setEditTarget] = useState(null)
  const [editRole, setEditRole] = useState('banker')
  const [deactivateTarget, setDeactivateTarget] = useState(null)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const data = await adminGet('/settings/admins')
      setAdmins(Array.isArray(data) ? data : data?.admins || [])
    } catch { setAdmins([]) }
    setLoading(false)
  }

  async function handleCreate(e) {
    e.preventDefault()
    setCreateError(''); setBusy(true)
    try {
      const data = await adminPost('/settings/admins', form)
      if (data?.success) {
        setCreateOpen(false)
        setForm({ name: '', email: '', password: '', role: 'banker' })
        await load()
      } else {
        setCreateError(data?.message || 'Could not create admin.')
      }
    } catch (err) { setCreateError(err.message) }
    setBusy(false)
  }

  async function saveRole() {
    if (!editTarget) return
    setBusy(true)
    try {
      await adminPatch(`/settings/admins/${editTarget.id}`, { role: editRole })
      setEditTarget(null)
      await load()
    } catch {}
    setBusy(false)
  }

  async function confirmDeactivate() {
    if (!deactivateTarget) return
    setBusy(true)
    try {
      await adminPatch(`/settings/admins/${deactivateTarget.id}`, { status: 'inactive' })
      setDeactivateTarget(null)
      await load()
    } catch {}
    setBusy(false)
  }

  const columns = [
    { key: 'name', label: 'Name' },
    { key: 'email', label: 'Email' },
    { key: 'role', label: 'Role', render: r => <Badge label={r.role} color={r.role === 'admin' ? 'primary' : 'warning'} /> },
    { key: 'status', label: 'Status', render: r => <Badge label={r.status} color={r.status === 'active' ? 'success' : 'muted'} /> },
    { key: 'last_login', label: 'Last Login', render: r => r.last_login ? formatTimestamp(r.last_login) : 'Never' },
    { key: 'actions', label: 'Actions', render: r => {
      const isSelf = r.email === currentAdminEmail
      return (
        <div style={{ display: 'flex', gap: 6, opacity: isSelf ? 0.4 : 1 }}>
          <button className="as-mini-btn" disabled={isSelf} onClick={() => { setEditTarget(r); setEditRole(r.role) }}>Edit Role</button>
          <button className="as-mini-btn as-mini-danger" disabled={isSelf || r.status === 'inactive'} onClick={() => setDeactivateTarget(r)}>Deactivate</button>
        </div>
      )
    }},
  ]

  return (
    <div>
      <style>{`
        .as-mini-btn { background: var(--color-content-bg); border: 1px solid var(--color-border); border-radius: 6px; padding: 5px 10px; font-size: 11px; font-weight: 600; cursor: pointer; color: var(--color-text-primary); }
        .as-mini-btn:disabled { cursor: not-allowed; }
        .as-mini-danger:not(:disabled) { color: var(--color-danger); border-color: var(--color-danger); }
        .as-form label { display: block; font-size: 12.5px; font-weight: 600; color: var(--color-text-secondary); margin-top: 12px; margin-bottom: 4px; }
        .as-form input, .as-form select { width: 100%; padding: 9px 12px; border: 1px solid var(--color-border); border-radius: 7px; font-size: 13px; }
        .as-create-btn { background: var(--color-primary); color: #fff; border: none; border-radius: 8px; padding: 9px 16px; font-weight: 700; font-size: 12.5px; cursor: pointer; }
      `}</style>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h3 style={{ margin: 0 }}>Admin User Management</h3>
          <p className="as-sub" style={{ margin: '4px 0 0' }}>Create and manage admin/banker accounts.</p>
        </div>
        <button className="as-create-btn" onClick={() => setCreateOpen(true)}>+ Create New Admin</button>
      </div>

      {loading ? <LoadingSpinner label="Loading admins..." /> : (
        <DataTable columns={columns} rows={admins} emptyIcon="fa-users" emptyTitle="No admin accounts" emptyMessage="Create the first one above." />
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create New Admin"
        footer={<>
          <button className="as-mini-btn" onClick={() => setCreateOpen(false)}>Cancel</button>
          <button className="as-create-btn" onClick={handleCreate} disabled={busy}>{busy ? 'Creating...' : 'Create'}</button>
        </>}>
        <form className="as-form" onSubmit={handleCreate}>
          <label>Name</label>
          <input required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          <label>Email</label>
          <input type="email" required value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
          <label>Password</label>
          <input type="password" required value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
          <label>Role</label>
          <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
            <option value="banker">Banker</option>
            <option value="admin">Admin</option>
          </select>
          {createError && <p style={{ color: 'var(--color-danger)', fontSize: 12.5, marginTop: 10 }}>{createError}</p>}
        </form>
      </Modal>

      <Modal open={!!editTarget} onClose={() => setEditTarget(null)} title={`Edit role for ${editTarget?.name}`}
        footer={<>
          <button className="as-mini-btn" onClick={() => setEditTarget(null)}>Cancel</button>
          <button className="as-create-btn" onClick={saveRole} disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
        </>}>
        <select value={editRole} onChange={e => setEditRole(e.target.value)} style={{ width: '100%', padding: 9, border: '1px solid var(--color-border)', borderRadius: 7 }}>
          <option value="banker">Banker</option>
          <option value="admin">Admin</option>
        </select>
      </Modal>

      <Modal open={!!deactivateTarget} onClose={() => setDeactivateTarget(null)} title={`Deactivate ${deactivateTarget?.name}?`} danger
        footer={<>
          <button className="as-mini-btn" onClick={() => setDeactivateTarget(null)}>Cancel</button>
          <button className="as-create-btn" style={{ background: 'var(--color-danger)' }} onClick={confirmDeactivate} disabled={busy}>{busy ? 'Saving...' : 'Deactivate'}</button>
        </>}>
        <p>{deactivateTarget?.name} won't be able to sign in until reactivated.</p>
      </Modal>
    </div>
  )
}

// ── SUB-SECTION 2: System Health ──────────────────────────
function HealthSection() {
  const [health, setHealth] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    load()
    const interval = setInterval(load, 30000)
    return () => clearInterval(interval)
  }, [])

  async function load() {
    try {
      const data = await adminGet('/settings/health')
      if (data) setHealth(data)
    } catch {}
    setLoading(false)
  }

  function dot(status) {
    return <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: status === 'ok' ? 'var(--color-success)' : 'var(--color-danger)', marginRight: 8 }} />
  }

  const fallbackRate = health?.llm_fallback_rate_today
  const fallbackColor = fallbackRate == null ? 'var(--color-text-muted)' : fallbackRate < 20 ? 'var(--color-success)' : fallbackRate <= 40 ? 'var(--color-warning)' : 'var(--color-danger)'

  return (
    <div>
      <h3>System Health</h3>
      <p className="as-sub">Auto-refreshes every 30 seconds.</p>
      {loading ? <LoadingSpinner label="Checking systems..." /> : (
        <>
          <div style={{ display: 'flex', gap: 24, marginBottom: 24, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>{dot(health?.flask_status)} Flask Backend</div>
            <div style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>{dot(health?.postgres_status)} PostgreSQL</div>
            <div style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>{dot(health?.groq_status)} Groq API (LLM)</div>
          </div>

          <div style={{ background: 'var(--color-content-bg)', borderRadius: 10, padding: 20, marginBottom: 24 }}>
            <div style={{ fontSize: 11.5, textTransform: 'uppercase', color: 'var(--color-text-secondary)', marginBottom: 6 }}>LLM Fallback Rate Today</div>
            <div style={{ fontSize: 36, fontWeight: 700, color: fallbackColor }}>{fallbackRate != null ? `${fallbackRate}%` : '—'}</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>of messages used LLM fallback</div>
          </div>

          <h4 style={{ fontSize: 12.5, textTransform: 'uppercase', color: 'var(--color-text-secondary)', marginBottom: 10 }}>Recent Errors</h4>
          {(health?.recent_errors || []).length === 0 ? (
            <EmptyState icon="fa-check" title="No recent errors" message="Everything's running clean." />
          ) : health.recent_errors.map((err, i) => (
            <div key={i} style={{ padding: '10px 0', borderBottom: '1px solid var(--color-border)', fontSize: 12.5 }}>
              <div style={{ color: 'var(--color-text-muted)', fontSize: 11 }}>{formatTimestamp(err.timestamp)}</div>
              <div style={{ color: 'var(--color-danger)' }}>{err.message}</div>
            </div>
          ))}
        </>
      )}
    </div>
  )
}

// ── SUB-SECTION 3: Fraud Detection Thresholds ─────────────
function ThresholdsSection() {
  const [config, setConfig] = useState({})
  const [loading, setLoading] = useState(true)
  const [drafts, setDrafts] = useState({})
  const [confirmField, setConfirmField] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const data = await adminGet('/settings/config')
      const conf = data?.success === false ? {} : data
      setConfig(conf || {})
      setDrafts(conf || {})
    } catch { setConfig({}); setDrafts({}) }
    setLoading(false)
  }

  async function confirmSave() {
    if (!confirmField) return
    setBusy(true)
    try {
      await adminPatch('/settings/config', { config_key: confirmField, config_value: String(drafts[confirmField]) })
      setConfig(c => ({ ...c, [confirmField]: drafts[confirmField] }))
      setConfirmField(null)
    } catch {}
    setBusy(false)
  }

  return (
    <div>
      <h3>Fraud Detection Thresholds</h3>
      <p className="as-sub">These values control when transactions are automatically flagged as suspicious.</p>
      {loading ? <LoadingSpinner label="Loading thresholds..." /> : (
        THRESHOLD_FIELDS.map(field => (
          <div key={field.key} style={{ display: 'flex', alignItems: 'flex-end', gap: 12, padding: '14px 0', borderBottom: '1px solid var(--color-border)' }}>
            <div style={{ flexGrow: 1 }}>
              <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>{field.label}</label>
              <input
                type="number"
                value={drafts[field.key] ?? ''}
                onChange={e => setDrafts(d => ({ ...d, [field.key]: e.target.value }))}
                style={{ width: '100%', padding: 9, border: '1px solid var(--color-border)', borderRadius: 7, fontSize: 13 }}
              />
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>{field.helper}</div>
            </div>
            <button
              className="as-mini-btn"
              disabled={String(drafts[field.key]) === String(config[field.key])}
              onClick={() => setConfirmField(field.key)}
              style={{ padding: '9px 16px' }}
            >
              Save
            </button>
          </div>
        ))
      )}

      <Modal open={!!confirmField} onClose={() => setConfirmField(null)}
        title={`Update ${THRESHOLD_FIELDS.find(f => f.key === confirmField)?.label} to ${drafts[confirmField]}?`}
        footer={<>
          <button className="as-mini-btn" onClick={() => setConfirmField(null)}>Cancel</button>
          <button className="as-mini-btn" style={{ background: 'var(--color-primary)', color: '#fff' }} onClick={confirmSave} disabled={busy}>{busy ? 'Saving...' : 'Confirm'}</button>
        </>}>
        <p>This changes how the anomaly detector flags new activity going forward.</p>
      </Modal>
    </div>
  )
}

// ── SUB-SECTION 4: Change My Password ─────────────────────
function PasswordSection() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(''); setSuccess('')
    if (next !== confirm) { setError('New passwords do not match.'); return }
    if (next.length < 4) { setError('New password must be at least 4 characters.'); return }
    setBusy(true)
    try {
      const data = await adminPost('/settings/change-password', { currentPassword: current, newPassword: next })
      if (data?.success) {
        setSuccess('Password updated successfully.')
        setCurrent(''); setNext(''); setConfirm('')
      } else {
        setError(data?.message || 'Could not update password.')
      }
    } catch (err) { setError(err.message) }
    setBusy(false)
  }

  return (
    <div>
      <h3>Change My Password</h3>
      <p className="as-sub">Update the password for your own admin account.</p>
      <form className="as-form" onSubmit={handleSubmit} style={{ maxWidth: 340 }}>
        <label>Current Password</label>
        <input type="password" required value={current} onChange={e => setCurrent(e.target.value)} />
        <label>New Password</label>
        <input type="password" required value={next} onChange={e => setNext(e.target.value)} />
        <label>Confirm New Password</label>
        <input type="password" required value={confirm} onChange={e => setConfirm(e.target.value)} />
        {error && <p style={{ color: 'var(--color-danger)', fontSize: 12.5, marginTop: 10 }}>{error}</p>}
        {success && <p style={{ color: 'var(--color-success)', fontSize: 12.5, marginTop: 10 }}>{success}</p>}
        <button type="submit" className="as-create-btn" style={{ marginTop: 16 }} disabled={busy}>{busy ? 'Updating...' : 'Update Password'}</button>
      </form>
    </div>
  )
}