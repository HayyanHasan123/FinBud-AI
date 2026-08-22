import { useState } from 'react'

// Small "?" bubble that reveals a helper explanation on click. Used inside
// stat labels on the Analytics and Wallet panels (e.g. "Safe to Spend ?",
// "Total Net Worth ?"). Self-contained — no dependency on Dashboard state.
export default function InfoTip({ text }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="info-tip-wrap">
      <button
        type="button"
        className="info-tip-btn"
        aria-label="What does this mean?"
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
      >?</button>
      {open && (
        <span className="info-tip-bubble" onClick={e => e.stopPropagation()}>
          {text}
        </span>
      )}
    </span>
  )
}