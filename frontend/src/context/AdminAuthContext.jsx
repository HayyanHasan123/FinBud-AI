import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { adminGet, adminPost } from '../utils/adminApi'

const AdminAuthContext = createContext(null)

// Wraps the whole /admin/* route group (everything except /admin/login) in
// App.jsx:
//   <Route path="/admin" element={<AdminAuthProvider><AdminLayout /></AdminAuthProvider>}>
//     <Route path="dashboard" element={<AdminOverview />} />
//     ...
//   </Route>
export function AdminAuthProvider({ children }) {
  const navigate = useNavigate()
  const [admin, setAdmin] = useState(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const data = await adminGet('/me')
      if (data && data.success) {
        setAdmin({ name: data.name, email: data.email, role: data.role })
      } else {
        setAdmin(null)
        navigate('/admin/login')
      }
    } catch {
      setAdmin(null)
      navigate('/admin/login')
    }
    setLoading(false)
  }, [navigate])

  useEffect(() => { refresh() }, [refresh])

  async function logout() {
    try { await adminPost('/logout', {}) }
    finally {
      setAdmin(null)
      navigate('/admin/login')
    }
  }

  const value = {
    admin,
    loading,
    isAdmin: admin?.role === 'admin',
    isBanker: admin?.role === 'banker',
    refresh,
    logout
  }

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh', background: '#f2f2f2', display: 'flex',
        alignItems: 'center', justifyContent: 'center', color: '#5c2d91',
        fontFamily: 'Inter, sans-serif', fontSize: 14, fontWeight: 600
      }}>
        Loading console...
      </div>
    )
  }
  if (!admin) return null // navigate() to /admin/login already fired

  return (
    <AdminAuthContext.Provider value={value}>
      {children}
    </AdminAuthContext.Provider>
  )
}

export function useAdminAuth() {
  const ctx = useContext(AdminAuthContext)
  if (!ctx) throw new Error('useAdminAuth must be called inside <AdminAuthProvider>')
  return ctx
}