import { useState, useEffect } from 'react'
import { adminGet, adminPost, formatTimestamp } from '../../utils/adminApi'
import StatCard from '../../components/shared/StatCard'
import Badge from '../../components/shared/Badge'
import Modal from '../../components/shared/Modal'
import LoadingSpinner from '../../components/shared/LoadingSpinner'
import EmptyState from '../../components/shared/EmptyState'

const TABS = [
  { key: '', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'flagged', label: 'Flagged' },
]

const FLAG_REASONS = [
  { key: 'face_mismatch', label: "Face doesn't match CNIC photo" },
  { key: 'cnic_altered', label: 'CNIC appears altered or fake' },
  { key: 'duplicate_cnic', label: 'Duplicate CNIC (already used by another account)' },
  { key: 'other', label: 'Other reason' },
]

const STATUS_COLOR = { pending: 'warning', approved: 'success', flagged: 'danger' }

function timeAgo(iso) {
  if (!iso) return '—'
  const diffMs = Date.now() - new Date(iso).getTime()
  const days = Math.floor(diffMs / 86400000)
  if (days >= 1) return `${days} day${days > 1 ? 's' : ''} ago`
  const hours = Math.floor(diffMs / 3600000)
  if (hours >= 1) return `${hours} hour${hours > 1 ? 's' : ''} ago`
  return 'Just now'
}

export default function KYCReviewQueue() {
  const [tab, setTab] = useState('pending')
  const [loading, setLoading] = useState(true)
  const [submissions, setSubmissions] = useState([])
  const [meta, setMeta] = useState({ total: 0, pending_count: 0, approved_this_week: 0, flagged_this_week: 0, avg_review_time_hours: null })
  const [selectedId, setSelectedId] = useState(null)

  const [approveOpen, setApproveOpen] = useState(false)
  const [flagOpen, setFlagOpen] = useState(false)
  const [flagReason, setFlagReason] = useState('face_mismatch')
  const [flagOther, setFlagOther] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => { load() }, [tab])

  async function load() {
    setLoading(true)
    try {
      const data = await adminGet(`/kyc/queue?status=${tab}`)
      if (data?.success !== false) {
        setSubmissions(data.submissions || [])
        setMeta({
          total: data.total || 0,
          pending_count: data.pending_count || 0,
          approved_this_week: data.approved_this_week || 0,
          flagged_this_week: data.flagged_this_week || 0,
          avg_review_time_hours: data.avg_review_time_hours
        })
        if (!selectedId && data.submissions?.length > 0) setSelectedId(data.submissions[0].id)
      }
    } catch { setSubmissions([]) }
    setLoading(false)
  }

  const selected = submissions.find(s => s.id === selectedId)

  async function confirmApprove() {
    if (!selectedId) return
    setBusy(true)
    try {
      await adminPost(`/kyc/${selectedId}/approve`, {})
      setApproveOpen(false)
      setSelectedId(null)
      await load()
    } catch {}
    setBusy(false)
  }

  async function confirmFlag() {
    if (!selectedId) return
    const reason = flagReason === 'other' ? (flagOther.trim() || 'other') : flagReason
    setBusy(true)
    try {
      await adminPost(`/kyc/${selectedId}/flag`, { reason })
      setFlagOpen(false)
      setFlagReason('face_mismatch')
      setFlagOther('')
      setSelectedId(null)
      await load()
    } catch {}
    setBusy(false)
  }

  return (
    <div className="kyc-wrap">
      <style>{`
        .kyc-wrap { max-width: 1280px; margin: 0 auto; }
        .kyc-stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 20px; }
        .kyc-tabs { display: flex; gap: 8px; margin-bottom: 16px; }
        .kyc-tab { background: var(--color-card-bg); border: 1px solid var(--color-border); border-radius: 20px; padding: 7px 16px; font-size: 12.5px; font-weight: 600; cursor: pointer; color: var(--color-text-secondary); }
        .kyc-tab.active { background: var(--color-primary); border-color: var(--color-primary); color: #fff; }
        .kyc-layout { display: grid; grid-template-columns: 35% 1fr; gap: 18px; align-items: start; }
        .kyc-list { background: var(--color-card-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); overflow: hidden; box-shadow: var(--shadow-card); }
        .kyc-item { padding: 13px 16px; border-bottom: 1px solid var(--color-border); cursor: pointer; }
        .kyc-item:hover { background: var(--color-content-bg); }
        .kyc-item.active { background: var(--color-primary-light); }
        .kyc-item-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
        .kyc-item-name { font-size: 13px; font-weight: 700; color: var(--color-text-primary); }
        .kyc-item-sub { font-size: 11.5px; color: var(--color-text-muted); }
        .kyc-review-panel { background: var(--color-card-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 24px; box-shadow: var(--shadow-card); min-height: 400px; }
        .kyc-user-bar { display: flex; gap: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--color-border); margin-bottom: 20px; flex-wrap: wrap; }
        .kyc-user-bar div span { display: block; font-size: 11px; color: var(--color-text-muted); text-transform: uppercase; margin-bottom: 2px; }
        .kyc-user-bar div strong { font-size: 14px; color: var(--color-text-primary); }
        .kyc-images { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 18px; }
        .kyc-image-box { border: 1px solid var(--color-border); border-radius: 10px; overflow: hidden; }
        .kyc-image-box h5 { margin: 0; padding: 10px 14px; background: var(--color-content-bg); font-size: 12px; font-weight: 700; color: var(--color-text-primary); }
        .kyc-image-box img { width: 100%; height: 240px; object-fit: cover; display: block; background: #eee; }
        .kyc-image-box a { display: block; text-align: center; padding: 8px; font-size: 11.5px; color: var(--color-primary); font-weight: 600; text-decoration: none; }
        .kyc-cnic-number { text-align: center; font-size: 20px; font-weight: 700; letter-spacing: 1px; color: var(--color-text-primary); background: var(--color-content-bg); padding: 12px; border-radius: 8px; margin-bottom: 16px; }
        .kyc-instruction { font-size: 12.5px; color: var(--color-text-secondary); text-align: center; margin-bottom: 20px; line-height: 1.5; }
        .kyc-action-row { display: flex; gap: 12px; }
        .kyc-btn { flex: 1; padding: 13px; border-radius: 8px; font-weight: 700; font-size: 13px; cursor: pointer; border: none; text-transform: uppercase; }
        .kyc-btn-approve { background: var(--color-success); color: #fff; }
        .kyc-btn-flag { background: var(--color-danger); color: #fff; }
        .kyc-radio-row { display: flex; align-items: center; gap: 8px; padding: 8px 0; font-size: 13px; color: var(--color-text-primary); }
        .kyc-other-input { width: 100%; margin-top: 8px; padding: 9px 12px; border: 1px solid var(--color-border); border-radius: 6px; font-size: 13px; }
        @media (max-width: 1024px) { .kyc-layout { grid-template-columns: 1fr; } .kyc-images { grid-template-columns: 1fr; } .kyc-stats-row { grid-template-columns: repeat(2, 1fr); } }
      `}</style>

      <div className="kyc-stats-row">
        <StatCard label="Total Pending" value={meta.pending_count} accent="warning" icon="fa-hourglass-half" />
        <StatCard label="Approved This Week" value={meta.approved_this_week} accent="success" icon="fa-check" />
        <StatCard label="Flagged This Week" value={meta.flagged_this_week} accent="danger" icon="fa-flag" />
        <StatCard label="Avg Review Time" value={meta.avg_review_time_hours != null ? `${meta.avg_review_time_hours}h` : '—'} icon="fa-stopwatch" />
      </div>

      <div className="kyc-tabs">
        {TABS.map(t => <button key={t.key} className={`kyc-tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>)}
      </div>

      {loading ? <LoadingSpinner label="Loading KYC queue..." /> : (
        <div className="kyc-layout">
          <div className="kyc-list">
            {submissions.length === 0 ? (
              <EmptyState icon="fa-id-card" title="Queue is empty" message="No submissions match this filter." />
            ) : submissions.map(s => (
              <div key={s.id} className={`kyc-item ${selectedId === s.id ? 'active' : ''}`} onClick={() => setSelectedId(s.id)}>
                <div className="kyc-item-top">
                  <span className="kyc-item-name">{s.name}</span>
                  <Badge label={s.status} color={STATUS_COLOR[s.status] || 'muted'} />
                </div>
                <div className="kyc-item-sub">{s.account_number} · {timeAgo(s.submitted_at)}</div>
              </div>
            ))}
          </div>

          <div className="kyc-review-panel">
            {!selected ? (
              <EmptyState icon="fa-magnifying-glass" title="Select a submission to review" message="Pick an item from the queue on the left." />
            ) : (
              <>
                <div className="kyc-user-bar">
                  <div><span>Name</span><strong>{selected.name}</strong></div>
                  <div><span>Account Number</span><strong>{selected.account_number}</strong></div>
                  <div><span>Status</span><Badge label={selected.status} color={STATUS_COLOR[selected.status] || 'muted'} /></div>
                </div>

                <div className="kyc-images">
                  <div className="kyc-image-box">
                    <h5>Selfie</h5>
                    {selected.selfie_url ? <img src={selected.selfie_url} alt="Selfie" /> : <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-muted)' }}>No image</div>}
                    {selected.selfie_url && <a href={selected.selfie_url} target="_blank" rel="noreferrer">View Full Size</a>}
                  </div>
                  <div className="kyc-image-box">
                    <h5>CNIC Front</h5>
                    {selected.cnic_front_url ? <img src={selected.cnic_front_url} alt="CNIC front" /> : <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-muted)' }}>No image</div>}
                    {selected.cnic_front_url && <a href={selected.cnic_front_url} target="_blank" rel="noreferrer">View Full Size</a>}
                  </div>
                </div>

                <div className="kyc-cnic-number">{selected.cnic_number}</div>
                <p className="kyc-instruction">Compare the face in the selfie with the photo on the CNIC. Verify the CNIC number matches.</p>

                {selected.status === 'pending' ? (
                  <div className="kyc-action-row">
                    <button className="kyc-btn kyc-btn-approve" onClick={() => setApproveOpen(true)}>✅ Approve</button>
                    <button className="kyc-btn kyc-btn-flag" onClick={() => setFlagOpen(true)}>🚩 Flag</button>
                  </div>
                ) : (
                  <p style={{ textAlign: 'center', fontSize: 12.5, color: 'var(--color-text-muted)' }}>
                    {selected.status === 'flagged' ? `Flagged: ${selected.flag_reason}` : 'Already reviewed'} — {selected.reviewed_by_name ? `by ${selected.reviewed_by_name}` : ''}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <Modal open={approveOpen} onClose={() => setApproveOpen(false)} title={`Approve KYC for ${selected?.name}?`}
        footer={<>
          <button className="kyc-btn" style={{ flex: 'none', padding: '9px 16px', background: 'var(--color-content-bg)', color: 'var(--color-text-primary)' }} onClick={() => setApproveOpen(false)}>Cancel</button>
          <button className="kyc-btn kyc-btn-approve" style={{ flex: 'none', padding: '9px 16px' }} onClick={confirmApprove} disabled={busy}>{busy ? 'Approving...' : 'Approve'}</button>
        </>}>
        <p>Their account will become fully verified.</p>
      </Modal>

      <Modal open={flagOpen} onClose={() => setFlagOpen(false)} title={`Flag KYC for ${selected?.name}?`} danger
        footer={<>
          <button className="kyc-btn" style={{ flex: 'none', padding: '9px 16px', background: 'var(--color-content-bg)', color: 'var(--color-text-primary)' }} onClick={() => setFlagOpen(false)}>Cancel</button>
          <button className="kyc-btn kyc-btn-flag" style={{ flex: 'none', padding: '9px 16px' }} onClick={confirmFlag} disabled={busy || (flagReason === 'other' && !flagOther.trim())}>{busy ? 'Flagging...' : 'Confirm'}</button>
        </>}>
        {FLAG_REASONS.map(r => (
          <label key={r.key} className="kyc-radio-row">
            <input type="radio" name="flagReason" checked={flagReason === r.key} onChange={() => setFlagReason(r.key)} />
            {r.label}
          </label>
        ))}
        {flagReason === 'other' && (
          <input className="kyc-other-input" placeholder="Describe the reason..." value={flagOther} onChange={e => setFlagOther(e.target.value)} />
        )}
      </Modal>
    </div>
  )
}