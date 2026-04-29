import { useEffect, useState } from 'react'
import api from '../api'

const fmt = (n) => '$' + (+n || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function Liabilities() {
  const [payables, setPayables] = useState([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      const debts = await api.getDebts()
      setPayables(debts.filter(debt => debt.type === 'payable'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const total = payables.reduce((sum, debt) => sum + (+debt.debt || 0), 0)

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Обязательства</div>
          <div className="page-subtitle">{payables.length} документов поставщиков</div>
        </div>
        <button className="btn btn-secondary" onClick={load}>Обновить</button>
      </div>

      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label">💳 Всего обязательств</div>
          <div className="stat-value negative">{fmt(total)}</div>
          <div className="stat-sub">{payables.length} открытых документов</div>
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
              {payables.length === 0 && (
                <tr><td colSpan={4}>
                  <div className="empty-state"><p>Обязательств нет</p></div>
                </td></tr>
              )}
              {payables.map(debt => (
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
