import { useEffect, useState } from 'react'
import api from '../api'
import { normalizeArray, toNumber } from '../utils/data'

const fmt = (n) => '$' + toNumber(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function Liabilities() {
  const [payables, setPayables] = useState([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      const debts = await api.getDebts()
      console.log('Analytics data:', debts)
      const safeDebts = normalizeArray(debts)
      setPayables(safeDebts.filter(debt => debt.type === 'payable'))
    } catch (e) {
      console.log('Analytics data:', null)
      setPayables([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const safePayables = normalizeArray(payables)
  const total = safePayables.reduce((sum, debt) => sum + toNumber(debt.debt), 0)

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Обязательства</div>
          <div className="page-subtitle">{safePayables.length} документов поставщиков</div>
        </div>
        <button className="btn btn-secondary" onClick={load}>Обновить</button>
      </div>

      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label">💳 Всего обязательств</div>
          <div className="stat-value negative">{fmt(total)}</div>
          <div className="stat-sub">{safePayables.length} открытых документов</div>
        </div>
      </div>

      {loading ? <div className="loading">Загрузка...</div> : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Поставщик</th>
                <th>Документ</th>
                <th>Сумма долга</th>
              </tr>
            </thead>
            <tbody>
              {safePayables.length === 0 && (
                <tr><td colSpan={4}>
                  <div className="empty-state"><p>Обязательств нет</p></div>
                </td></tr>
              )}
              {safePayables.map(debt => (
                <tr key={debt.id}>
                  <td className="td-muted">{debt.date || '—'}</td>
                  <td style={{ fontWeight: 600 }}>{debt.supplier_name || 'Без поставщика'}</td>
                  <td>{debt.document_label || `Приход №${debt.id}`}</td>
                  <td><span className="badge badge-danger" style={{ fontSize: 13 }}>{fmt(debt.debt)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
