import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'

// ============================================================
// LANGUAGE STRINGS (English / Urdu / Roman Urdu)
// ============================================================
const STRINGS = {
  en: {
    dir: 'ltr',
    tagline: 'Your Voice-Powered Banking Assistant',
    login: {
      title: 'WELCOME BACK!', sub: 'Sign in to access your account',
      email: 'Email:', password: 'Password:', loginBtn: 'Log In', loggingIn: 'Logging in...',
      forgot: 'Forgot password?', newUser: 'New User? Create Account',
      or: 'OR', fingerprintBtn: 'Use Fingerprint / Face ID', fingerprintChecking: 'Checking...',
      emailFirst: 'Enter your email above first, then tap fingerprint login.'
    },
    phoneCnic: {
      title: 'LET\'S GET STARTED', sub: 'Enter your phone number and CNIC to verify your identity.',
      phone: 'Phone Number:', phonePh: '0300-1234567',
      cnic: 'CNIC Number:', cnicPh: '42101-1234567-1',
      next: 'Continue', back: 'Already have an account? Log In',
      phoneErr: 'Enter a valid 11-digit phone number.', cnicErr: 'Enter a valid 13-digit CNIC number.'
    },
    createAccount: {
      title: 'CREATE ACCOUNT', sub: 'Enter your email and password to register.',
      email: 'Email:', password: 'Create Password:', passwordPh: 'Minimum 4 characters',
      next: 'Next Step', back: 'Back'
    },
    consent: {
      title: 'BEFORE WE CONTINUE',
      listen: 'Listen', understand: 'I understand and agree', continueBtn: 'Continue',
      progress: (n, total) => `${n} of ${total}`,
      screens: [
        { heading: 'Why we need your CNIC', body: 'We use your CNIC and phone number to verify it\'s really you, as required by the State Bank of Pakistan. We never share your CNIC with anyone outside FinBud without your permission.' },
        { heading: 'How we protect your data', body: 'Your information is encrypted and stored securely. You can review or delete what we\'ve stored about you at any time from Settings.' },
        { heading: 'About the AI Assistant', body: 'FinBud\'s assistant can check your balance, pay bills, and send money when you ask it to. It will always show you the details and ask for your password before moving any money — it never sends money without your confirmation.' }
      ]
    },
    setUsername: {
      title: 'CHOOSE DISPLAY NAME', sub: 'This name will appear on your dashboard.',
      name: 'Display Name:', namePh: 'e.g., Alex B.',
      finish: 'Go to Dashboard', creating: 'Creating Account...', back: 'Cancel & Back to Login'
    },
    biometric: {
      title: 'SECURE YOUR ACCOUNT', sub: 'Add fingerprint or face login so you don\'t have to type your password every time.',
      setup: 'Set Up Fingerprint / Face Login', settingUp: 'Waiting for your device...',
      skip: 'Do this later', success: 'Biometric login is set up! You can use it next time you log in.',
      unsupported: 'Your device or browser doesn\'t support fingerprint/face login. No problem — you can always use your password.',
      failed: 'That didn\'t work — you can always use your password instead.', continueBtn: 'Continue'
    },
    selfie: {
      title: 'IDENTITY PHOTO', sub: 'This helps us confirm it\'s really you. This is a photo capture only — full automated identity verification is part of our next development phase.',
      capture: 'Capture Photo', retake: 'Retake', continueBtn: 'Continue', skip: 'Do this later',
      camErr: 'Could not access camera. You can skip this step for now.'
    },
    forgotPassword: {
      title: 'FORGOT PASSWORD', sub: 'Enter your email to receive a password reset code.',
      email: 'Email:', send: 'Send Reset Code', back: 'Back to Login'
    },
    footer: '© 2026 FinBud AI'
  },
  ur: {
    dir: 'rtl',
    tagline: 'آپ کا آواز سے چلنے والا بینکنگ اسسٹنٹ',
    login: {
      title: 'خوش آمدید!', sub: 'اپنے اکاؤنٹ تک رسائی کے لیے لاگ ان کریں',
      email: 'ای میل:', password: 'پاس ورڈ:', loginBtn: 'لاگ ان کریں', loggingIn: 'لاگ ان ہو رہا ہے...',
      forgot: 'پاس ورڈ بھول گئے؟', newUser: 'نیا صارف؟ اکاؤنٹ بنائیں',
      or: 'یا', fingerprintBtn: 'فنگر پرنٹ / فیس آئی ڈی استعمال کریں', fingerprintChecking: 'چیک ہو رہا ہے...',
      emailFirst: 'پہلے اوپر اپنا ای میل درج کریں، پھر فنگر پرنٹ لاگ ان دبائیں۔'
    },
    phoneCnic: {
      title: 'آئیے شروع کرتے ہیں', sub: 'اپنی شناخت کی تصدیق کے لیے فون نمبر اور شناختی کارڈ نمبر درج کریں۔',
      phone: 'فون نمبر:', phonePh: '0300-1234567',
      cnic: 'شناختی کارڈ نمبر:', cnicPh: '42101-1234567-1',
      next: 'جاری رکھیں', back: 'پہلے سے اکاؤنٹ ہے؟ لاگ ان کریں',
      phoneErr: 'ایک درست 11 ہندسوں کا فون نمبر درج کریں۔', cnicErr: 'ایک درست 13 ہندسوں کا شناختی کارڈ نمبر درج کریں۔'
    },
    createAccount: {
      title: 'اکاؤنٹ بنائیں', sub: 'رجسٹر ہونے کے لیے اپنا ای میل اور پاس ورڈ درج کریں۔',
      email: 'ای میل:', password: 'پاس ورڈ بنائیں:', passwordPh: 'کم از کم 4 حروف',
      next: 'اگلا مرحلہ', back: 'واپس'
    },
    consent: {
      title: 'آگے بڑھنے سے پہلے',
      listen: 'سنیں', understand: 'میں سمجھتا/سمجھتی ہوں اور راضی ہوں', continueBtn: 'جاری رکھیں',
      progress: (n, total) => `${n} از ${total}`,
      screens: [
        { heading: 'ہمیں آپ کا شناختی کارڈ نمبر کیوں چاہیے', body: 'ہم اسٹیٹ بینک آف پاکستان کی ضرورت کے مطابق آپ کی شناخت کی تصدیق کے لیے آپ کا شناختی کارڈ نمبر اور فون نمبر استعمال کرتے ہیں۔ ہم آپ کی اجازت کے بغیر آپ کا شناختی کارڈ نمبر کسی کے ساتھ شیئر نہیں کرتے۔' },
        { heading: 'ہم آپ کا ڈیٹا کیسے محفوظ رکھتے ہیں', body: 'آپ کی معلومات کو خفیہ اور محفوظ طریقے سے محفوظ کیا جاتا ہے۔ آپ کسی بھی وقت سیٹنگز سے اپنا ڈیٹا دیکھ یا حذف کر سکتے ہیں۔' },
        { heading: 'اے آئی اسسٹنٹ کے بارے میں', body: 'فن بڈ کا اسسٹنٹ آپ کے کہنے پر بیلنس چیک کر سکتا ہے، بل ادا کر سکتا ہے، اور پیسے بھیج سکتا ہے۔ یہ ہمیشہ آپ کو تفصیلات دکھائے گا اور کوئی بھی رقم بھیجنے سے پہلے آپ کا پاس ورڈ مانگے گا۔' }
      ]
    },
    setUsername: {
      title: 'ڈسپلے نام منتخب کریں', sub: 'یہ نام آپ کے ڈیش بورڈ پر ظاہر ہوگا۔',
      name: 'ڈسپلے نام:', namePh: 'مثال کے طور پر، احمد خان',
      finish: 'ڈیش بورڈ پر جائیں', creating: 'اکاؤنٹ بنایا جا رہا ہے...', back: 'منسوخ کریں اور لاگ ان پر واپس جائیں'
    },
    biometric: {
      title: 'اپنا اکاؤنٹ محفوظ بنائیں', sub: 'فنگر پرنٹ یا فیس لاگ ان شامل کریں تاکہ آپ کو ہر بار پاس ورڈ نہ لکھنا پڑے۔',
      setup: 'فنگر پرنٹ / فیس لاگ ان سیٹ اپ کریں', settingUp: 'آپ کے ڈیوائس کا انتظار ہے...',
      skip: 'بعد میں کریں', success: 'بایومیٹرک لاگ ان سیٹ ہو گیا! اگلی بار آپ اسے استعمال کر سکتے ہیں۔',
      unsupported: 'آپ کا ڈیوائس یا براؤزر فنگر پرنٹ/فیس لاگ ان کو سپورٹ نہیں کرتا۔ کوئی بات نہیں — آپ ہمیشہ پاس ورڈ استعمال کر سکتے ہیں۔',
      failed: 'یہ کام نہیں ہوا — آپ اس کے بجائے ہمیشہ پاس ورڈ استعمال کر سکتے ہیں۔', continueBtn: 'جاری رکھیں'
    },
    selfie: {
      title: 'شناختی تصویر', sub: 'یہ ہمیں یقین دلانے میں مدد دیتا ہے کہ یہ واقعی آپ ہیں۔ یہ صرف ایک تصویر کیپچر ہے — مکمل خودکار شناختی تصدیق ہمارے اگلے مرحلے میں شامل ہوگی۔',
      capture: 'تصویر لیں', retake: 'دوبارہ لیں', continueBtn: 'جاری رکھیں', skip: 'بعد میں کریں',
      camErr: 'کیمرہ تک رسائی حاصل نہیں ہو سکی۔ آپ فی الحال یہ مرحلہ چھوڑ سکتے ہیں۔'
    },
    forgotPassword: {
      title: 'پاس ورڈ بھول گئے', sub: 'پاس ورڈ ری سیٹ کوڈ حاصل کرنے کے لیے اپنا ای میل درج کریں۔',
      email: 'ای میل:', send: 'ری سیٹ کوڈ بھیجیں', back: 'لاگ ان پر واپس جائیں'
    },
    footer: '© 2026 فن بڈ اے آئی'
  },
  ru: {
    dir: 'ltr',
    tagline: 'Aap ka Voice-Powered Banking Assistant',
    login: {
      title: 'WAPSI MUBARAK!', sub: 'Apne account tak rasai ke liye login karein',
      email: 'Email:', password: 'Password:', loginBtn: 'Log In', loggingIn: 'Login ho raha hai...',
      forgot: 'Password bhool gaye?', newUser: 'Naya user? Account banayein',
      or: 'YA', fingerprintBtn: 'Fingerprint / Face ID istemal karein', fingerprintChecking: 'Check ho raha hai...',
      emailFirst: 'Pehle upar apna email likhein, phir fingerprint login dabayein.'
    },
    phoneCnic: {
      title: 'CHALEIN SHURU KARTE HAIN', sub: 'Apni pehchan ki tasdeeq ke liye phone number aur CNIC number darj karein.',
      phone: 'Phone Number:', phonePh: '0300-1234567',
      cnic: 'CNIC Number:', cnicPh: '42101-1234567-1',
      next: 'Continue Karein', back: 'Pehle se account hai? Login Karein',
      phoneErr: 'Sahi 11-digit phone number darj karein.', cnicErr: 'Sahi 13-digit CNIC number darj karein.'
    },
    createAccount: {
      title: 'ACCOUNT BANAYEIN', sub: 'Register hone ke liye email aur password darj karein.',
      email: 'Email:', password: 'Password Banayein:', passwordPh: 'Kam se kam 4 characters',
      next: 'Agla Step', back: 'Wapis'
    },
    consent: {
      title: 'AAGE BADHNE SE PEHLE',
      listen: 'Sunein', understand: 'Mujhe samajh aa gaya aur main razi hoon', continueBtn: 'Continue Karein',
      progress: (n, total) => `${n} of ${total}`,
      screens: [
        { heading: 'Humein aapka CNIC kyun chahiye', body: 'State Bank of Pakistan ki requirement ke mutabiq, hum aapki pehchan tasdeeq karne ke liye aapka CNIC aur phone number istemal karte hain. Hum aapki ijazat ke baghair aapka CNIC kisi aur ke sath share nahi karte.' },
        { heading: 'Hum aapka data kaise mehfooz rakhte hain', body: 'Aapki maloomat encrypt aur mehfooz tareeqe se store ki jati hain. Aap kabhi bhi Settings se apna data dekh ya delete kar sakte hain.' },
        { heading: 'AI Assistant ke baare mein', body: 'FinBud ka assistant aapke kehne par balance check kar sakta hai, bill pay kar sakta hai, aur paisay bhej sakta hai. Yeh hamesha aapko tafseelat dikhayega aur koi bhi paisa bhejne se pehle aapka password poochega.' }
      ]
    },
    setUsername: {
      title: 'DISPLAY NAAM CHUNEIN', sub: 'Yeh naam aapke dashboard par nazar aayega.',
      name: 'Display Naam:', namePh: 'Misaal ke tor par, Ahmed Khan',
      finish: 'Dashboard Par Jayein', creating: 'Account banaya ja raha hai...', back: 'Cancel karein aur Login par wapis jayein'
    },
    biometric: {
      title: 'APNA ACCOUNT MEHFOOZ BANAYEIN', sub: 'Fingerprint ya face login add karein taake har bar password type na karna pare.',
      setup: 'Fingerprint / Face Login Set Up Karein', settingUp: 'Aapke device ka intezar hai...',
      skip: 'Baad mein karenge', success: 'Biometric login set ho gaya! Agli baar aap ise istemal kar sakte hain.',
      unsupported: 'Aapka device ya browser fingerprint/face login support nahi karta. Koi baat nahi — aap hamesha password istemal kar sakte hain.',
      failed: 'Yeh kaam nahi hua — aap iske bajaye hamesha password istemal kar sakte hain.', continueBtn: 'Continue Karein'
    },
    selfie: {
      title: 'PEHCHAN TASVEER', sub: 'Yeh humein yaqeen dilane mein madad deta hai ke yeh waqai aap hain. Yeh sirf ek photo capture hai — mukammal automated identity verification hamare agle phase mein shamil hogi.',
      capture: 'Tasveer Lein', retake: 'Dobara Lein', continueBtn: 'Continue Karein', skip: 'Baad mein karenge',
      camErr: 'Camera tak rasai nahi mil saki. Aap filhal yeh step skip kar sakte hain.'
    },
    forgotPassword: {
      title: 'PASSWORD BHOOL GAYE', sub: 'Password reset code hasil karne ke liye apna email darj karein.',
      email: 'Email:', send: 'Reset Code Bhejein', back: 'Login Par Wapis Jayein'
    },
    footer: '© 2026 FinBud AI'
  }
}

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ur', label: 'اردو' },
  { code: 'ru', label: 'Roman Urdu' }
]

const TOTAL_STEPS = 6

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

// WebAuthn base64url <-> ArrayBuffer helpers
function bufferToBase64url(buffer) {
  const bytes = new Uint8Array(buffer)
  let str = ''
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i])
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function base64urlToBuffer(base64url) {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4)
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const buffer = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) buffer[i] = raw.charCodeAt(i)
  return buffer.buffer
}

export default function Login() {
  const navigate = useNavigate()
  const [language, setLanguage] = useState('en')
  const t = STRINGS[language]

  const [activeCard, setActiveCard] = useState('login')
  const [tempAccountData, setTempAccountData] = useState({})
  const [webauthnSupported, setWebauthnSupported] = useState(false)

  useEffect(() => {
    setWebauthnSupported(typeof window !== 'undefined' && !!window.PublicKeyCredential)
  }, [])

  // Login state
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)
  const [bioLoginLoading, setBioLoginLoading] = useState(false)

  // Phone + CNIC state
  const [phone, setPhone] = useState('')
  const [cnic, setCnic] = useState('')
  const [phoneCnicError, setPhoneCnicError] = useState('')

  // Create account state
  const [newEmail, setNewEmail] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [createError, setCreateError] = useState('')

  // Consent state
  const [consentIndex, setConsentIndex] = useState(0)
  const [consentChecked, setConsentChecked] = useState(false)

  // Set name state
  const [displayName, setDisplayName] = useState('')
  const [nameLoading, setNameLoading] = useState(false)
  const [nameError, setNameError] = useState('')

  // Biometric setup state
  const [bioSetupLoading, setBioSetupLoading] = useState(false)
  const [bioSetupStatus, setBioSetupStatus] = useState(null) // null | 'success' | 'unsupported' | 'failed'

  // Forgot password state
  const [resetEmail, setResetEmail] = useState('')

  // ── LOGIN ──────────────────────────────────────────────
  const handleLogin = async (e) => {
    e.preventDefault()
    setLoginError('')
    setLoginLoading(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, password: loginPassword })
      })
      const data = await res.json()
      if (res.ok && data.success) {
        navigate('/dashboard')
      } else {
        setLoginError(data.message || 'Invalid credentials')
      }
    } catch {
      setLoginError('Server error. Please try again.')
    }
    setLoginLoading(false)
  }

  const handleBiometricLogin = async () => {
    if (!loginEmail) { setLoginError(t.login.emailFirst); return }
    setLoginError('')
    setBioLoginLoading(true)
    try {
      const optRes = await fetch('/api/auth/webauthn/login/options', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail })
      })
      if (optRes.status === 404) {
        setLoginError('Biometric login is not set up for this account yet.')
        setBioLoginLoading(false); return
      }
      const options = await optRes.json()
      const publicKey = {
        ...options,
        challenge: base64urlToBuffer(options.challenge),
        allowCredentials: (options.allowCredentials || []).map(c => ({ ...c, id: base64urlToBuffer(c.id) }))
      }
      const assertion = await navigator.credentials.get({ publicKey })
      const payload = {
        email: loginEmail,
        id: assertion.id,
        rawId: bufferToBase64url(assertion.rawId),
        type: assertion.type,
        response: {
          authenticatorData: bufferToBase64url(assertion.response.authenticatorData),
          clientDataJSON: bufferToBase64url(assertion.response.clientDataJSON),
          signature: bufferToBase64url(assertion.response.signature)
        }
      }
      const verifyRes = await fetch('/api/auth/webauthn/login/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify(payload)
      })
      const data = await verifyRes.json()
      if (data.success) navigate('/dashboard')
      else setLoginError(data.message || 'Fingerprint login failed. Please use your password.')
    } catch {
      setLoginError('Fingerprint login was cancelled or is unavailable.')
    }
    setBioLoginLoading(false)
  }

  // ── SIGNUP WIZARD ──────────────────────────────────────
  const handlePhoneCnicSubmit = (e) => {
    e.preventDefault()
    const phoneDigits = phone.replace(/\D/g, '')
    const cnicDigits = cnic.replace(/\D/g, '')
    if (phoneDigits.length !== 11) { setPhoneCnicError(t.phoneCnic.phoneErr); return }
    if (cnicDigits.length !== 13) { setPhoneCnicError(t.phoneCnic.cnicErr); return }
    setPhoneCnicError('')
    setTempAccountData(d => ({ ...d, phone: phoneDigits, cnic: cnicDigits }))
    setActiveCard('createAccount')
  }

  const handleCreateAccount = (e) => {
    e.preventDefault()
    setTempAccountData(d => ({ ...d, email: newEmail, password: newPassword }))
    setConsentIndex(0)
    setConsentChecked(false)
    setActiveCard('consent')
  }

  const handleListenConsent = () => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return
    const screen = t.consent.screens[consentIndex]
    const utterance = new SpeechSynthesisUtterance(`${screen.heading}. ${screen.body}`)
    utterance.lang = language === 'ur' ? 'ur-PK' : 'en-US'
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)
  }

  const handleConsentContinue = () => {
    if (!consentChecked) return
    const isLast = consentIndex === t.consent.screens.length - 1
    if (!isLast) {
      setConsentIndex(i => i + 1)
      setConsentChecked(false)
    } else {
      setTempAccountData(d => ({
        ...d,
        consents: { identity: true, data: true, ai_assistant: true },
        consent_accepted_at: new Date().toISOString(),
        language
      }))
      setActiveCard('setUsername')
    }
  }

  const handleSetName = async (e) => {
    e.preventDefault()
    setNameError('')
    setNameLoading(true)
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: displayName,
          email: tempAccountData.email,
          password: tempAccountData.password,
          phone: tempAccountData.phone,
          cnic: tempAccountData.cnic,
          language: tempAccountData.language || language,
          consents: tempAccountData.consents,
          consent_accepted_at: tempAccountData.consent_accepted_at
        })
      })
      const data = await res.json()
      if (res.ok && data.success) {
        setBioSetupStatus(null)
        setActiveCard('biometric')
      } else {
        setNameError(data.message || 'Account creation failed')
      }
    } catch {
      setNameError('Server error. Please try again.')
    }
    setNameLoading(false)
  }

  // ── BIOMETRIC SETUP ────────────────────────────────────
  const handleBiometricSetup = async () => {
    if (!webauthnSupported) { setBioSetupStatus('unsupported'); return }
    setBioSetupLoading(true)
    try {
      const optRes = await fetch('/api/auth/webauthn/register/options', {
        method: 'POST', credentials: 'include'
      })
      if (optRes.status === 404) { setBioSetupStatus('unsupported'); setBioSetupLoading(false); return }
      const options = await optRes.json()
      const publicKey = {
        ...options,
        challenge: base64urlToBuffer(options.challenge),
        user: { ...options.user, id: base64urlToBuffer(options.user.id) },
        excludeCredentials: (options.excludeCredentials || []).map(c => ({ ...c, id: base64urlToBuffer(c.id) }))
      }
      const credential = await navigator.credentials.create({ publicKey })
      const payload = {
        id: credential.id,
        rawId: bufferToBase64url(credential.rawId),
        type: credential.type,
        response: {
          attestationObject: bufferToBase64url(credential.response.attestationObject),
          clientDataJSON: bufferToBase64url(credential.response.clientDataJSON)
        }
      }
      const verifyRes = await fetch('/api/auth/webauthn/register/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify(payload)
      })
      const data = await verifyRes.json()
      setBioSetupStatus(data.success ? 'success' : 'failed')
    } catch {
      setBioSetupStatus('failed')
    }
    setBioSetupLoading(false)
  }

  // ── FORGOT PASSWORD ────────────────────────────────────
  const handleForgotPassword = (e) => {
    e.preventDefault()
    alert('Password reset feature coming soon! Please contact support.')
    setActiveCard('login')
  }

  // ── SHARED UI PIECES ────────────────────────────────────
  function LanguageSwitch() {
    return (
      <div className="lang-switch">
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

  // ── SELFIE CAPTURE (own component for camera lifecycle) ─
  function SelfieCapture() {
    const videoRef = useRef(null)
    const canvasRef = useRef(null)
    const streamRef = useRef(null)
    const [captured, setCaptured] = useState(null)
    const [camError, setCamError] = useState('')
    const [uploading, setUploading] = useState(false)

    useEffect(() => {
      startCamera()
      return () => stopCamera()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    async function startCamera() {
      setCamError('')
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } })
        streamRef.current = stream
        if (videoRef.current) videoRef.current.srcObject = stream
      } catch {
        setCamError(t.selfie.camErr)
      }
    }
    function stopCamera() {
      streamRef.current?.getTracks().forEach(tr => tr.stop())
      streamRef.current = null
    }
    function capture() {
      const video = videoRef.current, canvas = canvasRef.current
      if (!video || !canvas) return
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      canvas.getContext('2d').drawImage(video, 0, 0)
      setCaptured(canvas.toDataURL('image/jpeg', 0.85))
      stopCamera()
    }
    function retake() {
      setCaptured(null)
      startCamera()
    }
    async function finish(skip = false) {
      setUploading(true)
      try {
        if (!skip && captured) {
          const res = await fetch('/api/auth/selfie', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            credentials: 'include', body: JSON.stringify({ image: captured })
          })
          // 404 = endpoint not built yet on backend; don't block onboarding
          if (res.status !== 404) await res.json().catch(() => {})
        }
      } catch { /* non-blocking */ }
      setUploading(false)
      navigate('/dashboard')
    }

    return (
      <div>
        <h2>{t.selfie.title}</h2>
        <p className="sub">{t.selfie.sub}</p>
        <StepDots current={6} />
        <div className="camera-frame">
          {captured
            ? <img src={captured} alt="Captured selfie" className="camera-preview" />
            : <video ref={videoRef} autoPlay playsInline muted className="camera-preview" />}
          <canvas ref={canvasRef} style={{ display: 'none' }} />
        </div>
        {camError && <p className="error-message">{camError}</p>}
        {!captured ? (
          <button className="primary" type="button" onClick={capture} disabled={!!camError}>{t.selfie.capture}</button>
        ) : (
          <>
            <button className="primary" type="button" onClick={() => finish(false)} disabled={uploading}>
              {uploading ? '...' : t.selfie.continueBtn}
            </button>
            <button className="secondary-btn" type="button" onClick={retake}>{t.selfie.retake}</button>
          </>
        )}
        <div className="links-row">
          <a className="back-link" onClick={() => finish(true)}>{t.selfie.skip}</a>
        </div>
      </div>
    )
  }

  return (
    <>
      <style>{`
        html, body { margin: 0; padding: 0; min-height: 100vh; width: 100%; }
        html { background: #5c2d91; }
        body { background: #5c2d91; }
        #root { display: flex; min-height: 100vh; width: 100%; margin: 0; padding: 0; }
        * { box-sizing: border-box; font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue", Arial; }
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
        }
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

        /* Wizard step indicator */
        .wizard-steps { display: flex; align-items: center; gap: 6px; margin: 4px 0 22px; }
        .wizard-dot { width: 24px; height: 24px; border-radius: 50%; background: #e9e3f6; color: #5c2d91; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; flex-shrink: 0; }
        .wizard-dot.done { background: #10b981; color: #fff; }
        .wizard-dot.current { background: #5c2d91; color: #fff; }
        .wizard-line { flex-grow: 1; height: 2px; background: #e9e3f6; margin: 0 2px; }

        /* Fingerprint / biometric */
        .fingerprint-btn {
          width: 100%; padding: 14px; margin-top: 18px;
          background: #f6f2fc; color: #5c2d91; border: 1.5px solid #5c2d91;
          border-radius: 4px; cursor: pointer; font-weight: 700; font-size: 14px;
          display: flex; align-items: center; justify-content: center; gap: 10px;
        }
        .fingerprint-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .divider-row { display: flex; align-items: center; gap: 10px; margin: 18px 0; }
        .divider-row .line { flex-grow: 1; height: 1px; background: #e6e9ef; }
        .divider-row span { font-size: 11px; color: #9aa0ab; font-weight: 700; }
        .biometric-icon { font-size: 56px; text-align: center; margin: 10px 0 4px; }
        .status-box { padding: 14px 16px; border-radius: 6px; font-size: 13px; margin-top: 16px; line-height: 1.5; }
        .status-box.success { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; }
        .status-box.info { background: #f6f2fc; color: #5c2d91; border: 1px solid #ddd0f0; }

        /* Consent screens */
        .consent-box { background: #f6f2fc; padding: 18px; border-radius: 8px; margin: 6px 0 16px; }
        .consent-box h3 { margin: 0 0 8px; color: #5c2d91; font-size: 16px; }
        .consent-box p { margin: 0; font-size: 13.5px; line-height: 1.6; color: #333; }
        .listen-btn { background: none; border: 1px solid #5c2d91; color: #5c2d91; border-radius: 20px; padding: 5px 14px; font-size: 12px; font-weight: 700; cursor: pointer; margin-top: 12px; }
        .consent-progress { font-size: 12px; color: #9aa0ab; text-align: center; margin-bottom: 8px; }
        .checkbox-row { display: flex; align-items: flex-start; gap: 10px; margin-top: 16px; font-size: 13.5px; color: #333; }
        .checkbox-row input { width: auto; margin-top: 3px; }

        /* Selfie / camera */
        .camera-frame { width: 100%; aspect-ratio: 4/3; background: #111; border-radius: 8px; overflow: hidden; margin: 8px 0 16px; display: flex; align-items: center; justify-content: center; }
        .camera-preview { width: 100%; height: 100%; object-fit: cover; }

        @media (max-width: 768px) {
          .split { flex-direction: column; }
          .left-panel { min-height: 180px; }
          .right-panel { padding: 20px; }
          .login-card { width: 100%; max-width: 440px; }
        }
      `}</style>

      <main className="split">
        {/* LEFT PANEL */}
        <section className="left-panel">
          <div className="brand">
            <div className="logo-circle">AI</div>
            <h1>FinBud</h1>
            <p className="tagline">{t.tagline}</p>
          </div>
        </section>

        {/* RIGHT PANEL */}
        <section className="right-panel">
          <div className="login-card" dir={t.dir}>
            <LanguageSwitch />

            {/* LOGIN */}
            {activeCard === 'login' && (
              <div>
                <h2>{t.login.title}</h2>
                <p className="sub">{t.login.sub}</p>
                <form onSubmit={handleLogin}>
                  <label>{t.login.email}</label>
                  <input type="email" required placeholder="name@example.com"
                    value={loginEmail} onChange={e => setLoginEmail(e.target.value)} />
                  <label>{t.login.password}</label>
                  <input type="password" required
                    value={loginPassword} onChange={e => setLoginPassword(e.target.value)} />
                  {loginError && <p className="error-message">{loginError}</p>}
                  <button className="primary" type="submit" disabled={loginLoading}>
                    {loginLoading ? t.login.loggingIn : t.login.loginBtn}
                  </button>
                </form>

                {webauthnSupported && (
                  <>
                    <div className="divider-row"><div className="line" /><span>{t.login.or}</span><div className="line" /></div>
                    <button type="button" className="fingerprint-btn" onClick={handleBiometricLogin} disabled={bioLoginLoading}>
                      🔒 {bioLoginLoading ? t.login.fingerprintChecking : t.login.fingerprintBtn}
                    </button>
                  </>
                )}

                <div className="links-row">
                  <a onClick={() => setActiveCard('forgotPassword')}>{t.login.forgot}</a>
                  <a onClick={() => setActiveCard('phoneCnic')}>{t.login.newUser}</a>
                </div>
              </div>
            )}

            {/* STEP 1: PHONE + CNIC */}
            {activeCard === 'phoneCnic' && (
              <div>
                <h2>{t.phoneCnic.title}</h2>
                <p className="sub">{t.phoneCnic.sub}</p>
                <StepDots current={1} />
                <form onSubmit={handlePhoneCnicSubmit}>
                  <label>{t.phoneCnic.phone}</label>
                  <input type="tel" required inputMode="numeric" placeholder={t.phoneCnic.phonePh}
                    value={phone} onChange={e => setPhone(formatPhone(e.target.value))} maxLength={12} />
                  <label>{t.phoneCnic.cnic}</label>
                  <input type="text" required inputMode="numeric" placeholder={t.phoneCnic.cnicPh}
                    value={cnic} onChange={e => setCnic(formatCnic(e.target.value))} maxLength={15} />
                  {phoneCnicError && <p className="error-message">{phoneCnicError}</p>}
                  <button className="primary" type="submit">{t.phoneCnic.next}</button>
                </form>
                <div className="links-row">
                  <a className="back-link" onClick={() => setActiveCard('login')}>{t.phoneCnic.back}</a>
                </div>
              </div>
            )}

            {/* STEP 2: CREATE ACCOUNT */}
            {activeCard === 'createAccount' && (
              <div>
                <h2>{t.createAccount.title}</h2>
                <p className="sub">{t.createAccount.sub}</p>
                <StepDots current={2} />
                <form onSubmit={handleCreateAccount}>
                  <label>{t.createAccount.email}</label>
                  <input type="email" required placeholder="name@example.com"
                    value={newEmail} onChange={e => setNewEmail(e.target.value)} />
                  <label>{t.createAccount.password}</label>
                  <input type="password" required minLength={4} placeholder={t.createAccount.passwordPh}
                    value={newPassword} onChange={e => setNewPassword(e.target.value)} />
                  {createError && <p className="error-message">{createError}</p>}
                  <button className="primary" type="submit">{t.createAccount.next}</button>
                </form>
                <div className="links-row">
                  <a className="back-link" onClick={() => setActiveCard('phoneCnic')}>{t.createAccount.back}</a>
                </div>
              </div>
            )}

            {/* STEP 3: CONSENT */}
            {activeCard === 'consent' && (
              <div>
                <h2>{t.consent.title}</h2>
                <StepDots current={3} />
                <p className="consent-progress">{t.consent.progress(consentIndex + 1, t.consent.screens.length)}</p>
                <div className="consent-box">
                  <h3>{t.consent.screens[consentIndex].heading}</h3>
                  <p>{t.consent.screens[consentIndex].body}</p>
                  <button type="button" className="listen-btn" onClick={handleListenConsent}>🔊 {t.consent.listen}</button>
                </div>
                <label className="checkbox-row">
                  <input type="checkbox" checked={consentChecked} onChange={e => setConsentChecked(e.target.checked)} />
                  <span>{t.consent.understand}</span>
                </label>
                <button className="primary" type="button" disabled={!consentChecked} onClick={handleConsentContinue}>
                  {t.consent.continueBtn}
                </button>
              </div>
            )}

            {/* STEP 4: SET USERNAME */}
            {activeCard === 'setUsername' && (
              <div>
                <h2>{t.setUsername.title}</h2>
                <p className="sub">{t.setUsername.sub}</p>
                <StepDots current={4} />
                <form onSubmit={handleSetName}>
                  <label>{t.setUsername.name}</label>
                  <input type="text" required placeholder={t.setUsername.namePh}
                    value={displayName} onChange={e => setDisplayName(e.target.value)} />
                  {nameError && <p className="error-message">{nameError}</p>}
                  <button className="primary" type="submit" disabled={nameLoading}>
                    {nameLoading ? t.setUsername.creating : t.setUsername.finish}
                  </button>
                </form>
                <div className="links-row">
                  <a className="back-link" onClick={() => setActiveCard('login')}>{t.setUsername.back}</a>
                </div>
              </div>
            )}

            {/* STEP 5: BIOMETRIC SETUP */}
            {activeCard === 'biometric' && (
              <div>
                <h2>{t.biometric.title}</h2>
                <p className="sub">{t.biometric.sub}</p>
                <StepDots current={5} />
                <div className="biometric-icon">🔒</div>

                {bioSetupStatus === 'success' && <div className="status-box success">{t.biometric.success}</div>}
                {bioSetupStatus === 'unsupported' && <div className="status-box info">{t.biometric.unsupported}</div>}
                {bioSetupStatus === 'failed' && <div className="status-box info">{t.biometric.failed}</div>}

                {bioSetupStatus !== 'success' && bioSetupStatus !== 'unsupported' && (
                  <button className="primary" type="button" onClick={handleBiometricSetup} disabled={bioSetupLoading}>
                    {bioSetupLoading ? t.biometric.settingUp : t.biometric.setup}
                  </button>
                )}

                <button className="secondary-btn" type="button" onClick={() => setActiveCard('selfieCapture')}>
                  {bioSetupStatus ? t.biometric.continueBtn : t.biometric.skip}
                </button>
              </div>
            )}

            {/* STEP 6: SELFIE */}
            {activeCard === 'selfieCapture' && <SelfieCapture />}

            {/* FORGOT PASSWORD */}
            {activeCard === 'forgotPassword' && (
              <div>
                <h2>{t.forgotPassword.title}</h2>
                <p className="sub">{t.forgotPassword.sub}</p>
                <form onSubmit={handleForgotPassword}>
                  <label>{t.forgotPassword.email}</label>
                  <input type="email" required placeholder="name@example.com"
                    value={resetEmail} onChange={e => setResetEmail(e.target.value)} />
                  <button className="primary" type="submit">{t.forgotPassword.send}</button>
                </form>
                <div className="links-row">
                  <a className="back-link" onClick={() => setActiveCard('login')}>{t.forgotPassword.back}</a>
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