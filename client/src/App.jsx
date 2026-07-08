import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import api from './api'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Clients from './pages/Clients'
import Suppliers from './pages/Suppliers'
import Markings from './pages/Markings'
import Products from './pages/Products'
import Tariffs from './pages/Tariffs'
import Purchases from './pages/Purchases'
import Receipts from './pages/Receipts'
import Sales from './pages/Sales'
import MoneyAssets from './pages/MoneyAssets'
import Liabilities from './pages/Liabilities'
import Debts from './pages/Debts'
import Payments from './pages/Payments'
import Finance from './pages/Finance'
import Accounts from './pages/Accounts'
import Transactions from './pages/Transactions'
import Expenses from './pages/Expenses'
import Ledger from './pages/Ledger'
import Audit from './pages/Audit'
import OperationLogs from './pages/OperationLogs'
import Analytics from './pages/Analytics'
import AICommands from './pages/AICommands'

function LoginScreen({ onLogin }) {
  const [form, setForm] = useState({ username: '', password: '' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (event) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await onLogin(form)
    } catch (e) {
      setError(e.message || 'Не удалось войти')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-panel" onSubmit={submit}>
        <div className="auth-brand">
          <div className="auth-title">Cargo Manager</div>
          <div className="auth-subtitle">Вход в рабочую панель</div>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        <div className="form-group">
          <label className="form-label">Логин</label>
          <input
            className="form-input"
            value={form.username}
            onChange={(e) => setForm((prev) => ({ ...prev, username: e.target.value }))}
            autoComplete="username"
            autoFocus
          />
        </div>
        <div className="form-group">
          <label className="form-label">Пароль</label>
          <input
            type="password"
            className="form-input"
            value={form.password}
            onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
            autoComplete="current-password"
          />
        </div>
        <button className="btn btn-primary auth-submit" type="submit" disabled={saving}>
          {saving ? 'Проверка...' : 'Войти'}
        </button>
      </form>
    </div>
  )
}

export default function App() {
  const [auth, setAuth] = useState({ loading: true, user: null })

  useEffect(() => {
    let mounted = true
    api.getAuthMe()
      .then((data) => {
        if (!mounted) return
        setAuth({ loading: false, user: data.authenticated ? data.user : null })
      })
      .catch(() => {
        if (mounted) setAuth({ loading: false, user: null })
      })
    return () => { mounted = false }
  }, [])

  const login = async (credentials) => {
    const data = await api.login(credentials)
    setAuth({ loading: false, user: data.user })
  }

  const logout = async () => {
    try {
      await api.logout()
    } finally {
      setAuth({ loading: false, user: null })
    }
  }

  if (auth.loading) {
    return (
      <div className="auth-screen">
        <div className="loading">Загрузка...</div>
      </div>
    )
  }

  if (!auth.user) return <LoginScreen onLogin={login} />

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout user={auth.user} onLogout={logout} />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="clients" element={<Clients />} />
          <Route path="suppliers" element={<Suppliers />} />
          <Route path="markings" element={<Markings />} />
          <Route path="products" element={<Products />} />
          <Route path="tariffs" element={<Tariffs />} />
          <Route path="purchases" element={<Purchases />} />
          <Route path="receipts" element={<Receipts />} />
          <Route path="sales" element={<Sales />} />
          <Route path="money-assets" element={<MoneyAssets />} />
          <Route path="liabilities" element={<Liabilities />} />
          <Route path="debts" element={<Debts />} />
          <Route path="payments" element={<Payments />} />
          <Route path="finance" element={<Finance />} />
          <Route path="accounts" element={<Accounts />} />
          <Route path="transactions" element={<Transactions />} />
          <Route path="expenses" element={<Expenses />} />
          <Route path="ledger" element={<Ledger />} />
          <Route path="audit" element={<Audit />} />
          <Route path="operation-logs" element={<OperationLogs />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="ai" element={<AICommands />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
