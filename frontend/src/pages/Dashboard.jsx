import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'

const DAILY_TRANSFER_LIMIT = 200000

const REDEMPTION_TIERS = {
  cash_voucher:      { label: 'Cash Voucher',      points_cost: 500,  pkr_value: 250 },
  product_purchase:  { label: 'Product Purchase',  points_cost: 1000, pkr_value: 500 },
  investment_pocket: { label: 'Investment Pocket', points_cost: 750,  pkr_value: 375 }
}

const MOCK_PRODUCT_CATALOGUE = {
  P001: { name: 'FinBud Prepaid Mobile Recharge', pkr_value: 200 },
  P002: { name: 'FinBud Shopping Gift Voucher',   pkr_value: 500 },
  P003: { name: 'FinBud Utility Bill Discount',   pkr_value: 300 }
}

// SBP-assigned 4-letter bank identifier codes — occupy characters 5-8 of every
// Pakistani IBAN (e.g. PK36 SCBL 0000... -> "SCBL" = Standard Chartered).
// Used both to auto-detect the destination bank on Send Money (per mentor
// feedback) and to populate the bank picker in the Wallet/Link Account flow.
const PAKISTAN_BANK_CODES = {
  HABB: 'Habib Bank Limited (HBL)',
  UNIL: 'United Bank Limited (UBL)',
  MUCB: 'MCB Bank',
  MCIB: 'MCB Islamic Bank',
  MEZN: 'Meezan Bank',
  ALFH: 'Bank Alfalah',
  ABPA: 'Allied Bank',
  ASCM: 'Askari Bank',
  BAHL: 'Bank Al Habib',
  FAYS: 'Faysal Bank',
  NBPA: 'National Bank of Pakistan',
  SONE: 'Soneri Bank',
  SCBL: 'Standard Chartered Pakistan',
  JSBL: 'JS Bank',
  BKIP: 'BankIslami',
  KHYB: 'Bank of Khyber',
  BPUN: 'Bank of Punjab',
  SILK: 'Silk Bank',
  SUMB: 'Summit Bank',
  SIND: 'Sindh Bank',
  MPBL: 'Habib Metropolitan Bank',
}
const PAKISTAN_BANKS = Array.from(new Set(Object.values(PAKISTAN_BANK_CODES))).sort()

function detectBankFromIBAN(iban) {
  if (!iban || iban.length < 8) return null
  const code = iban.slice(4, 8).toUpperCase()
  return PAKISTAN_BANK_CODES[code] || null
}

// Simple, illustrative starting-point allocations for the "Grow Your Money"
// education card — not personalized financial advice, just a rule-of-thumb
// split shown to spark the conversation (labeled clearly as such in the UI).
const RISK_ALLOCATIONS = {
  Conservative: { Gold: 50, PSX: 30, Crypto: 5, Savings: 15 },
  Balanced:     { Gold: 30, PSX: 45, Crypto: 10, Savings: 15 },
  Aggressive:   { Gold: 15, PSX: 50, Crypto: 25, Savings: 10 },
}

// Heuristic recurring-charge detector — groups expense transactions by
// description and flags ones that repeat 2+ times at a consistent amount
// (within 15%). Works entirely off /api/transaction/history, no new backend
// endpoint required. Bills naturally vary month to month (electricity usage
// changes) so they won't false-positive here — this only catches genuinely
// fixed-price recurring charges, the way Rocket Money's detector does.
function detectSubscriptions(transactions) {
  const groups = {}
  transactions.forEach(tx => {
    if (tx.amount >= 0) return
    const key = tx.description
    if (!groups[key]) groups[key] = []
    groups[key].push(Math.abs(tx.amount))
  })
  const subs = []
  Object.entries(groups).forEach(([description, amounts]) => {
    if (amounts.length < 2) return
    const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length
    const consistent = amounts.every(a => Math.abs(a - avg) / avg < 0.15)
    if (consistent) subs.push({ description, amount: avg, occurrences: amounts.length })
  })
  return subs.sort((a, b) => b.amount - a.amount)
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [userData, setUserData] = useState({ name: 'User', initials: 'U', balance: 0, isMasked: true, userId: '', points: 0, email: '' })
  const [transactions, setTransactions] = useState([])
  const [reminders, setReminders] = useState([])
  const [breakdown, setBreakdown] = useState({})
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [remindersOpen, setRemindersOpen] = useState(false)
  const [modal, setModal] = useState(null)
  const [pendingTransfer, setPendingTransfer] = useState(null)
  const [pendingBill, setPendingBill] = useState(null)
  const [openMenuId, setOpenMenuId] = useState(null)
  const [hasCard, setHasCard] = useState(false)
  const [activeView, setActiveView] = useState('home')
  const [advisor, setAdvisor] = useState({
    loaded: false,
    summary: null,
    summaryAvailable: true,
    incomeBreakdown: {},
    incomeAvailable: true,
    monthlyTrend: [],
    trendAvailable: true,
    utilityUsage: null,
    utilityAvailable: true,
    subscriptions: []
  })
  const [wallet, setWallet] = useState({
    loaded: false,
    cards: [],
    linkedBanks: [],
    linkedBanksAvailable: true,
    otherAssets: 0,
    otherAssetsAvailable: true
  })
  const printRef = useRef(null)

  useEffect(() => { loadAll() }, [])

  useEffect(() => {
    if (activeView === 'advisor' && !advisor.loaded) loadAdvisorData()
  }, [activeView])

  useEffect(() => {
    if (activeView === 'wallet' && !wallet.loaded) loadWalletData()
  }, [activeView])

  async function loadAll() {
    try {
      const res = await fetch('/api/user/data', { credentials: 'include' })
      if (!res.ok) { navigate('/'); return }
      const user = await res.json()
      const parts = user.name.trim().split(' ')
      const initials = parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : user.name.slice(0,2).toUpperCase()
      setUserData({ name: user.name, initials, balance: user.balance, isMasked: true, userId: user.userId, points: user.points, email: user.email })
      loadTransactions()
      loadReminders()
      loadBreakdown()
      checkCard()
    } catch { navigate('/') }
  }

  async function checkCard() {
    try {
      const res = await fetch('/api/cards/check', { credentials: 'include' })
      const data = await res.json()
      setHasCard(!!data.has_card)
    } catch { setHasCard(false) }
  }

  async function loadTransactions() {
    try {
      const res = await fetch('/api/transaction/history?limit=4', { credentials: 'include' })
      const data = await res.json()
      setTransactions(data.transactions || [])
    } catch {}
  }

  function loadReminders() {
    setReminders([
      { biller: 'K-Electric', amount: 3500, due_date: '2025-11-15', days_left: 3, kind: 'due_soon' },
      { biller: 'PTCL', amount: 1200, due_date: '2025-11-12', days_left: 0, kind: 'due_today' }
    ])
  }

  async function loadBreakdown() {
    try {
      const res = await fetch('/api/financial/spending-category', { credentials: 'include' })
      const data = await res.json()
      setBreakdown(data.spending_by_category || {})
    } catch {}
  }

  async function loadAdvisorData() {
    // These three endpoints are not built yet — Anum's backend handoff doc
    // (shared alongside this file) specs them out. Until they exist, each
    // section below falls back to a friendly "coming soon" state instead
    // of breaking, the same pattern already used for topup/email-receipt.
    const [summaryRes, incomeRes, trendRes, utilityRes] = await Promise.allSettled([
      fetch('/api/financial/income-vs-expense', { credentials: 'include' }),
      fetch('/api/financial/income-by-source', { credentials: 'include' }),
      fetch('/api/financial/monthly-trend', { credentials: 'include' }),
      fetch('/api/financial/utility-usage', { credentials: 'include' })
    ])

    let summary = null, summaryAvailable = false
    if (summaryRes.status === 'fulfilled' && summaryRes.value.ok) {
      try {
        const d = await summaryRes.value.json()
        if (d.success) { summary = d; summaryAvailable = true }
      } catch {}
    }

    let incomeBreakdown = {}, incomeAvailable = false
    if (incomeRes.status === 'fulfilled' && incomeRes.value.ok) {
      try {
        const d = await incomeRes.value.json()
        if (d.success) { incomeBreakdown = d.income_by_source || {}; incomeAvailable = true }
      } catch {}
    }

    let monthlyTrend = [], trendAvailable = false
    if (trendRes.status === 'fulfilled' && trendRes.value.ok) {
      try {
        const d = await trendRes.value.json()
        if (d.success) { monthlyTrend = d.trend || []; trendAvailable = true }
      } catch {}
    }

    let utilityUsage = null, utilityAvailable = false
    if (utilityRes.status === 'fulfilled' && utilityRes.value.ok) {
      try {
        const d = await utilityRes.value.json()
        if (d.success) { utilityUsage = d.usage || null; utilityAvailable = true }
      } catch {}
    }

    let subscriptions = []
    try {
      const txRes = await fetch('/api/transaction/history?limit=100', { credentials: 'include' })
      if (txRes.ok) {
        const txData = await txRes.json()
        if (txData.success) subscriptions = detectSubscriptions(txData.transactions || [])
      }
    } catch {}

    setAdvisor({ loaded: true, summary, summaryAvailable, incomeBreakdown, incomeAvailable, monthlyTrend, trendAvailable, utilityUsage, utilityAvailable, subscriptions })
  }

  async function loadWalletData() {
    // /api/cards/list already exists in the backend (used for the Emergency
    // gate) so cards populate for real today. /api/wallet/bank-accounts does
    // not exist yet — falls back to an empty "no accounts linked" state.
    let cards = []
    try {
      const cRes = await fetch('/api/cards/list', { credentials: 'include' })
      if (cRes.ok) {
        const cData = await cRes.json()
        if (cData.success) cards = cData.cards || []
      }
    } catch {}

    let linkedBanks = [], linkedBanksAvailable = false
    try {
      const bRes = await fetch('/api/wallet/bank-accounts', { credentials: 'include' })
      if (bRes.ok) {
        const bData = await bRes.json()
        if (bData.success) { linkedBanks = bData.accounts || []; linkedBanksAvailable = true }
      }
    } catch {}

    let otherAssets = 0, otherAssetsAvailable = false
    try {
      const aRes = await fetch('/api/wallet/other-assets', { credentials: 'include' })
      if (aRes.ok) {
        const aData = await aRes.json()
        if (aData.success) { otherAssets = aData.amount || 0; otherAssetsAvailable = true }
      }
    } catch {}

    setWallet({ loaded: true, cards, linkedBanks, linkedBanksAvailable, otherAssets, otherAssetsAvailable })
  }

  async function getDailyLimitUsage() {
    try {
      const res = await fetch('/api/transaction/history?limit=50', { credentials: 'include' })
      const data = await res.json()
      const todayStr = new Date().toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })
      let used = 0
      ;(data.transactions || []).forEach(tx => { if (tx.date === todayStr && tx.amount < 0) used += Math.abs(tx.amount) })
      return { used, remaining: Math.max(DAILY_TRANSFER_LIMIT - used, 0) }
    } catch { return { used: 0, remaining: DAILY_TRANSFER_LIMIT } }
  }

  async function handleLogout() {
    setSidebarOpen(false)
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    } finally { navigate('/') }
  }

  async function downloadReceipt(txId) {
    if (!txId) { setModal({ type: 'alert', title: 'Receipt Unavailable', message: 'This transaction is missing an ID.', color: 'var(--danger)' }); return }
    try {
      const res = await fetch(`/api/transaction/${txId}/receipt`, { credentials: 'include' })
      const data = await res.json()
      if (!data.success) { setModal({ type: 'alert', title: 'Error', message: data.message, color: 'var(--danger)' }); return }
      renderPrint(data.receipt)
      setTimeout(() => window.print(), 300)
    } catch { setModal({ type: 'alert', title: 'Error', message: 'Could not fetch receipt.', color: 'var(--danger)' }) }
  }

  function renderPrint(receipt) {
    if (!printRef.current) return
    const amt = Math.abs(receipt.amount).toLocaleString('en-PK')
    printRef.current.innerHTML = `
      <div class="r-header"><h2>FinBud AI — Transaction Receipt</h2><p>${receipt.date} • ${receipt.time}</p></div>
      <div class="r-row"><span>Transaction ID</span><strong>#${receipt.transaction_id}</strong></div>
      <div class="r-row"><span>Account</span><strong>${receipt.account_number}</strong></div>
      <div class="r-row"><span>Type</span><strong>${receipt.transaction_type}</strong></div>
      <div class="r-row"><span>Description</span><strong>${receipt.description}</strong></div>
      ${receipt.recipient ? `<div class="r-row"><span>Recipient</span><strong>${receipt.recipient}</strong></div>` : ''}
      ${receipt.biller ? `<div class="r-row"><span>Biller</span><strong>${receipt.biller}</strong></div>` : ''}
      <div class="r-row"><span>Amount</span><strong>PKR ${amt}</strong></div>
      <div class="r-row"><span>Status</span><strong>${receipt.status}</strong></div>
    `
  }

  async function emailReceipt(txId) {
    try {
      const res = await fetch(`/api/transaction/${txId}/email-receipt`, { method: 'POST', credentials: 'include' })
      if (res.status === 404) { setModal({ type: 'alert', title: 'Coming Soon', message: 'Email receipts are part of Phase 2. Download the PDF for now.', color: 'var(--primary-purple)' }); return }
      const data = await res.json()
      if (data.success) setModal({ type: 'alert', title: 'Receipt Sent', message: 'Receipt emailed to your registered address!', color: 'var(--income)' })
      else setModal({ type: 'alert', title: 'Error', message: data.message, color: 'var(--danger)' })
    } catch { setModal({ type: 'alert', title: 'Coming Soon', message: 'Email receipts are part of Phase 2. Download the PDF for now.', color: 'var(--primary-purple)' }) }
  }

  // ── MODALS ──────────────────────────────────────────────

  function SendMoneyStep1() {
    const [recipientName, setRecipientName] = useState('')
    const [method, setMethod] = useState('IBAN')
    const [recipientId, setRecipientId] = useState('')
    const [manualBank, setManualBank] = useState('')
    const [amount, setAmount] = useState('')
    const [purpose, setPurpose] = useState('Rent')
    const [error, setError] = useState('')
    const [usage, setUsage] = useState({ remaining: DAILY_TRANSFER_LIMIT })

    useEffect(() => { getDailyLimitUsage().then(setUsage) }, [])

    const placeholders = { 'IBAN': 'e.g., PK36SCBL0000001123456702', 'Account Number': 'e.g., 001123456702', 'Raast ID': 'e.g., 03001234567' }
    const detectedBank = method === 'IBAN' ? detectBankFromIBAN(recipientId) : null
    const destinationBank = method === 'IBAN' ? detectedBank : (method === 'Account Number' ? manualBank : null)

    function handleIdChange(v) {
      if (method === 'IBAN') {
        // IBAN validation rules from the mentor session: auto-capitalize, and
        // hard-cap at exactly 24 characters (the Pakistani IBAN length).
        setRecipientId(v.toUpperCase().replace(/\s/g, '').slice(0, 24))
      } else {
        setRecipientId(v)
      }
    }

    function handleSubmit(e) {
      e.preventDefault()
      const amt = parseFloat(amount)
      if (!recipientName.trim()) { setError('Please enter the recipient\'s name.'); return }
      if (method === 'IBAN' && recipientId.length !== 24) { setError('IBAN must be exactly 24 characters.'); return }
      if (method === 'Account Number' && !manualBank) { setError('Please select the destination bank.'); return }
      if (isNaN(amt) || amt <= 0) { setError('Please enter a valid positive amount.'); return }
      if (amt > usage.remaining) { setError(`Exceeds your remaining daily limit of PKR ${usage.remaining.toLocaleString('en-PK')}.`); return }
      setPendingTransfer({ method, recipientName, recipientIdentifier: recipientId, destinationBank, amount: amt, purpose })
      setModal({ type: 'sendMoney2' })
    }

    return (
      <div>
        <h3>Send Money</h3>
        {stepDots(1, 3)}
        <form onSubmit={handleSubmit}>
          <label>Recipient Name</label>
          <input type="text" required autoFocus placeholder="e.g., Ahmed Khan" value={recipientName} onChange={e => setRecipientName(e.target.value)} />

          <label>Transfer Method</label>
          <select value={method} onChange={e => { setMethod(e.target.value); setRecipientId(''); setManualBank('') }} required>
            <option>IBAN</option><option>Account Number</option><option>Raast ID</option>
          </select>

          <label>{method}</label>
          <input type="text" required placeholder={placeholders[method]} value={recipientId}
            maxLength={method === 'IBAN' ? 24 : undefined}
            onChange={e => handleIdChange(e.target.value)} />
          {method === 'IBAN' && (
            <div className="bank-detect-note">
              {recipientId.length === 24
                ? (detectedBank ? `Destination Bank: ${detectedBank}` : 'Bank code not recognized — double-check the IBAN.')
                : `${recipientId.length}/24 characters`}
            </div>
          )}

          {method === 'Account Number' && (
            <>
              <label>Destination Bank</label>
              <select value={manualBank} onChange={e => setManualBank(e.target.value)} required>
                <option value="">Select bank...</option>
                {PAKISTAN_BANKS.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            </>
          )}

          <label>Amount (PKR)</label>
          <input type="number" required min="1" step="0.01" placeholder="e.g., 5000" value={amount} onChange={e => setAmount(e.target.value)} />
          <label>Purpose</label>
          <select value={purpose} onChange={e => setPurpose(e.target.value)} required>
            <option>Rent</option><option>Salary</option><option>Business</option><option>Personal</option><option>Other</option>
          </select>
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
          <button type="submit" className="modal-btn-primary">CONTINUE</button>
        </form>
        <div className="limit-note">Remaining today: <strong>PKR {usage.remaining.toLocaleString('en-PK')}</strong> of PKR {DAILY_TRANSFER_LIMIT.toLocaleString('en-PK')} daily limit</div>
      </div>
    )
  }

  function SendMoneyStep2() {
    const [password, setPassword] = useState('')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)

    async function handleSubmit(e) {
      e.preventDefault()
      setError(''); setLoading(true)
      try {
        const vRes = await fetch('/api/user/verify-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ password }) })
        const vData = await vRes.json()
        if (!vData.success) { setError('Incorrect password. Please try again.'); setLoading(false); return }
        const txRes = await fetch('/api/transaction/create', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ type: 'transfer', amount: pendingTransfer.amount, recipient: pendingTransfer.recipientName, recipient_account: pendingTransfer.recipientIdentifier, transfer_method: pendingTransfer.method, destination_bank: pendingTransfer.destinationBank, purpose: pendingTransfer.purpose })
        })
        const txData = await txRes.json()
        if (txData.success) {
          setUserData(u => ({ ...u, balance: txData.new_balance, points: txData.new_points }))
          loadTransactions(); loadBreakdown()
          setModal({ type: 'sendMoney3', txData })
        } else { setError(txData.message || 'Transaction failed.') }
      } catch { setError('Server error. Please try again.') }
      setLoading(false)
    }

    return (
      <div>
        <h3>Confirm Transfer</h3>
        {stepDots(2, 3)}
        <div className="summary-box">
          <div className="summary-row"><span>Recipient</span><strong>{pendingTransfer?.recipientName}</strong></div>
          {pendingTransfer?.destinationBank && <div className="summary-row"><span>Bank</span><strong>{pendingTransfer.destinationBank}</strong></div>}
          <div className="summary-row"><span>{pendingTransfer?.method}</span><strong>{pendingTransfer?.recipientIdentifier}</strong></div>
          <div className="summary-row"><span>Amount</span><strong>PKR {pendingTransfer?.amount?.toLocaleString('en-PK')}</strong></div>
          <div className="summary-row"><span>Purpose</span><strong>{pendingTransfer?.purpose}</strong></div>
        </div>
        <form onSubmit={handleSubmit}>
          <label>Enter your password to confirm</label>
          <input type="password" required autoFocus placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} />
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
          <button type="submit" className="modal-btn-primary" disabled={loading}>{loading ? 'Processing...' : 'CONFIRM & SEND'}</button>
          <button type="button" className="modal-btn-secondary" onClick={() => setModal({ type: 'sendMoney1' })}>BACK</button>
        </form>
        <p style={{ fontSize: 11, color: '#6b7280', marginTop: 12 }}>Note: this confirms with your account password.</p>
      </div>
    )
  }

  function SendMoneyStep3({ txData }) {
    const txId = txData?.transaction_id
    return (
      <div style={{ textAlign: 'center', padding: 10 }}>
        {stepDots(3, 3)}
        <div className="success-icon">✓</div>
        <h3 style={{ color: 'var(--income)', marginBottom: 15 }}>Transfer Successful!</h3>
        <p style={{ fontSize: 16, marginBottom: 5 }}>PKR {pendingTransfer?.amount?.toLocaleString('en-PK')} sent to {pendingTransfer?.recipientName}</p>
        <p style={{ fontSize: 14, color: '#666', marginBottom: 10 }}>via {pendingTransfer?.method} · {pendingTransfer?.purpose}</p>
        <p style={{ fontSize: 14, color: 'var(--primary-purple)' }}>You earned {txData?.points_earned} reward points!</p>
        <div className="receipt-actions">
          <button className="modal-btn-primary" style={{ marginTop: 0 }} onClick={() => downloadReceipt(txId)}>DOWNLOAD PDF</button>
          <button className="modal-btn-primary" style={{ marginTop: 0 }} onClick={() => emailReceipt(txId)}>EMAIL RECEIPT</button>
        </div>
        <button className="modal-btn-secondary" onClick={() => setModal(null)}>DONE</button>
      </div>
    )
  }

  function PayBillStep1() {
    const [category, setCategory] = useState('')
    const [provider, setProvider] = useState('')
    const [providers, setProviders] = useState([])
    const [billId, setBillId] = useState('')
    const [amount, setAmount] = useState('')
    const [error, setError] = useState('')
    const [savedRef, setSavedRef] = useState(null)
    const [loadingProviders, setLoadingProviders] = useState(false)

    async function handleCategoryChange(cat) {
      setCategory(cat); setProvider(''); setProviders([]); setSavedRef(null)
      if (!cat) return
      setLoadingProviders(true)
      try {
        const res = await fetch(`/api/bills/providers?category=${encodeURIComponent(cat)}`, { credentials: 'include' })
        const data = await res.json()
        if (data.success) setProviders(data.providers || [])
      } catch {}
      setLoadingProviders(false)
    }

    async function handleProviderChange(p) {
      setProvider(p); setSavedRef(null)
      if (!p) return
      try {
        const res = await fetch(`/api/bills/saved-ref?provider=${encodeURIComponent(p)}`, { credentials: 'include' })
        const data = await res.json()
        if (data.success && data.has_saved_ref) setSavedRef(data.ref)
      } catch {}
    }

    function handleSubmit(e) {
      e.preventDefault()
      const amt = parseFloat(amount)
      if (!provider) { setError('Please select a service provider.'); return }
      if (isNaN(amt) || amt <= 0) { setError('Please enter a valid positive amount.'); return }
      setPendingBill({ biller: provider, billId, amount: amt })
      setModal({ type: 'payBill2' })
    }

    return (
      <div>
        <h3>Pay Bill</h3>
        {stepDots(1, 3)}
        <form onSubmit={handleSubmit}>
          <label>Bill Category</label>
          <select value={category} onChange={e => handleCategoryChange(e.target.value)} required>
            <option value="">Select...</option>
            <option value="electricity">Electricity</option>
            <option value="gas">Gas</option>
            <option value="internet">Internet</option>
          </select>
          <label>Service Provider</label>
          <select value={provider} onChange={e => handleProviderChange(e.target.value)} required disabled={!category || loadingProviders}>
            <option value="">{loadingProviders ? 'Loading...' : 'Select a category first'}</option>
            {providers.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          {savedRef && (
            <div className="saved-account-prompt">
              Are you referring to your previously saved account <strong>{savedRef}</strong>?
              <div className="prompt-actions">
                <button type="button" className="yes-btn" onClick={() => setBillId(savedRef)}>Yes</button>
                <button type="button" className="no-btn" onClick={() => setSavedRef(null)}>No</button>
              </div>
            </div>
          )}
          <label>Bill Reference Number</label>
          <input type="text" required placeholder="Enter reference number" value={billId} onChange={e => setBillId(e.target.value)} />
          <label>Amount (PKR)</label>
          <input type="number" required min="10" step="0.01" placeholder="e.g., 6200" value={amount} onChange={e => setAmount(e.target.value)} />
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
          <button type="submit" className="modal-btn-primary">CONTINUE</button>
        </form>
      </div>
    )
  }

  function PayBillStep2({ inlineError }) {
    const [password, setPassword] = useState('')
    const [error, setError] = useState(inlineError || '')
    const [loading, setLoading] = useState(false)

    async function handleSubmit(e) {
      e.preventDefault()
      setError(''); setLoading(true)
      try {
        const vRes = await fetch('/api/user/verify-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ password }) })
        const vData = await vRes.json()
        if (!vData.success) { setError('Incorrect password. Please try again.'); setLoading(false); return }
        const txRes = await fetch('/api/transaction/create', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ type: 'bill', amount: pendingBill.amount, biller: pendingBill.biller, billId: pendingBill.billId })
        })
        const txData = await txRes.json()
        if (txData.success) {
          setUserData(u => ({ ...u, balance: txData.new_balance, points: txData.new_points }))
          loadTransactions(); loadBreakdown(); loadReminders()
          setModal({ type: 'payBill3', txData })
        } else { setModal({ type: 'payBill2', inlineError: txData.message || 'Payment failed.' }) }
      } catch { setError('Server error. Please try again.') }
      setLoading(false)
    }

    return (
      <div>
        <h3>Confirm Bill Payment</h3>
        {stepDots(2, 3)}
        <div className="summary-box">
          <div className="summary-row"><span>Biller</span><strong>{pendingBill?.biller}</strong></div>
          <div className="summary-row"><span>Reference Number</span><strong>{pendingBill?.billId}</strong></div>
          <div className="summary-row"><span>Amount</span><strong>PKR {pendingBill?.amount?.toLocaleString('en-PK')}</strong></div>
        </div>
        {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
        <form onSubmit={handleSubmit}>
          <label>Enter your password to confirm</label>
          <input type="password" required autoFocus placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} />
          <button type="submit" className="modal-btn-primary" disabled={loading}>{loading ? 'Processing...' : 'CONFIRM & PAY'}</button>
          <button type="button" className="modal-btn-secondary" onClick={() => setModal({ type: 'payBill1' })}>BACK</button>
        </form>
      </div>
    )
  }

  function PayBillStep3({ txData }) {
    const txId = txData?.transaction_id
    return (
      <div style={{ textAlign: 'center', padding: 10 }}>
        {stepDots(3, 3)}
        <div className="success-icon">✓</div>
        <h3 style={{ color: 'var(--income)', marginBottom: 15 }}>Transaction Successful!</h3>
        <p style={{ fontSize: 16, marginBottom: 10 }}>Your {pendingBill?.biller} bill has been paid successfully!</p>
        <p style={{ fontSize: 14, color: '#666', marginBottom: 20 }}>Amount: <strong>PKR {pendingBill?.amount?.toLocaleString('en-PK')}</strong></p>
        <p style={{ fontSize: 14, color: 'var(--primary-purple)' }}>You earned {txData?.points_earned} reward points!</p>
        <div className="receipt-actions">
          <button className="modal-btn-primary" style={{ marginTop: 0 }} onClick={() => downloadReceipt(txId)}>DOWNLOAD PDF</button>
          <button className="modal-btn-primary" style={{ marginTop: 0 }} onClick={() => emailReceipt(txId)}>EMAIL RECEIPT</button>
        </div>
        <button className="modal-btn-secondary" onClick={() => setModal(null)}>DONE</button>
      </div>
    )
  }

  function RewardsInfo() {
    return (
      <div>
        <h3>FinBud Rewards Program</h3>
        <h4 style={{ color: 'var(--income)', margin: '20px 0' }}>Current Points: {userData.points}</h4>
        <p style={{ marginBottom: 20 }}>You earn 5 points for every PKR 1,000 spent via FinBud transfers or bill payments.</p>
        <div style={{ background: 'var(--secondary-purple)', padding: 20, borderRadius: 8, marginBottom: 20 }}>
          {Object.values(REDEMPTION_TIERS).map(t => (
            <p key={t.label} style={{ margin: '10px 0' }}><strong>{t.points_cost} Points:</strong> {t.label} — PKR {t.pkr_value.toLocaleString('en-PK')}</p>
          ))}
        </div>
        <p style={{ fontSize: 12, color: '#777' }}>Use "Redeem Points" to convert your points into one of the rewards above.</p>
        <button className="modal-btn-primary" onClick={() => setModal(null)}>GOT IT</button>
      </div>
    )
  }

  function RewardsRedeem({ message, messageType }) {
    async function redeem(tierKey, productId = null) {
      try {
        const body = { tier: tierKey }
        if (productId) body.product_id = productId
        const res = await fetch('/api/rewards/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) })
        const data = await res.json()
        if (data.success) {
          setUserData(u => ({ ...u, points: data.remaining_points, balance: data.new_balance }))
          loadTransactions()
          setModal({ type: 'redeemPoints', message: `Redeemed! ${data.description}`, messageType: 'success' })
        } else {
          setModal({ type: 'redeemPoints', message: data.message || 'Redemption failed.', messageType: 'error' })
        }
      } catch { setModal({ type: 'redeemPoints', message: 'Server error.', messageType: 'error' }) }
    }

    return (
      <div>
        <h3>Redeem Points</h3>
        <h4 style={{ color: 'var(--income)', margin: '20px 0' }}>Available Points: {userData.points}</h4>
        {message && <p style={{ color: messageType === 'success' ? 'var(--income)' : 'var(--danger)', fontSize: 13, marginBottom: 10 }}>{message}</p>}
        {Object.entries(REDEMPTION_TIERS).map(([key, tier]) => (
          <div key={key} className="summary-box" style={{ marginBottom: 14 }}>
            <div className="summary-row"><span>{tier.label}</span><strong>{tier.points_cost} pts</strong></div>
            <div className="summary-row"><span>Value</span><strong>PKR {tier.pkr_value.toLocaleString('en-PK')}</strong></div>
            <button className="modal-btn-primary" style={{ marginTop: 10 }}
              onClick={() => key === 'product_purchase' ? setModal({ type: 'productSelect' }) : redeem(key)}>
              REDEEM
            </button>
          </div>
        ))}
        <button className="modal-btn-secondary" onClick={() => setModal(null)}>CLOSE</button>
      </div>
    )
  }

  function ProductSelect() {
    async function redeem(productId) {
      try {
        const res = await fetch('/api/rewards/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ tier: 'product_purchase', product_id: productId }) })
        const data = await res.json()
        if (data.success) {
          setUserData(u => ({ ...u, points: data.remaining_points, balance: data.new_balance }))
          loadTransactions()
          setModal({ type: 'redeemPoints', message: `Redeemed! ${data.description}`, messageType: 'success' })
        } else { setModal({ type: 'redeemPoints', message: data.message || 'Redemption failed.', messageType: 'error' }) }
      } catch { setModal({ type: 'redeemPoints', message: 'Server error.', messageType: 'error' }) }
    }
    return (
      <div>
        <h3>Choose a Product</h3>
        <h4 style={{ color: 'var(--income)', margin: '20px 0' }}>Available Points: {userData.points}</h4>
        {Object.entries(MOCK_PRODUCT_CATALOGUE).map(([id, p]) => (
          <div key={id} className="summary-box" style={{ marginBottom: 14 }}>
            <div className="summary-row"><span>{p.name}</span><strong>PKR {p.pkr_value.toLocaleString('en-PK')}</strong></div>
            <button className="modal-btn-primary" style={{ marginTop: 10 }} onClick={() => redeem(id)}>CONFIRM</button>
          </div>
        ))}
        <button className="modal-btn-secondary" onClick={() => setModal({ type: 'redeemPoints' })}>BACK</button>
      </div>
    )
  }

  function TopUp() {
    const [amount, setAmount] = useState('')
    const [error, setError] = useState('')

    async function handleSubmit(e) {
      e.preventDefault()
      const amt = parseFloat(amount)
      if (isNaN(amt) || amt <= 0) { setError('Please enter a valid positive amount.'); return }
      try {
        const res = await fetch('/api/user/topup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ amount: amt }) })
        if (res.status === 404) { setError('Top-up endpoint not added to the backend yet.'); return }
        const data = await res.json()
        if (data.success) {
          setUserData(u => ({ ...u, balance: data.new_balance }))
          setModal({ type: 'alert', title: 'Balance Updated', message: `PKR ${amt.toLocaleString('en-PK')} added. New balance: PKR ${data.new_balance.toLocaleString('en-PK')}`, color: 'var(--income)' })
          loadTransactions()
        } else { setError(data.message || 'Top-up failed.') }
      } catch { setError('Server error. Please try again.') }
    }
    return (
      <div>
        <h3>Top Up Balance (Demo)</h3>
        <p style={{ fontSize: 12, color: '#777' }}>For demonstration and testing purposes only.</p>
        <form onSubmit={handleSubmit}>
          <label>Amount (PKR)</label>
          <input type="number" required min="1" step="0.01" autoFocus placeholder="e.g., 10000" value={amount} onChange={e => setAmount(e.target.value)} />
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
          <button type="submit" className="modal-btn-primary">ADD FUNDS</button>
        </form>
      </div>
    )
  }

  function LogIncome() {
    const [amount, setAmount] = useState('')
    const [source, setSource] = useState('Business Sales')
    const [note, setNote] = useState('')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)

    async function handleSubmit(e) {
      e.preventDefault()
      const amt = parseFloat(amount)
      if (isNaN(amt) || amt <= 0) { setError('Please enter a valid positive amount.'); return }
      setError(''); setLoading(true)
      try {
        const res = await fetch('/api/income/log', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ amount: amt, source, note })
        })
        if (res.status === 404) {
          setModal({ type: 'alert', title: 'Coming Soon', message: 'Income logging is part of our Phase 2 backend rollout — this screen is ready and waiting for the API.', color: 'var(--primary-purple)' })
          setLoading(false); return
        }
        const data = await res.json()
        if (data.success) {
          setUserData(u => ({ ...u, balance: data.new_balance ?? u.balance }))
          loadTransactions()
          setAdvisor(a => ({ ...a, loaded: false }))
          setModal({ type: 'alert', title: 'Income Logged', message: `PKR ${amt.toLocaleString('en-PK')} added from ${source}.`, color: 'var(--income)' })
        } else { setError(data.message || 'Could not log income.') }
      } catch { setError('Server error. Please try again.') }
      setLoading(false)
    }

    return (
      <div>
        <h3>Log Income</h3>
        <p style={{ fontSize: 12, color: '#777', marginTop: -8 }}>Record money coming in — sales, salary, freelance work, or remittances.</p>
        <form onSubmit={handleSubmit}>
          <label>Source</label>
          <select value={source} onChange={e => setSource(e.target.value)} required>
            <optgroup label="Active Income">
              <option>Salary</option>
              <option>Business Sales</option>
              <option>Freelance</option>
            </optgroup>
            <optgroup label="Passive Income">
              <option>Rental Income</option>
            </optgroup>
            <optgroup label="Investment Income">
              <option>Stock Market (PSX)</option>
            </optgroup>
            <optgroup label="Other">
              <option>Remittance</option>
              <option>Other</option>
            </optgroup>
          </select>
          <label>Amount (PKR)</label>
          <input type="number" required min="1" step="0.01" autoFocus placeholder="e.g., 15000" value={amount} onChange={e => setAmount(e.target.value)} />
          <label>Note (optional)</label>
          <input type="text" placeholder="e.g., Evening sales" value={note} onChange={e => setNote(e.target.value)} />
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
          <button type="submit" className="modal-btn-primary" disabled={loading}>{loading ? 'Saving...' : 'ADD INCOME'}</button>
        </form>
      </div>
    )
  }

  function AddCard() {
    const [cardholder, setCardholder] = useState('')
    const [cardNumber, setCardNumber] = useState('')
    const [expiry, setExpiry] = useState('')
    const [nickname, setNickname] = useState('')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)

    function formatCardNumber(v) {
      const digits = v.replace(/\D/g, '').slice(0, 16)
      return digits.replace(/(.{4})/g, '$1 ').trim()
    }
    function formatExpiry(v) {
      const digits = v.replace(/\D/g, '').slice(0, 4)
      return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits
    }

    async function handleSubmit(e) {
      e.preventDefault()
      const rawNumber = cardNumber.replace(/\s/g, '')
      if (rawNumber.length !== 16) { setError('Card number must be 16 digits.'); return }
      if (!/^\d{2}\/\d{2}$/.test(expiry)) { setError('Enter expiry as MM/YY.'); return }
      setError(''); setLoading(true)
      try {
        const res = await fetch('/api/cards/add', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ cardholder_name: cardholder, card_number: rawNumber, expiry, nickname })
        })
        if (res.status === 404) {
          setModal({ type: 'alert', title: 'Coming Soon', message: 'Card storage uses tokenization on real banking infrastructure, so this is wired up on the frontend and waiting for the backend/token-vault integration described in the handoff doc.', color: 'var(--primary-purple)' })
          setLoading(false); return
        }
        const data = await res.json()
        if (data.success) {
          setWallet(w => ({ ...w, loaded: false }))
          checkCard()
          setModal({ type: 'alert', title: 'Card Added', message: `Card ending in ${rawNumber.slice(-4)} has been added to your wallet.`, color: 'var(--income)' })
        } else { setError(data.message || 'Could not add card.') }
      } catch { setError('Server error. Please try again.') }
      setLoading(false)
    }

    return (
      <div>
        <h3>Add a Card</h3>
        <p style={{ fontSize: 12, color: '#777', marginTop: -8 }}>Add a debit/credit card from any bank to your FinBud wallet.</p>
        <form onSubmit={handleSubmit}>
          <label>Cardholder Name</label>
          <input type="text" required placeholder="Name on card" value={cardholder} onChange={e => setCardholder(e.target.value)} />
          <label>Card Number</label>
          <input type="text" required inputMode="numeric" placeholder="1234 5678 9012 3456" value={cardNumber} onChange={e => setCardNumber(formatCardNumber(e.target.value))} />
          <label>Expiry (MM/YY)</label>
          <input type="text" required inputMode="numeric" placeholder="MM/YY" value={expiry} onChange={e => setExpiry(formatExpiry(e.target.value))} maxLength={5} />
          <label>Nickname (optional)</label>
          <input type="text" placeholder="e.g., HBL Debit" value={nickname} onChange={e => setNickname(e.target.value)} />
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
          <button type="submit" className="modal-btn-primary" disabled={loading}>{loading ? 'Adding...' : 'ADD CARD'}</button>
        </form>
        <p style={{ fontSize: 11, color: '#6b7280', marginTop: 12 }}>Card details are tokenized — FinBud never stores your raw card number.</p>
      </div>
    )
  }

  function LinkBankAccount() {
    const [bank, setBank] = useState('')
    const [iban, setIban] = useState('')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)

    function handleIbanChange(v) {
      setIban(v.toUpperCase().replace(/\s/g, '').slice(0, 24))
    }

    const detectedBank = iban.length === 24 ? detectBankFromIBAN(iban) : null

    async function handleSubmit(e) {
      e.preventDefault()
      if (!bank) { setError('Please select your bank.'); return }
      if (iban.length !== 24) { setError('IBAN must be exactly 24 characters.'); return }
      setError(''); setLoading(true)
      try {
        const res = await fetch('/api/wallet/link-bank', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ bank, iban })
        })
        if (res.status === 404) {
          setModal({ type: 'alert', title: 'Coming Soon', message: "Real account linking needs each bank's consent under SBP's Open Banking framework (or a 1LINK Open API integration) — this screen is ready and waiting for that connection. See the research doc for details.", color: 'var(--primary-purple)' })
          setLoading(false); return
        }
        const data = await res.json()
        if (data.success) {
          setWallet(w => ({ ...w, loaded: false }))
          setModal({ type: 'alert', title: 'Request Sent', message: `A consent request has been sent to link your ${bank} account.`, color: 'var(--income)' })
        } else { setError(data.message || 'Could not link account.') }
      } catch { setError('Server error. Please try again.') }
      setLoading(false)
    }

    return (
      <div>
        <h3>Link a Bank Account</h3>
        <p style={{ fontSize: 12, color: '#777', marginTop: -8 }}>Connect any Pakistani bank account to view its balance and transactions inside FinBud.</p>
        <form onSubmit={handleSubmit}>
          <label>Bank</label>
          <select value={bank} onChange={e => setBank(e.target.value)} required>
            <option value="">Select bank...</option>
            {PAKISTAN_BANKS.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
          <label>IBAN</label>
          <input type="text" required placeholder="e.g., PK36SCBL0000001123456702" value={iban} maxLength={24} onChange={e => handleIbanChange(e.target.value)} />
          <div className="bank-detect-note">
            {iban.length === 24
              ? (detectedBank ? `Matches: ${detectedBank}` : 'Bank code not recognized — double-check the IBAN.')
              : `${iban.length}/24 characters`}
          </div>
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
          <button type="submit" className="modal-btn-primary" disabled={loading}>{loading ? 'Sending Request...' : 'SEND LINK REQUEST'}</button>
        </form>
        <p style={{ fontSize: 11, color: '#6b7280', marginTop: 12 }}>You'll be asked to verify with your bank via OTP before the account is linked — FinBud never sees or stores your online banking password.</p>
      </div>
    )
  }

  function EditOtherAssets() {
    const [amount, setAmount] = useState(wallet.otherAssets || '')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)

    async function handleSubmit(e) {
      e.preventDefault()
      const amt = parseFloat(amount)
      if (isNaN(amt) || amt < 0) { setError('Please enter a valid amount (0 or more).'); return }
      setError(''); setLoading(true)
      try {
        const res = await fetch('/api/wallet/other-assets', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ amount: amt })
        })
        if (res.status === 404) {
          setWallet(w => ({ ...w, otherAssets: amt }))
          setModal({ type: 'alert', title: 'Saved Locally', message: 'This total will show for this session. Once the backend endpoint is live, it\'ll persist across logins — see the handoff doc.', color: 'var(--primary-purple)' })
          setLoading(false); return
        }
        const data = await res.json()
        if (data.success) {
          setWallet(w => ({ ...w, otherAssets: amt, otherAssetsAvailable: true }))
          setModal(null)
        } else { setError(data.message || 'Could not save.') }
      } catch { setError('Server error. Please try again.') }
      setLoading(false)
    }

    return (
      <div>
        <h3>Other Assets</h3>
        <p style={{ fontSize: 12, color: '#777', marginTop: -8 }}>Savings elsewhere, cash on hand, or anything else you want counted toward your net worth.</p>
        <form onSubmit={handleSubmit}>
          <label>Total Amount (PKR)</label>
          <input type="number" required min="0" step="0.01" autoFocus placeholder="e.g., 50000" value={amount} onChange={e => setAmount(e.target.value)} />
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
          <button type="submit" className="modal-btn-primary" disabled={loading}>{loading ? 'Saving...' : 'SAVE'}</button>
        </form>
      </div>
    )
  }

  function VerifyBalance() {
    const [pw, setPw] = useState('')
    const [error, setError] = useState('')
    async function handleSubmit(e) {
      e.preventDefault()
      try {
        const res = await fetch('/api/user/verify-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ password: pw }) })
        const data = await res.json()
        if (data.success) { setUserData(u => ({ ...u, isMasked: false })); setModal(null) }
        else { setError('Incorrect password. Please try again.'); setPw('') }
      } catch { setError('Server error.') }
    }
    return (
      <div>
        <h3>Verify Your Password</h3>
        <p>Please enter your password to view your balance.</p>
        <form onSubmit={handleSubmit}>
          <label>Password</label>
          <input type="password" required autoFocus placeholder="Enter your password" value={pw} onChange={e => setPw(e.target.value)} />
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
          <button type="submit" className="modal-btn-primary">VERIFY</button>
        </form>
      </div>
    )
  }

  function ChangePassword() {
    const [cur, setCur] = useState(''); const [nw, setNw] = useState(''); const [conf, setConf] = useState(''); const [error, setError] = useState('')
    async function handleSubmit(e) {
      e.preventDefault()
      if (nw !== conf) { setError('New passwords do not match.'); return }
      try {
        const res = await fetch('/api/user/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ currentPassword: cur, newPassword: nw }) })
        const data = await res.json()
        if (data.success) setModal({ type: 'alert', title: 'Password Updated!', message: 'Your password has been successfully changed.', color: 'var(--income)' })
        else { setError(data.message || 'Password change failed.') }
      } catch { setError('Server error.') }
    }
    return (
      <div>
        <h3>Change Password</h3>
        <form onSubmit={handleSubmit}>
          <label>Current Password</label><input type="password" required value={cur} onChange={e => setCur(e.target.value)} />
          <label>New Password</label><input type="password" required minLength={4} value={nw} onChange={e => setNw(e.target.value)} />
          <label>Confirm New Password</label><input type="password" required value={conf} onChange={e => setConf(e.target.value)} />
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
          <button type="submit" className="modal-btn-primary">UPDATE PASSWORD</button>
        </form>
      </div>
    )
  }

  // ── HELPERS ──────────────────────────────────────────────
  function stepDots(current, total) {
    return (
      <div className="step-indicator">
        {Array.from({ length: total }, (_, i) => i + 1).map((n, idx) => (
          <>
            {idx > 0 && <div key={`line-${n}`} className="step-line" />}
            <div key={n} className={`step-dot ${n < current ? 'done' : n === current ? 'current' : ''}`}>{n}</div>
          </>
        ))}
      </div>
    )
  }

  function renderModalContent() {
    if (!modal) return null
    switch (modal.type) {
      case 'sendMoney1': return <SendMoneyStep1 />
      case 'sendMoney2': return <SendMoneyStep2 />
      case 'sendMoney3': return <SendMoneyStep3 txData={modal.txData} />
      case 'payBill1':   return <PayBillStep1 />
      case 'payBill2':   return <PayBillStep2 inlineError={modal.inlineError} />
      case 'payBill3':   return <PayBillStep3 txData={modal.txData} />
      case 'rewards':    return <RewardsInfo />
      case 'redeemPoints': return <RewardsRedeem message={modal.message} messageType={modal.messageType} />
      case 'productSelect': return <ProductSelect />
      case 'topup':      return <TopUp />
      case 'logIncome':  return <LogIncome />
      case 'addCard':    return <AddCard />
      case 'linkBank':   return <LinkBankAccount />
      case 'editAssets': return <EditOtherAssets />
      case 'verifyBalance': return <VerifyBalance />
      case 'changePassword': return <ChangePassword />
      case 'profileOverview': return (
        <div>
          <h3>Profile Overview</h3>
          <div style={{ background: 'var(--secondary-purple)', padding: 20, borderRadius: 8, margin: '20px 0' }}>
            <p><strong>Name:</strong> {userData.name}</p>
            <p><strong>User ID:</strong> {userData.userId}</p>
            <p><strong>Balance:</strong> PKR {userData.balance.toLocaleString('en-PK')}</p>
            <p><strong>Reward Points:</strong> {userData.points}</p>
            <p><strong>Email:</strong> {userData.email}</p>
          </div>
          <button className="modal-btn-primary" onClick={() => setModal(null)}>CLOSE</button>
        </div>
      )
      case 'settings': return (
        <div>
          <h3>Settings</h3>
          {['Notifications', 'Language & Region', 'Linked Accounts', 'Privacy Settings'].map(s => (
            <div key={s} style={{ padding: 15, borderBottom: '1px solid var(--secondary-purple)', cursor: 'pointer' }} onClick={() => alert('Feature coming soon!')}>
              <strong>{s}</strong>
            </div>
          ))}
          <button className="modal-btn-primary" onClick={() => setModal(null)}>CLOSE</button>
        </div>
      )
      case 'security': return (
        <div>
          <h3>Security Center</h3>
          <div style={{ padding: 15, borderBottom: '1px solid var(--secondary-purple)', cursor: 'pointer' }} onClick={() => setModal({ type: 'changePassword' })}>
            <strong>Change Password</strong><p style={{ fontSize: 13, color: '#666', margin: '5px 0 0' }}>Update your account password</p>
          </div>
          {['Two-Factor Authentication', 'Login History', 'Trusted Devices'].map(s => (
            <div key={s} style={{ padding: 15, borderBottom: '1px solid var(--secondary-purple)', cursor: 'pointer' }} onClick={() => alert('Feature coming soon!')}>
              <strong>{s}</strong>
            </div>
          ))}
          <button className="modal-btn-primary" onClick={() => setModal(null)}>CLOSE</button>
        </div>
      )
      case 'financialReports': return <FinancialReports />
      case 'alert': return (
        <div>
          <h3 style={{ color: modal.color }}>{modal.title}</h3>
          <p>{modal.message}</p>
          <button className="modal-btn-primary" onClick={() => setModal(null)}>OK</button>
        </div>
      )
      default: return null
    }
  }

  function FinancialAdvisorView() {
    const income = advisor.summary?.income ?? 0
    const expenses = advisor.summary?.expenses ?? 0
    const net = advisor.summary?.net ?? (income - expenses)
    const upcomingBillsTotal = reminders.reduce((s, r) => s + (r.amount || 0), 0)
    const safeToSpend = advisor.summaryAvailable ? net - upcomingBillsTotal : null
    const incomeEntries = Object.entries(advisor.incomeBreakdown).sort((a, b) => b[1] - a[1])
    const incomeTotal = incomeEntries.reduce((s, [, v]) => s + v, 0)
    const maxTrend = Math.max(1, ...advisor.monthlyTrend.flatMap(m => [m.income || 0, m.expenses || 0]))
    const today = new Date()
    const dayOfMonth = today.getDate()
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
    const pctDaysElapsed = (dayOfMonth / daysInMonth) * 100
    const priorMonthsAvg = advisor.monthlyTrend.length > 0
      ? advisor.monthlyTrend.reduce((s, m) => s + (m.expenses || 0), 0) / advisor.monthlyTrend.length
      : null
    const pctBudgetUsed = (priorMonthsAvg && priorMonthsAvg > 0) ? Math.min(200, (expenses / priorMonthsAvg) * 100) : null
    const paceAhead = pctBudgetUsed !== null && pctBudgetUsed > pctDaysElapsed + 10
    const subscriptionsTotal = advisor.subscriptions.reduce((s, sub) => s + sub.amount, 0)
    const [riskProfile, setRiskProfile] = useState('Balanced')

    return (
      <div className="advisor-wrap">
        <div className="advisor-header">
          <div>
            <h2 className="advisor-title">Financial Advisor</h2>
            <p className="advisor-subtitle">Your income, spending, and money habits — all in one place.</p>
          </div>
          <button className="topup-btn" onClick={() => setModal({ type: 'logIncome' })}>+ Log Income</button>
        </div>

        <div className="advisor-grid">
          <div className="card advisor-summary-card">
            <h3 style={{ marginTop: 0 }}>This Month</h3>
            {advisor.summaryAvailable ? (
              <div className="advisor-summary-row">
                <div className="advisor-stat">
                  <span className="advisor-stat-label">Income</span>
                  <strong className="advisor-stat-value income-text">PKR {income.toLocaleString('en-PK')}</strong>
                </div>
                <div className="advisor-stat">
                  <span className="advisor-stat-label">Expenses</span>
                  <strong className="advisor-stat-value expense-text">PKR {expenses.toLocaleString('en-PK')}</strong>
                </div>
                <div className="advisor-stat">
                  <span className="advisor-stat-label">Net</span>
                  <strong className={`advisor-stat-value ${net >= 0 ? 'income-text' : 'expense-text'}`}>PKR {net.toLocaleString('en-PK')}</strong>
                </div>
                <div className="advisor-stat">
                  <span className="advisor-stat-label">Safe to Spend</span>
                  <strong className={`advisor-stat-value ${safeToSpend >= 0 ? 'income-text' : 'expense-text'}`}>PKR {safeToSpend.toLocaleString('en-PK')}</strong>
                </div>
              </div>
            ) : (
              <p className="advisor-empty">Income vs. expense tracking is coming online soon — this card will populate automatically once it's connected on the backend.</p>
            )}
            {advisor.summaryAvailable && (
              <p className="advisor-footnote">Safe to Spend = Net − upcoming bills (PKR {upcomingBillsTotal.toLocaleString('en-PK')}) — so a night out doesn't quietly eat into money already owed for bills.</p>
            )}
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Monthly Trend</h3>
            {advisor.trendAvailable && advisor.monthlyTrend.length > 0 ? (
              <div className="trend-chart">
                {advisor.monthlyTrend.map(m => (
                  <div key={m.month} className="trend-col">
                    <div className="trend-bars">
                      <div className="trend-bar income-bar" style={{ height: `${((m.income || 0) / maxTrend) * 100}%` }} title={`Income: PKR ${m.income}`} />
                      <div className="trend-bar expense-bar" style={{ height: `${((m.expenses || 0) / maxTrend) * 100}%` }} title={`Expenses: PKR ${m.expenses}`} />
                    </div>
                    <span className="trend-label">{m.month}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="advisor-empty">Once a few months of data are in, you'll see your income vs. expense trend here.</p>
            )}
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Spending Pace</h3>
            {pctBudgetUsed !== null ? (
              <>
                <div className="pace-row">
                  <div className="pace-label-row"><span>Days elapsed this month</span><strong>{pctDaysElapsed.toFixed(0)}%</strong></div>
                  <div className="breakdown-bar-track"><div className="breakdown-bar-fill" style={{ width: `${pctDaysElapsed.toFixed(0)}%` }} /></div>
                </div>
                <div className="pace-row">
                  <div className="pace-label-row"><span>Of typical monthly spend used</span><strong>{pctBudgetUsed.toFixed(0)}%</strong></div>
                  <div className="breakdown-bar-track"><div className={`breakdown-bar-fill ${paceAhead ? 'pace-bar-warning' : 'income-bar-fill'}`} style={{ width: `${Math.min(100, pctBudgetUsed).toFixed(0)}%` }} /></div>
                </div>
                <p className={`advisor-footnote ${paceAhead ? 'pace-warning-text' : ''}`}>
                  {paceAhead
                    ? `You're spending faster than usual for this point in the month — on pace for about PKR ${((expenses / dayOfMonth) * daysInMonth).toLocaleString('en-PK', { maximumFractionDigits: 0 })} by month end.`
                    : "You're tracking close to your usual pace for this point in the month."}
                </p>
              </>
            ) : (
              <p className="advisor-empty">Once a couple of months of history are in, this will show whether you're spending faster or slower than usual for this point in the month.</p>
            )}
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Income Sources</h3>
            {advisor.incomeAvailable && incomeEntries.length > 0 ? (
              incomeEntries.map(([src, amt]) => {
                const pct = incomeTotal > 0 ? (amt / incomeTotal) * 100 : 0
                return (
                  <div key={src} className="breakdown-row">
                    <div className="breakdown-label-row"><span>{src}</span><strong>{pct.toFixed(1)}% · PKR {amt.toLocaleString('en-PK', { maximumFractionDigits: 0 })}</strong></div>
                    <div className="breakdown-bar-track"><div className="breakdown-bar-fill income-bar-fill" style={{ width: `${pct.toFixed(1)}%` }} /></div>
                  </div>
                )
              })
            ) : (
              <p className="advisor-empty">No income logged yet — tap "+ Log Income" to add your first entry.</p>
            )}
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Spending Breakdown</h3>
            {breakdownEntries.length === 0 ? (
              <p className="advisor-empty">No spending yet — make a transfer or pay a bill to see your breakdown.</p>
            ) : breakdownEntries.map(([cat, amt]) => {
              const pct = breakdownTotal > 0 ? ((amt / breakdownTotal) * 100) : 0
              return (
                <div key={cat} className="breakdown-row">
                  <div className="breakdown-label-row">
                    <span>{cat}</span>
                    <strong>{pct.toFixed(1)}% · PKR {amt.toLocaleString('en-PK', { maximumFractionDigits: 0 })}</strong>
                  </div>
                  <div className="breakdown-bar-track">
                    <div className="breakdown-bar-fill" style={{ width: `${pct.toFixed(1)}%` }} />
                  </div>
                </div>
              )
            })}
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Subscriptions & Recurring <span className="preview-tag">Preview</span></h3>
            {advisor.subscriptions.length > 0 ? (
              <>
                {advisor.subscriptions.map(sub => (
                  <div key={sub.description} className="wallet-row">
                    <div>
                      <strong>{sub.description}</strong>
                      <div style={{ fontSize: 12, color: '#777' }}>Seen {sub.occurrences} times · consistent amount</div>
                    </div>
                    <span>PKR {sub.amount.toLocaleString('en-PK', { maximumFractionDigits: 0 })}</span>
                  </div>
                ))}
                <p className="advisor-footnote">Detected recurring spend: PKR {subscriptionsTotal.toLocaleString('en-PK', { maximumFractionDigits: 0 })}/month across your last 100 transactions.</p>
              </>
            ) : (
              <p className="advisor-empty">No fixed-amount recurring charges detected yet in your recent transactions. Once you have a few repeat payments of the same amount (like a subscription), they'll show up here automatically.</p>
            )}
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Utility Usage</h3>
            {advisor.utilityAvailable && advisor.utilityUsage ? (
              <div className="breakdown-row">
                <div className="breakdown-label-row">
                  <span>{advisor.utilityUsage.label || 'Electricity'}</span>
                  <strong>{advisor.utilityUsage.this_period} units vs {advisor.utilityUsage.last_period} last cycle</strong>
                </div>
              </div>
            ) : (
              <p className="advisor-empty">Unit-level utility tracking (like the K-Electric app — this month's units vs. the same billing cycle last year) is on the roadmap. Once a biller integration is connected, it'll show up here automatically.</p>
            )}
          </div>

          <div className="card advisor-invest-card">
            <h3 style={{ marginTop: 0 }}>Grow Your Money <span className="preview-tag">Educational</span></h3>
            <p style={{ fontSize: 13, color: '#6b7280', marginTop: 0 }}>Pick a risk comfort level to see an illustrative starting-point split. This is general education, not personalized financial advice.</p>
            <div className="risk-toggle">
              {Object.keys(RISK_ALLOCATIONS).map(r => (
                <button key={r} type="button" className={`risk-btn ${riskProfile === r ? 'active' : ''}`} onClick={() => setRiskProfile(r)}>{r}</button>
              ))}
            </div>
            {Object.entries(RISK_ALLOCATIONS[riskProfile]).map(([asset, pct]) => (
              <div key={asset} className="breakdown-row">
                <div className="breakdown-label-row"><span>{asset}</span><strong>{pct}%</strong></div>
                <div className="breakdown-bar-track"><div className="breakdown-bar-fill" style={{ width: `${pct}%` }} /></div>
              </div>
            ))}
          </div>

          <div className="card advisor-insights-card">
            <h3 style={{ marginTop: 0 }}>AI Insights <span className="preview-tag">Preview</span></h3>
            <div className="insight-item">💡 Insights like "your electricity bill is 20% higher than usual" will appear here once this panel is connected to the NLP engine.</div>
            <div className="insight-item">📈 As you log income and expenses, FinBud AI will start suggesting a monthly savings target based on your habits.</div>
          </div>
        </div>
      </div>
    )
  }

  function WalletView() {
    const linkedBalance = wallet.linkedBanks.reduce((s, a) => s + (a.balance || 0), 0)
    const netWorth = (userData.balance || 0) + linkedBalance + (wallet.otherAssets || 0)

    return (
      <div className="advisor-wrap">
        <div className="advisor-header">
          <div>
            <h2 className="advisor-title">Wallet</h2>
            <p className="advisor-subtitle">All your bank accounts and cards, linked in one place — like Google Pay or Apple Pay, but built for FinBud.</p>
          </div>
        </div>

        <div className="advisor-grid">
          <div className="card advisor-summary-card">
            <h3 style={{ marginTop: 0 }}>Net Worth</h3>
            <div className="advisor-summary-row">
              <div className="advisor-stat">
                <span className="advisor-stat-label">FinBud Balance</span>
                <strong className="advisor-stat-value income-text">PKR {(userData.balance || 0).toLocaleString('en-PK')}</strong>
              </div>
              <div className="advisor-stat">
                <span className="advisor-stat-label">Linked Accounts</span>
                <strong className="advisor-stat-value">{wallet.linkedBanks.length > 0 ? `PKR ${linkedBalance.toLocaleString('en-PK')}` : '—'}</strong>
              </div>
              <div className="advisor-stat">
                <span className="advisor-stat-label">Other Assets</span>
                <strong className="advisor-stat-value">PKR {(wallet.otherAssets || 0).toLocaleString('en-PK')}</strong>
                <button type="button" className="edit-assets-link" onClick={() => setModal({ type: 'editAssets' })}>Edit</button>
              </div>
              <div className="advisor-stat">
                <span className="advisor-stat-label">Total Net Worth</span>
                <strong className="advisor-stat-value" style={{ color: 'var(--primary-purple)' }}>PKR {netWorth.toLocaleString('en-PK')}</strong>
              </div>
            </div>
            {wallet.linkedBanks.length === 0 && (
              <p className="advisor-footnote">Link a bank account below to have its balance count toward your net worth automatically.</p>
            )}
          </div>

          <div className="card">
            <div className="wallet-card-header">
              <h3 style={{ margin: 0 }}>Linked Bank Accounts</h3>
              <button className="topup-btn" onClick={() => setModal({ type: 'linkBank' })}>+ Link Account</button>
            </div>
            {wallet.linkedBanksAvailable && wallet.linkedBanks.length > 0 ? (
              wallet.linkedBanks.map((acc, i) => (
                <div key={i} className="wallet-row">
                  <div>
                    <strong>{acc.bank}</strong>
                    <div style={{ fontSize: 12, color: '#777' }}>{acc.masked_iban || acc.iban}</div>
                  </div>
                  <span className="wallet-status-pill">{acc.status || 'Linked'}</span>
                </div>
              ))
            ) : (
              <p className="advisor-empty">No bank accounts linked yet. Link an HBL, Meezan, or any other Pakistani bank account to see its balance alongside your FinBud balance.</p>
            )}
          </div>

          <div className="card">
            <div className="wallet-card-header">
              <h3 style={{ margin: 0 }}>My Cards</h3>
              <button className="topup-btn" onClick={() => setModal({ type: 'addCard' })}>+ Add Card</button>
            </div>
            {wallet.cards.length > 0 ? (
              wallet.cards.map(c => (
                <div key={c.card_id} className="wallet-row">
                  <div>
                    <strong>{c.card_number_masked}</strong>
                  </div>
                  <span className={`wallet-status-pill ${c.status === 'locked' ? 'locked' : ''}`}>{c.status}</span>
                </div>
              ))
            ) : (
              <p className="advisor-empty">No cards on file yet. Add a card to enable the Emergency lock feature and start building your wallet.</p>
            )}
          </div>

          <div className="card advisor-insights-card">
            <h3 style={{ marginTop: 0 }}>How This Works</h3>
            <div className="insight-item">🏦 Bank accounts are linked through consent-based Open Banking APIs (per the State Bank of Pakistan's Open Banking framework and 1LINK's Open API Gateway) — FinBud never sees or stores your online banking password.</div>
            <div className="insight-item">💳 Cards are stored using tokenization, the same approach Google Pay and Apple Pay use — your real card number is replaced with a token, so FinBud's servers never hold raw card data.</div>
          </div>
        </div>
      </div>
    )
  }

  function FinancialReports() {
    const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1])
    const total = entries.reduce((s, [, v]) => s + v, 0)
    return (
      <div>
        <h3>Financial Reports</h3>
        <h4 style={{ color: 'var(--primary-purple)', marginBottom: 15 }}>Spending by Category</h4>
        {entries.length === 0
          ? <p style={{ textAlign: 'center', color: '#999' }}>No spending data available</p>
          : entries.map(([cat, amt]) => (
            <div key={cat} style={{ padding: '10px 0', borderBottom: '1px solid var(--secondary-purple)', display: 'flex', justifyContent: 'space-between' }}>
              <strong>{cat}</strong>
              <span>PKR {amt.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ({total > 0 ? ((amt / total) * 100).toFixed(1) : '0.0'}%)</span>
            </div>
          ))}
        <button className="modal-btn-primary" onClick={() => setModal(null)}>CLOSE</button>
      </div>
    )
  }

  const breakdownEntries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]).slice(0, 5)
  const breakdownTotal = breakdownEntries.reduce((s, [, v]) => s + v, 0)
  const formattedBalance = new Intl.NumberFormat('en-PK').format(userData.balance)

  return (
    <>
      <style>{`
        :root {
          --primary-purple: #5c2d91;
          --secondary-purple: #f2f2f2;
          --text-dark: #111;
          --text-light: #fff;
          --bg: #f2f2f2;
          --card: #ffffff;
          --danger: #b91c1c;
          --income: #10b981;
          --expense: #ef4444;
          --warning: #f59e0b;
        }
        html, body { margin:0; padding:0; width:100%; min-height:100vh; }
        #root { width:100%; min-height:100vh; display:block; }
        * { box-sizing: border-box; font-family: Inter, ui-sans-serif, system-ui; }
        body { background: var(--bg); color: var(--text-dark); }
        .app-shell { display:flex; min-height:100vh; width:100%; }
        .left-nav { width:220px; flex-shrink:0; background:var(--card); border-right:1px solid rgba(0,0,0,0.05); display:flex; flex-direction:column; padding:24px 0; position:sticky; top:0; height:100vh; }
        .left-nav-brand { display:flex; align-items:center; gap:10px; padding:0 24px 24px; }
        .left-nav-brand-text { font-size:22px; font-weight:700; color:var(--primary-purple); }
        .left-nav-list { list-style:none; margin:0; padding:8px 12px; display:flex; flex-direction:column; gap:4px; }
        .left-nav-list li { display:flex; align-items:center; gap:14px; padding:13px 16px; border-radius:8px; font-weight:600; font-size:15px; color:var(--text-dark); cursor:pointer; transition:background 0.2s, color 0.2s; }
        .left-nav-list li i { width:18px; text-align:center; font-size:16px; color:var(--primary-purple); }
        .left-nav-list li:hover { background:var(--secondary-purple); }
        .left-nav-list li.active { background:var(--primary-purple); color:#fff; }
        .left-nav-list li.active i { color:#fff; }
        .main-content { flex-grow:1; min-width:0; }
        .topbar { display:flex; justify-content:space-between; align-items:center; padding:15px 40px; background:var(--card); border-bottom:1px solid rgba(0,0,0,0.05); position:sticky; top:0; z-index:10; }
        .topbar-title { font-size:22px; font-weight:700; color:var(--primary-purple); margin:0; }
        .logo-circle { width:36px; height:36px; border-radius:50%; background:var(--primary-purple); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:14px; flex-shrink:0; }
        .topbar-right { display:flex; align-items:center; gap:20px; }
        .bell-container { position:relative; cursor:pointer; padding:8px; }
        .bell-container i { font-size:22px; color:var(--primary-purple); }
        .reminder-badge { position:absolute; top:5px; right:5px; background:var(--danger); color:#fff; border-radius:50%; width:18px; height:18px; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; }
        .reminders-dropdown { position:absolute; top:60px; right:40px; width:350px; max-height:400px; overflow-y:auto; background:var(--card); border-radius:12px; box-shadow:0 8px 20px rgba(0,0,0,0.15); z-index:1000; padding:20px; }
        .reminders-dropdown h3 { color:var(--primary-purple); font-weight:700; margin:0 0 15px; font-size:18px; }
        .reminder-item { padding:12px; margin-bottom:10px; border-radius:8px; border-left:4px solid var(--warning); background:rgba(245,158,11,0.1); font-size:14px; }
        .reminder-item.due-today { border-left-color:var(--expense); background:rgba(239,68,68,0.1); }
        .reminder-item.overdue { border-left-color:var(--danger); background:rgba(185,28,28,0.1); }
        .profile-area { display:flex; align-items:center; gap:10px; font-weight:600; color:var(--primary-purple); cursor:pointer; }
        .profile-avatar { width:40px; height:40px; border-radius:50%; background:var(--primary-purple); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:16px; }
        .dashboard-grid { display:grid; grid-template-columns:1.7fr 1fr; gap:20px; padding:40px; max-width:1150px; margin:0 auto; }
        .card { background:var(--card); padding:30px; border-radius:12px; box-shadow:0 4px 10px rgba(0,0,0,0.05); color:var(--primary-purple); }
        .column-left { display:flex; flex-direction:column; gap:20px; }
        .column-right { display:flex; flex-direction:column; gap:20px; }
        .main-balance-card { background:var(--card); padding:40px; border-radius:12px; box-shadow:0 4px 10px rgba(0,0,0,0.05); }
        .main-balance-card h2 { font-size:32px; font-weight:700; margin:0 0 10px; color:var(--primary-purple); text-align:left; }
        .balance-label { font-size:14px; font-weight:600; margin-bottom:5px; color:var(--primary-purple); text-align:left; }
        .balance-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
        .currency { font-size:28px; font-weight:700; color:var(--text-dark); }
        .balance-value { font-size:28px; font-weight:700; color:var(--text-dark); }
        .sign-up-btn { background:#fff; color:var(--primary-purple); border:2px solid var(--primary-purple); padding:8px 20px; border-radius:8px; cursor:pointer; font-weight:700; text-transform:uppercase; margin-left:auto; }
        .topup-btn { background:var(--primary-purple); color:#fff; border:none; padding:8px 18px; border-radius:8px; cursor:pointer; font-weight:700; text-transform:uppercase; font-size:13px; }
        .quick-actions-grid { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
        .action-btn { background:var(--primary-purple); color:#fff; padding:30px 20px; border:none; border-radius:12px; cursor:pointer; font-weight:600; font-size:16px; text-transform:uppercase; text-align:center; transition:transform 0.15s, box-shadow 0.15s; }
        .action-btn:hover { transform:translateY(-3px); box-shadow:0 5px 15px rgba(0,0,0,0.2); }
        .action-btn.full-width { grid-column:1/-1; }
        .action-btn.danger { background:var(--danger); }
        .chat-card { background:var(--primary-purple); color:#fff; display:flex; justify-content:space-between; align-items:center; padding:20px 30px; cursor:pointer; border:none; border-radius:12px; box-shadow:0 4px 10px rgba(0,0,0,0.05); transition:opacity 0.2s; width:100%; }
        .chat-card:hover { opacity:0.9; }
        .chat-text { font-weight:600; font-size:20px; line-height:1.3; }
        .transactions-card { background:var(--card); padding:20px 22px; border-radius:12px; box-shadow:0 4px 10px rgba(0,0,0,0.05); max-width:420px; }
        .transactions-card h3 { color:var(--primary-purple); font-weight:700; margin:0; font-size:16px; }
        .tx-table { width:100%; table-layout:fixed; border-collapse:collapse; margin-top:15px; color:var(--text-dark); }
        .tx-table th, .tx-table td { padding:12px 0; border-bottom:1px solid rgba(92,45,145,0.1); font-size:13px; text-align:left; overflow:hidden; }
        .tx-table th:nth-child(1), .tx-table td:nth-child(1) { white-space:nowrap; padding-right:8px; }
        .tx-table th { color:var(--primary-purple); font-weight:600; text-transform:uppercase; font-size:11px; }
        .tx-desc-cell { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; padding-right:8px; }
        .tx-table th:nth-child(3), .tx-table td:nth-child(3) { text-align:right; font-weight:600; white-space:nowrap; }
        .tx-table th:nth-child(4), .tx-table td:nth-child(4) { text-align:right; }
        .income-text { color:var(--income); }
        .expense-text { color:var(--expense); }
        .tx-menu-wrap { position:relative; display:inline-block; }
        .tx-menu-btn { background:none; border:none; color:var(--primary-purple); font-size:18px; font-weight:900; cursor:pointer; padding:2px 8px; border-radius:6px; }
        .tx-menu-btn:hover { background:var(--secondary-purple); }
        .tx-menu-dropdown { display:none; position:absolute; right:0; top:28px; background:var(--card); box-shadow:0 4px 15px rgba(0,0,0,0.15); border-radius:8px; min-width:170px; z-index:50; overflow:hidden; }
        .tx-menu-dropdown.open { display:block; }
        .tx-menu-dropdown a { display:block; padding:10px 14px; font-size:13px; color:var(--text-dark); text-decoration:none; cursor:pointer; }
        .tx-menu-dropdown a:hover { background:var(--secondary-purple); color:var(--primary-purple); }
        .breakdown-card { background:var(--card); padding:20px 30px; border-radius:12px; box-shadow:0 4px 10px rgba(0,0,0,0.05); }
        .breakdown-row { margin-bottom:14px; }
        .breakdown-label-row { display:flex; justify-content:space-between; font-size:13px; margin-bottom:6px; }
        .breakdown-bar-track { width:100%; height:8px; background:var(--secondary-purple); border-radius:4px; overflow:hidden; }
        .breakdown-bar-fill { height:100%; background:var(--primary-purple); border-radius:4px; transition:width 0.4s; }
        .income-bar-fill { background:var(--income); }
        .advisor-wrap { max-width:1150px; margin:0 auto; padding:40px; }
        .advisor-header { display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:16px; margin-bottom:24px; }
        .advisor-title { font-size:26px; font-weight:700; color:var(--primary-purple); margin:0 0 6px; }
        .advisor-subtitle { font-size:14px; color:#6b7280; margin:0; }
        .advisor-grid { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
        .advisor-summary-card { grid-column:1/-1; }
        .advisor-summary-row { display:flex; gap:30px; flex-wrap:wrap; margin-top:10px; }
        .advisor-stat { display:flex; flex-direction:column; gap:6px; }
        .advisor-stat-label { font-size:13px; font-weight:600; color:#6b7280; text-transform:uppercase; }
        .advisor-stat-value { font-size:24px; font-weight:700; }
        .advisor-empty { font-size:13px; color:#999; text-align:center; padding:20px 0; }
        .advisor-insights-card { grid-column:1/-1; }
        .preview-tag { font-size:10px; font-weight:700; background:var(--secondary-purple); color:var(--primary-purple); padding:3px 8px; border-radius:20px; text-transform:uppercase; margin-left:8px; vertical-align:middle; }
        .insight-item { background:var(--secondary-purple); padding:14px 16px; border-radius:8px; font-size:13px; color:var(--text-dark); margin-top:10px; line-height:1.5; }
        .trend-chart { display:flex; align-items:flex-end; gap:14px; height:160px; margin-top:10px; padding-top:10px; }
        .trend-col { display:flex; flex-direction:column; align-items:center; gap:8px; flex:1; height:100%; }
        .trend-bars { display:flex; align-items:flex-end; gap:3px; height:100%; width:100%; justify-content:center; }
        .trend-bar { width:10px; border-radius:3px 3px 0 0; min-height:2px; }
        .trend-bar.income-bar { background:var(--income); }
        .trend-bar.expense-bar { background:var(--expense); }
        .trend-label { font-size:11px; color:#6b7280; font-weight:600; }
        .bank-detect-note { font-size:12px; color:var(--primary-purple); background:var(--secondary-purple); padding:8px 12px; border-radius:6px; margin-top:6px; }
        .advisor-footnote { font-size:12px; color:#6b7280; margin:12px 0 0; line-height:1.5; }
        .advisor-invest-card { grid-column:1/-1; }
        .risk-toggle { display:flex; gap:8px; margin:14px 0 16px; }
        .risk-btn { flex:1; padding:10px; border-radius:8px; border:1.5px solid rgba(92,45,145,0.3); background:#fff; color:var(--primary-purple); font-weight:700; font-size:12px; text-transform:uppercase; cursor:pointer; }
        .risk-btn.active { background:var(--primary-purple); color:#fff; border-color:var(--primary-purple); }
        .wallet-card-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }
        .wallet-row { display:flex; justify-content:space-between; align-items:center; padding:14px 0; border-bottom:1px solid var(--secondary-purple); }
        .wallet-row:last-child { border-bottom:none; }
        .wallet-status-pill { font-size:11px; font-weight:700; text-transform:uppercase; padding:4px 10px; border-radius:20px; background:rgba(16,185,129,0.12); color:var(--income); }
        .wallet-status-pill.locked { background:rgba(185,28,28,0.12); color:var(--danger); }
        .pace-row { margin-bottom:16px; }
        .pace-label-row { display:flex; justify-content:space-between; font-size:13px; margin-bottom:6px; }
        .pace-bar-warning { background:var(--warning) !important; }
        .pace-warning-text { color:var(--warning); font-weight:600; }
        .edit-assets-link { background:none; border:none; color:var(--primary-purple); font-size:11px; font-weight:700; text-transform:uppercase; text-decoration:underline; cursor:pointer; padding:2px 0; margin-top:2px; align-self:flex-start; }
        .sidebar-overlay { position:fixed; top:0; left:0; width:100%; height:100%; background:transparent; z-index:150; display:none; }
        .sidebar-overlay.visible { display:block; }
        .sidebar { position:fixed; top:0; right:0; width:min(300px,90vw); height:100%; background:var(--card); z-index:200; box-shadow:-5px 0 15px rgba(0,0,0,0.2); transform:translateX(100%); transition:transform 0.3s; display:flex; flex-direction:column; }
        .sidebar.open { transform:translateX(0); }
        .sidebar-header { display:flex; flex-direction:column; align-items:center; padding:30px 20px 20px; border-bottom:1px solid var(--secondary-purple); }
        .sidebar-header .profile-avatar { width:60px; height:60px; font-size:20px; margin-bottom:10px; }
        .profile-name-large { font-size:20px; font-weight:700; color:var(--primary-purple); margin-bottom:5px; }
        .user-id { font-size:12px; color:#777; word-break:break-all; text-align:center; }
        .sidebar-nav { flex-grow:1; padding:20px 0; list-style:none; margin:0; }
        .sidebar-nav a { display:flex; align-items:center; padding:15px 30px; text-decoration:none; color:var(--text-dark); font-weight:600; transition:background 0.2s; cursor:pointer; }
        .sidebar-nav a:hover { background:var(--secondary-purple); color:var(--primary-purple); }
        .sidebar-nav a i { margin-right:15px; font-size:16px; width:20px; text-align:center; }
        .sidebar-footer { padding:20px; border-top:1px solid var(--secondary-purple); }
        .logout-btn { width:100%; background:var(--danger); color:#fff; padding:12px; border:none; border-radius:8px; cursor:pointer; font-weight:700; }
        .sidebar-close-btn { position:absolute; top:15px; left:-40px; background:var(--primary-purple); color:#fff; border:none; border-radius:50%; width:30px; height:30px; font-size:20px; cursor:pointer; display:flex; align-items:center; justify-content:center; }
        .blurred { filter:blur(5px); transform:scale(0.98); pointer-events:none; }
        .modal-overlay { position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6); backdrop-filter:blur(5px); display:flex; justify-content:center; align-items:center; z-index:300; }
        .modal-box { background:var(--card); padding:30px; border-radius:12px; width:min(90%,450px); position:relative; box-shadow:0 10px 30px rgba(0,0,0,0.2); max-height:85vh; overflow-y:auto; }
        .modal-close { position:absolute; top:10px; right:10px; background:none; border:none; font-size:24px; cursor:pointer; color:var(--primary-purple); }
        .modal-box h3 { margin-top:0; color:var(--primary-purple); font-size:22px; text-align:center; }
        .modal-box label { display:block; margin-top:15px; font-size:14px; font-weight:600; color:var(--primary-purple); text-align:left; }
        .modal-box input, .modal-box select { width:100%; padding:10px; margin-top:5px; border:1px solid rgba(92,45,145,0.3); border-radius:6px; font-size:14px; background:#fff; }
        .modal-btn-primary { width:100%; padding:12px; margin-top:25px; background:var(--primary-purple); color:#fff; border:none; border-radius:6px; cursor:pointer; font-weight:700; text-transform:uppercase; font-size:14px; }
        .modal-btn-primary:disabled { opacity:0.6; cursor:not-allowed; }
        .modal-btn-secondary { width:100%; padding:12px; margin-top:10px; background:transparent; color:var(--primary-purple); border:2px solid var(--primary-purple); border-radius:6px; cursor:pointer; font-weight:700; text-transform:uppercase; font-size:14px; }
        .step-indicator { display:flex; align-items:center; gap:8px; margin:4px 0 20px; }
        .step-dot { width:26px; height:26px; border-radius:50%; background:var(--secondary-purple); color:var(--primary-purple); display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; }
        .step-dot.done { background:var(--income); color:#fff; }
        .step-dot.current { background:var(--primary-purple); color:#fff; }
        .step-line { flex-grow:1; height:2px; background:var(--secondary-purple); }
        .summary-box { background:var(--secondary-purple); padding:16px; border-radius:8px; margin:16px 0; }
        .summary-row { display:flex; justify-content:space-between; font-size:13px; padding:4px 0; }
        .summary-row strong { color:var(--primary-purple); }
        .limit-note { background:var(--secondary-purple); padding:10px 14px; border-radius:8px; font-size:12px; color:var(--primary-purple); margin-top:16px; }
        .receipt-actions { display:flex; gap:10px; margin-top:10px; }
        .receipt-actions button { flex:1; }
        .success-icon { width:80px; height:80px; border-radius:50%; background:var(--primary-purple); color:#fff; display:flex; align-items:center; justify-content:center; margin:0 auto 20px; font-size:40px; }
        .saved-account-prompt { background:rgba(92,45,145,0.08); border:1px solid rgba(92,45,145,0.25); border-radius:8px; padding:12px 14px; margin-top:14px; font-size:13px; }
        .prompt-actions { display:flex; gap:8px; margin-top:10px; }
        .yes-btn { flex:1; padding:8px; border-radius:6px; border:none; cursor:pointer; font-weight:600; background:var(--primary-purple); color:#fff; }
        .no-btn { flex:1; padding:8px; border-radius:6px; cursor:pointer; font-weight:600; background:#fff; color:var(--primary-purple); border:1px solid var(--primary-purple); }
        .profile-switch-toggle { width:100%; background:var(--secondary-purple); border:none; border-radius:8px; padding:10px; font-size:12px; font-weight:700; color:var(--primary-purple); cursor:pointer; text-transform:uppercase; margin-top:16px; }
        .receipt-print { display:none; }
        @media print { body * { visibility:hidden; } .receipt-print, .receipt-print * { visibility:visible; } .receipt-print { display:block !important; position:absolute; top:0; left:0; width:100%; padding:30px; } }
        .receipt-print .r-header { text-align:center; margin-bottom:20px; }
        .receipt-print .r-header h2 { color:#5c2d91; margin:0; }
        .receipt-print .r-row { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #eee; font-size:14px; }
        @media(max-width:900px) {
          .app-shell { flex-direction:column; }
          .left-nav { width:100%; height:auto; position:sticky; top:0; z-index:20; flex-direction:row; align-items:center; padding:10px 16px; overflow-x:auto; }
          .left-nav-brand { padding:0 16px 0 0; }
          .left-nav-list { flex-direction:row; padding:0; }
          .left-nav-list li span { display:none; }
          .left-nav-list li { padding:10px 14px; }
          .topbar{padding:15px 20px;}
          .dashboard-grid{grid-template-columns:1fr;padding:20px;}
          .quick-actions-grid{grid-template-columns:1fr;}
          .transactions-card{max-width:100%;}
          .advisor-wrap{padding:20px;}
          .advisor-grid{grid-template-columns:1fr;}
        }
      `}</style>

      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css" />

      <div ref={printRef} className="receipt-print" />

      <div className="app-shell">
        <nav className="left-nav">
          <div className="left-nav-brand">
            <span className="logo-circle">AI</span>
            <span className="left-nav-brand-text">FinBud</span>
          </div>
          <ul className="left-nav-list">
            <li className={activeView === 'home' ? 'active' : ''} onClick={() => { setActiveView('home'); setRemindersOpen(false) }}>
              <i className="fas fa-home" /> <span>Home</span>
            </li>
            <li className={activeView === 'advisor' ? 'active' : ''} onClick={() => { setActiveView('advisor'); setRemindersOpen(false) }}>
              <i className="fas fa-chart-pie" /> <span>Financial Advisor</span>
            </li>
            <li className={activeView === 'wallet' ? 'active' : ''} onClick={() => { setActiveView('wallet'); setRemindersOpen(false) }}>
              <i className="fas fa-wallet" /> <span>Wallet</span>
            </li>
          </ul>
        </nav>

        <div className="main-content">
          <div className={modal || sidebarOpen ? 'blurred' : ''} style={{ minHeight: '100vh' }}>
            <header className="topbar">
              <h1 className="topbar-title">{activeView === 'home' ? 'Dashboard' : activeView === 'advisor' ? 'Financial Advisor' : 'Wallet'}</h1>
              <div className="topbar-right">
                <div className="bell-container" onClick={() => setRemindersOpen(o => !o)}>
                  <i className="fas fa-bell" />
                  {reminders.length > 0 && <span className="reminder-badge">{reminders.length}</span>}
                </div>
                <div className="profile-area" onClick={() => setSidebarOpen(true)}>
                  <span>{userData.name}</span>
                  <div className="profile-avatar">{userData.initials}</div>
                </div>
              </div>
            </header>

            {remindersOpen && (
              <div className="reminders-dropdown" onClick={e => e.stopPropagation()}>
                <h3><i className="fas fa-bell" /> Bill Reminders</h3>
                {reminders.map((r, i) => {
                  const daysText = r.days_left === 0 ? 'Due Today' : r.days_left < 0 ? `${Math.abs(r.days_left)} days overdue` : `Due in ${r.days_left} day${r.days_left > 1 ? 's' : ''}`
                  return (
                    <div key={i} className={`reminder-item ${r.kind}`}>
                      <div style={{ fontWeight: 600 }}>{r.biller}</div>
                      <div style={{ fontWeight: 700, color: 'var(--primary-purple)' }}>PKR {r.amount.toLocaleString('en-PK')}</div>
                      <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>{daysText} ({r.due_date})</div>
                    </div>
                  )
                })}
              </div>
            )}

            {activeView === 'home' ? (
              <main className="dashboard-grid" onClick={() => { setRemindersOpen(false); setOpenMenuId(null) }}>
                <section className="column-left">
                  <div className="main-balance-card">
                    <h2>Hello, {userData.name}!</h2>
                    <p className="balance-label">YOUR BALANCE:</p>
                    <div className="balance-row">
                      <span className="currency">PKR</span>
                      <strong className="balance-value">{userData.isMasked ? '*****' : formattedBalance}</strong>
                      <button className="sign-up-btn" onClick={() => userData.isMasked ? setModal({ type: 'verifyBalance' }) : setUserData(u => ({ ...u, isMasked: true }))}>
                        {userData.isMasked ? 'SHOW BALANCE' : 'HIDE BALANCE'}
                      </button>
                      <button className="topup-btn" onClick={() => setModal({ type: 'topup' })}>+ Top Up</button>
                    </div>
                  </div>

                  <div className="quick-actions-grid">
                    <button className="action-btn" onClick={() => setModal({ type: 'sendMoney1' })}>SEND MONEY</button>
                    <button className="action-btn" onClick={() => setModal({ type: 'payBill1' })}>PAY BILL</button>
                    <button className="action-btn" onClick={() => setModal({ type: 'rewards' })}>REWARDS</button>
                    <button className="action-btn" onClick={() => setModal({ type: 'redeemPoints' })}>REDEEM POINTS</button>
                    {hasCard && (
                      <button className="action-btn danger full-width" onClick={() => navigate('/chat?action=emergency')}>
                        🚨 EMERGENCY — LOCK CARDS
                      </button>
                    )}
                  </div>
                </section>

                <section className="column-right">
                  <button className="chat-card" onClick={() => navigate('/chat')}>
                    <div className="chat-text">Chat With <br /> Your AI Assistant</div>
                    <span style={{ fontSize: 30, fontWeight: 900 }}>→</span>
                  </button>

                  <div className="transactions-card">
                    <h3>Recent Transactions <i className="fas fa-chevron-down" style={{ fontSize: 18, marginLeft: 5 }} /></h3>
                    <table className="tx-table">
                      <colgroup>
                        <col style={{ width: '26%' }} />
                        <col style={{ width: '40%' }} />
                        <col style={{ width: '24%' }} />
                        <col style={{ width: '10%' }} />
                      </colgroup>
                      <thead><tr><th>Date</th><th>Type</th><th>Amount</th><th /></tr></thead>
                      <tbody>
                        {transactions.length === 0
                          ? <tr><td colSpan={4} style={{ textAlign: 'center', color: '#999' }}>No transactions yet</td></tr>
                          : transactions.map((tx, i) => {
                            const menuId = tx.id ?? `idx-${i}`
                            return (
                              <tr key={menuId}>
                                <td>{tx.date}</td>
                                <td className="tx-desc-cell" title={tx.description}>{tx.description}</td>
                                <td className={tx.amount < 0 ? 'expense-text' : 'income-text'}>PKR {Math.abs(tx.amount).toLocaleString('en-PK')}</td>
                                <td>
                                  <div className="tx-menu-wrap">
                                    <button className="tx-menu-btn" onClick={e => { e.stopPropagation(); setOpenMenuId(openMenuId === menuId ? null : menuId) }}>⋯</button>
                                    <div className={`tx-menu-dropdown ${openMenuId === menuId ? 'open' : ''}`}>
                                      <a onClick={() => { setOpenMenuId(null); downloadReceipt(tx.id) }}>Download Receipt</a>
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )
                          })}
                      </tbody>
                    </table>
                  </div>
                </section>
              </main>
            ) : activeView === 'advisor' ? (
              <main onClick={() => { setRemindersOpen(false); setOpenMenuId(null) }}>
                <FinancialAdvisorView />
              </main>
            ) : (
              <main onClick={() => { setRemindersOpen(false); setOpenMenuId(null) }}>
                <WalletView />
              </main>
            )}
          </div>
        </div>
      </div>

      <div className={`sidebar-overlay ${sidebarOpen ? 'visible' : ''}`} onClick={() => setSidebarOpen(false)} />

      <div className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <button className="sidebar-close-btn" onClick={() => setSidebarOpen(false)}>×</button>
        <div className="sidebar-header">
          <div className="profile-avatar" style={{ width: 60, height: 60, fontSize: 20 }}>{userData.initials}</div>
          <span className="profile-name-large">{userData.name}</span>
          <span className="user-id">User ID: {userData.userId}</span>
          <button className="profile-switch-toggle" onClick={() => alert('Multi-profile support is on our roadmap.')}>Switch Profile <i className="fas fa-chevron-down" /></button>
        </div>
        <ul className="sidebar-nav">
          <li><a onClick={() => { setSidebarOpen(false); setModal({ type: 'profileOverview' }) }}><i className="fas fa-user-circle" /> Profile Overview</a></li>
          <li><a onClick={() => { setSidebarOpen(false); setModal({ type: 'settings' }) }}><i className="fas fa-cog" /> Settings</a></li>
          <li><a onClick={() => { setSidebarOpen(false); setModal({ type: 'security' }) }}><i className="fas fa-shield-alt" /> Security Center</a></li>
          <li><a onClick={() => { setSidebarOpen(false); setModal({ type: 'financialReports' }) }}><i className="fas fa-chart-line" /> Financial Reports</a></li>
        </ul>
        <div className="sidebar-footer">
          <button className="logout-btn" onClick={handleLogout}>LOG OUT</button>
        </div>
      </div>

      {modal && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setModal(null)}>×</button>
            {renderModalContent()}
          </div>
        </div>
      )}
    </>
  )
}