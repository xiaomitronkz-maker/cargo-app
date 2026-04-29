import { useEffect, useState } from 'react'
import api from '../api'

const fmt = (n) => '$' + (+n || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function Accounts() {
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const load = () => {
    setLoading(true)
    api.getAccounts().then(setAccounts).finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const createAccount = async () => {
    setSaving(true)
    setError('')
    try {
      await api.createAccount({ name, currency: 'USD' })
      setName('')
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Кассы</div>
          <div className="page-subtitle">{accounts.length} счетов</div>
        </div>
      </div>

      <div className="filters-bar">
        <input className="form-input filter-input" value={name} onChange={e => setName(e.target.value)} placeholder="Название кассы" />
        <button className="btn btn-primary" onClick={createAccount} disabled={saving}>
          {saving ? 'Сохранение...' : '+ Добавить кассу'}
        </button>
      </div>
      {error && <div className="alert alert-error">{error}</div>}

      {loading ? <div className="loading">Загрузка...</div> : (
        <div className="stat-grid">
          {accounts.length === 0 && (
            <div className="stat-card">
              <div className="stat-label">Кассы</div>
              <div className="stat-sub">Кассы не созданы</div>
            </div>
          )}
          {accounts.map(account => (
            <div className="stat-card" key={account.id}>
              <div className="stat-label">{account.name}</div>
              <div className="stat-value positive">{fmt(account.balance)}</div>
              <div className="stat-sub">{account.currency}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
