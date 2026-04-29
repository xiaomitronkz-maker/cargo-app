import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Modal from '../components/Modal'
import api from '../api'

const fmt = (n) => '$' + (+n || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function FinanceCard({ label, value, tone }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone || ''}`}>{fmt(value)}</div>
    </div>
  )
}

export default function Finance() {
  const navigate = useNavigate()
  const [summary, setSummary] = useState(null)
  const [profitSummary, setProfitSummary] = useState(null)
  const [debts, setDebts] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(null)
  const [accountForm, setAccountForm] = useState({ name: '', currency: 'USD' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const load = () => {
    setLoading(true)
    Promise.all([api.getDebtsSummary(), api.getDebtsBySuppliers(), api.getAccounts(), api.getProfitSummary(), api.getDebts()])
      .then(([summaryData, suppliersData, accountsData, profitData, debtsData]) => {
        setSummary(summaryData)
        setSuppliers(suppliersData)
        setAccounts(accountsData)
        setProfitSummary(profitData)
        setDebts(debtsData)
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const createAccount = async () => {
    setSaving(true); setError('')
    try {
      await api.createAccount(accountForm)
      setAccountForm({ name: '', currency: 'USD' })
      setModal(null)
      await load()
    } catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }

  if (loading) return <div className="loading">Загрузка...</div>

  const receivable = summary?.receivable?.total || 0
  const payable = debts
    .filter(debt => debt.type === 'payable')
    .reduce((sum, debt) => sum + (+debt.debt || 0), 0)
  const balance = receivable - payable
  const profit = profitSummary?.profit || 0
  const cash = accounts.reduce((sum, account) => sum + (+account.balance || 0), 0)
  const assets = cash + receivable
  const liabilities = payable
  const control = assets - (liabilities + profit)
  const isOk = Math.abs(control) < 0.01

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Баланс</div>
          <div className="page-subtitle">Баланс бизнеса</div>
        </div>
        <div className="td-actions">
          <button className="btn btn-secondary" onClick={() => navigate('/audit')}>Перейти в аудит</button>
          <button className="btn btn-primary" onClick={() => setModal('account')}>+ Добавить кассу</button>
        </div>
      </div>

      <div className="stat-grid">
        <FinanceCard label="💰 Деньги" value={cash} tone={cash >= 0 ? 'positive' : 'negative'} />
        <FinanceCard label="📥 Нам должны" value={receivable} tone="positive" />
        <FinanceCard label="📤 Мы должны" value={payable} tone="negative" />
        <FinanceCard label="📊 Прибыль" value={profit} tone={profit >= 0 ? 'positive' : 'negative'} />
        <FinanceCard label="🧮 Контроль" value={control} tone={isOk ? 'positive' : 'negative'} />
      </div>

      <div className={`alert ${isOk ? 'alert-success' : 'alert-error'}`} style={{ marginBottom: 20 }}>
        {isOk ? 'Баланс сошелся' : `Ошибка баланса: ${fmt(control)}`}
        {!isOk && (
          <div style={{ marginTop: 8 }}>
            assets: {fmt(assets)} · liabilities: {fmt(liabilities)} · profit: {fmt(profit)}
          </div>
        )}
      </div>

      <div className="table-wrapper" style={{ marginBottom: 20 }}>
        <table>
          <thead>
            <tr>
              <th>Касса</th>
              <th>Валюта</th>
              <th>Остаток</th>
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 && (
              <tr><td colSpan={3}>
                <div className="empty-state"><p>Кассы не созданы</p></div>
              </td></tr>
            )}
            {accounts.map(a => (
              <tr key={a.id}>
                <td style={{ fontWeight: 600 }}>{a.name}</td>
                <td className="td-muted">{a.currency}</td>
                <td>
                  <span className={`badge ${(+a.balance || 0) >= 0 ? 'badge-success' : 'badge-danger'}`} style={{ fontSize: 13 }}>
                    {fmt(a.balance)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Поставщик</th>
              <th>Долг</th>
            </tr>
          </thead>
          <tbody>
            {suppliers.length === 0 && (
              <tr><td colSpan={2}>
                <div className="empty-state"><p>Долгов поставщикам нет</p></div>
              </td></tr>
            )}
            {suppliers.map(s => (
              <tr key={s.id}>
                <td style={{ fontWeight: 600 }}>{s.name}</td>
                <td>
                  <span className="badge badge-warning" style={{ fontSize: 13 }}>{fmt(s.debt)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal === 'account' && (
        <Modal
          title="Новая касса"
          onClose={() => setModal(null)}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setModal(null)}>Отмена</button>
              <button className="btn btn-primary" onClick={createAccount} disabled={saving}>
                {saving ? 'Сохранение...' : 'Сохранить'}
              </button>
            </>
          }
        >
          {error && <div className="alert alert-error">{error}</div>}
          <div className="form-group">
            <label className="form-label">Название <span className="required">*</span></label>
            <input className="form-input" value={accountForm.name} onChange={e => setAccountForm(f => ({ ...f, name: e.target.value }))} placeholder="Касса USD" autoFocus />
          </div>
          <div className="form-group">
            <label className="form-label">Валюта <span className="required">*</span></label>
            <input className="form-input" value={accountForm.currency} onChange={e => setAccountForm(f => ({ ...f, currency: e.target.value }))} placeholder="USD" />
          </div>
        </Modal>
      )}
    </div>
  )
}
