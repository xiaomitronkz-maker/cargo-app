import { useEffect, useState } from 'react'
import api from '../api'

const fmt = (n) => '$' + (+n || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const today = () => new Date().toISOString().slice(0, 10)

const accountName = (tx) => {
  if (tx.type === 'income') return tx.account_to_name || '—'
  if (tx.type === 'expense') return tx.account_from_name || '—'
  return `${tx.account_from_name || '—'} → ${tx.account_to_name || '—'}`
}

export default function Transactions() {
  const [transactions, setTransactions] = useState([])
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ account_from_id: '', account_to_id: '', amount: '' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const load = () => {
    setLoading(true)
    Promise.all([api.getTransactions(), api.getAccounts()])
      .then(([transactionsData, accountsData]) => {
        setTransactions(transactionsData)
        setAccounts(accountsData)
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const transfer = async () => {
    setSaving(true)
    setError('')
    if (!form.account_from_id || !form.account_to_id) {
      setError('Выберите кассы')
      setSaving(false)
      return
    }
    if (form.account_from_id === form.account_to_id) {
      setError('Кассы должны отличаться')
      setSaving(false)
      return
    }
    if (!(+form.amount > 0)) {
      setError('Сумма должна быть больше 0')
      setSaving(false)
      return
    }
    try {
      await api.createTransaction({
        type: 'transfer',
        amount: form.amount,
        account_from_id: form.account_from_id,
        account_to_id: form.account_to_id,
        date: today(),
      })
      setForm({ account_from_id: '', account_to_id: '', amount: '' })
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
          <div className="page-title">Движение денег</div>
          <div className="page-subtitle">{transactions.length} операций</div>
        </div>
        <button className="btn btn-secondary" onClick={load}>Обновить</button>
      </div>

      <div className="table-wrapper" style={{ marginBottom: 20 }}>
        <div style={{ padding: 16 }}>
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">Откуда</label>
              <select className="form-input" value={form.account_from_id} onChange={e => setForm(f => ({ ...f, account_from_id: e.target.value }))}>
                <option value="">Выберите кассу</option>
                {accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Куда</label>
              <select className="form-input" value={form.account_to_id} onChange={e => setForm(f => ({ ...f, account_to_id: e.target.value }))}>
                <option value="">Выберите кассу</option>
                {accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Сумма</label>
              <input type="number" min="0" step="0.01" className="form-input" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="0.00" />
            </div>
          </div>
          <div className="record-meta" style={{ marginBottom: 10 }}>
            <span>Списывается: {fmt(form.amount)}</span>
            <span>Поступает: {fmt(form.amount)}</span>
          </div>
          {error && <div className="alert alert-error" style={{ marginBottom: 10 }}>{error}</div>}
          <button className="btn btn-primary" onClick={transfer} disabled={saving}>
            {saving ? 'Перевод...' : 'Перевести'}
          </button>
        </div>
      </div>

      {loading ? <div className="loading">Загрузка...</div> : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Тип</th>
                <th>Сумма</th>
                <th>Счет</th>
                <th>Комментарий</th>
              </tr>
            </thead>
            <tbody>
              {transactions.length === 0 && (
                <tr><td colSpan={5}>
                  <div className="empty-state"><p>Движений нет</p></div>
                </td></tr>
              )}
              {transactions.map(tx => (
                <tr key={tx.id}>
                  <td className="td-muted">{tx.date}</td>
                  <td><span className="badge badge-neutral">{tx.type}</span></td>
                  <td className="td-mono">{fmt(tx.amount)}</td>
                  <td>{accountName(tx)}</td>
                  <td className="td-muted">{tx.comment || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
