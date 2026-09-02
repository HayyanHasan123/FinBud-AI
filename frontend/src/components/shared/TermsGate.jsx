import { useState, useEffect } from 'react'

// ── Terms & Conditions content, in all 3 languages ──────────────────────
const CONTENT = {
  en: {
    dir: 'ltr',
    title: 'Terms & Conditions',
    subtitle: 'Please review and accept before continuing.',
    items: [
      'All balances, transfers, and rewards shown in FinBud AI are part of a simulated banking environment for demonstration purposes.',
      'FinBud AI may store your transaction and chat data to power the assistant and analytics features.',
      'You are responsible for keeping your PIN confidential and for any actions taken under your account.',
      'FinBud AI is not a licensed financial institution and does not provide investment, legal, or tax advice.',
      'These terms may be updated periodically — continued use of the app means you accept the latest version.'
    ],
    accept: 'Accept & Continue',
    wait: 'Please wait…',
    readAloud: '🔊 Read Aloud'
  },
  roman: {
    dir: 'ltr',
    title: 'Shartain o Zawabit',
    subtitle: 'Aage barhne se pehle in shartain ko parh kar qabool karein.',
    items: [
      'FinBud AI mein dikhaye gaye tamam balances, transfers, aur rewards sirf demonstration ke liye ek simulated banking environment ka hissa hain.',
      'FinBud AI aapka transaction aur chat data store kar sakta hai taake assistant aur analytics features kaam kar sakein.',
      'Apna PIN confidential rakhna aur apne account mein hone wali tamam activities ki zimmedari aap par hai.',
      'FinBud AI koi licensed financial institution nahi hai aur investment, legal, ya tax advice nahi deta.',
      'Yeh shartain waqtan faqtan update ho sakti hain — app istemal karte rehna iska matlab hai ke aap latest version qabool karte hain.'
    ],
    accept: 'Qabool Karein Aur Aage Barhein',
    wait: 'Zara Intezar Karein…',
    readAloud: '🔊 Parh Kar Sunayein'
  },
  ur: {
    dir: 'rtl',
    title: 'شرائط و ضوابط',
    subtitle: 'آگے بڑھنے سے پہلے ان شرائط کو پڑھ کر قبول کریں۔',
    items: [
      'فن بڈ اے آئی میں دکھائے گئے تمام بیلنس، ٹرانسفرز، اور ریوارڈز صرف مظاہرے کے مقصد کے لیے ایک نقلی بینکنگ ماحول کا حصہ ہیں۔',
      'فن بڈ اے آئی اسسٹنٹ اور تجزیاتی خصوصیات کو چلانے کے لیے آپ کا ٹرانزیکشن اور چیٹ ڈیٹا محفوظ کر سکتا ہے۔',
      'اپنا پن خفیہ رکھنا اور اپنے اکاؤنٹ میں ہونے والی تمام سرگرمیوں کی ذمہ داری آپ پر ہے۔',
      'فن بڈ اے آئی کوئی لائسنس یافتہ مالیاتی ادارہ نہیں ہے اور سرمایہ کاری، قانونی، یا ٹیکس سے متعلق مشورہ نہیں دیتا۔',
      'یہ شرائط وقتاً فوقتاً اپ ڈیٹ ہو سکتی ہیں — ایپ کا استعمال جاری رکھنے کا مطلب ہے کہ آپ تازہ ترین ورژن قبول کرتے ہیں۔'
    ],
    accept: 'قبول کریں اور آگے بڑھیں',
    wait: 'ذرا انتظار کریں…',
    readAloud: '🔊 پڑھ کر سنائیں'
  }
}

const LANG_OPTIONS = [
  { code: 'en', label: 'English' },
  { code: 'roman', label: 'Roman Urdu' },
  { code: 'ur', label: 'اردو' }
]

// Wraps /dashboard and /chat. Reuses /api/user/data (already the auth-check
// call both pages make on mount) to read termsAccepted. Until accepted, the
// wrapped page sits blurred + non-interactive behind a glassmorphic modal.
// The modal has its own independent EN / Roman Urdu / Urdu switcher — it
// does not depend on whatever language was picked on the Login page, since
// that selection currently isn't persisted anywhere the modal can read.
export default function TermsGate({ children }) {
  const [status, setStatus] = useState('checking') // checking | accepted | pending
  const [submitting, setSubmitting] = useState(false)
  const [termsLang, setTermsLang] = useState('en')

  useEffect(() => {
    let cancelled = false
    fetch('/api/user/data', { credentials: 'include' })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (cancelled) return
        setStatus(data && data.termsAccepted ? 'accepted' : 'pending')
      })
      .catch(() => { if (!cancelled) setStatus('accepted') }) // fail open, never hard-lock the user out on a network blip
    return () => { cancelled = true }
  }, [])

  async function handleAccept() {
    setSubmitting(true)
    try {
      const res = await fetch('/api/user/accept-terms', { method: 'POST', credentials: 'include' })
      const data = await res.json()
      if (res.ok && data.success) setStatus('accepted')
    } finally {
      setSubmitting(false)
    }
  }

  function handleReadAloud() {
    if (typeof window === 'undefined' || !window.speechSynthesis) return
    const c = CONTENT[termsLang]
    const fullText = `${c.title}. ${c.subtitle} ${c.items.join(' ')}`
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(fullText)
    utterance.lang = termsLang === 'en' ? 'en-US' : 'ur-PK'
    window.speechSynthesis.speak(utterance)
  }

  const c = CONTENT[termsLang]

  return (
    <>
      <div style={{ filter: status === 'pending' ? 'blur(6px)' : 'none', pointerEvents: status === 'pending' ? 'none' : 'auto' }}>
        {children}
      </div>
      {status === 'pending' && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(20, 8, 40, 0.55)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20
        }}>
          <div style={{
            width: '100%', maxWidth: 560, maxHeight: '85vh', overflowY: 'auto',
            borderRadius: 20, padding: '32px 32px 28px',
            background: 'linear-gradient(145deg, rgba(48,15,84,0.94), rgba(20,6,38,0.94))',
            border: '1px solid rgba(255,255,255,0.12)', boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            color: '#f1e9ff', fontFamily: 'Inter, sans-serif'
          }}>
            {/* Language switcher */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
              {LANG_OPTIONS.map(opt => (
                <button
                  key={opt.code}
                  type="button"
                  onClick={() => setTermsLang(opt.code)}
                  style={{
                    padding: '6px 14px', borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                    border: termsLang === opt.code ? '1px solid #c4a6f5' : '1px solid rgba(255,255,255,0.18)',
                    background: termsLang === opt.code ? 'rgba(139,92,246,0.35)' : 'transparent',
                    color: '#f1e9ff'
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <div dir={c.dir} style={{ textAlign: c.dir === 'rtl' ? 'right' : 'left' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 4 }}>
                <h2 style={{ margin: 0, fontSize: 26, fontWeight: 800 }}>{c.title}</h2>
                <button
                  type="button"
                  onClick={handleReadAloud}
                  style={{
                    background: 'rgba(255,255,255,0.12)', color: '#e6d9ff', border: '1px solid rgba(255,255,255,0.2)',
                    borderRadius: 20, padding: '6px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer'
                  }}
                >
                  {c.readAloud}
                </button>
              </div>
              <p style={{ margin: '0 0 18px', fontSize: 15, opacity: 0.8 }}>{c.subtitle}</p>

              <div style={{
                maxHeight: 300, overflowY: 'auto',
                background: 'rgba(0,0,0,0.22)', borderRadius: 14, padding: '18px 20px', marginBottom: 24
              }}>
                {c.items.map((item, i) => (
                  <p key={i} style={{ margin: '0 0 16px', fontSize: 16.5, lineHeight: 1.75 }}>
                    <strong style={{ color: '#c4a6f5' }}>{i + 1}.</strong> {item}
                  </p>
                ))}
              </div>
            </div>

            <button
              onClick={handleAccept}
              disabled={submitting}
              style={{
                width: '100%', padding: '16px 0', borderRadius: 12, border: 'none',
                background: submitting ? '#7a4fb0' : 'linear-gradient(90deg, #8b5cf6, #6d28d9)',
                color: '#fff', fontSize: 16, fontWeight: 700, cursor: submitting ? 'default' : 'pointer'
              }}
            >
              {submitting ? c.wait : c.accept}
            </button>
          </div>
        </div>
      )}
    </>
  )
}