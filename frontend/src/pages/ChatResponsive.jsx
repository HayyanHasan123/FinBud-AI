import { useState, useEffect } from 'react'
import Chat from './Chat'
import ChatMobile from './ChatMobile'

const MOBILE_QUERY = '(max-width: 768px)'

function getIsMobile() {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia(MOBILE_QUERY).matches
}

// ── ChatResponsive ──────────────────────────────────────────────────
// Point your route at this component instead of Chat.jsx directly.
// It watches the viewport and renders the mobile layout (ChatMobile.jsx)
// on phones and the existing desktop layout (Chat.jsx) everywhere else.
// Both share the exact same logic via useChatController, so switching
// between them (e.g. rotating a tablet, resizing a window) never changes
// the underlying chat flow — only the presentation.
export default function ChatResponsive() {
  const [isMobile, setIsMobile] = useState(getIsMobile)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia(MOBILE_QUERY)
    const onChange = (e) => setIsMobile(e.matches)
    // Safari <14 fallback
    if (mql.addEventListener) mql.addEventListener('change', onChange)
    else mql.addListener(onChange)
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange)
      else mql.removeListener(onChange)
    }
  }, [])

  return isMobile ? <ChatMobile /> : <Chat />
}