import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useChatController } from './useChatController'

// ── ChatMobile ──────────────────────────────────────────────────────
// Mobile-first layout for the same FinBud chat experience as Chat.jsx.
// Same hook, same API calls, same confirm-with-password flow — only the
// markup/CSS differ so it doesn't feel cramped on a phone.
//
// Human Support / Emergency are NOT shown as always-visible cards here.
// They only live behind the "+" button next to the text box, and tapping
// either one shows an inline "this is what will happen — send?" step
// before anything is actually triggered.
export default function ChatMobile() {
  const navigate = useNavigate()
    const {
    messagesEndRef, printRef,
    messages, inputText, setInputText, isLoading,
    voiceState, isVoiceModeActive,
    hasCard, modal, setModal, pendingInfo,
    sessionId, isReadOnly, sessions,
    speak, toggleVoiceMode, openAdvisor,
    sendMessage, handleHumanHandoff, handleEmergency,
    submitPassword, downloadReceipt, emailReceipt,
    startNewChat, loadSessions, openSession,
  } = useChatController()

  // "+" action sheet: null (closed) -> 'menu' (pick an action) -> 'confirm-human' | 'confirm-emergency'
  const [actionSheet, setActionSheet] = useState(null)
  const sheetRef = useRef(null)
  const plusBtnRef = useRef(null)
  const [showHistory, setShowHistory] = useState(false)

  useEffect(() => {
    if (!actionSheet) return
    function onOutside(e) {
      if (sheetRef.current?.contains(e.target)) return
      if (plusBtnRef.current?.contains(e.target)) return
      setActionSheet(null)
    }
    document.addEventListener('mousedown', onOutside)
    document.addEventListener('touchstart', onOutside)
    return () => {
      document.removeEventListener('mousedown', onOutside)
      document.removeEventListener('touchstart', onOutside)
    }
  }, [actionSheet])

  function togglePlus() {
    setActionSheet(prev => (prev ? null : 'menu'))
  }

  function confirmAndSend() {
    if (actionSheet === 'confirm-human') handleHumanHandoff()
    if (actionSheet === 'confirm-emergency') handleEmergency()
    setActionSheet(null)
  }

  // ── PASSWORD BOTTOM SHEET ────────────────────────────────
  function PasswordSheet() {
    const [pw, setPw] = useState('')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)
    const isEmergency = pendingInfo?.type === 'emergency'

    async function handleSubmit(e) {
      e.preventDefault()
      if (!pw) { setError('Please enter your password.'); return }
      setError(''); setLoading(true)
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
      <div className={`m-sheet ${isEmergency ? 'emergency' : ''}`}>
        <div className="m-sheet-handle" />
        <button className="m-sheet-close" aria-label="Close dialog" onClick={() => setModal(null)}>×</button>
        <h3>{pendingInfo?.title}</h3>
        <div className="m-summary">
          {pendingInfo?.summaryRows?.map(r => (
            <div key={r.label} className="m-row"><span>{r.label}</span><strong>{r.value}</strong></div>
          ))}
        </div>
        <form onSubmit={handleSubmit}>
          <label>Enter your password to confirm</label>
          <input type="password" autoFocus placeholder="Password" value={pw}
            onChange={e => setPw(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit(e)} />
          {error && <p className="m-error">{error}</p>}
          <button type="submit" className="m-btn-primary" disabled={loading}>
            {loading ? 'Verifying...' : pendingInfo?.confirmLabel}
          </button>
          <button type="button" className="m-btn-secondary" onClick={() => setModal(null)}>BACK</button>
          <p className="m-note">Note: this confirms with your account password.</p>
        </form>
      </div>
    )
  }

  function SuccessSheet({ type }) {
    const txData = pendingInfo?.txData
    const txId   = txData?.transaction_id || txData?.id
    const isTransfer = type === 'transfer'
    return (
      <div className="m-sheet">
        <div className="m-sheet-handle" />
        <button className="m-sheet-close" aria-label="Close dialog" onClick={() => setModal(null)}>×</button>
        <div style={{ textAlign:'center', padding:'4px 0 0' }}>
          <div className="m-success-icon">✓</div>
          <h3 style={{ color:'#15803d', marginBottom:12 }}>{isTransfer ? 'Transfer Successful!' : 'Transaction Successful!'}</h3>
          {isTransfer
            ? <>
                <p style={{ fontSize:15, marginBottom:5 }}>
                  PKR {(pendingInfo?.entities?.amount||0).toLocaleString('en-PK')} sent to {pendingInfo?.entities?.recipient || pendingInfo?.entities?.recipient_name || 'recipient'}
                </p>
                <p style={{ fontSize:13, color:'#666', marginBottom:8 }}>Purpose: {pendingInfo?.entities?.purpose || 'Personal'}</p>
              </>
            : <p style={{ fontSize:15, marginBottom:8 }}>
                Your {pendingInfo?.entities?.bill_type || pendingInfo?.entities?.biller || 'bill'} bill has been paid successfully!
              </p>
          }
          <p style={{ fontSize:13, color:'var(--primary-purple)' }}>You earned {txData?.points_earned || 0} reward points!</p>
          <div className="m-receipt-actions">
            <button className="m-btn-primary" style={{ marginTop:0 }} onClick={() => downloadReceipt(txId)}>DOWNLOAD PDF</button>
            <button className="m-btn-primary" style={{ marginTop:0 }} onClick={() => emailReceipt(txId)}>EMAIL RECEIPT</button>
          </div>
          <button className="m-btn-secondary" onClick={() => setModal(null)}>DONE</button>
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
        html, body { margin:0; padding:0; width:100%; height:100%; overflow:hidden; color-scheme:light; }
        #root { width:100%; height:100%; display:flex; flex-direction:column; }
        * { box-sizing: border-box; font-family: Inter, ui-sans-serif, system-ui; -webkit-tap-highlight-color: transparent; }
        body { background: var(--secondary-purple); color: var(--text-dark); }

        .m-app { display:flex; flex-direction:column; height:100dvh; width:100%; background:var(--secondary-purple); position:relative; overflow:hidden; }

        /* TOPBAR */
        .m-topbar { display:flex; align-items:center; gap:10px; padding:calc(env(safe-area-inset-top,0px) + 10px) 12px 10px; background:var(--card); border-bottom:1px solid rgba(0,0,0,0.06); flex-shrink:0; z-index:10; }
        .m-back-btn { width:36px; height:36px; border-radius:50%; border:none; background:var(--secondary-purple); color:var(--primary-purple); font-size:15px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
        .m-brand { display:flex; align-items:center; gap:8px; flex-grow:1; }
        .m-logo-circle { width:30px; height:30px; border-radius:50%; background:var(--primary-purple); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:12px; flex-shrink:0; }
        .m-brand h1 { font-size:16px; font-weight:700; color:var(--primary-purple); margin:0; }

        /* MESSAGES */
        .m-messages { flex-grow:1; overflow-y:auto; -webkit-overflow-scrolling:touch; padding:14px 12px; display:flex; flex-direction:column; gap:10px; }
        .m-welcome { text-align:center; margin:auto; padding:30px 16px; }
        .m-welcome .large-text { font-size:1.7rem; font-weight:800; color:var(--primary-purple); margin:0; line-height:1.15; }
        .m-welcome .small-text { font-size:0.9rem; color:#6b7280; margin-top:8px; font-weight:500; }
        .message { max-width:82%; padding:10px 14px; border-radius:16px; line-height:1.45; font-size:14.5px; white-space:pre-wrap; word-wrap:break-word; }
        .message.user { align-self:flex-end; background:var(--primary-purple); color:#fff; border-bottom-right-radius:4px; }
        .message.ai { align-self:flex-start; background:var(--card); color:var(--text-dark); border:1px solid rgba(0,0,0,0.06); border-bottom-left-radius:4px; }
        .message.loading { align-self:flex-start; background:var(--card); color:#6b7280; border:1px solid rgba(0,0,0,0.06); border-bottom-left-radius:4px; font-style:italic; font-size:13.5px; }
        .msg-read-aloud { display:inline-flex; background:none; border:none; cursor:pointer; font-size:12px; margin-left:6px; opacity:0.6; vertical-align:middle; padding:2px; }
        .advisor-cta-wrap { margin-top:7px; }
        .advisor-cta-btn { background:var(--primary-purple); color:#fff; border:none; border-radius:8px; padding:9px 14px; font-size:13px; font-weight:600; cursor:pointer; }
        .advisor-cta-btn:active { opacity:0.85; }

        /* INPUT BAR */
        .m-input-bar-wrap { position:relative; flex-shrink:0; background:var(--card); border-top:1px solid rgba(0,0,0,0.06); padding:8px 8px calc(env(safe-area-inset-bottom,0px) + 8px); }
        .m-input-area { display:flex; align-items:center; gap:6px; }
        .m-plus-btn { width:38px; height:38px; border-radius:50%; border:none; background:var(--secondary-purple); color:var(--primary-purple); font-size:20px; flex-shrink:0; display:flex; align-items:center; justify-content:center; line-height:1; transition:transform .15s ease, background .15s ease; }
        .m-plus-btn.open { background:var(--primary-purple); color:#fff; transform:rotate(45deg); }
        .m-input-area input { flex-grow:1; min-width:0; padding:10px 14px; border:1px solid rgba(92,45,145,0.25); border-radius:20px; font-size:15px; background:#f2f2f2 !important; color:#111111 !important; -webkit-text-fill-color:#111111 !important; color-scheme:light; caret-color:var(--primary-purple); }
        .m-input-area input::placeholder { color:#8a8a8a !important; -webkit-text-fill-color:#8a8a8a !important; opacity:1; }
        .m-input-area input:disabled { opacity:0.7; }
        .m-icon-btn { width:38px; height:38px; border-radius:50%; border:none; flex-shrink:0; display:flex; align-items:center; justify-content:center; font-size:16px; }
        .m-mic-btn { background:var(--secondary-purple); color:var(--primary-purple); border:1px solid rgba(92,45,145,0.25); }
        .m-mic-btn.idle { background:var(--primary-purple); color:#fff; border-color:var(--primary-purple); }
        .m-mic-btn.listening { background:var(--danger); color:#fff; border-color:var(--danger); animation:pulse 1.5s infinite; }
        .m-mic-btn.processing { background:var(--primary-purple); color:#fff; border-color:var(--primary-purple); }
        .m-mic-btn.speaking { background:#15803d; color:#fff; border-color:#15803d; animation:speakGlow 1.2s infinite; }
        .m-send-btn { background:var(--primary-purple); color:#fff; }
        .m-send-btn:disabled { opacity:0.5; }
        @keyframes pulse { 0%{box-shadow:0 0 0 0 rgba(185,28,28,0.6)} 70%{box-shadow:0 0 0 9px rgba(185,28,28,0)} 100%{box-shadow:0 0 0 0 rgba(185,28,28,0)} }
        @keyframes speakGlow { 0%{box-shadow:0 0 0 0 rgba(21,128,61,0.5)} 70%{box-shadow:0 0 0 7px rgba(21,128,61,0)} 100%{box-shadow:0 0 0 0 rgba(21,128,61,0)} }

        /* "+" ACTION SHEET — opens upward, anchored above the input bar */
        .m-action-sheet { position:absolute; left:8px; bottom:100%; margin-bottom:6px; width:min(84vw,300px); background:var(--card); border-radius:14px; box-shadow:0 -6px 24px rgba(0,0,0,0.18); overflow:hidden; animation:sheetUp .18s ease; z-index:30; border:1px solid rgba(0,0,0,0.06); }
        @keyframes sheetUp { from{ transform:translateY(8px); opacity:0 } to{ transform:translateY(0); opacity:1 } }
        .m-action-item { display:flex; align-items:center; gap:12px; padding:13px 14px; cursor:pointer; border:none; background:none; width:100%; text-align:left; }
        .m-action-item + .m-action-item { border-top:1px solid rgba(0,0,0,0.06); }
        .m-action-icon { width:34px; height:34px; border-radius:50%; display:flex; align-items:center; justify-content:center; flex-shrink:0; color:#fff; }
        .m-action-icon.human { background:linear-gradient(135deg,var(--primary-purple) 0%,#7c3fb3 100%); }
        .m-action-icon.emergency { background:linear-gradient(135deg,#dc2626 0%,#b91c1c 100%); }
        .m-action-title { font-size:14px; font-weight:700; color:var(--text-dark); margin:0; }
        .m-action-desc { font-size:11.5px; color:#6b7280; margin:1px 0 0; }
        .m-action-item.disabled { opacity:0.5; }
        .m-action-item.disabled .m-action-icon { filter:grayscale(1); }

        .m-confirm-box { padding:16px; }
        .m-confirm-box p { font-size:13.5px; line-height:1.5; color:var(--text-dark); margin:0 0 14px; }
        .m-confirm-box .title { font-size:13px; font-weight:700; color:var(--primary-purple); margin:0 0 8px; text-transform:uppercase; letter-spacing:.02em; }
        .m-confirm-actions { display:flex; gap:8px; }
        .m-confirm-actions button { flex:1; padding:10px; border-radius:8px; font-size:13.5px; font-weight:700; border:none; cursor:pointer; }
        .m-confirm-cancel { background:var(--secondary-purple); color:var(--primary-purple); }
        .m-confirm-send { background:var(--primary-purple); color:#fff; }
        .m-confirm-send.emergency { background:var(--danger); }

        /* BOTTOM SHEET MODALS (password / success) */
        .m-modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.55); z-index:200; display:flex; align-items:flex-end; }
        .m-sheet { background:var(--card); border-radius:20px 20px 0 0; padding:18px 18px calc(env(safe-area-inset-bottom,0px) + 18px); width:100%; position:relative; max-height:85vh; overflow-y:auto; animation:sheetIn .22s ease; box-shadow:0 -8px 30px rgba(0,0,0,0.2); }
        @keyframes sheetIn { from{ transform:translateY(100%) } to{ transform:translateY(0) } }
        .m-sheet-handle { width:38px; height:4px; border-radius:2px; background:rgba(0,0,0,0.15); margin:0 auto 12px; }
        .m-sheet-close { position:absolute; top:12px; right:14px; background:none; border:none; font-size:22px; cursor:pointer; color:var(--primary-purple); }
        .m-sheet h3 { margin:0 0 12px; font-size:19px; color:var(--primary-purple); padding-right:24px; }
        .m-sheet.emergency h3 { color:var(--danger); }
        .m-sheet.emergency label { color:var(--danger); }
        .m-sheet.emergency .m-btn-primary { background:var(--danger); }
        .m-summary { background:var(--secondary-purple); border-radius:8px; padding:12px 14px; margin-bottom:16px; }
        .m-row { display:flex; justify-content:space-between; font-size:13px; padding:3px 0; gap:8px; }
        .m-row span { color:#374151; }
        .m-row strong { color:var(--primary-purple); text-align:right; }
        .m-sheet label { display:block; font-size:13.5px; font-weight:600; color:var(--primary-purple); margin-bottom:6px; }
        .m-sheet input[type="password"] { width:100%; padding:12px 14px; border:1.5px solid rgba(92,45,145,.3); border-radius:8px; font-size:16px; outline:none; color:#111111 !important; -webkit-text-fill-color:#111111 !important; background:#ffffff !important; color-scheme:light; caret-color:var(--primary-purple); }
        .m-error { color:var(--danger); font-size:12.5px; margin-top:6px; }
        .m-btn-primary { width:100%; margin-top:16px; padding:13px; background:var(--primary-purple); color:#fff; border:none; border-radius:8px; font-size:14px; font-weight:700; cursor:pointer; }
        .m-btn-primary:disabled { opacity:0.6; }
        .m-btn-secondary { width:100%; margin-top:10px; padding:13px; background:transparent; color:var(--primary-purple); border:2px solid var(--primary-purple); border-radius:8px; font-size:14px; font-weight:700; cursor:pointer; }
        .m-note { font-size:11px; color:#6b7280; margin-top:12px; line-height:1.5; }
        .m-success-icon { width:64px; height:64px; border-radius:50%; background:var(--primary-purple); color:#fff; display:flex; align-items:center; justify-content:center; margin:0 auto 16px; font-size:32px; }
        .m-receipt-actions { display:flex; gap:8px; margin-top:8px; }
        .m-receipt-actions button { flex:1; font-size:12.5px; padding:11px 6px; }
        .receipt-print { display:none; }
        @media print { body * { visibility:hidden; } .receipt-print, .receipt-print * { visibility:visible; } .receipt-print { display:block !important; position:absolute; top:0; left:0; width:100%; padding:30px; } }
        .receipt-print .r-header { text-align:center; margin-bottom:20px; }
        .receipt-print .r-header h2 { color:#5c2d91; margin:0; }
        .receipt-print .r-row { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #eee; font-size:14px; }

        /* ══════════ ACCESSIBILITY (Module F) — mirrors Dashboard.jsx ══════════ */
        html[data-contrast="high"] {
          --primary-purple: #3d1a66;
          --secondary-purple: #e8e8e8;
          --text-dark: #000000;
          --card: #ffffff;
        }
        html[data-contrast="high"] .message.ai,
        html[data-contrast="high"] .m-topbar,
        html[data-contrast="high"] .m-input-bar-wrap { border-color:#000; }

        html[data-font-size="large"] .message { font-size:16.5px; }
        html[data-font-size="large"] .m-input-area input { font-size:16.5px; }

        html[data-font-size="small"] .message { font-size:13px; }
        html[data-font-size="small"] .m-input-area input { font-size:14px; }
        .topbar-actions { display:flex; align-items:center; gap:6px; }
        .topbar-icon-btn { background:none; border:none; color:var(--primary-purple); font-size:16px; cursor:pointer; padding:8px; border-radius:6px; }
        .chat-closed-badge { background:#6b7280; color:#fff; font-size:10px; font-weight:700; padding:3px 8px; border-radius:10px; letter-spacing:.5px; text-transform:uppercase; }
        .history-panel { position:absolute; top:56px; right:10px; left:10px; max-height:50vh; overflow-y:auto; background:var(--card); border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,0.15); z-index:20; padding:8px; }
        .history-item { display:flex; justify-content:space-between; align-items:center; width:100%; text-align:left; background:none; border:none; padding:10px 8px; border-radius:6px; cursor:pointer; }
        .history-item:hover, .history-item.current { background:var(--secondary-purple); }
        .history-empty { padding:16px; text-align:center; color:#6b7280; font-size:13px; }
        .history-preview { font-size:13px; color:var(--text-dark); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:70%; }
        .history-status { font-size:11px; font-weight:700; }
        .history-status.active { color:#15803d; }
        .history-status.closed { color:#6b7280; }
      `}</style>

      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css" />

      <div className="m-app">
        <div ref={printRef} className="receipt-print" />

        {/* TOPBAR */}
        <header className="m-topbar">
          <button className="m-back-btn" aria-label="Back to Dashboard" onClick={() => navigate('/dashboard')}>
            <i className="fas fa-arrow-left" />
          </button>
          <div className="m-brand">
            <span className="m-logo-circle">AI</span>
            <h1>FinBud Chat</h1>
          </div>
          <div className="topbar-actions">
            {isReadOnly && <span className="chat-closed-badge">Closed</span>}
            <button className="topbar-icon-btn" aria-label="Chat history"
              onClick={() => { setShowHistory(s => !s); loadSessions() }}>
              <i className="fas fa-clock-rotate-left" />
            </button>
            <button className="topbar-icon-btn" aria-label="New chat" onClick={startNewChat}>
              <i className="fas fa-plus" />
            </button>
          </div>
        </header>

        {showHistory && (
          <div className="history-panel">
            {sessions.length === 0 && <p className="history-empty">No past conversations yet.</p>}
            {sessions.map(s => (
              <button key={s.id} className={`history-item ${s.id === sessionId ? 'current' : ''}`}
                onClick={() => { openSession(s.id); setShowHistory(false) }}>
                <span className="history-preview">{s.preview || '(empty conversation)'}</span>
                <span className={`history-status ${s.status}`}>{s.status === 'active' ? 'Active' : 'Closed'}</span>
              </button>
            ))}
          </div>
        )}

        {/* MESSAGES */}
        <div className="m-messages">
          {messages.length === 0 && (
            <div className="m-welcome">
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
              {m.type === 'ai' && m.advisorCta && (
                <div className="advisor-cta-wrap">
                  <button type="button" className="advisor-cta-btn" onClick={openAdvisor}>
                    💬 Talk to Fin, your Advisor
                  </button>
                </div>
              )}
            </div>
          ))}
          {isLoading && <div className="message loading"><i className="fas fa-spinner fa-spin" /> Thinking...</div>}
          <div ref={messagesEndRef} />
        </div>

        {/* INPUT BAR */}
        <div className="m-input-bar-wrap">
          {actionSheet && (
            <div className="m-action-sheet" ref={sheetRef}>
              {actionSheet === 'menu' && (
                <>
                  <button type="button" className="m-action-item" onClick={() => setActionSheet('confirm-human')}>
                    <span className="m-action-icon human">
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
                      </svg>
                    </span>
                    <span>
                      <p className="m-action-title">Human Support</p>
                      <p className="m-action-desc">Connect with banker</p>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`m-action-item ${!hasCard ? 'disabled' : ''}`}
                    onClick={() => hasCard && setActionSheet('confirm-emergency')}
                    disabled={!hasCard}
                  >
                    <span className="m-action-icon emergency">
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                        <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                      </svg>
                    </span>
                    <span>
                      <p className="m-action-title">Emergency</p>
                      <p className="m-action-desc">{hasCard ? 'Lock all cards now' : 'No card registered'}</p>
                    </span>
                  </button>
                </>
              )}

              {actionSheet === 'confirm-human' && (
                <div className="m-confirm-box">
                  <p className="title">Human Support</p>
                  <p>I'll connect you with a human banker for support. Send this request?</p>
                  <div className="m-confirm-actions">
                    <button className="m-confirm-cancel" onClick={() => setActionSheet('menu')}>Cancel</button>
                    <button className="m-confirm-send" onClick={confirmAndSend}>Send</button>
                  </div>
                </div>
              )}

              {actionSheet === 'confirm-emergency' && (
                <div className="m-confirm-box">
                  <p className="title">Emergency</p>
                  <p>This will immediately lock all your registered cards. Send this request?</p>
                  <div className="m-confirm-actions">
                    <button className="m-confirm-cancel" onClick={() => setActionSheet('menu')}>Cancel</button>
                    <button className="m-confirm-send emergency" onClick={confirmAndSend}>Send</button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="m-input-area">
            <button
              ref={plusBtnRef}
              type="button"
              className={`m-plus-btn ${actionSheet ? 'open' : ''}`}
              onClick={togglePlus}
              disabled={isReadOnly}
              aria-label={actionSheet ? 'Close quick actions' : 'Open quick actions'}
              aria-expanded={!!actionSheet}
            >
              +
            </button>
                        <input
              type="text"
              placeholder={isReadOnly ? 'This conversation is closed' : 'Ask FinBud AI a question...'}
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              onFocus={() => setActionSheet(null)}
              onKeyDown={e => e.key === 'Enter' && !isLoading && !isReadOnly && sendMessage()}
              disabled={isLoading || isReadOnly}
              aria-label="Type your message to FinBud AI"
            />
            <button
              className={`m-icon-btn m-mic-btn ${isVoiceModeActive ? voiceState : ''}`}
              onClick={toggleVoiceMode}
              disabled={isReadOnly}
              aria-label={isVoiceModeActive ? 'Stop hands-free voice chat' : 'Start hands-free voice chat'}
            >
              {voiceState === 'processing' && isVoiceModeActive && <i className="fas fa-spinner fa-spin" />}
              {voiceState === 'speaking' && isVoiceModeActive && <i className="fas fa-volume-high" />}
              {(!isVoiceModeActive || voiceState === 'idle' || voiceState === 'listening') && (
                <i className="fas fa-microphone" />
              )}
            </button>
            <button
              className="m-icon-btn m-send-btn"
              onClick={() => sendMessage()}
              disabled={isLoading || isReadOnly}
              aria-label="Send message"
            >
              <i className="fas fa-paper-plane" />
            </button>
          </div>
        </div>
      </div>

      {/* MODAL */}
      {modal && modal !== 'processing' && (
        <div className="m-modal-overlay" onClick={() => setModal(null)}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%' }}>
            {(modal === 'password' || modal === 'passwordError') && <PasswordSheet />}
            {modal === 'transferSuccess' && <SuccessSheet type="transfer" />}
            {modal === 'billSuccess'     && <SuccessSheet type="bill"     />}
          </div>
        </div>
      )}
      {modal === 'processing' && (
        <div className="m-modal-overlay">
          <div className="m-sheet" style={{ textAlign:'center', padding:'26px 18px' }}>
            <i className="fas fa-spinner fa-spin" style={{ fontSize:28, color:'var(--primary-purple)' }} />
            <p style={{ marginTop:14 }}>Processing...</p>
          </div>
        </div>
      )}
    </>
  )
}
