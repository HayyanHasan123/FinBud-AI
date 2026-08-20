import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

// ============================================================
// LANGUAGE STRINGS (English / Urdu / Roman Urdu)
// ============================================================
const STRINGS = {
  en: {
    dir: 'ltr',
    tagline: 'Your Voice-Powered Banking Assistant',
    common: {
      back: 'Back', continueBtn: 'Continue', resend: 'Resend Code',
      demoNote: (code) => `Demo mode: your OTP is ${code} (in a live app this would be sent via SMS).`
    },
    login: {
      greeting: 'Welcome Back To',
      title: 'Sign In', sub: 'Sign in to access your account',
      phone: 'Phone Number:', phonePh: '0300-1234567',
      pin: 'PIN:', loginBtn: 'Log In', loggingIn: 'Logging in...',
      forgot: 'Forgot PIN?', newUser: 'New User? Create Account',
      err: 'Enter your phone number and 5-digit PIN.'
    },
    phoneStep: {
      title: "LET'S GET STARTED", sub: "Enter your phone number — we'll text you a one-time code.",
      phone: 'Phone Number:', phonePh: '0300-1234567',
      next: 'Send Code', back: 'Already have an account? Log In',
      phoneErr: 'Enter a valid 11-digit phone number.'
    },
    otpStep: {
      title: 'VERIFY YOUR NUMBER', sub: 'Enter the 6-digit code we sent to your phone.',
      otp: 'OTP Code:', otpPh: '000000',
      verify: 'Verify', otpErr: 'Enter the 6-digit code.', back: 'Back'
    },
    cnicStep: {
      title: 'VERIFY YOUR IDENTITY', sub: 'Enter your CNIC number to verify your identity with NADRA.',
      cnic: 'CNIC Number:', cnicPh: '42101-1234567-1',
      next: 'Continue', back: 'Back', cnicErr: 'Enter a valid 13-digit CNIC number.',
      verifying: 'Verifying...'
    },
    setCredentials: {
      title: 'SET UP YOUR ACCOUNT', sub: 'Choose a display name and a 5-digit PIN. Your phone number will be your account number.',
      name: 'Display Name:', namePh: 'e.g., Alex B.',
      pin: '5-Digit PIN:', confirmPin: 'Confirm PIN:',
      finish: 'Go to Dashboard', creating: 'Creating Account...', back: 'Back',
      pinErr: 'PIN must be exactly 5 digits.', mismatchErr: "PINs don't match.",
      weakErr: 'That PIN is too easy to guess. Please choose another.'
    },
    forgotPhone: {
      title: 'FORGOT PIN', sub: "Enter your phone number and we'll send you a reset code.",
      phone: 'Phone Number:', phonePh: '0300-1234567',
      send: 'Send Reset Code', back: 'Back to Login'
    },
    forgotReset: {
      title: 'RESET YOUR PIN', sub: 'Enter the code we sent you and choose a new 5-digit PIN.',
      otp: 'OTP Code:', otpPh: '000000',
      newPin: 'New PIN:', confirmPin: 'Confirm New PIN:',
      reset: 'Reset PIN', back: 'Back'
    },
    footer: '© 2026 FinBud AI'
  },
  ur: {
    dir: 'rtl',
    tagline: 'آپ کا آواز سے چلنے والا بینکنگ اسسٹنٹ',
    common: {
      back: 'واپس', continueBtn: 'جاری رکھیں', resend: 'کوڈ دوبارہ بھیجیں',
      demoNote: (code) => `ڈیمو موڈ: آپ کا او ٹی پی ${code} ہے (اصل ایپ میں یہ ایس ایم ایس کے ذریعے بھیجا جائے گا)۔`
    },
    login: {
      greeting: 'خوش آمدید',
      title: 'سائن ان کریں', sub: 'اپنے اکاؤنٹ تک رسائی کے لیے لاگ ان کریں',
      phone: 'فون نمبر:', phonePh: '0300-1234567',
      pin: 'پن:', loginBtn: 'لاگ ان کریں', loggingIn: 'لاگ ان ہو رہا ہے...',
      forgot: 'پن بھول گئے؟', newUser: 'نیا صارف؟ اکاؤنٹ بنائیں',
      err: 'اپنا فون نمبر اور 5 ہندسوں کا پن درج کریں۔'
    },
    phoneStep: {
      title: 'آئیے شروع کرتے ہیں', sub: 'اپنا فون نمبر درج کریں — ہم آپ کو ایک وقتی کوڈ بھیجیں گے۔',
      phone: 'فون نمبر:', phonePh: '0300-1234567',
      next: 'کوڈ بھیجیں', back: 'پہلے سے اکاؤنٹ ہے؟ لاگ ان کریں',
      phoneErr: 'ایک درست 11 ہندسوں کا فون نمبر درج کریں۔'
    },
    otpStep: {
      title: 'اپنا نمبر تصدیق کریں', sub: 'اپنے فون پر بھیجا گیا 6 ہندسوں کا کوڈ درج کریں۔',
      otp: 'او ٹی پی کوڈ:', otpPh: '000000',
      verify: 'تصدیق کریں', otpErr: '6 ہندسوں کا کوڈ درج کریں۔', back: 'واپس'
    },
    cnicStep: {
      title: 'اپنی شناخت کی تصدیق کریں', sub: 'نادرا کے ذریعے اپنی شناخت کی تصدیق کے لیے اپنا شناختی کارڈ نمبر درج کریں۔',
      cnic: 'شناختی کارڈ نمبر:', cnicPh: '42101-1234567-1',
      next: 'جاری رکھیں', back: 'واپس', cnicErr: 'ایک درست 13 ہندسوں کا شناختی کارڈ نمبر درج کریں۔',
      verifying: 'تصدیق ہو رہی ہے...'
    },
    setCredentials: {
      title: 'اپنا اکاؤنٹ سیٹ اپ کریں', sub: 'ایک ڈسپلے نام اور 5 ہندسوں کا پن منتخب کریں۔ آپ کا فون نمبر آپ کا اکاؤنٹ نمبر ہوگا۔',
      name: 'ڈسپلے نام:', namePh: 'مثال کے طور پر، احمد خان',
      pin: '5 ہندسوں کا پن:', confirmPin: 'پن کی تصدیق کریں:',
      finish: 'ڈیش بورڈ پر جائیں', creating: 'اکاؤنٹ بنایا جا رہا ہے...', back: 'واپس',
      pinErr: 'پن بالکل 5 ہندسوں کا ہونا چاہیے۔', mismatchErr: 'پن مماثل نہیں ہیں۔',
      weakErr: 'یہ پن اندازہ لگانا بہت آسان ہے۔ براہ کرم دوسرا منتخب کریں۔'
    },
    forgotPhone: {
      title: 'پن بھول گئے', sub: 'اپنا فون نمبر درج کریں اور ہم آپ کو ری سیٹ کوڈ بھیجیں گے۔',
      phone: 'فون نمبر:', phonePh: '0300-1234567',
      send: 'ری سیٹ کوڈ بھیجیں', back: 'لاگ ان پر واپس جائیں'
    },
    forgotReset: {
      title: 'اپنا پن ری سیٹ کریں', sub: 'ہم نے آپ کو جو کوڈ بھیجا وہ درج کریں اور ایک نیا 5 ہندسوں کا پن منتخب کریں۔',
      otp: 'او ٹی پی کوڈ:', otpPh: '000000',
      newPin: 'نیا پن:', confirmPin: 'نئے پن کی تصدیق کریں:',
      reset: 'پن ری سیٹ کریں', back: 'واپس'
    },
    footer: '© 2026 فن بڈ اے آئی'
  },
  ru: {
    dir: 'ltr',
    tagline: 'Aap ka Voice-Powered Banking Assistant',
    common: {
      back: 'Wapis', continueBtn: 'Jari Rakhein', resend: 'Code Dobara Bhejein',
      demoNote: (code) => `Demo mode: aap ka OTP ${code} hai (live app mein yeh SMS ke zariye bheja jayega).`
    },
    login: {
      greeting: 'Wapis Mubarak Ho',
      title: 'Sign In', sub: 'Apne account tak rasai ke liye login karein',
      phone: 'Phone Number:', phonePh: '0300-1234567',
      pin: 'PIN:', loginBtn: 'Log In', loggingIn: 'Login ho raha hai...',
      forgot: 'PIN bhool gaye?', newUser: 'Naya user? Account banayein',
      err: 'Apna phone number aur 5-digit PIN darj karein.'
    },
    phoneStep: {
      title: 'CHALEIN SHURU KARTE HAIN', sub: 'Apna phone number darj karein — hum aapko ek one-time code bhejein ge.',
      phone: 'Phone Number:', phonePh: '0300-1234567',
      next: 'Code Bhejein', back: 'Pehle se account hai? Login Karein',
      phoneErr: 'Sahi 11-digit phone number darj karein.'
    },
    otpStep: {
      title: 'APNA NUMBER VERIFY KAREIN', sub: 'Aapke phone par bheja gaya 6-digit code darj karein.',
      otp: 'OTP Code:', otpPh: '000000',
      verify: 'Verify Karein', otpErr: '6-digit code darj karein.', back: 'Wapis'
    },
    cnicStep: {
      title: 'APNI PEHCHAN VERIFY KAREIN', sub: 'NADRA ke zariye apni pehchan verify karne ke liye CNIC number darj karein.',
      cnic: 'CNIC Number:', cnicPh: '42101-1234567-1',
      next: 'Jari Rakhein', back: 'Wapis', cnicErr: 'Sahi 13-digit CNIC number darj karein.',
      verifying: 'Verify ho raha hai...'
    },
    setCredentials: {
      title: 'APNA ACCOUNT SET UP KAREIN', sub: 'Ek display name aur 5-digit PIN chunein. Aapka phone number aapka account number hoga.',
      name: 'Display Name:', namePh: 'misaal ke tor par, Ahmed Khan',
      pin: '5-Digit PIN:', confirmPin: 'PIN Confirm Karein:',
      finish: 'Dashboard Par Jayein', creating: 'Account Bana Raha Hai...', back: 'Wapis',
      pinErr: 'PIN bilkul 5 digits ka hona chahiye.', mismatchErr: 'PINs match nahi karte.',
      weakErr: 'Yeh PIN andaza lagana bohot aasan hai. Doosra chunein.'
    },
    forgotPhone: {
      title: 'PIN BHOOL GAYE', sub: 'Apna phone number darj karein, hum aapko reset code bhejein ge.',
      phone: 'Phone Number:', phonePh: '0300-1234567',
      send: 'Reset Code Bhejein', back: 'Login Par Wapis Jayein'
    },
    forgotReset: {
      title: 'APNA PIN RESET KAREIN', sub: 'Humne aapko jo code bheja woh darj karein aur naya 5-digit PIN chunein.',
      otp: 'OTP Code:', otpPh: '000000',
      newPin: 'Naya PIN:', confirmPin: 'Naya PIN Confirm Karein:',
      reset: 'PIN Reset Karein', back: 'Wapis'
    },
    footer: '© 2026 FinBud AI'
  }
}

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ur', label: 'اردو' },
  { code: 'ru', label: 'Roman Urdu' }
]

const TOTAL_STEPS = 4 // phone -> otp -> cnic -> setCredentials

// ============================================================
// HELPERS
// ============================================================
function formatPhone(v) {
  const digits = v.replace(/\D/g, '').slice(0, 11)
  if (digits.length <= 4) return digits
  return `${digits.slice(0, 4)}-${digits.slice(4)}`
}
function formatCnic(v) {
  const digits = v.replace(/\D/g, '').slice(0, 13)
  if (digits.length <= 5) return digits
  if (digits.length <= 12) return `${digits.slice(0, 5)}-${digits.slice(5)}`
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`
}
function digitsOnly(v) { return v.replace(/\D/g, '') }

export default function Login() {
  const navigate = useNavigate()
  const [language, setLanguage] = useState('en')
  const [langOpen, setLangOpen] = useState(false)
  const t = STRINGS[language]

  // Force a light color scheme regardless of the device/browser dark mode
  // setting — without this, some mobile browsers auto-invert unstyled
  // form controls (inputs) into dark grey boxes.
  useEffect(() => {
    const meta = document.createElement('meta')
    meta.name = 'color-scheme'
    meta.content = 'light'
    document.head.appendChild(meta)
    return () => document.head.removeChild(meta)
  }, [])

  const [activeCard, setActiveCard] = useState('login')

  // Signup wizard shared state (the phone number carries through every step)
  const [signupPhone, setSignupPhone] = useState('')

  // Login state
  const [loginPhone, setLoginPhone] = useState('')
  const [loginPin, setLoginPin] = useState('')
  const [loginError, setLoginError] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)

  // Phone step state
  const [phone, setPhone] = useState('')
  const [phoneError, setPhoneError] = useState('')
  const [phoneLoading, setPhoneLoading] = useState(false)

  // OTP step state
  const [otp, setOtp] = useState('')
  const [otpError, setOtpError] = useState('')
  const [otpLoading, setOtpLoading] = useState(false)
  const [devOtp, setDevOtp] = useState('')

  // CNIC step state
  const [cnic, setCnic] = useState('')
  const [cnicError, setCnicError] = useState('')
  const [cnicLoading, setCnicLoading] = useState(false)

  // Set credentials state
  const [displayName, setDisplayName] = useState('')
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [credError, setCredError] = useState('')
  const [credLoading, setCredLoading] = useState(false)

  // Forgot PIN state
  const [forgotPhone, setForgotPhone] = useState('')
  const [forgotDevOtp, setForgotDevOtp] = useState('')
  const [forgotOtp, setForgotOtp] = useState('')
  const [forgotNewPin, setForgotNewPin] = useState('')
  const [forgotConfirmPin, setForgotConfirmPin] = useState('')
  const [forgotError, setForgotError] = useState('')
  const [forgotLoading, setForgotLoading] = useState(false)

  // ── LOGIN ──────────────────────────────────────────────
  const handleLogin = async (e) => {
    e.preventDefault()
    setLoginError('')
    const phoneDigits = digitsOnly(loginPhone)
    if (phoneDigits.length !== 11 || loginPin.length !== 5) {
      setLoginError(t.login.err); return
    }
    setLoginLoading(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ phone: phoneDigits, pin: loginPin })
      })
      const data = await res.json()
      if (res.ok && data.success) {
        navigate('/dashboard')
      } else {
        setLoginError(data.message || 'Invalid phone number or PIN')
      }
    } catch {
      setLoginError('Server error. Please try again.')
    }
    setLoginLoading(false)
  }

  // ── SIGNUP: STEP 1 — PHONE ─────────────────────────────
  const handlePhoneSubmit = async (e) => {
    e.preventDefault()
    setPhoneError('')
    const phoneDigits = digitsOnly(phone)
    if (phoneDigits.length !== 11) { setPhoneError(t.phoneStep.phoneErr); return }
    setPhoneLoading(true)
    try {
      const res = await fetch('/api/auth/register/phone', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phoneDigits })
      })
      const data = await res.json()
      if (res.ok && data.success) {
        setSignupPhone(phoneDigits)
        setDevOtp(data.dev_otp || '')
        setOtp('')
        setOtpError('')
        setActiveCard('otp')
      } else {
        setPhoneError(data.message || 'Could not send code. Please try again.')
      }
    } catch {
      setPhoneError('Server error. Please try again.')
    }
    setPhoneLoading(false)
  }

  // ── SIGNUP: STEP 2 — OTP ───────────────────────────────
  const handleOtpSubmit = async (e) => {
    e.preventDefault()
    setOtpError('')
    if (otp.length !== 6) { setOtpError(t.otpStep.otpErr); return }
    setOtpLoading(true)
    try {
      const res = await fetch('/api/auth/register/verify-otp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: signupPhone, otp })
      })
      const data = await res.json()
      if (res.ok && data.success) {
        setCnic(''); setCnicError('')
        setActiveCard('cnic')
      } else {
        setOtpError(data.message || 'Incorrect code.')
      }
    } catch {
      setOtpError('Server error. Please try again.')
    }
    setOtpLoading(false)
  }

  const handleResendOtp = async () => {
    setOtpError('')
    try {
      const res = await fetch('/api/auth/register/phone', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: signupPhone })
      })
      const data = await res.json()
      if (res.ok && data.success) setDevOtp(data.dev_otp || '')
      else setOtpError(data.message || 'Could not resend code.')
    } catch {
      setOtpError('Server error. Please try again.')
    }
  }

  // ── SIGNUP: STEP 3 — CNIC ──────────────────────────────
  const handleCnicSubmit = async (e) => {
    e.preventDefault()
    setCnicError('')
    const cnicDigits = digitsOnly(cnic)
    if (cnicDigits.length !== 13) { setCnicError(t.cnicStep.cnicErr); return }
    setCnicLoading(true)
    try {
      const res = await fetch('/api/auth/register/cnic', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: signupPhone, cnic: cnicDigits })
      })
      const data = await res.json()
      if (res.ok && data.success) {
        setDisplayName(''); setPin(''); setConfirmPin(''); setCredError('')
        setActiveCard('setCredentials')
      } else {
        setCnicError(data.message || 'CNIC could not be verified.')
      }
    } catch {
      setCnicError('Server error. Please try again.')
    }
    setCnicLoading(false)
  }

  // ── SIGNUP: STEP 4 — DISPLAY NAME + PIN ────────────────
  const handleSetCredentials = async (e) => {
    e.preventDefault()
    setCredError('')
    if (!displayName.trim()) { setCredError('Please enter a display name.'); return }
    if (pin.length !== 5) { setCredError(t.setCredentials.pinErr); return }
    if (pin !== confirmPin) { setCredError(t.setCredentials.mismatchErr); return }
    setCredLoading(true)
    try {
      const res = await fetch('/api/auth/register/complete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ phone: signupPhone, displayName: displayName.trim(), pin })
      })
      const data = await res.json()
      if (res.ok && data.success) {
        navigate('/dashboard')
      } else {
        setCredError(data.message || 'Account creation failed')
      }
    } catch {
      setCredError('Server error. Please try again.')
    }
    setCredLoading(false)
  }

  // ── FORGOT PIN ──────────────────────────────────────────
  const handleForgotPhoneSubmit = async (e) => {
    e.preventDefault()
    setForgotError('')
    const phoneDigits = digitsOnly(forgotPhone)
    if (phoneDigits.length !== 11) { setForgotError(t.phoneStep.phoneErr); return }
    setForgotLoading(true)
    try {
      const res = await fetch('/api/auth/forgot-pin/request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phoneDigits })
      })
      const data = await res.json()
      if (res.ok && data.success) {
        setForgotPhone(phoneDigits)
        setForgotDevOtp(data.dev_otp || '')
        setForgotOtp(''); setForgotNewPin(''); setForgotConfirmPin('')
        setActiveCard('forgotReset')
      } else {
        setForgotError(data.message || 'Could not send reset code.')
      }
    } catch {
      setForgotError('Server error. Please try again.')
    }
    setForgotLoading(false)
  }

  const handleForgotResetSubmit = async (e) => {
    e.preventDefault()
    setForgotError('')
    if (forgotOtp.length !== 6) { setForgotError(t.otpStep.otpErr); return }
    if (forgotNewPin.length !== 5) { setForgotError(t.setCredentials.pinErr); return }
    if (forgotNewPin !== forgotConfirmPin) { setForgotError(t.setCredentials.mismatchErr); return }
    setForgotLoading(true)
    try {
      const res = await fetch('/api/auth/forgot-pin/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: digitsOnly(forgotPhone), otp: forgotOtp, newPin: forgotNewPin })
      })
      const data = await res.json()
      if (res.ok && data.success) {
        setActiveCard('login')
        setLoginPhone(forgotPhone); setLoginPin('')
      } else {
        setForgotError(data.message || 'Could not reset PIN.')
      }
    } catch {
      setForgotError('Server error. Please try again.')
    }
    setForgotLoading(false)
  }

  // ── SHARED UI PIECES ────────────────────────────────────
  // Original pill switcher — kept for desktop, inside the card.
  function LanguageSwitch() {
    return (
      <div className="lang-switch lang-switch-card">
        {LANGUAGES.map(l => (
          <button key={l.code} type="button"
            className={`lang-pill ${language === l.code ? 'active' : ''}`}
            onClick={() => setLanguage(l.code)}>
            {l.label}
          </button>
        ))}
      </div>
    )
  }

  // Compact dropdown switcher — used in the mobile header, just below
  // the "Welcome Back" greeting. Shows the active language with a
  // caret; tapping it reveals the other two options.
  function LanguageDropdown() {
    const current = LANGUAGES.find(l => l.code === language) || LANGUAGES[0]
    return (
      <div className="lang-switch-header">
        <div className="lang-dropdown">
          <button type="button" className="lang-dropdown-trigger"
            aria-expanded={langOpen} onClick={() => setLangOpen(o => !o)}>
            {current.label}
            <svg className={`lang-caret ${langOpen ? 'open' : ''}`} width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {langOpen && (
            <div className="lang-dropdown-menu">
              {LANGUAGES.map(l => (
                <button key={l.code} type="button"
                  className={`lang-dropdown-item ${l.code === language ? 'active' : ''}`}
                  onClick={() => { setLanguage(l.code); setLangOpen(false) }}>
                  {l.label}
                </button>
              ))}
            </div>
          )}
        </div>
        {langOpen && <div className="lang-backdrop" onClick={() => setLangOpen(false)} />}
      </div>
    )
  }

  // Soft decorative background art (mobile only) — blurred white blobs
  // plus a few thin-line finance / voice doodles, spread across the
  // solid dark-purple background so it doesn't feel flat.
  function BackgroundArt() {
    return (
      <svg className="bg-art" viewBox="0 0 400 900" preserveAspectRatio="xMidYMin slice"
        xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          <filter id="softBlur" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="36" />
          </filter>
        </defs>
        <circle cx="375" cy="60" r="120" fill="#ffffff" opacity="0.07" filter="url(#softBlur)" />
        <circle cx="20" cy="420" r="100" fill="#ffffff" opacity="0.08" filter="url(#softBlur)" />
        <circle cx="365" cy="770" r="90" fill="#ffffff" opacity="0.06" filter="url(#softBlur)" />
        {/* coin doodle */}
        <g stroke="#ffffff" strokeWidth="1.6" fill="none" opacity="0.20">
          <circle cx="56" cy="140" r="21" />
          <path d="M56 129 v22 M49 135 q7 -5 14 0 M49 146 q7 5 14 0" />
        </g>
        {/* voice / sound-wave doodle */}
        <g stroke="#ffffff" strokeWidth="2" strokeLinecap="round" opacity="0.18">
          <line x1="302" y1="466" x2="302" y2="494" />
          <line x1="313" y1="452" x2="313" y2="508" />
          <line x1="324" y1="466" x2="324" y2="494" />
          <line x1="335" y1="438" x2="335" y2="522" />
          <line x1="346" y1="466" x2="346" y2="494" />
        </g>
        {/* padlock doodle */}
        <g stroke="#ffffff" strokeWidth="1.6" fill="none" opacity="0.16">
          <rect x="326" y="760" width="38" height="28" rx="4" />
          <path d="M332 760 v-9 a13 13 0 0 1 26 0 v9" />
        </g>
      </svg>
    )
  }

  function StepDots({ current }) {
    return (
      <div className="wizard-steps">
        {Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1).map((n, idx) => (
          <span key={n} style={{ display: 'flex', alignItems: 'center', flexGrow: idx > 0 ? 1 : 0 }}>
            {idx > 0 && <div className="wizard-line" />}
            <div className={`wizard-dot ${n < current ? 'done' : n === current ? 'current' : ''}`}>{n}</div>
          </span>
        ))}
      </div>
    )
  }

  function DemoOtpBanner({ code }) {
    if (!code) return null
    return <div className="status-box info">{t.common.demoNote(code)}</div>
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');

        /* Force a light theme regardless of device/browser dark mode —
           otherwise some mobile browsers auto-invert unstyled controls
           (like inputs) into dark grey boxes. */
        html, body { color-scheme: only light; }

        html, body { margin: 0; padding: 0; min-height: 100vh; width: 100%; }
        html { background: #5c2d91; }
        body { background: #5c2d91; }
        #root { display: flex; min-height: 100vh; width: 100%; margin: 0; padding: 0; }
        * { box-sizing: border-box; font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue", Arial; }
        .split { display: flex; min-height: 100vh; width: 100%; margin: 0; padding: 0; }
        .left-panel {
          flex: 1; background: #5c2d91;
          display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          padding: 32px; color: #fff;
        }
        .brand { display: flex; flex-direction: column; align-items: center; gap: 8px; }
        .logo-circle {
          width: 88px; height: 88px; border-radius: 50%;
          background: #fff; color: #5c2d91;
          display: flex; align-items: center; justify-content: center;
          font-weight: 700; font-size: 32px;
        }
        .brand h1 { font-size: 32px; margin-top: 10px; margin-bottom: 5px; color: #fff; letter-spacing: 2px; }
        .tagline { font-size: 14px; font-weight: 500; margin-top: 15px; text-transform: uppercase; color: #fff; text-align: center; max-width: 320px; }
        .right-panel {
          flex: 1; display: flex; align-items: center;
          justify-content: center; padding: 32px; background: #e9e3f6;
        }
        .login-card {
          width: 440px; background: #fff;
          padding: 36px; border-radius: 8px;
          display: flex; flex-direction: column;
        }
        .login-card[dir="rtl"] { text-align: right; }
        .login-card[dir="rtl"] label { text-align: right; }
        .login-card h2 { margin: 0 0 6px 0; text-transform: uppercase; font-weight: 900; color: #111; }
        .login-card .sub { margin: 0 0 24px 0; color: #444; font-size: 14px; line-height: 1.5; }
        .login-card label { display: block; font-size: 14px; margin-top: 16px; color: #111; font-weight: 500; text-align: left; }
        .login-card input {
          width: 100%; padding: 12px 10px; margin-top: 6px;
          border: 1px solid #e6e9ef; border-radius: 4px; font-size: 14px;
          background: #fff; color: #111; color-scheme: only light;
        }
        .login-card input::placeholder { color: #9aa0ab; }
        .primary {
          width: 100%; padding: 14px; margin-top: 22px;
          background: #5c2d91; color: #fff; border: none;
          border-radius: 4px; cursor: pointer; font-weight: 600;
          text-transform: uppercase; font-size: 14px;
        }
        .primary:disabled { opacity: 0.6; cursor: not-allowed; }
        .secondary-btn {
          width: 100%; padding: 14px; margin-top: 10px;
          background: #fff; color: #5c2d91; border: 2px solid #5c2d91;
          border-radius: 4px; cursor: pointer; font-weight: 600;
          text-transform: uppercase; font-size: 14px;
        }
        .secondary-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .links-row {
          display: flex; justify-content: space-between;
          margin-top: 20px; font-size: 13px;
        }
        .links-row a { color: #5c2d91; text-decoration: none; font-weight: 600; cursor: pointer; }
        .links-row a:hover { text-decoration: underline; }
        .links-row .back-link { width: 100%; text-align: center; }
        .error-message { color: #b91c1c; font-size: 13px; margin-top: 10px; }
        .footer { margin-top: 26px; font-size: 13px; color: #5c2d91; text-align: center; }

        /* Language switcher */
        .lang-switch { display: flex; gap: 6px; justify-content: center; margin-bottom: 20px; flex-wrap: wrap; }
        .lang-pill {
          padding: 6px 14px; border-radius: 20px; border: 1.5px solid #5c2d91;
          background: #fff; color: #5c2d91; font-size: 12px; font-weight: 700;
          cursor: pointer;
        }
        .lang-pill.active { background: #5c2d91; color: #fff; }

        /* Mobile-only greeting vs desktop brand name */
        .brand-mobile { display: none; }

        /* Dropdown language switcher — lives in the mobile header;
           hidden on desktop where the pill switcher (in the card) is used. */
        .lang-switch-header { display: none; }
        .lang-dropdown { position: relative; display: inline-flex; }
        .lang-dropdown-trigger {
          display: flex; align-items: center; gap: 8px;
          padding: 7px 16px; border-radius: 20px; border: 1.5px solid #5c2d91;
          background: #fff; color: #5c2d91; font-size: 13px; font-weight: 700;
          cursor: pointer;
        }
        .lang-caret { transition: transform .15s ease; flex-shrink: 0; }
        .lang-caret.open { transform: rotate(180deg); }
        .lang-dropdown-menu {
          position: absolute; top: calc(100% + 6px); left: 50%; transform: translateX(-50%);
          background: #fff; border: 1.5px solid #5c2d91; border-radius: 12px;
          min-width: 150px; box-shadow: 0 10px 24px rgba(92,45,145,0.18);
          overflow: hidden; z-index: 20;
        }
        .lang-dropdown-item {
          display: block; width: 100%; text-align: center; padding: 10px 14px;
          background: #fff; border: none; border-bottom: 1px solid #f0eaf9;
          color: #5c2d91; font-size: 13px; font-weight: 600; cursor: pointer;
        }
        .lang-dropdown-item:last-child { border-bottom: none; }
        .lang-dropdown-item:hover { background: #f6f2fc; }
        .lang-dropdown-item.active { background: #f6f2fc; font-weight: 800; }
        .lang-backdrop { position: fixed; inset: 0; z-index: 10; background: transparent; }

        /* Soft decorative background art — mobile only */
        .bg-art { display: none; }

        /* Wizard step indicator */
        .wizard-steps { display: flex; align-items: center; gap: 6px; margin: 4px 0 22px; }
        .wizard-dot { width: 24px; height: 24px; border-radius: 50%; background: #e9e3f6; color: #5c2d91; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; flex-shrink: 0; }
        .wizard-dot.done { background: #10b981; color: #fff; }
        .wizard-dot.current { background: #5c2d91; color: #fff; }
        .wizard-line { flex-grow: 1; height: 2px; background: #e9e3f6; margin: 0 2px; }

        .status-box { padding: 14px 16px; border-radius: 6px; font-size: 13px; margin-top: 4px; margin-bottom: 12px; line-height: 1.5; }
        .status-box.info { background: #f6f2fc; color: #5c2d91; border: 1px solid #ddd0f0; }

        /* ============================================================
           MOBILE LAYOUT
           Below 768px the two-panel split collapses into a single
           stacked column: a compact brand header up top, the active
           card takes the full width beneath it. Desktop panels above
           this breakpoint are untouched.
        ============================================================ */
        @media (max-width: 768px) {
          .split { flex-direction: column; min-height: 100vh; background: #5c2d91; position: relative; }
          .bg-art { display: block; position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 0; pointer-events: none; }
          .left-panel {
            flex: none; min-height: 0; padding: 46px 20px 30px;
            background: transparent; position: relative; z-index: 2;
          }
          .left-panel .brand, .left-panel .lang-switch-header { position: relative; z-index: 1; }
          .left-panel .logo-circle { display: none; }
          .left-panel .brand-desktop { display: none; }
          .left-panel .brand-mobile {
            display: block; color: #fff; font-size: 30px; font-weight: 900;
            letter-spacing: 0.5px; line-height: 1.2; text-transform: uppercase;
            margin-top: 0;
          }
          .left-panel .tagline { display: none; }

          /* Language switcher moves from the card into the header,
             directly under the "Welcome Back" greeting, and becomes
             a compact dropdown instead of three pills side by side. */
          .lang-switch-card { display: none; }
          .lang-switch-header { display: flex; justify-content: center; margin-top: 18px; }

          .right-panel {
            flex: 1; padding: 14px 16px 32px; align-items: center;
            background: transparent; position: relative; z-index: 1;
          }
          .login-card {
            width: 100%; max-width: 100%; padding: 22px 18px; border-radius: 18px;
            box-shadow: 0 12px 32px rgba(0,0,0,0.28); margin-top: -10px;
          }
          .login-card h2 { font-size: 19px; }
          .login-card .sub { font-size: 13px; margin-bottom: 18px; }
          .login-card label { font-size: 13px; margin-top: 12px; }
          .login-card input { padding: 11px 10px; font-size: 16px; } /* 16px avoids iOS zoom-on-focus */
          .primary, .secondary-btn { padding: 13px; margin-top: 16px; font-size: 13px; }
          .wizard-steps { margin: 2px 0 16px; }
          .lang-switch { margin-bottom: 14px; gap: 5px; }
          .lang-pill { padding: 5px 11px; font-size: 11px; }
        }
      `}</style>

      <main className="split">
        <BackgroundArt />

        {/* LEFT / TOP PANEL */}
        <section className="left-panel">
          <div className="brand">
            <div className="logo-circle">AI</div>
            <h1 className="brand-desktop">FinBud</h1>
            <h1 className="brand-mobile">{t.login.greeting}<br />FinBud AI</h1>
            <p className="tagline">{t.tagline}</p>
          </div>
          <LanguageDropdown />
        </section>

        {/* RIGHT / BOTTOM PANEL */}
        <section className="right-panel">
          <div className="login-card" dir={t.dir}>
            <LanguageSwitch />

            {/* LOGIN */}
            {activeCard === 'login' && (
              <div>
                <h2>{t.login.title}</h2>
                <form onSubmit={handleLogin}>
                  <label>{t.login.phone}</label>
                  <input type="tel" required inputMode="numeric" placeholder={t.login.phonePh} maxLength={12}
                    value={loginPhone} onChange={e => setLoginPhone(formatPhone(e.target.value))} />
                  <label>{t.login.pin}</label>
                  <input type="password" required inputMode="numeric" maxLength={5}
                    value={loginPin} onChange={e => setLoginPin(digitsOnly(e.target.value).slice(0, 5))} />
                  {loginError && <p className="error-message">{loginError}</p>}
                  <button className="primary" type="submit" disabled={loginLoading}>
                    {loginLoading ? t.login.loggingIn : t.login.loginBtn}
                  </button>
                </form>
                <div className="links-row">
                  <a onClick={() => { setForgotError(''); setActiveCard('forgotPhone') }}>{t.login.forgot}</a>
                  <a onClick={() => { setPhoneError(''); setPhone(''); setActiveCard('phone') }}>{t.login.newUser}</a>
                </div>
              </div>
            )}

            {/* SIGNUP STEP 1: PHONE */}
            {activeCard === 'phone' && (
              <div>
                <h2>{t.phoneStep.title}</h2>
                <p className="sub">{t.phoneStep.sub}</p>
                <StepDots current={1} />
                <form onSubmit={handlePhoneSubmit}>
                  <label>{t.phoneStep.phone}</label>
                  <input type="tel" required inputMode="numeric" placeholder={t.phoneStep.phonePh} maxLength={12}
                    value={phone} onChange={e => setPhone(formatPhone(e.target.value))} />
                  {phoneError && <p className="error-message">{phoneError}</p>}
                  <button className="primary" type="submit" disabled={phoneLoading}>
                    {phoneLoading ? '...' : t.phoneStep.next}
                  </button>
                </form>
                <div className="links-row">
                  <a className="back-link" onClick={() => setActiveCard('login')}>{t.phoneStep.back}</a>
                </div>
              </div>
            )}

            {/* SIGNUP STEP 2: OTP */}
            {activeCard === 'otp' && (
              <div>
                <h2>{t.otpStep.title}</h2>
                <p className="sub">{t.otpStep.sub}</p>
                <StepDots current={2} />
                <DemoOtpBanner code={devOtp} />
                <form onSubmit={handleOtpSubmit}>
                  <label>{t.otpStep.otp}</label>
                  <input type="text" required inputMode="numeric" placeholder={t.otpStep.otpPh} maxLength={6}
                    value={otp} onChange={e => setOtp(digitsOnly(e.target.value).slice(0, 6))} />
                  {otpError && <p className="error-message">{otpError}</p>}
                  <button className="primary" type="submit" disabled={otpLoading}>
                    {otpLoading ? '...' : t.otpStep.verify}
                  </button>
                </form>
                <div className="links-row">
                  <a className="back-link" onClick={() => setActiveCard('phone')}>{t.otpStep.back}</a>
                </div>
                <div className="links-row">
                  <a className="back-link" onClick={handleResendOtp}>{t.common.resend}</a>
                </div>
              </div>
            )}

            {/* SIGNUP STEP 3: CNIC */}
            {activeCard === 'cnic' && (
              <div>
                <h2>{t.cnicStep.title}</h2>
                <p className="sub">{t.cnicStep.sub}</p>
                <StepDots current={3} />
                <form onSubmit={handleCnicSubmit}>
                  <label>{t.cnicStep.cnic}</label>
                  <input type="text" required inputMode="numeric" placeholder={t.cnicStep.cnicPh} maxLength={15}
                    value={cnic} onChange={e => setCnic(formatCnic(e.target.value))} />
                  {cnicError && <p className="error-message">{cnicError}</p>}
                  <button className="primary" type="submit" disabled={cnicLoading}>
                    {cnicLoading ? t.cnicStep.verifying : t.cnicStep.next}
                  </button>
                </form>
                <div className="links-row">
                  <a className="back-link" onClick={() => setActiveCard('otp')}>{t.cnicStep.back}</a>
                </div>
              </div>
            )}

            {/* SIGNUP STEP 4: DISPLAY NAME + PIN */}
            {activeCard === 'setCredentials' && (
              <div>
                <h2>{t.setCredentials.title}</h2>
                <p className="sub">{t.setCredentials.sub}</p>
                <StepDots current={4} />
                <form onSubmit={handleSetCredentials}>
                  <label>{t.setCredentials.name}</label>
                  <input type="text" required placeholder={t.setCredentials.namePh}
                    value={displayName} onChange={e => setDisplayName(e.target.value)} />
                  <label>{t.setCredentials.pin}</label>
                  <input type="password" required inputMode="numeric" maxLength={5}
                    value={pin} onChange={e => setPin(digitsOnly(e.target.value).slice(0, 5))} />
                  <label>{t.setCredentials.confirmPin}</label>
                  <input type="password" required inputMode="numeric" maxLength={5}
                    value={confirmPin} onChange={e => setConfirmPin(digitsOnly(e.target.value).slice(0, 5))} />
                  {credError && <p className="error-message">{credError}</p>}
                  <button className="primary" type="submit" disabled={credLoading}>
                    {credLoading ? t.setCredentials.creating : t.setCredentials.finish}
                  </button>
                </form>
                <div className="links-row">
                  <a className="back-link" onClick={() => setActiveCard('cnic')}>{t.setCredentials.back}</a>
                </div>
              </div>
            )}

            {/* FORGOT PIN — STEP A: PHONE */}
            {activeCard === 'forgotPhone' && (
              <div>
                <h2>{t.forgotPhone.title}</h2>
                <p className="sub">{t.forgotPhone.sub}</p>
                <form onSubmit={handleForgotPhoneSubmit}>
                  <label>{t.forgotPhone.phone}</label>
                  <input type="tel" required inputMode="numeric" placeholder={t.forgotPhone.phonePh} maxLength={12}
                    value={forgotPhone} onChange={e => setForgotPhone(formatPhone(e.target.value))} />
                  {forgotError && <p className="error-message">{forgotError}</p>}
                  <button className="primary" type="submit" disabled={forgotLoading}>
                    {forgotLoading ? '...' : t.forgotPhone.send}
                  </button>
                </form>
                <div className="links-row">
                  <a className="back-link" onClick={() => setActiveCard('login')}>{t.forgotPhone.back}</a>
                </div>
              </div>
            )}

            {/* FORGOT PIN — STEP B: OTP + NEW PIN */}
            {activeCard === 'forgotReset' && (
              <div>
                <h2>{t.forgotReset.title}</h2>
                <p className="sub">{t.forgotReset.sub}</p>
                <DemoOtpBanner code={forgotDevOtp} />
                <form onSubmit={handleForgotResetSubmit}>
                  <label>{t.forgotReset.otp}</label>
                  <input type="text" required inputMode="numeric" placeholder={t.forgotReset.otpPh} maxLength={6}
                    value={forgotOtp} onChange={e => setForgotOtp(digitsOnly(e.target.value).slice(0, 6))} />
                  <label>{t.forgotReset.newPin}</label>
                  <input type="password" required inputMode="numeric" maxLength={5}
                    value={forgotNewPin} onChange={e => setForgotNewPin(digitsOnly(e.target.value).slice(0, 5))} />
                  <label>{t.forgotReset.confirmPin}</label>
                  <input type="password" required inputMode="numeric" maxLength={5}
                    value={forgotConfirmPin} onChange={e => setForgotConfirmPin(digitsOnly(e.target.value).slice(0, 5))} />
                  {forgotError && <p className="error-message">{forgotError}</p>}
                  <button className="primary" type="submit" disabled={forgotLoading}>
                    {forgotLoading ? '...' : t.forgotReset.reset}
                  </button>
                </form>
                <div className="links-row">
                  <a className="back-link" onClick={() => setActiveCard('forgotPhone')}>{t.forgotReset.back}</a>
                </div>
              </div>
            )}

            <footer className="footer">{t.footer}</footer>
          </div>
        </section>
      </main>
    </>
  )
}