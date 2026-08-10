import { useState, useEffect, useRef } from 'react'
import { useAdminAuth } from '../../context/AdminAuthContext'
import { adminGet, adminPost, formatTimestamp } from '../../utils/adminApi'
import LoadingSpinner from '../../components/shared/LoadingSpinner'
import EmptyState from '../../components/shared/EmptyState'
import Badge from '../../components/shared/Badge'

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'bot', label: 'Bot Mode' },
  { key: 'human', label: 'Human Mode' },
  { key: 'unclaimed', label: 'Unclaimed' }
]

export default function LiveChatMonitor() {
  const { admin } = useAdminAuth()
  const [conversations, setConversations] = useState([])
  const [listLoading, setListLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [replyText, setReplyText] = useState('')
  const [sending, setSending] = useState(false)
  const [ticketBusy, setTicketBusy] = useState(false)
  const messagesEndRef = useRef(null)

  useEffect(() => { loadList() }, [filter])
  useEffect(() => {
    const interval = setInterval(loadList, 15000) // light poll — real-time-ish without a socket layer
    return () => clearInterval(interval)
  }, [filter])
  useEffect(() => { if (selected) loadDetail(selected) }, [selected])
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [detail])

  async function loadList() {
    try {
      const data = await adminGet(`/chat-monitor/conversations?mode_filter=${filter}`)
      if (data?.success) setConversations(data.conversations || [])
    } catch {}
    setListLoading(false)
  }

  async function loadDetail(accountNumber) {
    setDetailLoading(true)
    try {
      const data = await adminGet(`/chat-monitor/conversations/${encodeURIComponent(accountNumber)}`)
      if (data?.success) setDetail(data)
    } catch {}
    setDetailLoading(false)
  }

  async function sendReply() {
    if (!replyText.trim() || !selected) return
    setSending(true)
    try {
      const data = await adminPost(`/chat-monitor/conversations/${encodeURIComponent(selected)}/reply`, { message: replyText.trim() })
      if (data?.success) {
        setReplyText('')
        await loadDetail(selected)
      }
    } catch {}
    setSending(false)
  }

  async function returnToBot() {
    if (!selected) return
    try {
      const data = await adminPost(`/chat-monitor/conversations/${encodeURIComponent(selected)}/return-to-bot`, {})
      if (data?.success) { await loadDetail(selected); await loadList() }
    } catch {}
  }

  // /handoff/create already exists in app.py (not under /api/admin) and isn't
  // session-gated to a customer — reused directly here instead of duplicating
  // ticket-creation logic in a new admin route.
  async function createTicket() {
    if (!selected) return
    setTicketBusy(true)
    try {
      await fetch('/handoff/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ account: selected, reason: 'Escalated from Live Chat Monitor' })
      })
      await loadDetail(selected)
    } catch {}
    setTicketBusy(false)
  }

  const selectedConvo = conversations.find(c => c.account_number === selected)

  return (
    <div className="lcm-wrap">
      <style>{`
        .lcm-wrap { display: grid; grid-template-columns: 340px 1fr; gap: 18px; height: calc(100vh - 128px); }
        .lcm-list-panel { background: var(--color-card-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); display: flex; flex-direction: column; overflow: hidden; box-shadow: var(--shadow-card); }
        .lcm-filter-row { display: flex; gap: 6px; padding: 12px; border-bottom: 1px solid var(--color-border); flex-wrap: wrap; }
        .lcm-filter-btn { background: var(--color-content-bg); border: 1px solid var(--color-border); border-radius: 20px; padding: 5px 12px; font-size: 11.5px; font-weight: 600; cursor: pointer; color: var(--color-text-secondary); }
        .lcm-filter-btn.active { background: var(--color-primary); border-color: var(--color-primary); color: #fff; }
        .lcm-convo-list { flex-grow: 1; overflow-y: auto; }
        .lcm-convo-row { padding: 12px 16px; border-bottom: 1px solid var(--color-border); cursor: pointer; transition: background 0.15s; }
        .lcm-convo-row:hover { background: var(--color-content-bg); }
        .lcm-convo-row.active { background: var(--color-primary-light); }
        .lcm-convo-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
        .lcm-convo-name { font-size: 13px; font-weight: 700; color: var(--color-text-primary); }
        .lcm-convo-preview { font-size: 12px; color: var(--color-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .lcm-convo-meta { font-size: 10.5px; color: var(--color-text-muted); margin-top: 4px; }
        .lcm-detail-panel { background: var(--color-card-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); display: flex; flex-direction: column; overflow: hidden; box-shadow: var(--shadow-card); }
        .lcm-detail-header { padding: 14px 20px; border-bottom: 1px solid var(--color-border); display: flex; justify-content: space-between; align-items: center; }
        .lcm-detail-header h3 { margin: 0; font-size: 15px; color: var(--color-text-primary); }
        .lcm-detail-actions { display: flex; gap: 8px; }
        .lcm-action-btn { background: var(--color-content-bg); border: 1px solid var(--color-border); border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 600; cursor: pointer; color: var(--color-text-primary); }
        .lcm-action-btn:hover { border-color: var(--color-primary); color: var(--color-primary); }
        .lcm-action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .lcm-messages { flex-grow: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px; background: var(--color-content-bg); }
        .lcm-msg { max-width: 70%; padding: 10px 14px; border-radius: 14px; font-size: 13px; line-height: 1.5; }
        .lcm-msg-user { align-self: flex-end; background: var(--color-primary); color: #fff; border-bottom-right-radius: 3px; }
        .lcm-msg-ai { align-self: flex-start; background: #fff; color: var(--color-text-primary); border: 1px solid var(--color-border); border-bottom-left-radius: 3px; }
        .lcm-msg-banker { align-self: flex-start; background: #fef3c7; color: var(--color-text-primary); border: 1px solid #f59e0b; border-bottom-left-radius: 3px; }
        .lcm-msg-tag { font-size: 9.5px; text-transform: uppercase; font-weight: 700; opacity: 0.65; margin-bottom: 3px; }
        .lcm-msg-time { font-size: 10px; opacity: 0.6; margin-top: 4px; }
        .lcm-reply-bar { display: flex; gap: 10px; padding: 14px 20px; border-top: 1px solid var(--color-border); }
        .lcm-reply-input { flex-grow: 1; padding: 10px 14px; border: 1px solid var(--color-border); border-radius: 8px; font-size: 13px; outline: none; }
        .lcm-reply-input:focus { border-color: var(--color-primary); }
        .lcm-send-btn { background: var(--color-primary); color: #fff; border: none; border-radius: 8px; padding: 0 20px; font-weight: 600; font-size: 13px; cursor: pointer; }
        .lcm-send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      `}</style>

      <div className="lcm-list-panel">
        <div className="lcm-filter-row">
          {FILTERS.map(f => (
            <button key={f.key} className={`lcm-filter-btn ${filter === f.key ? 'active' : ''}`} onClick={() => setFilter(f.key)}>{f.label}</button>
          ))}
        </div>
        <div className="lcm-convo-list">
          {listLoading ? <LoadingSpinner label="Loading conversations..." /> : conversations.length === 0 ? (
            <EmptyState icon="fa-comments" title="No conversations" message="Nothing matches this filter right now." />
          ) : conversations.map(c => (
            <div key={c.account_number} className={`lcm-convo-row ${selected === c.account_number ? 'active' : ''}`} onClick={() => setSelected(c.account_number)}>
              <div className="lcm-convo-top">
                <span className="lcm-convo-name">{c.name}</span>
                <Badge label={c.mode === 'human' ? 'HUMAN' : 'BOT'} color={c.mode === 'human' ? 'warning' : 'success'} />
              </div>
              <div className="lcm-convo-preview">{c.last_message_preview || 'No messages yet'}</div>
              <div className="lcm-convo-meta">
                {c.mode === 'human' && (c.assigned_to ? `Claimed by ${c.assigned_to}` : 'Unclaimed')}
                {c.mode === 'human' && ' · '}
                {formatTimestamp(c.last_activity)}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="lcm-detail-panel">
        {!selected ? (
          <EmptyState icon="fa-message" title="Select a conversation" message="Pick a user from the list to view their full chat history." />
        ) : detailLoading ? (
          <LoadingSpinner label="Loading conversation..." />
        ) : (
          <>
            <div className="lcm-detail-header">
              <h3>{selectedConvo?.name || selected} <span style={{ fontWeight: 400, color: 'var(--color-text-muted)', fontSize: 12 }}>· {selected}</span></h3>
              <div className="lcm-detail-actions">
                <button className="lcm-action-btn" onClick={createTicket} disabled={ticketBusy}>
                  <i className="fas fa-ticket" /> {ticketBusy ? 'Creating...' : 'Create Ticket'}
                </button>
                {selectedConvo?.mode === 'human' && (
                  <button className="lcm-action-btn" onClick={returnToBot}><i className="fas fa-robot" /> Return to Bot</button>
                )}
              </div>
            </div>

            <div className="lcm-messages">
              {(detail?.messages || []).length === 0 ? (
                <EmptyState icon="fa-comment-slash" title="No messages yet" message="This user hasn't chatted with FinBud AI yet." />
              ) : detail.messages.map(m => (
                <div key={m.id}>
                  <div className="lcm-msg lcm-msg-user">{m.user_message}</div>
                  <div className={`lcm-msg ${m.sender === 'banker' ? 'lcm-msg-banker' : 'lcm-msg-ai'}`} style={{ marginTop: 6 }}>
                    <div className="lcm-msg-tag">{m.sender === 'banker' ? 'Banker' : m.engine ? m.engine : 'AI'}</div>
                    {m.ai_response}
                    <div className="lcm-msg-time">{formatTimestamp(m.created_at)}</div>
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {selectedConvo?.mode === 'human' && (
              <div className="lcm-reply-bar">
                <input
                  className="lcm-reply-input"
                  placeholder="Type a reply as the assigned banker..."
                  value={replyText}
                  onChange={e => setReplyText(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !sending && sendReply()}
                />
                <button className="lcm-send-btn" onClick={sendReply} disabled={sending || !replyText.trim()}>
                  {sending ? 'Sending...' : 'Send'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}