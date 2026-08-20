import { useState, useRef, useEffect } from 'react'

// A small cartoonish "speech bubble with a face" icon — Fin's symbol.
// Purely an SVG symbol (currentColor-based), no emoji characters, so it
// stays crisp and on-brand purple everywhere it's used (trigger button,
// greeting bubble, panel header).
function FinIcon({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M12 3C6.48 3 2 6.58 2 11c0 2.21 1.09 4.2 2.86 5.61-.12.9-.48 2.02-1.36 3.09a.5.5 0 00.5.8c1.98-.36 3.4-1.18 4.24-1.78A12.6 12.6 0 0012 19c5.52 0 10-3.58 10-8s-4.48-8-10-8z"
        fill="currentColor"
      />
      <circle cx="8.6" cy="11" r="1.15" fill="var(--fin-face-color, #fff)" />
      <circle cx="15.4" cy="11" r="1.15" fill="var(--fin-face-color, #fff)" />
      <path
        d="M8.6 14c1 1 5 1 5.8 0"
        stroke="var(--fin-face-color, #fff)"
        strokeWidth="1.3"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}

// A friendly floating character docked near the Investing panel — tap the
// greeting bubble or the avatar itself to open Fin as a side panel that
// stays docked to the edge of the screen while browsing the advisor
// section (not a small floating popup). Scoped to financial-advisory
// topics only via {context: 'financial_advisor'} on /api/chat/message
// (same endpoint the full Chat page uses — see Chat.jsx's postChat() —
// just with that extra flag).
export default function AdvisorChatBubble() {
  const [open, setOpen] = useState(false)
  const [greetingDismissed, setGreetingDismissed] = useState(false)
  const [messages, setMessages] = useState([
    { type: 'ai', text: "Hi! I'm Fin. Ask me anything about your saving goals, spending, or investing." }
  ])
  const [inputText, setInputText] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const scrollRef = useRef(null)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, open])

  async function sendMessage(e) {
    e.preventDefault()
    const text = inputText.trim()
    if (!text || isLoading) return

    setMessages(m => [...m, { type: 'user', text }])
    setInputText('')
    setIsLoading(true)

    try {
      const res = await fetch('/api/chat/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ message: text, context: 'financial_advisor' })
      })
      const data = await res.json()
      if (data.success) {
        setMessages(m => [...m, { type: 'ai', text: data.ai_response }])
      } else {
        setMessages(m => [...m, { type: 'ai', text: "Sorry, I couldn't get an answer just now. Please try again." }])
      }
    } catch {
      setMessages(m => [...m, { type: 'ai', text: "I couldn't reach the server. Please try again." }])
    } finally {
      setIsLoading(false)
    }
  }

  function openChat() {
    setGreetingDismissed(true)
    setOpen(true)
  }

  return (
    <>
      {/* Auto-shown greeting bubble, dismissable */}
      {!open && !greetingDismissed && (
        <button type="button" className="advisor-greeting-bubble" onClick={openChat}>
          <span className="advisor-greeting-icon"><FinIcon size={16} /></span>
          <span>Hi! I'm <strong>Fin</strong>, an AI guide to help with your saving &amp; investing.</span>
          <span
            className="advisor-greeting-close"
            role="button"
            aria-label="Dismiss"
            onClick={(e) => { e.stopPropagation(); setGreetingDismissed(true) }}
          >
            <i className="fas fa-xmark" />
          </span>
        </button>
      )}

      <button
        type="button"
        className="advisor-chat-bubble-btn"
        aria-label={open ? 'Close Fin' : 'Chat with Fin'}
        onClick={() => setOpen(o => !o)}
      >
        {open ? <i className="fas fa-xmark" /> : <FinIcon size={26} />}
      </button>

      {/* Docked side panel — stays anchored to the edge of the screen
          while the user keeps browsing the rest of the advisor section
          behind it, rather than a small floating box. */}
      {open && (
        <div className="advisor-chat-sidepanel" role="dialog" aria-label="Fin — financial advisor chat">
          <div className="advisor-chat-popup-header">
            <div className="advisor-chat-popup-header-title">
              <span className="advisor-chat-popup-avatar"><FinIcon size={20} /></span>
              <strong>FinBud</strong>
            </div>
            <button type="button" aria-label="Close" onClick={() => setOpen(false)}>
              <i className="fas fa-xmark" />
            </button>
          </div>

          <div className="advisor-chat-popup-messages" ref={scrollRef}>
            <div className="advisor-chat-disclaimer">
              Just a reminder that this chat is AI generated. Mistakes are possible.
              Fin only discusses your saving goals, spending, and investing here in
              Grow My Money; for anything else, use FinBud's main chat. This is
              educational information, not formal financial advice.
            </div>
            {messages.map((m, i) => (
              <div key={i} className={`advisor-chat-bubble-msg ${m.type}`}>{m.text}</div>
            ))}
            {isLoading && <div className="advisor-chat-bubble-msg ai">…</div>}
          </div>

          <form className="advisor-chat-popup-input-row" onSubmit={sendMessage}>
            <input
              type="text"
              value={inputText}
              placeholder="Write a message"
              onChange={e => setInputText(e.target.value)}
              disabled={isLoading}
            />
            <button type="submit" disabled={isLoading || !inputText.trim()} aria-label="Send">
              <i className="fas fa-paper-plane" />
            </button>
          </form>
        </div>
      )}
    </>
  )
}