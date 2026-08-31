import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useChatController } from './useChatController'

export default function Chat() {
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

  const [showHistory, setShowHistory] = useState(false)

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
        /* Hands-free voice states: idle (mic on, not yet active) / listening (pulsing red) / processing (spinner) / speaking (waveform) */
        .mic-btn.idle { background:var(--primary-purple) !important; color:#fff !important; border-color:var(--primary-purple) !important; }
        .mic-btn.listening { background:var(--danger) !important; color:#fff !important; border-color:var(--danger) !important; animation:pulse 1.5s infinite; }
        .mic-btn.processing { background:var(--primary-purple) !important; color:#fff !important; border-color:var(--primary-purple) !important; }
        .mic-btn.speaking { background:#15803d !important; color:#fff !important; border-color:#15803d !important; animation:speakGlow 1.2s infinite; }
        .send-btn { padding:12px 20px !important; }
        @keyframes pulse { 0%{box-shadow:0 0 0 0 rgba(185,28,28,0.6)} 70%{box-shadow:0 0 0 10px rgba(185,28,28,0)} 100%{box-shadow:0 0 0 0 rgba(185,28,28,0)} }
        @keyframes speakGlow { 0%{box-shadow:0 0 0 0 rgba(21,128,61,0.5)} 70%{box-shadow:0 0 0 8px rgba(21,128,61,0)} 100%{box-shadow:0 0 0 0 rgba(21,128,61,0)} }
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
        .advisor-cta-wrap { margin-top:8px; }
        .advisor-cta-btn { background:var(--primary-purple); color:#fff; border:none; border-radius:8px; padding:8px 14px; font-size:13px; font-weight:600; cursor:pointer; }
        .advisor-cta-btn:hover { opacity:0.9; }

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
        .topbar-actions { display:flex; align-items:center; gap:8px; }
        .topbar-icon-btn { display:flex; align-items:center; gap:6px; background:none; border:1px solid rgba(92,45,145,0.25); color:var(--primary-purple); font-size:13px; font-weight:600; cursor:pointer; padding:7px 12px; border-radius:8px; white-space:nowrap; }
        .topbar-icon-btn:hover { background:rgba(92,45,145,0.08); }
        .topbar-icon-btn i { font-size:13px; }
        .topbar-icon-btn:hover { background:rgba(92,45,145,0.08); }
        .chat-closed-badge { background:#6b7280; color:#fff; font-size:11px; font-weight:700; padding:4px 10px; border-radius:12px; letter-spacing:.5px; text-transform:uppercase; }
        .history-panel { position:absolute; top:60px; right:20px; width:300px; max-height:400px; overflow-y:auto; background:var(--card); border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,0.15); z-index:20; padding:8px; }
        .history-item { display:flex; justify-content:space-between; align-items:center; width:100%; text-align:left; background:none; border:none; padding:10px 8px; border-radius:6px; cursor:pointer; }
        .history-item:hover, .history-item.current { background:var(--secondary-purple); }
        .history-empty { padding:16px; text-align:center; color:#6b7280; font-size:13px; }
        .history-preview { font-size:13px; color:var(--text-dark); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:200px; }
        .history-status { font-size:11px; font-weight:700; margin-left:8px; }
        .history-status.active { color:#15803d; }
        .history-status.closed { color:#6b7280; }
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
        <div className="topbar-actions">
          {isReadOnly && <span className="chat-closed-badge">Closed</span>}
          <button className="topbar-icon-btn" onClick={() => { setShowHistory(s => !s); loadSessions() }}>
           <i className="fas fa-clock-rotate-left" /> <span>History</span>
          </button>
          <button className="topbar-icon-btn" onClick={startNewChat}>
           <i className="fas fa-plus" /> <span>New Chat</span>
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

          <div className="input-area">
            <input
              type="text"
              placeholder={isReadOnly ? 'This conversation is closed' : 'Ask FinBud AI a question...'}
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !isLoading && !isReadOnly && sendMessage()}
              disabled={isLoading || isReadOnly}
              aria-label="Type your message to FinBud AI"
            />
            <button
              className={`mic-btn ${isVoiceModeActive ? voiceState : ''}`}
              onClick={toggleVoiceMode}
              disabled={isReadOnly}
              title={isVoiceModeActive ? 'Stop hands-free voice chat' : 'Start hands-free voice chat'}
              aria-label={isVoiceModeActive ? 'Stop hands-free voice chat' : 'Start hands-free voice chat'}
            >
              {voiceState === 'processing' && <i className="fas fa-spinner fa-spin" />}
              {voiceState === 'speaking' && <i className="fas fa-volume-high" />}
              {(voiceState === 'idle' || voiceState === 'listening') && (
                <i className={`fas fa-microphone${isVoiceModeActive ? '' : ''}`} />
              )}
            </button>
            <button className="send-btn" onClick={() => sendMessage()} disabled={isLoading || isReadOnly} aria-label="Send message">Send</button>
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
