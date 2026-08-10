import { useState, useEffect, useRef } from 'react'
import { adminGet, formatPKR, formatTimestamp } from '../../utils/adminApi'
import SearchInput from '../../components/shared/SearchInput'
import DataTable from '../../components/shared/DataTable'
import Badge from '../../components/shared/Badge'
import LoadingSpinner from '../../components/shared/LoadingSpinner'
import EmptyState from '../../components/shared/EmptyState'

const INTENTS = ['check_balance', 'transfer_money', 'pay_bill', 'transaction_history', 'redeem_points', 'check_rewards', 'general_chat', 'unknown']
const TXN_TYPES = ['transfer', 'bill', 'redemption', 'income', 'topup']

export default function UserActivityLog() {
  const [selectedUser, setSelectedUser] = useState(null)
  const [tab, setTab] = useState('chat')
  const printRef = useRef(null)

  // Tab 1: chat
  const [chatIntent, setChatIntent] = useState('')
  const [chatDateFrom, setChatDateFrom] = useState('')
  const [chatDateTo, setChatDateTo] = useState('')
  const [chatPage, setChatPage] = useState(1)
  const [chatData, setChatData] = useState({ sessions: [], total: 0, page: 1, pages: 1 })
  const [chatLoading, setChatLoading] = useState(false)
  const [expandedSession, setExpandedSession] = useState(null)

  // Tab 2: transactions
  const [txnType, setTxnType] = useState('')
  const [txnDateFrom, setTxnDateFrom] = useState('')
  const [txnDateTo, setTxnDateTo] = useState('')
  const [txnPage, setTxnPage] = useState(1)
  const [txnData, setTxnData] = useState({ transactions: [], total: 0, page: 1, pages: 1 })
  const [txnLoading, setTxnLoading] = useState(false)

  // Tab 3: logins
  const [logins, setLogins] = useState([])
  const [loginsLoading, setLoginsLoading] = useState(false)

  useEffect(() => {
    if (!selectedUser) return
    if (tab === 'chat') loadChat()
    if (tab === 'transactions') loadTransactions()
    if (tab === 'logins') loadLogins()
  }, [selectedUser, tab, chatIntent, chatDateFrom, chatDateTo, chatPage, txnType, txnDateFrom, txnDateTo, txnPage])

  async function searchUsers(q) {
    const data = await adminGet(`/activity/search-users?q=${encodeURIComponent(q)}`)
    return data?.success ? data.results : []
  }

  function selectUser(u) {
    setSelectedUser(u)
    setTab('chat')
    setChatPage(1); setTxnPage(1); setExpandedSession(null)
  }

  async function loadChat() {
    setChatLoading(true)
    const params = new URLSearchParams({ page: chatPage })
    if (chatIntent) params.set('intent_filter', chatIntent)
    if (chatDateFrom) params.set('date_from', chatDateFrom)
    if (chatDateTo) params.set('date_to', chatDateTo)
    setExpandedSession(null)
    try {
      const data = await adminGet(`/activity/${encodeURIComponent(selectedUser.account_number)}/chat?${params.toString()}`)
      if (data?.success !== false) setChatData({ sessions: data.sessions || [], total: data.total || 0, page: data.page || 1, pages: data.pages || 1 })
    } catch { setChatData({ sessions: [], total: 0, page: 1, pages: 1 }) }
    setChatLoading(false)
  }

  async function loadTransactions() {
    setTxnLoading(true)
    const params = new URLSearchParams({ page: txnPage })
    if (txnType) params.set('type_filter', txnType)
    if (txnDateFrom) params.set('date_from', txnDateFrom)
    if (txnDateTo) params.set('date_to', txnDateTo)
    try {
      const data = await adminGet(`/activity/${encodeURIComponent(selectedUser.account_number)}/transactions?${params.toString()}`)
      if (data?.success !== false) setTxnData({ transactions: data.transactions || [], total: data.total || 0, page: data.page || 1, pages: data.pages || 1 })
    } catch { setTxnData({ transactions: [], total: 0, page: 1, pages: 1 }) }
    setTxnLoading(false)
  }

  async function loadLogins() {
    setLoginsLoading(true)
    try {
      const data = await adminGet(`/activity/${encodeURIComponent(selectedUser.account_number)}/logins`)
      setLogins(Array.isArray(data) ? data : data?.logins || [])
    } catch { setLogins([]) }
    setLoginsLoading(false)
  }

  function renderPrint(receipt) {
    if (!printRef.current) return
    const amt = Math.abs(receipt.amount).toLocaleString('en-PK')
    printRef.current.innerHTML = `
      <div class="r-header"><h2>FinBud AI — Transaction Receipt</h2><p>${receipt.date} · ${receipt.time}</p></div>
      <div class="r-row"><span>Transaction ID</span><strong>#${receipt.transaction_id}</strong></div>
      <div class="r-row"><span>Account</span><strong>${receipt.account_number}</strong></div>
      <div class="r-row"><span>Type</span><strong>${receipt.transaction_type}</strong></div>
      <div class="r-row"><span>Description</span><strong>${receipt.description}</strong></div>
      <div class="r-row"><span>Amount</span><strong>PKR ${amt}</strong></div>
      <div class="r-row"><span>Status</span><strong>${receipt.status}</strong></div>
    `
  }

  async function downloadReceipt(txnId) {
    try {
      const data = await adminGet(`/activity/${encodeURIComponent(selectedUser.account_number)}/receipt/${txnId}`)
      if (data?.receipt) { renderPrint(data.receipt); setTimeout(() => window.print(), 250) }
    } catch {}
  }

  const chatColumns = [
    { key: 'started_at', label: 'Started', render: r => formatTimestamp(r.started_at) },
    { key: 'ended_at', label: 'Ended', render: r => formatTimestamp(r.ended_at) },
    { key: 'message_count', label: 'Messages', align: 'right', render: r => r.message_count },
    { key: 'preview', label: 'Preview', render: r => {
      const text = r.preview || ''
      return <span>{text.length > 70 ? text.slice(0, 70) + '…' : text}</span>
    }},
    { key: 'dominant_intent', label: 'Main Intent', render: r => r.dominant_intent ? <Badge label={r.dominant_intent} color="primary" /> : <Badge label="n/a" color="muted" /> },
  ]

  const txnColumns = [
    { key: 'created_at', label: 'Date', render: r => formatTimestamp(r.created_at) },
    { key: 'transaction_type', label: 'Type', render: r => <Badge label={r.transaction_type} color="primary" /> },
    { key: 'description', label: 'Description' },
    { key: 'amount', label: 'Amount', align: 'right', render: r => <span style={{ color: r.amount < 0 ? 'var(--color-danger)' : 'var(--color-success)', fontWeight: 600 }}>{formatPKR(r.amount)}</span> },
    { key: 'status', label: 'Status', render: r => <Badge label={r.status} color={r.status === 'completed' ? 'success' : 'warning'} /> },
    { key: 'anomaly_flagged', label: 'Anomaly', align: 'right', render: r => r.anomaly_flagged ? <span title="Linked fraud alert" style={{ color: 'var(--color-danger)' }}><i className="fas fa-triangle-exclamation" /></span> : '—' },
    { key: 'receipt', label: 'Receipt', align: 'right', render: r => (
      <button onClick={e => { e.stopPropagation(); downloadReceipt(r.id) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-primary)' }}>
        <i className="fas fa-download" />
      </button>
    )},
  ]

  const loginColumns = [
    { key: 'created_at', label: 'Date/Time', render: r => formatTimestamp(r.created_at) },
    { key: 'ip_address', label: 'IP Address' },
    { key: 'user_agent', label: 'Browser/Device' },
    { key: 'success', label: 'Result', render: r => <Badge label={r.success ? 'Success' : 'Failed'} color={r.success ? 'success' : 'danger'} /> },
  ]

  return (
    <div className="ual-wrap">
      <style>{`
        .ual-wrap { max-width: 1280px; margin: 0 auto; }
        .ual-search-row { margin-bottom: 18px; max-width: 460px; }
        .ual-user-pill { display: inline-flex; align-items: center; gap: 10px; background: var(--color-primary-light); color: var(--color-primary); padding: 8px 14px; border-radius: 20px; font-size: 13px; font-weight: 600; margin-bottom: 18px; }
        .ual-user-pill button { background: none; border: none; color: var(--color-primary); cursor: pointer; font-size: 15px; font-weight: 700; }
        .ual-tabs { display: flex; gap: 8px; margin-bottom: 16px; }
        .ual-tab { background: var(--color-card-bg); border: 1px solid var(--color-border); border-radius: 20px; padding: 7px 16px; font-size: 12.5px; font-weight: 600; cursor: pointer; color: var(--color-text-secondary); }
        .ual-tab.active { background: var(--color-primary); border-color: var(--color-primary); color: #fff; }
        .ual-filter-bar { display: flex; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
        .ual-filter-bar select, .ual-filter-bar input { padding: 8px 12px; border: 1px solid var(--color-border); border-radius: 7px; font-size: 12.5px; }
        .receipt-print { display: none; }
        @media print { body * { visibility: hidden; } .receipt-print, .receipt-print * { visibility: visible; } .receipt-print { display: block !important; position: absolute; top: 0; left: 0; width: 100%; padding: 30px; } }
        .receipt-print .r-header { text-align: center; margin-bottom: 20px; }
        .receipt-print .r-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; font-size: 14px; }
        .ual-thread { background: var(--color-card-bg); border: 1px solid var(--color-border); border-radius: 10px; padding: 18px; }
        .ual-thread-back { background: none; border: none; cursor: pointer; color: var(--color-primary); font-weight: 600; font-size: 12.5px; padding: 0 0 12px 0; display: flex; align-items: center; gap: 6px; }
        .ual-thread-meta { font-size: 12px; color: var(--color-text-secondary); margin-bottom: 16px; }
        .ual-thread-body { display: flex; flex-direction: column; gap: 18px; max-height: 520px; overflow-y: auto; }
        .ual-thread-turn { display: flex; flex-direction: column; gap: 6px; }
        .ual-thread-bubble { padding: 10px 14px; border-radius: 10px; font-size: 13.5px; max-width: 80%; line-height: 1.4; }
        .ual-thread-user { align-self: flex-end; background: var(--color-primary-light); color: var(--color-primary); }
        .ual-thread-ai { align-self: flex-start; background: var(--color-bg-secondary, #f4f4f7); }
        .ual-thread-banker { background: var(--color-primary); color: #fff; }
        .ual-thread-tag { font-size: 10.5px; font-weight: 700; text-transform: uppercase; opacity: 0.7; margin-bottom: 3px; }
        .ual-thread-time { font-size: 11px; color: var(--color-text-secondary); align-self: flex-end; }
      `}</style>

      <div ref={printRef} className="receipt-print" />

      <div className="ual-search-row">
        <SearchInput
          placeholder="Search users by name, email, or account number..."
          onSearch={searchUsers}
          renderResult={u => <><strong>{u.name}</strong><span>{u.account_number} · {u.email}</span></>}
          onSelect={selectUser}
        />
      </div>

      {!selectedUser ? (
        <EmptyState icon="fa-user-magnifying-glass" title="No user selected" message="Search for a user above to view their chat, transaction, and login activity." />
      ) : (
        <>
          <div className="ual-user-pill">
            {selectedUser.name} · {selectedUser.account_number}
            <button onClick={() => setSelectedUser(null)}>×</button>
          </div>

          <div className="ual-tabs">
            <button className={`ual-tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab('chat')}>Chat History</button>
            <button className={`ual-tab ${tab === 'transactions' ? 'active' : ''}`} onClick={() => setTab('transactions')}>Transaction History</button>
            <button className={`ual-tab ${tab === 'logins' ? 'active' : ''}`} onClick={() => setTab('logins')}>Login Activity</button>
          </div>

          {tab === 'chat' && (
            <>
              <div className="ual-filter-bar">
                <select value={chatIntent} onChange={e => { setChatIntent(e.target.value); setChatPage(1) }}>
                  <option value="">All Intents</option>
                  {INTENTS.map(i => <option key={i} value={i}>{i}</option>)}
                </select>
                <input type="date" value={chatDateFrom} onChange={e => { setChatDateFrom(e.target.value); setChatPage(1) }} />
                <input type="date" value={chatDateTo} onChange={e => { setChatDateTo(e.target.value); setChatPage(1) }} />
              </div>
              {chatLoading ? <LoadingSpinner label="Loading chat history..." /> : (
                expandedSession ? (
                  <div className="ual-thread">
                    <button className="ual-thread-back" onClick={() => setExpandedSession(null)}>
                      <i className="fas fa-arrow-left" /> Back to conversations
                    </button>
                    <div className="ual-thread-meta">
                      {formatTimestamp(expandedSession.started_at)} — {formatTimestamp(expandedSession.ended_at)} · {expandedSession.message_count} messages
                    </div>
                    <div className="ual-thread-body">
                      {expandedSession.messages.map(m => (
                        <div key={m.id} className="ual-thread-turn">
                          <div className="ual-thread-bubble ual-thread-user">{m.user_message}</div>
                          <div className={`ual-thread-bubble ual-thread-ai ${m.sender === 'banker' ? 'ual-thread-banker' : ''}`}>
                            <div className="ual-thread-tag">{m.sender === 'banker' ? 'Banker' : (m.engine ? m.engine.toUpperCase() : 'AI')}</div>
                            {m.ai_response}
                          </div>
                          <div className="ual-thread-time">{formatTimestamp(m.created_at)}{m.intent ? ` · ${m.intent}` : ''}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <DataTable columns={chatColumns} rows={chatData.sessions} page={chatData.page} totalPages={chatData.pages} onPageChange={setChatPage}
                    onRowClick={r => setExpandedSession(r)}
                    emptyIcon="fa-comments" emptyTitle="No chat messages" emptyMessage="This user hasn't chatted with FinBud AI in this range." />
                )
              )}
            </>
          )}

          {tab === 'transactions' && (
            <>
              <div className="ual-filter-bar">
                <select value={txnType} onChange={e => { setTxnType(e.target.value); setTxnPage(1) }}>
                  <option value="">All Types</option>
                  {TXN_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <input type="date" value={txnDateFrom} onChange={e => { setTxnDateFrom(e.target.value); setTxnPage(1) }} />
                <input type="date" value={txnDateTo} onChange={e => { setTxnDateTo(e.target.value); setTxnPage(1) }} />
              </div>
              {txnLoading ? <LoadingSpinner label="Loading transactions..." /> : (
                <DataTable columns={txnColumns} rows={txnData.transactions} page={txnData.page} totalPages={txnData.pages} onPageChange={setTxnPage}
                  emptyIcon="fa-money-bill-transfer" emptyTitle="No transactions" emptyMessage="Nothing matches this filter." />
              )}
            </>
          )}

          {tab === 'logins' && (
            loginsLoading ? <LoadingSpinner label="Loading login activity..." /> : (
              <DataTable columns={loginColumns} rows={logins} emptyIcon="fa-right-to-bracket" emptyTitle="No login history" emptyMessage="No recorded login attempts for this user yet." />
            )
          )}
        </>
      )}
    </div>
  )
}