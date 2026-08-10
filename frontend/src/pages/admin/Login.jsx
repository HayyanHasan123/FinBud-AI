import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { adminPost } from '../../utils/adminApi'

export default function AdminLogin() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const data = await adminPost('/login', { email, password })
      if (data && data.success) {
        navigate('/admin/dashboard')
      } else {
        setError((data && data.message) || 'Invalid credentials')
      }
    } catch (err) {
      setError(err.message || 'Server error. Please try again.')
    }
    setLoading(false)
  }

  return (
    <>
      <style>{`
        html, body { margin: 0; padding: 0; min-height: 100vh; width: 100%; }
        html { background: #5c2d91; }
        body { background: #5c2d91; }
        #root { display: flex; min-height: 100vh; width: 100%; margin: 0; padding: 0; max-width: none; border-inline: none; text-align: left; }
        * { box-sizing: border-box; font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue", Arial; }
        .admin-split { display: flex; min-height: 100vh; width: 100%; margin: 0; padding: 0; }
        .admin-left-panel {
          flex: 1; background: #5c2d91;
          display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          padding: 32px; color: #fff;
        }
        .admin-brand { display: flex; flex-direction: column; align-items: center; gap: 8px; }
        .admin-logo-circle {
          width: 88px; height: 88px; border-radius: 50%;
          background: #fff; color: #5c2d91;
          display: flex; align-items: center; justify-content: center;
          font-weight: 700; font-size: 32px;
        }
        .admin-brand h1 { font-size: 32px; margin-top: 10px; margin-bottom: 5px; color: #fff; letter-spacing: 2px; }
        .admin-tagline { font-size: 14px; font-weight: 500; margin-top: 15px; text-transform: uppercase; color: #fff; text-align: center; max-width: 320px; letter-spacing: 1px; }
        .admin-right-panel {
          flex: 1; display: flex; align-items: center;
          justify-content: center; padding: 32px; background: #e9e3f6;
        }
        .admin-login-card {
          width: 400px; background: #fff;
          padding: 36px; border-radius: 8px;
          display: flex; flex-direction: column;
        }
        .admin-login-card h2 { margin: 0 0 6px 0; text-transform: uppercase; font-weight: 900; color: #111; }
        .admin-login-card .sub { margin: 0 0 24px 0; color: #444; font-size: 14px; line-height: 1.5; }
        .admin-login-card label { display: block; font-size: 14px; margin-top: 16px; color: #111; font-weight: 500; text-align: left; }
        .admin-login-card input {
          width: 100%; padding: 12px 10px; margin-top: 6px;
          border: 1px solid #e6e9ef; border-radius: 4px; font-size: 14px; outline: none;
        }
        .admin-login-card input:focus { border-color: #5c2d91; }
        .admin-primary {
          width: 100%; padding: 14px; margin-top: 22px;
          background: #5c2d91; color: #fff; border: none;
          border-radius: 4px; cursor: pointer; font-weight: 600;
          text-transform: uppercase; font-size: 14px;
        }
        .admin-primary:disabled { opacity: 0.6; cursor: not-allowed; }
        .admin-error { color: #b91c1c; font-size: 13px; margin-top: 10px; }
        .admin-footer-note { margin-top: 26px; font-size: 12px; color: #6b6280; text-align: center; line-height: 1.5; }

        @media (max-width: 768px) {
          .admin-split { flex-direction: column; }
          .admin-left-panel { min-height: 180px; }
          .admin-right-panel { padding: 20px; }
          .admin-login-card { width: 100%; max-width: 440px; }
        }
      `}</style>

      <main className="admin-split">
        <section className="admin-left-panel">
          <div className="admin-brand">
            <div className="admin-logo-circle">AI</div>
            <h1>FinBud</h1>
            <p className="admin-tagline">Ops Console</p>
          </div>
        </section>

        <section className="admin-right-panel">
          <div className="admin-login-card">
            <h2>Staff Sign In</h2>
            <p className="sub">Admin and banker access only.</p>

            <form onSubmit={handleSubmit}>
              <label>Email</label>
              <input type="email" required autoFocus placeholder="name@finbud.internal"
                value={email} onChange={e => setEmail(e.target.value)} />
              <label>Password</label>
              <input type="password" required
                value={password} onChange={e => setPassword(e.target.value)} />
              {error && <p className="admin-error">{error}</p>}
              <button className="admin-primary" type="submit" disabled={loading}>
                {loading ? 'Signing in...' : 'Sign In'}
              </button>
            </form>

            <p className="admin-footer-note">This console is restricted to authorized FinBud AI staff.<br />Unauthorized access attempts are logged.</p>
          </div>
        </section>
      </main>
    </>
  )
}