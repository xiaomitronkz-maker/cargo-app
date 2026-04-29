import { useEffect, useState } from 'react'
import api from '../api'
import { normalizeArray, toNumber } from '../utils/data'

const fmt = (n) => '$' + toNumber(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const typeMeta = {
  sale: { label: 'Продажа', badge: 'badge-success' },
  purchase: { label: 'Приход', badge: 'badge-warning' },
  payment: { label: 'Оплата', badge: 'badge-neutral' },
}

export default function Ledger() {
  const [entityType, setEntityType] = useState('client')
  const [clients, setClients] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    Promise.all([api.getClients(), api.getSuppliers()])
      .then(([clientsData, suppliersData]) => {
        console.log('Analytics data:', { clientsData, suppliersData })
        setClients(normalizeArray(clientsData))
        setSuppliers(normalizeArray(suppliersData))
      })
      .catch(() => {
        console.log('Analytics data:', null)
        setClients([])
        setSuppliers([])
      })
  }, [])

  useEffect(() => {
    setSelectedId('')
    setRows([])
  }, [entityType])

  useEffect(() => {
    if (!selectedId) {
      setRows([])
      return
    }
    setLoading(true)
    api.getLedger({ type: entityType, id: selectedId })
      .then(data => {
        console.log('Analytics data:', data)
        const safeData = normalizeArray(data)
        let running = 0
        setRows(safeData.map(row => {
          const amount = toNumber(row?.amount)
          const paidAmount = row?.paid_amount == null ? null : toNumber(row.paid_amount)
          running += row.type === 'payment' ? -amount : amount
          return { ...row, amount, paid_amount: paidAmount, running_balance: running }
        }))
      })
      .catch(() => {
        console.log('Analytics data:', null)
        setRows([])
      })
      .finally(() => setLoading(false))
  }, [entityType, selectedId])

  const entities = entityType === 'client' ? normalizeArray(clients) : normalizeArray(suppliers)
  const safeRows = normalizeArray(rows)
  const total = safeRows.length ? toNumber(safeRows[safeRows.length - 1].running_balance) : 0

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">История</div>
          <div className="page-subtitle">Операции по клиенту или поставщику</div>
        </div>
      </div>

      <div className="filters-bar">
        <select className="form-select" value={entityType} onChange={e => setEntityType(e.target.value)}>
          <option value="client">Клиент</option>
          <option value="supplier">Поставщик</option>
        </select>
        <select className="form-select" value={selectedId} onChange={e => setSelectedId(e.target.value)}>
          <option value="">Выберите {entityType === 'client' ? 'клиента' : 'поставщика'}</option>
          {entities.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </div>

      {!selectedId ? (
        <div className="empty-state"><p>Выберите клиента или поставщика</p></div>
      ) : loading ? (
        <div className="loading">Загрузка...</div>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Тип</th>
                <th>Касса</th>
                <th>Сумма</th>
                <th>Оплачено</th>
                <th>Остаток</th>
              </tr>
            </thead>
            <tbody>
              {safeRows.length === 0 && (
                <tr><td colSpan={6}>
                  <div className="empty-state"><p>Операций нет</p></div>
                </td></tr>
              )}
              {safeRows.map(row => (
                <tr key={`${row.type}-${row.id}`}>
                  <td className="td-muted">{row.date}</td>
                  <td>
                    <span className={`badge ${typeMeta[row.type]?.badge || 'badge-neutral'}`}>
                      {typeMeta[row.type]?.label || row.type}
                    </span>
                  </td>
                  <td className="td-muted">
                    {row.type === 'payment' ? row.account_name || '—' : '—'}
                  </td>
                  <td style={{ fontWeight: 600 }}>{fmt(row.amount)}</td>
                  <td className="td-muted">{row.paid_amount == null ? '—' : fmt(row.paid_amount)}</td>
                  <td>
                    <span className={`badge ${toNumber(row.running_balance) > 0 ? 'badge-warning' : 'badge-success'}`} style={{ fontSize: 13 }}>
                      {fmt(row.running_balance)}
                    </span>
                  </td>
                </tr>
              ))}
              <tr>
                <td colSpan={5} style={{ fontWeight: 700 }}>Итого</td>
                <td>
                  <span className={`badge ${toNumber(total) > 0 ? 'badge-warning' : 'badge-success'}`} style={{ fontSize: 13 }}>
                    {fmt(total)}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
