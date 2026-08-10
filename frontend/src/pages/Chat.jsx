import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'

export default function Chat() {
  const navigate = useNavigate()
  const messagesEndRef = useRef(null)
  const printRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const audioChunksRef = useRef([])
  const audioStreamRef = useRef(null)

  const [messages, setMessages] = useState([])
  const [inputText, setInputText] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [hasCard, setHasCard] = useState(true)
  const [modal, setModal] = useState(null)
  const [pendingInfo, setPendingInfo] = useState(null)
  const [lastBillType, setLastBillType] = useState(null)

  useEffect(() => {
    checkCard()
    // Module F: Dashboard.jsx sets these on <html> and they persist across
    // client-side navigation, but if a user lands directly on /chat (e.g. a
    // deep link or a fresh tab), apply the saved preference here too.
    document.documentElement.setAttribute('data-font-size', localStorage.getItem('finbud_font_size') || 'default')
    document.documentElement.setAttribute('data-contrast', localStorage.getItem('finbud_high_contrast') === 'true' ? 'high' : 'default')
  }, [])

  function speak(text) {
    if (typeof window === 'undefined' || !window.speechSynthesis) return
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'en-US'
    window.speechSynthesis.speak(utterance)
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isLoading])

  async function checkCard() {
    try {
      const res = await fetch('/api/cards/check', { credentials: 'include' })
      const data = await res.json()
      setHasCard(!!data.has_card)
    } catch { setHasCard(true) }
  }

  function appendMessage(text, type) {
    setMessages(prev => [...prev, { text, type, id: Date.now() + Math.random() }])
  }

  async function postChat(message) {
    const res = await fetch('/api/chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ message })
    })
    return res.json()
  }

  async function maybePrefill(data) {
    const bt = data.entities && data.entities.bill_type
    if (!bt || bt === lastBillType) return
    setLastBillType(bt)
    try {
      const res = await fetch(`/api/bills/saved-ref?provider=${encodeURIComponent(bt)}`, { credentials: 'include' })
      if (res.ok) {
        const d = await res.json()
        if (d.success && d.has_saved_ref && d.ref) {
          setInputText(d.ref)
          return
        }
      }
    } catch {}
  }

  async function handleResponse(data, { emergencyFlow = false } = {}) {
    if (!data.success) {
      appendMessage('Sorry, I encountered an error. Please try again.', 'ai')
      return
    }

    appendMessage(data.ai_response, 'ai')

    const needsPw  = data.awaiting_password
    const needsEPw = data.awaiting_emergency_password

    if (!needsPw && !needsEPw && !emergencyFlow) return
    if ((needsEPw || emergencyFlow) && !hasCard) return

    const e      = data.entities || {}
    const intent = data.intent   || ''

    let config = {}

    if (needsEPw || emergencyFlow) {
      config = {
        type: 'emergency',
        title: 'Emergency: Lock All Cards',
        confirmLabel: 'LOCK CARDS NOW',
        summaryRows: [{ label: 'Action', value: 'Lock all registered cards immediately' }],
        intent, entities: e
      }
    } else if (intent === 'pay_bill' || e.bill_type) {
      const amt    = e.amount    ? `RS ${parseFloat(e.amount).toLocaleString('en-PK')}` : '—'
      const biller = e.bill_type || e.biller || '—'
      const ref    = e.bill_reference || e.account_number || e.bill_id || '—'
      config = {
        type: 'confirm',
        title: 'Confirm Bill Payment',
        confirmLabel: 'CONFIRM & PAY',
        summaryRows: [
          { label: 'Biller',           value: biller },
          { label: 'Reference Number', value: ref    },
          { label: 'Amount',           value: amt    }
        ],
        intent, entities: e
      }
    } else {
      const amt   = e.amount    ? `PKR ${parseFloat(e.amount).toLocaleString('en-PK')}` : '—'
      const recip = e.recipient || e.recipient_name || '—'
      const iban  = e.account_number || e.recipient_account || '—'
      const purp  = e.purpose   || 'Personal'
      config = {
        type: 'confirm',
        title: 'Confirm Transfer',
        confirmLabel: 'CONFIRM & SEND',
        summaryRows: [
          { label: 'Recipient', value: recip },
          { label: 'IBAN',      value: iban  },
          { label: 'Amount',    value: amt   },
          { label: 'Purpose',   value: purp  }
        ],
        intent, entities: e
      }
    }

    setPendingInfo(config)
    setModal('password')
  }

  async function submitPassword(password) {
    setModal('processing')
    try {
      const vRes  = await fetch('/api/user/verify-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password })
      })
      const vData = await vRes.json()
      if (!vData.success) {
        setModal('passwordError')
        return
      }
    } catch {}

    let pwData
    try {
      pwData = await postChat(password)
    } catch {
      setModal(null)
      appendMessage('Sorry, something went wrong. Please try again.', 'ai')
      return
    }

    if (!pwData || !pwData.success) {
      setModal(null)
      appendMessage(pwData?.ai_response || 'Sorry, something went wrong.', 'ai')
      return
    }

    if (pendingInfo?.type === 'emergency') {
      setModal(null)
      appendMessage(pwData.ai_response, 'ai')
    } else if (pendingInfo?.intent === 'pay_bill' || pendingInfo?.entities?.bill_type) {
      appendMessage(pwData.ai_response, 'ai')
      setModal('billSuccess')
      setPendingInfo(prev => ({ ...prev, txData: pwData }))
    } else {
      appendMessage(pwData.ai_response, 'ai')
      setModal('transferSuccess')
      setPendingInfo(prev => ({ ...prev, txData: pwData }))
    }
  }

  async function sendMessage(text) {
    const userText = (text || inputText).trim()
    if (!userText) return

    setMessages(prev => prev.filter(m => m.type !== 'welcome'))
    appendMessage(userText, 'user')
    setInputText('')
    setLastBillType(null)
    setIsLoading(true)

    let data
    try {
      data = await postChat(userText)
    } catch {
      setIsLoading(false)
      appendMessage('Sorry, I could not connect to the server. Please check your connection and try again.', 'ai')
      return
    }

    setIsLoading(false)
    await maybePrefill(data)
    await handleResponse(data)
  }

  async function toggleRecording() {
    if (isRecording) {
      mediaRecorderRef.current?.stop()
      audioStreamRef.current?.getTracks().forEach(t => t.stop())
      setIsRecording(false)
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      audioStreamRef.current = stream
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      audioChunksRef.current = []
      recorder.ondataavailable = e => audioChunksRef.current.push(e.data)
      recorder.onstart = () => setIsRecording(true)
      recorder.onstop = () => {
        setIsRecording(false)
        processVoiceMessage()
      }
      recorder.start()
      mediaRecorderRef.current = recorder
    } catch {
      appendMessage('Error: Could not access microphone. Please ensure permissions are granted.', 'ai')
    }
  }

  async function processVoiceMessage() {
    const hardcoded = 'mera balance kitna hai'
    setMessages(prev => prev.filter(m => m.type !== 'welcome'))
    appendMessage(hardcoded, 'user')
    setIsLoading(true)
    let data
    try { data = await postChat(hardcoded) }
    catch {
      setIsLoading(false)
      appendMessage('Sorry, I could not connect to the server.', 'ai')
      return
    }
    setIsLoading(false)
    await handleResponse(data)
  }

  async function handleHumanHandoff() {
    setMessages(prev => prev.filter(m => m.type !== 'welcome'))
    appendMessage('I want to talk to a human banker', 'user')
    setIsLoading(true)
    try {
      const res  = await fetch('/api/chat/human-handoff', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include'
      })
      const data = await res.json()
      setIsLoading(false)
      appendMessage(data.success ? data.ai_response : 'Sorry, I encountered an error.', 'ai')
    } catch {
      setIsLoading(false)
      appendMessage('Sorry, I could not connect to the server.', 'ai')
    }
  }

  async function handleEmergency() {
    if (!hasCard) return
    setMessages(prev => prev.filter(m => m.type !== 'welcome'))
    appendMessage('EMERGENCY - Lock my cards!', 'user')
    setIsLoading(true)
    let data
    try {
      const res = await fetch('/api/chat/emergency', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include'
      })
      data = await res.json()
    } catch {
      setIsLoading(false)
      appendMessage('Sorry, I could not connect to the server.', 'ai')
      return
    }
    setIsLoading(false)
    await handleResponse(data, { emergencyFlow: true })
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
      ${receipt.recipient ? `<div class="r-row"><span>Recipient</span><strong>${receipt.recipient}</strong></div>` : ''}
      ${receipt.biller   ? `<div class="r-row"><span>Biller</span><strong>${receipt.biller}</strong></div>`       : ''}
      <div class="r-row"><span>Amount</span><strong>PKR ${amt}</strong></div>
      <div class="r-row"><span>Status</span><strong>${receipt.status}</strong></div>
    `
  }

  async function downloadReceipt(txId) {
    if (!txId) { alert('Receipt not available.'); return }
    try {
      const res  = await fetch(`/api/transaction/${txId}/receipt`, { credentials: 'include' })
      const data = await res.json()
      if (data.success) { renderPrint(data.receipt); setTimeout(() => window.print(), 200) }
      else alert('Could not load receipt: ' + (data.message || 'Unknown error'))
    } catch { alert('Server error loading receipt.') }
  }

  async function emailReceipt(txId) {
    try {
      const res = await fetch(`/api/transaction/${txId}/email-receipt`, { method: 'POST', credentials: 'include' })
      if (res.status === 404) { alert('Email receipts are part of our Phase 2 rollout. Please download the PDF for now.'); return }
      const data = await res.json()
      if (data.success) alert('Receipt emailed to your registered address!')
      else alert('Could not send: ' + (data.message || 'Please download instead.'))
    } catch { alert('Email receipts are part of our Phase 2 rollout. Please download the PDF for now.') }
  }

  // ── PASSWORD MODAL ───────────────────────────────────────
  function PasswordModal() {
    const [pw, setPw] = useState('')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)
    const isEmergency = pendingInfo?.type === 'emergency'

    async function handleSubmit(e) {
      e.preventDefault()
      if (!pw) { setError('Please enter your password.'); return }
      setError(''); setLoading(true)

      // Inline verify
      try {
        const vRes  = await fetch('/api/user/verify-password', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'include', body: JSON.stringify({ password: pw })
        })
        const vData = await vRes.json()
        if (!vData.success) {
          setError('Incorrect password. Please try again.')
          setPw(''); setLoading(false); return
        }
      } catch {}

      setLoading(false)
      await submitPassword(pw)
    }

    return (
      <div className={`pw-modal ${isEmergency ? 'emergency' : ''}`}>
        <button className="pw-close" aria-label="Close dialog" onClick={() => setModal(null)}>×</button>
        <h3>{pendingInfo?.title}</h3>
        <div className="pw-steps">
          {[1,2].map((n,i) => (
            <span key={n} style={{ display:'flex', alignItems:'center', flexGrow: i > 0 ? 1 : 0 }}>
              {i > 0 && <div className="pw-line" />}
              <div className={`pw-dot ${n < 2 ? 'done' : 'current'}`}>{n}</div>
            </span>
          ))}
        </div>
        <div className="pw-summary">
          {pendingInfo?.summaryRows?.map(r => (
            <div key={r.label} className="pw-row"><span>{r.label}</span><strong>{r.value}</strong></div>
          ))}
        </div>
        <form onSubmit={handleSubmit}>
          <label>Enter your password to confirm</label>
          <input type="password" autoFocus placeholder="Password" value={pw}
            onChange={e => setPw(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit(e)} />
          {error && <p className="pw-error">{error}</p>}
          <button type="submit" className="pw-btn-primary" disabled={loading}>
            {loading ? 'Verifying...' : pendingInfo?.confirmLabel}
          </button>
          <button type="button" className="pw-btn-secondary" onClick={() => setModal(null)}>BACK</button>
          <p className="pw-note">Note: this confirms with your account password.</p>
        </form>
      </div>
    )
  }

  function SuccessModal({ type }) {
    const txData = pendingInfo?.txData
    const txId   = txData?.transaction_id || txData?.id
    const isTransfer = type === 'transfer'
    return (
      <div className="pw-modal">
        <button className="pw-close" aria-label="Close dialog" onClick={() => setModal(null)}>×</button>
        <div style={{ textAlign:'center', padding:10 }}>
          <div className="pw-steps">
            {[1,2].map((n,i) => (
              <span key={n} style={{ display:'flex', alignItems:'center', flexGrow: i > 0 ? 1 : 0 }}>
                {i > 0 && <div className="pw-line" />}
                <div className="pw-dot done">{n}</div>
              </span>
            ))}
          </div>
          <div className="pw-success-icon">✓</div>
          <h3 style={{ color:'#15803d', marginBottom:15 }}>{isTransfer ? 'Transfer Successful!' : 'Transaction Successful!'}</h3>
          {isTransfer
            ? <>
                <p style={{ fontSize:16, marginBottom:5 }}>
                  PKR {(pendingInfo?.entities?.amount||0).toLocaleString('en-PK')} sent to {pendingInfo?.entities?.recipient || pendingInfo?.entities?.recipient_name || 'recipient'}
                </p>
                <p style={{ fontSize:14, color:'#666', marginBottom:10 }}>Purpose: {pendingInfo?.entities?.purpose || 'Personal'}</p>
              </>
            : <p style={{ fontSize:16, marginBottom:10 }}>
                Your {pendingInfo?.entities?.bill_type || pendingInfo?.entities?.biller || 'bill'} bill has been paid successfully!
              </p>
          }
          <p style={{ fontSize:14, color:'var(--primary-purple)' }}>You earned {txData?.points_earned || 0} reward points!</p>
          <div className="receipt-actions">
            <button className="pw-btn-primary" style={{ marginTop:0 }} onClick={() => downloadReceipt(txId)}>DOWNLOAD PDF</button>
            <button className="pw-btn-primary" style={{ marginTop:0 }} onClick={() => emailReceipt(txId)}>EMAIL RECEIPT</button>
          </div>
          <button className="pw-btn-secondary" onClick={() => setModal(null)}>DONE</button>
        </div>
      </div>
    )
  }

  return (
    <>
      <style>{`
        :root {
          --primary-purple: #5c2d91;
          --secondary-purple: #f2f2f2;
          --text-dark: #111;
          --text-light: #fff;
          --card: #ffffff;
          --danger: #b91c1c;
        }
        html, body { margin:0; padding:0; width:100%; min-height:100vh; }
        #root { width:100%; min-height:100vh; display:flex; flex-direction:column; }
        * { box-sizing: border-box; font-family: Inter, ui-sans-serif, system-ui; }
        body { background: var(--secondary-purple); color: var(--text-dark); }
        .topbar { display:flex; justify-content:space-between; align-items:center; padding:15px 40px; background:var(--card); border-bottom:1px solid rgba(0,0,0,0.05); position:sticky; top:0; z-index:10; }
        .back-btn { background:none; border:none; color:var(--primary-purple); font-size:16px; font-weight:600; cursor:pointer; padding:8px 10px; border-radius:6px; display:flex; align-items:center; gap:5px; }
        .back-btn:hover { background:rgba(92,45,145,0.05); }
        .brand { display:flex; align-items:center; gap:10px; position:absolute; left:50%; transform:translateX(-50%); }
        .brand h1 { font-size:24px; font-weight:700; color:var(--primary-purple); margin:0; }
        .logo-circle { width:36px; height:36px; border-radius:50%; background:var(--primary-purple); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:14px; }
        .main-layout { flex-grow:1; display:flex; max-width:1400px; width:100%; margin:20px auto; gap:20px; padding:0 20px; height:calc(100vh - 120px); }
        .chat-container { flex-grow:1; display:flex; flex-direction:column; background:var(--card); border-radius:12px; box-shadow:0 4px 10px rgba(0,0,0,0.05); overflow:hidden; min-width:0; }
        .sidebar-right { width:200px; display:flex; flex-direction:column; gap:12px; flex-shrink:0; }
        .sidebar-card { background:var(--card); padding:16px; border-radius:10px; box-shadow:0 2px 8px rgba(0,0,0,0.08); cursor:pointer; transition:all 0.2s; border:2px solid transparent; display:flex; flex-direction:column; align-items:center; text-align:center; gap:8px; }
        .sidebar-card:hover { transform:translateY(-2px); box-shadow:0 4px 12px rgba(0,0,0,0.12); }
        .sidebar-card.human { background:linear-gradient(135deg,var(--primary-purple) 0%,#7c3fb3 100%); color:#fff; }
        .sidebar-card.emergency-card { background:linear-gradient(135deg,#dc2626 0%,#b91c1c 100%); color:#fff; }
        .sidebar-card.no-card { background:#d1d5db; color:#9ca3af; cursor:not-allowed; pointer-events:none; box-shadow:none; transform:none; }
        .sidebar-card-title { font-size:14px; font-weight:700; margin:0; line-height:1.2; }
        .sidebar-card-desc { font-size:11px; line-height:1.3; opacity:0.9; margin:0; }
        .messages-area { flex-grow:1; padding:20px; overflow-y:auto; display:flex; flex-direction:column; gap:15px; background:var(--secondary-purple); }
        .welcome-block { text-align:center; align-self:center; max-width:100%; padding:50px 20px; background:transparent; border:none; margin:auto; }
        .welcome-block .large-text { font-size:2.5rem; font-weight:800; color:var(--primary-purple); margin:0; line-height:1.1; }
        .welcome-block .small-text { font-size:1rem; color:#6b7280; margin-top:10px; font-weight:500; }
        .message { max-width:75%; padding:12px 18px; border-radius:18px; line-height:1.5; font-size:15px; white-space:pre-wrap; word-wrap:break-word; }
        .message.user { align-self:flex-end; background:var(--primary-purple); color:#fff; border-bottom-right-radius:4px; }
        .message.ai { align-self:flex-start; background:var(--card); color:var(--text-dark); border:1px solid rgba(0,0,0,0.05); border-bottom-left-radius:4px; }
        .message.loading { align-self:flex-start; background:var(--card); color:#6b7280; border:1px solid rgba(0,0,0,0.05); border-bottom-left-radius:4px; font-style:italic; }
        .input-area { padding:20px; display:flex; gap:10px; border-top:1px solid rgba(0,0,0,0.05); background:var(--card); }
        .input-area input { flex-grow:1; padding:12px 15px; border:1px solid rgba(92,45,145,0.3); border-radius:8px; font-size:16px; }
        .input-area button { background:var(--primary-purple); color:#fff; border:none; border-radius:8px; padding:12px; font-weight:600; cursor:pointer; transition:opacity 0.2s; }
        .input-area button:hover { opacity:0.9; }
        .mic-btn { background:var(--secondary-purple) !important; color:var(--primary-purple) !important; width:50px; padding:12px 0 !important; border:1px solid rgba(92,45,145,0.3) !important; font-size:18px; }
        .mic-btn.recording { background:var(--danger) !important; color:#fff !important; border-color:var(--danger) !important; animation:pulse 1.5s infinite; }
        .send-btn { padding:12px 20px !important; }
        @keyframes pulse { 0%{box-shadow:0 0 0 0 rgba(185,28,28,0.6)} 70%{box-shadow:0 0 0 10px rgba(185,28,28,0)} 100%{box-shadow:0 0 0 0 rgba(185,28,28,0)} }
        .modal-overlay { display:flex; position:fixed; inset:0; background:rgba(0,0,0,0.6); backdrop-filter:blur(5px); z-index:200; justify-content:center; align-items:center; }
        .pw-modal { background:var(--card); border-radius:12px; padding:30px; width:min(90vw,450px); position:relative; box-shadow:0 10px 30px rgba(0,0,0,0.2); max-height:90vh; overflow-y:auto; animation:pwIn .25s ease; }
        @keyframes pwIn { from{transform:scale(.94);opacity:0} to{transform:scale(1);opacity:1} }
        .pw-modal.emergency h3 { color:var(--danger); }
        .pw-modal.emergency label { color:var(--danger); }
        .pw-modal.emergency .pw-btn-primary { background:var(--danger); }
        .pw-modal.emergency .pw-dot.current { background:var(--danger); }
        .pw-close { position:absolute; top:10px; right:14px; background:none; border:none; font-size:22px; cursor:pointer; color:var(--primary-purple); }
        .pw-modal h3 { margin:0 0 4px; font-size:22px; color:var(--primary-purple); }
        .pw-steps { display:flex; align-items:center; width:100%; margin:12px 0 20px; }
        .pw-dot { width:26px; height:26px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; flex-shrink:0; background:var(--secondary-purple); color:var(--primary-purple); }
        .pw-dot.done { background:#15803d; color:#fff; }
        .pw-dot.current { background:var(--primary-purple); color:#fff; }
        .pw-line { flex-grow:1; height:2px; background:var(--secondary-purple); margin:0 8px; }
        .pw-summary { background:var(--secondary-purple); border-radius:8px; padding:14px 16px; margin-bottom:18px; }
        .pw-row { display:flex; justify-content:space-between; font-size:13px; padding:3px 0; }
        .pw-row span { color:#374151; }
        .pw-row strong { color:var(--primary-purple); }
        .pw-modal label { display:block; font-size:14px; font-weight:600; color:var(--primary-purple); margin-bottom:6px; }
        .pw-modal input[type="password"] { width:100%; padding:11px 14px; border:1.5px solid rgba(92,45,145,.3); border-radius:6px; font-size:15px; outline:none; box-sizing:border-box; }
        .pw-error { color:var(--danger); font-size:13px; margin-top:6px; }
        .pw-btn-primary { width:100%; margin-top:18px; padding:13px; background:var(--primary-purple); color:#fff; border:none; border-radius:6px; font-size:14px; font-weight:700; cursor:pointer; }
        .pw-btn-primary:disabled { opacity:0.6; cursor:not-allowed; }
        .pw-btn-secondary { width:100%; margin-top:10px; padding:13px; background:transparent; color:var(--primary-purple); border:2px solid var(--primary-purple); border-radius:6px; font-size:14px; font-weight:700; cursor:pointer; }
        .pw-note { font-size:11px; color:#6b7280; margin-top:12px; line-height:1.5; }
        .pw-success-icon { width:80px; height:80px; border-radius:50%; background:var(--primary-purple); color:#fff; display:flex; align-items:center; justify-content:center; margin:0 auto 20px; font-size:40px; }
        .receipt-actions { display:flex; gap:10px; margin-top:10px; }
        .receipt-actions button { flex:1; }
        .receipt-print { display:none; }
        @media print { body * { visibility:hidden; } .receipt-print, .receipt-print * { visibility:visible; } .receipt-print { display:block !important; position:absolute; top:0; left:0; width:100%; padding:30px; } }
        .receipt-print .r-header { text-align:center; margin-bottom:20px; }
        .receipt-print .r-header h2 { color:#5c2d91; margin:0; }
        .receipt-print .r-row { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #eee; font-size:14px; }
        .msg-read-aloud { display:inline-flex; background:none; border:none; cursor:pointer; font-size:13px; margin-left:8px; opacity:0.6; vertical-align:middle; }
        .msg-read-aloud:hover { opacity:1; }

        /* ══════════ ACCESSIBILITY (Module F) — mirrors Dashboard.jsx ══════════ */
        html[data-contrast="high"] {
          --primary-purple: #3d1a66;
          --secondary-purple: #e8e8e8;
          --text-dark: #000000;
          --card: #ffffff;
        }
        html[data-contrast="high"] .message.ai,
        html[data-contrast="high"] .chat-container,
        html[data-contrast="high"] .sidebar-card { border:1.5px solid #000; }

        html[data-font-size="large"] .message { font-size:18px; }
        html[data-font-size="large"] .input-area input { font-size:18px; }
        html[data-font-size="large"] .sidebar-card-title { font-size:16px; }
        html[data-font-size="large"] .sidebar-card-desc { font-size:13px; }

        html[data-font-size="small"] .message { font-size:13px; }
        html[data-font-size="small"] .input-area input { font-size:14px; }

        @media(max-width:900px) { .topbar{padding:15px 20px;} .main-layout{flex-direction:column;height:auto;padding:10px;margin:0;gap:10px;} .sidebar-right{width:100%;flex-direction:row;} .sidebar-card{flex:1;} .chat-container{height:60vh;border-radius:8px;} .message{max-width:90%;} .brand{position:static;transform:none;} }
      `}</style>

      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css" />

      <div ref={printRef} className="receipt-print" />

      {/* TOPBAR */}
      <header className="topbar">
        <button className="back-btn" onClick={() => navigate('/dashboard')}>
          <i className="fas fa-arrow-left" /> Back to Dashboard
        </button>
        <div className="brand">
          <span className="logo-circle">AI</span>
          <h1>FinBud Chat</h1>
        </div>
        <div style={{ width: 40 }} />
      </header>

      {/* MAIN LAYOUT */}
      <div className="main-layout">
        <main className="chat-container">
          <div className="messages-area">
            {messages.length === 0 && (
              <div className="welcome-block">
                <p className="large-text">Hello, I'm FinBud.</p>
                <p className="small-text">Your personal AI financial assistant, ready to help you manage your money.</p>
              </div>
            )}
            {messages.map(m => (
              <div key={m.id} className={`message ${m.type}`}>
                {m.text}
                {m.type === 'ai' && (
                  <button type="button" className="msg-read-aloud" aria-label="Read this message aloud" onClick={() => speak(m.text)}>🔊</button>
                )}
              </div>
            ))}
            {isLoading && <div className="message loading"><i className="fas fa-spinner fa-spin" /> Thinking...</div>}
            <div ref={messagesEndRef} />
          </div>

          <div className="input-area">
            <input
              type="text"
              placeholder="Ask FinBud AI a question..."
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !isLoading && sendMessage()}
              disabled={isLoading}
              aria-label="Type your message to FinBud AI"
            />
            <button className={`mic-btn ${isRecording ? 'recording' : ''}`} onClick={toggleRecording}
              title="Voice Input" aria-label={isRecording ? 'Stop recording' : 'Start voice input'}>
              <i className={`fas fa-${isRecording ? 'stop' : 'microphone'}`} />
            </button>
            <button className="send-btn" onClick={() => sendMessage()} disabled={isLoading} aria-label="Send message">Send</button>
          </div>
        </main>

        {/* SIDEBAR */}
        <aside className="sidebar-right">
          <div className="sidebar-card human" role="button" tabIndex={0} aria-label="Connect with a human banker" onClick={handleHumanHandoff}>
            <div style={{ fontSize: 24 }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
                <path d="M16 11h4m0 0l-2-2m2 2l-2 2" />
              </svg>
            </div>
            <div className="sidebar-card-title">Human Support</div>
            <div className="sidebar-card-desc">Connect with banker</div>
          </div>

          <div className={`sidebar-card emergency-card ${!hasCard ? 'no-card' : ''}`} role="button" tabIndex={0}
            aria-label={hasCard ? 'Emergency: lock all cards now' : 'Emergency lock unavailable, no card registered'} onClick={handleEmergency}>
            <div style={{ fontSize: 24 }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </div>
            <div className="sidebar-card-title">Emergency</div>
            <div className="sidebar-card-desc">{hasCard ? 'Lock all cards now' : 'No card registered'}</div>
          </div>
        </aside>
      </div>

      {/* MODAL */}
      {modal && modal !== 'processing' && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div onClick={e => e.stopPropagation()}>
            {(modal === 'password' || modal === 'passwordError') && <PasswordModal />}
            {modal === 'transferSuccess' && <SuccessModal type="transfer" />}
            {modal === 'billSuccess'     && <SuccessModal type="bill"     />}
          </div>
        </div>
      )}
      {modal === 'processing' && (
        <div className="modal-overlay">
          <div className="pw-modal" style={{ textAlign:'center', padding:30 }}>
            <i className="fas fa-spinner fa-spin" style={{ fontSize:30, color:'var(--primary-purple)' }} />
            <p style={{ marginTop:15 }}>Processing...</p>
          </div>
        </div>
      )}
    </>
  )
}