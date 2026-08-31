import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { FinBudVoiceManager, VOICE_STATES, isVoiceSupported } from '../utils/voiceManager'

// ── useChatController ──────────────────────────────────────────────
// All business logic for the FinBud chat experience lives here: message
// state, the API calls, the hands-free voice manager, and the
// confirm-with-password flow for transfers / bill pay / emergency lock.
//
// Both the web layout (Chat.jsx) and the mobile layout (ChatMobile.jsx)
// call this same hook, so the underlying flow (what happens when you send
// a message, hand off to a human, trigger the emergency lock, or confirm
// with your password) is identical on both surfaces — only the JSX/CSS
// around it differs.
export function useChatController() {
  const navigate = useNavigate()
  const messagesEndRef = useRef(null)
  const printRef = useRef(null)
  const voiceManagerRef = useRef(null)
  // Always holds the LATEST sendMessage function for this render. The
  // FinBudVoiceManager instance itself is created once in a mount-only
  // effect (see below) - without this ref, its onTranscript callback
  // would stay permanently bound to the very first render's sendMessage
  // (and therefore that render's handleResponse, and therefore that
  // render's captured isVoiceModeActive/hasCard/etc. values), which is
  // exactly the stale-closure bug that made hands-free replies never get
  // spoken and left the mic button stuck spinning: toggling voice mode
  // on updated the isVoiceModeActive STATE, but the mic-driven message
  // path was still executing against the stale FALSE captured at mount.
  const sendMessageRef = useRef(() => {})

  const [messages, setMessages] = useState([])
  const [inputText, setInputText] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  // Hands-free voice mode: 'idle' | 'listening' | 'processing' | 'speaking'
  const [voiceState, setVoiceState] = useState(VOICE_STATES.IDLE)
  const [isVoiceModeActive, setIsVoiceModeActive] = useState(false)
  const [hasCard, setHasCard] = useState(true)
  const [modal, setModal] = useState(null)
  const [pendingInfo, setPendingInfo] = useState(null)
  const [lastBillType, setLastBillType] = useState(null)
  const [sessionId, setSessionId] = useState(null)
  const [isReadOnly, setIsReadOnly] = useState(false)
  const [sessions, setSessions] = useState([])

  useEffect(() => {
    checkCard()
     loadActiveSession()
    // Module F: Dashboard.jsx sets these on <html> and they persist across
    // client-side navigation, but if a user lands directly on /chat (e.g. a
    // deep link or a fresh tab), apply the saved preference here too.
    document.documentElement.setAttribute('data-font-size', localStorage.getItem('finbud_font_size') || 'default')
    document.documentElement.setAttribute('data-contrast', localStorage.getItem('finbud_high_contrast') === 'true' ? 'high' : 'default')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function speak(text) {
    if (typeof window === 'undefined' || !window.speechSynthesis) return
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'en-US'
    window.speechSynthesis.speak(utterance)
  }

  // ── Hands-free voice mode ─────────────────────────────────
  // One FinBudVoiceManager instance lives for the life of the page. It owns
  // the browser SpeechRecognition/speechSynthesis lifecycle; this hook just
  // feeds it transcripts in and AI replies out.
  useEffect(() => {
    voiceManagerRef.current = new FinBudVoiceManager({
      // Always delegates to the CURRENT sendMessage via the ref kept in
      // sync below, instead of closing over this (mount-time) render's
      // sendMessage directly - see sendMessageRef's declaration for why.
      lang: 'ur-PK',
      onTranscript: (transcript) => { sendMessageRef.current(transcript) },
      onStateChange: (state) => setVoiceState(state),
      onError: (err) => {
        if (err === 'unsupported') {
          appendMessage("Voice chat isn't supported in this browser. Try Chrome or Edge.", 'ai')
        } else if (err === 'not-allowed' || err === 'service-not-allowed') {
          appendMessage('Voice chat needs microphone access. Please allow it and try again.', 'ai')
        }
        setIsVoiceModeActive(false)
      },
    })
    return () => { voiceManagerRef.current?.stop() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function toggleVoiceMode() {
    const vm = voiceManagerRef.current
    if (!vm) return
    if (isVoiceModeActive) {
      vm.stop()
      setIsVoiceModeActive(false)
    } else {
      if (!isVoiceSupported()) {
        appendMessage("Voice chat isn't supported in this browser. Try Chrome or Edge.", 'ai')
        return
      }
      setIsVoiceModeActive(true)
      vm.start()
    }
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

  function appendMessage(text, type, extra = {}) {
    setMessages(prev => [...prev, { text, type, id: Date.now() + Math.random(), ...extra }])
  }

  // Signal AdvisorChatBubble (rendered on the Dashboard page, not here) to
  // auto-open once the user lands there, since Chat.jsx has no direct
  // handle on a component mounted on a different route.
  function openAdvisor() {
    try { sessionStorage.setItem('finbud_open_advisor', '1') } catch { /* noop */ }
    navigate('/dashboard')
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

  function rowsToMessages(rows) {
    const out = []
    for (const r of rows) {
      if (r.user_message) out.push({ text: r.user_message, type: 'user', id: `u-${r.id}` })
      if (r.ai_response)  out.push({ text: r.ai_response,  type: 'ai',   id: `a-${r.id}` })
    }
    return out
  }

  async function loadActiveSession() {
    try {
      const res  = await fetch('/api/chat/history', { credentials: 'include' })
      const data = await res.json()
      if (data.success && data.session_id) {
        setMessages(rowsToMessages(data.messages))
        setSessionId(data.session_id)
        setIsReadOnly(!data.is_active)
      }
    } catch { /* fall back to blank, same as current behavior */ }
  }

  async function startNewChat() {
    try {
      const res  = await fetch('/api/chat/session/new', { method: 'POST', credentials: 'include' })
      const data = await res.json()
      if (data.success) {
        setMessages([])
        setSessionId(data.session_id)
        setIsReadOnly(false)
        setModal(null)
        setPendingInfo(null)
      }
    } catch { appendMessage('Could not start a new chat. Please try again.', 'ai') }
  }

  async function loadSessions() {
    try {
      const res  = await fetch('/api/chat/sessions', { credentials: 'include' })
      const data = await res.json()
      if (data.success) setSessions(data.sessions)
    } catch {}
  }

  async function openSession(id) {
    try {
      const res  = await fetch(`/api/chat/history?session_id=${id}`, { credentials: 'include' })
      const data = await res.json()
      if (data.success) {
        setMessages(rowsToMessages(data.messages))
        setSessionId(data.session_id)
        setIsReadOnly(!data.is_active)
      }
    } catch {}
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

    appendMessage(data.ai_response, 'ai', {
      // Structured signal from the NLP layer (investment/wealth questions
      // routed to Fin instead of being answered generically here) - drives
      // a CTA rendered under this specific message.
      advisorCta: !!data.redirect_to_advisor,
    })

    const needsPw  = data.awaiting_password
    const needsEPw = data.awaiting_emergency_password
    const opensPasswordModal = (needsPw || needsEPw || emergencyFlow) && !((needsEPw || emergencyFlow) && !hasCard)

    // Speak the reply aloud when hands-free mode is on. If a password
    // modal is about to open, don't re-arm the mic afterwards — password
    // entry should stay typed, not spoken.
    if (isVoiceModeActive) {
      voiceManagerRef.current?.speak(data.ai_response, { reArm: !opensPasswordModal })
    }

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
    if (isReadOnly) return
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

  // Keep the ref pointed at THIS render's sendMessage (and therefore this
  // render's handleResponse/isVoiceModeActive/hasCard/etc.) on every
  // render, so the mount-only voiceManager effect above always calls the
  // freshest version instead of the one captured when it was created.
  useEffect(() => {
    sendMessageRef.current = sendMessage
  })

  async function handleHumanHandoff() {
    if (isReadOnly) return
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
    if (!hasCard || isReadOnly) return
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

  return {
    // refs
    messagesEndRef, printRef,
    // state
    messages, inputText, setInputText, isLoading,
    voiceState, isVoiceModeActive,
    hasCard, modal, setModal, pendingInfo,
    sessionId, isReadOnly, sessions,
    // actions
    speak, toggleVoiceMode, openAdvisor,
    sendMessage, handleHumanHandoff, handleEmergency,
    submitPassword, downloadReceipt, emailReceipt,
    startNewChat, loadSessions, openSession,
  }
}
