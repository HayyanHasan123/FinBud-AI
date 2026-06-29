import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

const styles = {
  root: {
    '--primary-purple': '#5c2d91',
    '--secondary-purple': '#e9e3f6',
  }
}

export default function Login() {
  const navigate = useNavigate()
  const [activeCard, setActiveCard] = useState('login')
  const [tempAccountData, setTempAccountData] = useState({})

  // Login state
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)

  // Create account state
  const [newEmail, setNewEmail] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [createError, setCreateError] = useState('')

  // Set name state
  const [displayName, setDisplayName] = useState('')
  const [nameLoading, setNameLoading] = useState(false)

  // Forgot password state
  const [resetEmail, setResetEmail] = useState('')

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

  const handleCreateAccount = (e) => {
    e.preventDefault()
    setTempAccountData({ email: newEmail, password: newPassword })
    setActiveCard('setUsername')
  }

  const handleSetName = async (e) => {
    e.preventDefault()
    setNameLoading(true)
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: displayName,
          email: tempAccountData.email,
          password: tempAccountData.password,
          phone: ''
        })
      })
      const data = await res.json()
      if (res.ok && data.success) {
        setTempAccountData({})
        navigate('/dashboard')
      } else {
        alert('Account creation failed: ' + (data.message || 'Unknown error'))
      }
    } catch {
      alert('Server error. Please try again.')
    }
    setNameLoading(false)
  }

  const handleForgotPassword = (e) => {
    e.preventDefault()
    alert('Password reset feature coming soon! Please contact support.')
    setActiveCard('login')
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
        .tagline { font-size: 14px; font-weight: 500; margin-top: 15px; text-transform: uppercase; color: #fff; }
        .right-panel {
          flex: 1; display: flex; align-items: center;
          justify-content: center; padding: 32px; background: #e9e3f6;
        }
        .login-card {
          width: 420px; background: #fff;
          padding: 36px; border-radius: 8px;
          display: flex; flex-direction: column;
        }
        .login-card h2 { margin: 0 0 6px 0; text-transform: uppercase; font-weight: 900; color: #111; }
        .login-card .sub { margin: 0 0 24px 0; color: #111; font-size: 14px; }
        .login-card label { display: block; font-size: 14px; margin-top: 16px; color: #111; font-weight: 500; text-align: left; }
        .login-card input {
          width: 100%; padding: 12px 10px; margin-top: 6px;
          border: 1px solid #e6e9ef; border-radius: 4px; font-size: 14px;
        }
        .primary {
          width: 100%; padding: 14px; margin-top: 28px;
          background: #5c2d91; color: #fff; border: none;
          border-radius: 4px; cursor: pointer; font-weight: 600;
          text-transform: uppercase; font-size: 14px;
        }
        .primary:disabled { opacity: 0.6; cursor: not-allowed; }
        .links-row {
          display: flex; justify-content: space-between;
          margin-top: 20px; font-size: 13px;
        }
        .links-row a { color: #5c2d91; text-decoration: none; font-weight: 600; cursor: pointer; }
        .links-row a:hover { text-decoration: underline; }
        .links-row .back-link { width: 100%; text-align: center; }
        .error-message { color: #b91c1c; font-size: 13px; margin-top: 10px; }
        .footer { margin-top: 30px; font-size: 13px; color: #5c2d91; text-align: center; }
        @media (max-width: 768px) {
          .split { flex-direction: column; }
          .left-panel { min-height: 200px; }
          .right-panel { padding: 20px; }
          .login-card { width: 100%; max-width: 400px; }
        }
      `}</style>

      <main className="split">
        {/* LEFT PANEL */}
        <section className="left-panel">
          <div className="brand">
            <div className="logo-circle">AI</div>
            <h1>FinBud</h1>
            <p className="tagline">Your Voice‑Powered Banking Assistant</p>
          </div>
        </section>

        {/* RIGHT PANEL */}
        <section className="right-panel">
          <div className="login-card">

            {/* LOGIN */}
            {activeCard === 'login' && (
              <div>
                <h2>WELCOME BACK!</h2>
                <p className="sub">Sign in to access your account</p>
                <form onSubmit={handleLogin}>
                  <label>Email:</label>
                  <input type="email" required placeholder="name@example.com"
                    value={loginEmail} onChange={e => setLoginEmail(e.target.value)} />
                  <label>Password:</label>
                  <input type="password" required
                    value={loginPassword} onChange={e => setLoginPassword(e.target.value)} />
                  {loginError && <p className="error-message">{loginError}</p>}
                  <button className="primary" type="submit" disabled={loginLoading}>
                    {loginLoading ? 'Logging in...' : 'Log In'}
                  </button>
                </form>
                <div className="links-row">
                  <a onClick={() => setActiveCard('forgotPassword')}>Forgot password?</a>
                  <a onClick={() => setActiveCard('createAccount')}>New User? Create Account</a>
                </div>
              </div>
            )}

            {/* CREATE ACCOUNT */}
            {activeCard === 'createAccount' && (
              <div>
                <h2>CREATE ACCOUNT</h2>
                <p className="sub">Enter your email and password to register.</p>
                <form onSubmit={handleCreateAccount}>
                  <label>Email:</label>
                  <input type="email" required placeholder="name@example.com"
                    value={newEmail} onChange={e => setNewEmail(e.target.value)} />
                  <label>Create Password:</label>
                  <input type="password" required placeholder="Minimum 4 characters"
                    value={newPassword} onChange={e => setNewPassword(e.target.value)} />
                  {createError && <p className="error-message">{createError}</p>}
                  <button className="primary" type="submit">Next Step</button>
                </form>
                <div className="links-row">
                  <a className="back-link" onClick={() => setActiveCard('login')}>
                    Already have an account? Log In
                  </a>
                </div>
              </div>
            )}

            {/* SET USERNAME */}
            {activeCard === 'setUsername' && (
              <div>
                <h2>CHOOSE DISPLAY NAME</h2>
                <p className="sub">This name will appear on your dashboard.</p>
                <form onSubmit={handleSetName}>
                  <label>Display Name:</label>
                  <input type="text" required placeholder="e.g., Alex B."
                    value={displayName} onChange={e => setDisplayName(e.target.value)} />
                  <button className="primary" type="submit" disabled={nameLoading}>
                    {nameLoading ? 'Creating Account...' : 'Go to Dashboard'}
                  </button>
                </form>
                <div className="links-row">
                  <a className="back-link" onClick={() => setActiveCard('login')}>
                    Cancel & Back to Login
                  </a>
                </div>
              </div>
            )}

            {/* FORGOT PASSWORD */}
            {activeCard === 'forgotPassword' && (
              <div>
                <h2>FORGOT PASSWORD</h2>
                <p className="sub">Enter your email to receive a password reset code.</p>
                <form onSubmit={handleForgotPassword}>
                  <label>Email:</label>
                  <input type="email" required placeholder="name@example.com"
                    value={resetEmail} onChange={e => setResetEmail(e.target.value)} />
                  <button className="primary" type="submit">Send Reset Code</button>
                </form>
                <div className="links-row">
                  <a className="back-link" onClick={() => setActiveCard('login')}>Back to Login</a>
                </div>
              </div>
            )}

            <footer className="footer">© 2026 BankingAI</footer>
          </div>
        </section>
      </main>
    </>
  )
}