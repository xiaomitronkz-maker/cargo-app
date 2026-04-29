import { useEffect, useState } from 'react'
import api from '../api'
import { normalizeArray, toNumber } from '../utils/data'

const fmt = (n) => '$' + toNumber(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function MoneyAssets() {
  const [accounts, setAccounts] = useState([])
  const [debts, setDebts] = useState([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      const [accountsData, debtsData] = await Promise.all([
        api.getAccounts(),
        api.getDebts(),
      ])
      console.log('Analytics data:', { accountsData, debtsData })
      setAccounts(normalizeArray(accountsData))
      setDebts(normalizeArray(debtsData))
    } catch (e) {
      console.log('Analytics data:', null)
      setAccounts([])
      setDebts([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const safeAccounts = normalizeArray(accounts)
  const safeDebts = normalizeArray(debts)
  const cash = safeAccounts.reduce((sum, acc) => sum + toNumber(acc.balance), 0)
  const receivable = safeDebts
    .filter(debt => debt.type === 'receivable')
    .reduce((sum, debt) => sum + toNumber(debt.debt), 0)
  const inTransit = 0
  const transfers = 0
  const total = cash + receivable

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Активы</div>
          <div className="page-subtitle">Реальные деньги и дебиторка</div>
        </div>
        <button className="btn btn-secondary" onClick={load}>Обновить</button>
      </div>

      <div className="balance-grid" style={{ marginBottom: 20 }}>
        <div className="balance-card">
          <div className="balance-card-label">💵 Наличные</div>
          <div className="balance-card-value">{fmt(cash)}</div>
        </div>
        <div className="balance-card">
          <div className="balance-card-label">📄 Должники</div>
          <div className="balance-card-value">{fmt(receivable)}</div>
        </div>
        <div className="balance-card">
          <div className="balance-card-label">📊 Итого</div>
          <div className="balance-card-value" style={{ color: 'var(--primary-hover)' }}>{fmt(total)}</div>
        </div>
      </div>

      {loading ? <div className="loading">Загрузка...</div> : (
        <>
          <div className="table-wrapper" style={{ marginBottom: 20 }}>
            <table>
              <thead>
                <tr>
                  <th>Касса</th>
                  <th>Баланс</th>
                </tr>
              </thead>
              <tbody>
                {safeAccounts.length === 0 && (
                  <tr><td colSpan={2}>
                    <div className="empty-state"><p>Кассы не созданы</p></div>
                  </td></tr>
                )}
                {safeAccounts.map(account => (
                  <tr key={account.id}>
                    <td style={{ fontWeight: 600 }}>{account.name}</td>
                    <td className="td-mono">{fmt(account.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="balance-grid">
            <div className="balance-card">
              <div className="balance-card-label">🚚 В дороге</div>
              <div className="balance-card-value" style={{ color: 'var(--text-muted)' }}>{fmt(inTransit)}</div>
            </div>
            <div className="balance-card">
              <div className="balance-card-label">🔄 Переводы</div>
              <div className="balance-card-value" style={{ color: 'var(--text-muted)' }}>{fmt(transfers)}</div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
